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

  const cards = page.locator(".result-card");
  const count = await cards.count();
  if (!count) throw new Error("结果库没有显示已同步视频");
  const first = cards.first();
  markedId = await page.evaluate((id) => window.xinying.results.list(id).then((items) => items[0]?.id ?? ""), projectId);
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

  const screenshot = path.resolve("test-results", "results-library-ui.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, projectId, resultCount: count, markRestored: true, viewerBefore: before, viewerAfter: after, screenshot }, null, 2)}\n`);
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
