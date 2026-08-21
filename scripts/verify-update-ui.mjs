import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const remote = await chromium.connectOverCDP("http://127.0.0.1:9333", { timeout: 15_000 });

try {
  const page = remote.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));

  if (!page) throw new Error("找不到心影Pro主窗口");

  const state = await page.evaluate(() => window.xinying.updates.state());
  const buttonText = (await page.locator(".update-button").innerText()).trim();
  const knownStatus = /(更新|开发版本)/.test(buttonText);

  if (!knownStatus || !/^\d+\.\d+\.\d+/.test(state.currentVersion)) {
    throw new Error(`更新控件状态不符合预期：${buttonText} / ${JSON.stringify(state)}`);
  }

  const output = path.resolve("test-results", "packaged-update-button.png");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, buttonText, state, output }, null, 2)}\n`);
} finally {
  await remote.close();
}
