import path from "node:path";
import { chromium } from "playwright-core";

const port = Number(process.env.XINYING_CDP_PORT ?? 9333);
let browser;

async function dragAcross(page, start, end) {
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  if (!startBox || !endBox) throw new Error("拖选测试人像卡片不在可见区域");
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height * .42);
  await page.mouse.down();
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height * .42, { steps: 16 });
  await page.mouse.up();
}

try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  const renderer = browser.contexts().flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("file:") || page.url().includes("127.0.0.1:5173"));
  if (!renderer) throw new Error("找不到心影Pro渲染页面");
  const staleModalCancel = renderer.locator(".modal-backdrop").getByRole("button", { name: "取消", exact: true });
  if (await staleModalCancel.isVisible().catch(() => false)) await staleModalCancel.click();

  const dashboard = await renderer.evaluate(() => window.xinying.dashboard());
  const project = dashboard.projects.find((item) => item.platformWorkspaceId && item.platformProjectId && item.platformUrl);
  if (!project) throw new Error("没有已绑定心影空间和项目的本地项目");
  const skipSync = process.env.XINYING_SKIP_PORTRAIT_SYNC === "1";
  const synced = skipSync
    ? await renderer.evaluate(() => window.xinying.portraits.platformList())
    : await renderer.evaluate((projectId) => window.xinying.portraits.sync(projectId), project.id);
  const available = synced.filter((portrait) => portrait.available && portrait.workspaceId === project.platformWorkspaceId);
  const deletable = available.filter((portrait) => portrait.canDelete);
  if (!available.length) throw new Error("当前心影空间没有已同步虚拟人像");
  if (!deletable.length) throw new Error("当前心影空间没有检测到可删除权限标记");

  await renderer.getByRole("button", { name: "虚拟人像", exact: true }).click();
  await renderer.getByRole("heading", { name: "虚拟人像管理", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await renderer.waitForTimeout(4_500);
  const exitExistingManagement = renderer.getByRole("button", { name: "退出管理", exact: true });
  if ((await exitExistingManagement.count()) > 0) await exitExistingManagement.click();

  const sort = renderer.getByTestId("portrait-sort");
  await sort.waitFor({ state: "visible", timeout: 10_000 });
  await sort.selectOption("newest");
  const newestName = (await renderer.locator(".platform-library .portrait-card .portrait-body > strong").first().innerText()).trim();
  await sort.selectOption("oldest");
  const oldestName = (await renderer.locator(".platform-library .portrait-card .portrait-body > strong").first().innerText()).trim();
  if (available.length > 1 && newestName === oldestName) throw new Error("最新/最早排序没有改变首张卡片");

  await renderer.getByRole("button", { name: "批量管理", exact: true }).click();
  const batchBar = renderer.getByTestId("portrait-batch-bar");
  await batchBar.waitFor({ state: "visible", timeout: 5_000 });
  const selectableCards = renderer.locator(".platform-library .manage-portrait-card:not(.delete-forbidden-card)");
  if ((await selectableCards.count()) === 0) throw new Error("当前可见列表没有可选择的删除卡片");
  await selectableCards.first().click();
  if (!(await batchBar.innerText()).includes("已选择 1 项")) throw new Error("单项选择计数未更新");
  await selectableCards.first().click();
  const dragTargetCount = Math.min(3, await selectableCards.count());
  await dragAcross(renderer, selectableCards.first(), selectableCards.nth(dragTargetCount - 1));
  const dragSelectedCount = await renderer.locator(".platform-library .selected-delete-card").count();
  if (dragSelectedCount !== dragTargetCount) throw new Error(`虚拟人像拖选数量错误：${dragSelectedCount} / ${dragTargetCount}`);
  await dragAcross(renderer, selectableCards.first(), selectableCards.nth(dragTargetCount - 1));
  if ((await renderer.locator(".platform-library .selected-delete-card").count()) !== 0) throw new Error("虚拟人像从已选卡片拖动没有批量取消");

  await batchBar.getByRole("button", { name: "全选当前列表", exact: true }).click();
  const selectedCount = await renderer.locator(".platform-library .selected-delete-card").count();
  if (selectedCount < 1) throw new Error("全选当前列表未选择任何卡片");
  await batchBar.getByRole("button", { name: new RegExp(`永久删除 ${selectedCount} 项`) }).click();
  const modal = renderer.locator(".portrait-delete-modal");
  await modal.waitFor({ state: "visible", timeout: 5_000 });
  const modalText = await modal.innerText();
  if (!modalText.includes(`永久删除 ${selectedCount} 个心影虚拟人像`) || !modalText.includes("删除后不可恢复")) {
    throw new Error("永久删除确认框未显示数量或不可恢复警告");
  }
  if (await modal.getByRole("button", { name: "确认永久删除", exact: true }).isEnabled()) {
    throw new Error("未勾选不可恢复确认时，最终删除按钮不应可用");
  }
  await modal.screenshot({
    path: path.resolve("test-results", "portrait-batch-management-ui.png"),
    timeout: 60_000,
  });
  await modal.getByRole("button", { name: "取消", exact: true }).click();
  await batchBar.getByRole("button", { name: "清空选择", exact: true }).click();
  await renderer.getByRole("button", { name: "退出管理", exact: true }).click();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    project: project.name,
    workspaceId: project.platformWorkspaceId,
    available: available.length,
    deletable: deletable.length,
    newestName,
    oldestName,
    dragSelectedCount,
    dragDeselectChecked: true,
    selectedCount,
    confirmationChecked: false,
    deleteInvoked: false,
    source: skipSync ? "cached" : "synced",
    screenshot: path.resolve("test-results", "portrait-batch-management-ui.png"),
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
