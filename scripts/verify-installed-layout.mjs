import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const dataDir = process.env.XINYING_DATA_DIR
  ? path.resolve(process.env.XINYING_DATA_DIR)
  : path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "xinying-director");
const markedPort = fs.readFileSync(path.join(dataDir, "automation-port"), "utf8").trim();
const port = Number(process.env.XINYING_CDP_PORT ?? markedPort);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });

try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("找不到心影Pro主窗口");
  await page.setViewportSize({ width: 1120, height: 900 });
  await page.getByRole("button", { name: "空间与项目", exact: true }).click();
  await page.getByRole("heading", { name: "空间、项目与对话", exact: true }).waitFor();
  const cards = page.locator(".platform-project-card");
  await cards.first().waitFor({ state: "visible", timeout: 10_000 });
  const layouts = await cards.evaluateAll((elements) => elements.map((card) => {
    const detail = card.querySelector(":scope > div:nth-child(2)");
    const button = card.querySelector(":scope > button");
    if (!(detail instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
    const detailRect = detail.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return { detailRight: detailRect.right, buttonLeft: buttonRect.left, cardRight: card.getBoundingClientRect().right, viewportWidth: window.innerWidth };
  }).filter(Boolean));
  const overlapping = layouts.filter((item) => item.detailRight > item.buttonLeft || item.cardRight > item.viewportWidth);
  if (overlapping.length) throw new Error(`实际项目卡片仍有重叠：${JSON.stringify(overlapping.slice(0, 3))}`);
  const screenshot = path.resolve("test-results", "installed-project-layout.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, versionText: (await page.locator(".update-button small").innerText()).trim(), cardCount: layouts.length, overlapping: overlapping.length, screenshot }, null, 2)}\n`);
} finally {
  await browser.close().catch(() => undefined);
}
