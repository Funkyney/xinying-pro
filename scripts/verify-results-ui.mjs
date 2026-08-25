import path from "node:path";
import { chromium } from "playwright-core";

const projectId = process.env.XINYING_RESULTS_PROJECT_ID ?? "008677c8-228e-44c8-a8dc-a1512aa0cb39";
const portraitFixtureId = process.env.XINYING_RESULTS_PORTRAIT_ID ?? "";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
let markedId = "";
let reuseEditorChecked = false;

async function dragAcross(page, start, end) {
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  if (!startBox || !endBox) throw new Error("拖选测试卡片不在可见区域");
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height * .42);
  await page.mouse.down();
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height * .42, { steps: 16 });
  await page.mouse.up();
}

try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("找不到心影Pro主窗口");
  await page.reload({ waitUntil: "domcontentloaded" });
  const select = page.locator(".topbar-actions > select");
  await select.waitFor({ state: "visible", timeout: 15_000 });
  await select.selectOption(projectId);
  await page.getByRole("button", { name: "结果库", exact: true }).click();
  await page.getByRole("heading", { name: "结果库", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

  const personalTab = page.getByRole("tab", { name: /我的生成/ });
  const projectTab = page.getByRole("tab", { name: /项目素材库（全员）/ });
  if ((await personalTab.count()) !== 1 || (await projectTab.count()) !== 1) throw new Error("结果库没有显示两个来源选项卡");
  if ((await personalTab.getAttribute("aria-selected")) !== "true") throw new Error("结果库默认没有显示我的生成");

  const cards = page.locator(".result-card");
  const count = await cards.count();
  if (!count) throw new Error("结果库没有显示已同步视频");
  const first = portraitFixtureId ? page.locator(`.result-card[data-drag-select-id="${portraitFixtureId}"]`) : cards.first();
  markedId = await first.getAttribute("data-drag-select-id") ?? "";
  if (!markedId) throw new Error("结果库 API 没有返回首个视频");

  const filterButtons = page.locator(".result-filter-chips button");
  if ((await filterButtons.count()) !== 4) throw new Error("结果库没有显示全部/视频/图片/已标记四类筛选");
  const grid = page.locator(".result-grid");
  const sizeSlider = page.getByRole("slider", { name: "结果卡片大小" });
  const gridBeforeResize = await grid.getAttribute("style");
  await sizeSlider.fill("360");
  const gridAfterResize = await grid.getAttribute("style");
  if (gridBeforeResize === gridAfterResize || !gridAfterResize?.includes("360px")) throw new Error("结果卡片大小滑块没有改变网格排列");

  const hoverVideo = first.locator("video.result-hover-video");
  if ((await hoverVideo.count()) !== 1) throw new Error("视频结果卡片没有使用可悬停播放的视频预览");
  await hoverVideo.evaluate((video) => video.readyState >= 1 ? true : new Promise((resolve) => video.addEventListener("loadedmetadata", () => resolve(true), { once: true })));
  await first.waitFor({ state: "visible" });
  if (portraitFixtureId && !(await first.getAttribute("class"))?.includes("portrait-result")) throw new Error("9:16 视频没有切换为竖屏结果卡片");
  if (portraitFixtureId) await page.waitForTimeout(300);
  const portraitPreviewBox = await first.locator(".result-preview").boundingBox();
  if (portraitFixtureId && (!portraitPreviewBox || portraitPreviewBox.height <= portraitPreviewBox.width * 1.35)) throw new Error(`竖屏视频卡片比例不正确：${JSON.stringify(portraitPreviewBox)}`);
  await first.hover();
  await page.waitForTimeout(350);
  const hoverPlayback = await hoverVideo.evaluate((video) => ({ paused: video.paused, muted: video.muted, loop: video.loop }));
  if (!hoverPlayback.muted || !hoverPlayback.loop) throw new Error("悬停视频预览没有静音循环配置");

  await page.keyboard.press("1");
  await first.locator(".result-mark").waitFor({ state: "visible", timeout: 8_000 });
  const keyboardMarked = await page.evaluate((id) => window.xinying.results.list().then((items) => items.find((item) => item.id === id)?.marked), markedId);
  if (!keyboardMarked) throw new Error("鼠标悬停后按 1 没有持久化标记");
  await page.locator(".result-filter-chips button").filter({ hasText: "已标记" }).click();
  if ((await page.locator(".result-card .result-mark").count()) < 1) throw new Error("已标记筛选没有显示标记素材");
  if ((await page.getByRole("button", { name: /下载全部已标记/ }).count()) !== 1) throw new Error("已标记素材没有批量下载入口");
  await page.locator(".result-filter-chips button").filter({ hasText: "全部素材" }).click();
  await first.hover();
  await page.keyboard.press("1");
  await first.locator(".result-mark").waitFor({ state: "detached", timeout: 8_000 });

  await first.locator(".result-select").click();
  const batchBar = page.locator(".result-batch-bar");
  if (!(await batchBar.innerText()).includes(`已选择 1 / ${count}`)) throw new Error("结果批量选择计数未更新");
  await batchBar.getByRole("button", { name: "标记", exact: true }).click();
  await first.locator(".result-mark").waitFor({ state: "visible", timeout: 8_000 });
  const marked = await page.evaluate((id) => window.xinying.results.list().then((items) => items.find((item) => item.id === id)?.marked), markedId);
  if (!marked) throw new Error("结果标记未持久化");
  await batchBar.getByRole("button", { name: "取消标记", exact: true }).click();
  await first.locator(".result-mark").waitFor({ state: "detached", timeout: 8_000 });

  await first.locator(".result-select").click();
  const dragTargetCount = Math.min(3, count);
  await dragAcross(page, first, cards.nth(dragTargetCount - 1));
  const dragSelectedCount = await page.locator(".result-card.selected-result").count();
  if (dragSelectedCount !== dragTargetCount) throw new Error(`结果库拖选数量错误：${dragSelectedCount} / ${dragTargetCount}`);
  if ((await page.locator(".result-viewer").count()) !== 0) throw new Error("结果库拖选后误打开了预览");
  await dragAcross(page, first, cards.nth(dragTargetCount - 1));
  if ((await page.locator(".result-card.selected-result").count()) !== 0) throw new Error("结果库从已选卡片拖动没有批量取消");

  await first.click();
  const viewer = page.locator(".result-viewer");
  await viewer.waitFor({ state: "visible", timeout: 8_000 });
  if (portraitFixtureId && !(await viewer.getAttribute("class"))?.includes("portrait-viewer")) throw new Error("打开 9:16 视频后查看器没有进入竖屏布局");
  const inspector = viewer.locator(".result-viewer-inspector");
  if ((await inspector.count()) !== 1) throw new Error("结果查看器没有可滚动详情栏");
  const inspectorOverflow = await inspector.evaluate((element) => getComputedStyle(element).overflowY);
  if (!/auto|scroll/.test(inspectorOverflow)) throw new Error(`结果详情栏不能向下滚动：${inspectorOverflow}`);
  if ((await viewer.getByRole("heading", { name: "生成提示词" }).count()) !== 1) throw new Error("结果详情没有显示完整提示词区");
  if ((await viewer.getByRole("heading", { name: /参考素材/ }).count()) !== 1) throw new Error("结果详情没有显示参考素材区");
  const referenceImage = viewer.locator(".result-reference-item img").first();
  if ((await referenceImage.count()) > 0) {
    await referenceImage.waitFor({ state: "visible", timeout: 5_000 });
    if ((await referenceImage.evaluate((image) => image.naturalWidth)) === 0) throw new Error("结果详情中的历史参考图无法读取");
  }
  const reuseButton = viewer.getByRole("button", { name: "复用并编辑", exact: true });
  if ((await reuseButton.count()) !== 1) throw new Error(`个人视频结果没有复用入口：${(await viewer.locator(".result-reuse-actions").innerText()).trim()}`);
  await reuseButton.click();
  if ((await viewer.locator(".result-detail-section textarea").count()) !== 1) throw new Error("复用按钮没有进入提示词编辑状态");
  if ((await viewer.getByRole("button", { name: /提交生成/ }).count()) !== 1) throw new Error("复用编辑没有提交入口");
  await viewer.getByRole("button", { name: "取消编辑", exact: true }).click();
  reuseEditorChecked = true;
  const viewerScreenshot = path.resolve("test-results", "results-viewer-ui.png");
  await page.screenshot({ path: viewerScreenshot, fullPage: true });
  const before = (await viewer.locator("header span").innerText()).trim();
  await viewer.locator(".viewer-nav.next").click();
  const after = (await viewer.locator("header span").innerText()).trim();
  if (count > 1 && before === after) throw new Error("结果查看器下一条没有切换");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached", timeout: 5_000 });
  if ((await page.locator(".result-card.last-viewed").count()) !== 1) throw new Error("关闭查看器后没有定位上次查看项");

  const projectItems = await page.evaluate((id) => window.xinying.results.list(id).then((items) => items.filter((item) => item.source === "project")), projectId);
  if (!projectItems.some((item) => item.mediaKind === "video") || !projectItems.some((item) => item.mediaKind === "image")) throw new Error("项目素材库没有同时保存图片和视频");
  await projectTab.click();
  if ((await projectTab.getAttribute("aria-selected")) !== "true") throw new Error("项目素材库选项卡没有切换成功");
  const projectCards = page.locator(".result-card");
  const initialProjectCardCount = await projectCards.count();
  if (!initialProjectCardCount) throw new Error("项目素材库没有显示全员素材");
  if ((await page.locator(".result-kind-video").count()) === 0 || (await page.locator(".result-kind-image").count()) === 0) throw new Error("项目素材卡片没有区分图片和视频");
  const previewFit = await projectCards.first().locator(".result-preview img, .result-preview video").first().evaluate((element) => getComputedStyle(element).objectFit);
  if (previewFit !== "contain") throw new Error(`结果卡片仍在裁切素材：object-fit=${previewFit}`);

  const imageCard = projectCards.filter({ has: page.locator(".result-kind-image") }).first();
  await imageCard.locator(".result-preview img").evaluate((image) => image.complete ? true : new Promise((resolve) => image.addEventListener("load", () => resolve(true), { once: true })));
  if (portraitFixtureId && !(await imageCard.getAttribute("class"))?.includes("portrait-result")) throw new Error("9:16 图片没有切换为竖屏结果卡片");
  await imageCard.click();
  await viewer.waitFor({ state: "visible", timeout: 8_000 });
  const viewerImage = viewer.locator(".result-viewer-stage img");
  await viewerImage.waitFor({ state: "visible", timeout: 8_000 });
  if (await viewerImage.evaluate((element) => getComputedStyle(element).objectFit) !== "contain") throw new Error("图片查看器没有完整显示竖屏/横屏素材");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached", timeout: 5_000 });

  const loadMore = page.locator(".result-load-more");
  if (projectItems.length > initialProjectCardCount) {
    await loadMore.getByRole("button", { name: /继续加载/ }).click();
    if ((await projectCards.count()) <= initialProjectCardCount) throw new Error("大量项目素材无法继续加载");
  }

  await page.locator(".page-content").evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(100);
  const screenshot = path.resolve("test-results", "results-library-ui.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, projectId, personalResultCount: count, projectResultCount: projectItems.length, projectMediaKinds: [...new Set(projectItems.map((item) => item.mediaKind))], initialProjectCardCount, dragSelectedCount, dragDeselectChecked: true, keyboardMarkChecked: true, markedFilterChecked: true, hoverPlayback, gridBeforeResize, gridAfterResize, inspectorOverflow, reuseEditorChecked, markRestored: true, viewerBefore: before, viewerAfter: after, previewFit, viewerScreenshot, screenshot }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (markedId) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
    await page?.evaluate((id) => window.xinying.results.mark([id], false), markedId).catch(() => undefined);
  }
  await browser.close().catch(() => undefined);
}
