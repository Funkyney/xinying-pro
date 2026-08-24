import path from "node:path";
import { chromium } from "playwright-core";

const projectId = process.env.XINYING_RESULTS_PROJECT_ID ?? "008677c8-228e-44c8-a8dc-a1512aa0cb39";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
let markedId = "";
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
  const first = cards.first();
  markedId = await page.evaluate((id) => window.xinying.results.list(id).then((items) => items.find((item) => item.source === "personal")?.id ?? ""), projectId);
  if (!markedId) throw new Error("结果库 API 没有返回首个视频");

  await first.locator(".result-select").click();
  const batchBar = page.locator(".result-batch-bar");
  if (!(await batchBar.innerText()).includes(`已选择 1 / ${count}`)) throw new Error("结果批量选择计数未更新");
  await batchBar.getByRole("button", { name: "标记", exact: true }).click();
  await first.locator(".result-mark").waitFor({ state: "visible", timeout: 8_000 });
  const marked = await page.evaluate((id) => window.xinying.results.list().then((items) => items.find((item) => item.id === id)?.marked), markedId);
  if (!marked) throw new Error("结果标记未持久化");
  await batchBar.getByRole("button", { name: "取消标记", exact: true }).click();
  await first.locator(".result-mark").waitFor({ state: "detached", timeout: 8_000 });

  await first.click();
  const viewer = page.locator(".result-viewer");
  await viewer.waitFor({ state: "visible", timeout: 8_000 });
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
  process.stdout.write(`${JSON.stringify({ ok: true, projectId, personalResultCount: count, projectResultCount: projectItems.length, projectMediaKinds: [...new Set(projectItems.map((item) => item.mediaKind))], initialProjectCardCount, markRestored: true, viewerBefore: before, viewerAfter: after, previewFit, screenshot }, null, 2)}\n`);
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
