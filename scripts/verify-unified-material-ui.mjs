import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const projectId = process.env.XINYING_TEST_PROJECT_ID ?? "";
const portraitName = process.env.XINYING_TEST_PORTRAIT_NAME ?? "";
if (!projectId || !portraitName) throw new Error("缺少 XINYING_TEST_PROJECT_ID 或 XINYING_TEST_PORTRAIT_NAME");

const outputDir = path.join(process.cwd(), "test-results");
fs.mkdirSync(outputDir, { recursive: true });
const screenshotPath = path.join(outputDir, "unified-material-ui.png");
const reportPath = path.join(outputDir, "unified-material-ui.json");

const readOrder = async (page) => page.locator(".reference-grid > .reference-card").evaluateAll((cards) => cards.map((card) => ({
  label: (card.querySelector(".reference-index")?.textContent ?? "").trim(),
  name: (card.querySelector(".reference-meta strong")?.textContent ?? "").trim(),
  portrait: card.classList.contains("portrait-reference-card"),
  authorized: (card.querySelector(".authorized-material-badge")?.textContent ?? "").replace(/\s+/g, "").trim(),
})));

const pointerDrag = async (page, source, target) => {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("拖动卡片不可见");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
  await page.mouse.up();
};

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`, { timeout: 10_000 });
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("找不到心影Pro主窗口");
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  const projectSelect = page.locator(".topbar select").first();
  await projectSelect.selectOption(projectId);
  await page.locator(".reference-board").waitFor({ state: "visible", timeout: 15_000 });
  const choice = page.locator(".platform-portrait-choice").filter({ hasText: portraitName }).first();
  await choice.scrollIntoViewIfNeeded();
  if (((await choice.getAttribute("class")) ?? "").includes("selected")) {
    await choice.click();
    await page.waitForFunction((name) => !Array.from(document.querySelectorAll(".portrait-reference-card .reference-meta strong")).some((element) => element.textContent?.trim() === name), portraitName, { timeout: 15_000 });
  }
  const before = await readOrder(page);
  await choice.click();
  await page.waitForFunction((name) => Array.from(document.querySelectorAll(".portrait-reference-card .reference-meta strong")).some((element) => element.textContent?.trim() === name), portraitName, { timeout: 15_000 });
  const afterClick = await readOrder(page);
  const added = afterClick.find((item) => item.name === portraitName);
  if (!added?.portrait || added.authorized !== "已授权") throw new Error("点击后虚拟人像没有以已授权卡片出现在上方参考素材");

  const localCard = page.locator(".reference-card:not(.portrait-reference-card)").first();
  const firstPortrait = page.locator(".portrait-reference-card").first();
  await pointerDrag(page, localCard.locator(".drag-handle"), firstPortrait.locator(".reference-preview"));
  await page.waitForTimeout(700);
  const afterDrag = await readOrder(page);
  if (afterDrag[0]?.portrait) throw new Error("拖动后本地参考图没有移动到虚拟人像分组之前");

  await pointerDrag(page, page.locator(".reference-card:not(.portrait-reference-card) .drag-handle").first(), page.locator(".reference-card").last().locator(".reference-preview"));
  await page.waitForTimeout(700);
  const restored = await readOrder(page);
  if (!restored.at(-1) || restored.at(-1).portrait) throw new Error("验收后未能恢复本地参考图在末尾的顺序");
  await page.locator(".reference-board").screenshot({ path: screenshotPath });

  const report = { ok: true, generated: false, before, afterClick, afterDrag, restored, screenshotPath, verifiedAt: new Date().toISOString() };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
}
