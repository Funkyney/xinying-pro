import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const dataDir = process.env.XINYING_DATA_DIR
  ? path.resolve(process.env.XINYING_DATA_DIR)
  : path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "xinying-director");
const markedPort = fs.existsSync(path.join(dataDir, "automation-port"))
  ? fs.readFileSync(path.join(dataDir, "automation-port"), "utf8").trim()
  : "";
const port = Number(process.env.XINYING_CDP_PORT ?? (markedPort || "9333"));
const remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });

try {
  const page = remote.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));

  if (!page) throw new Error("找不到心影Pro主窗口");

  const state = process.env.XINYING_CHECK_UPDATE === "1"
    ? await page.evaluate(() => window.xinying.updates.check())
    : await page.evaluate(() => window.xinying.updates.state());
  const buttonText = (await page.locator(".update-button").innerText()).trim();
  const knownStatuses = new Set([
    "idle",
    "checking",
    "available",
    "not-available",
    "downloading",
    "downloaded",
    "installing",
    "error",
    "unsupported",
  ]);

  if (!buttonText || !knownStatuses.has(state.status) || !/^\d+\.\d+\.\d+/.test(state.currentVersion)) {
    throw new Error(`更新控件状态不符合预期：${buttonText} / ${JSON.stringify(state)}`);
  }

  const output = path.resolve("test-results", "packaged-update-button.png");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, buttonText, state, output }, null, 2)}\n`);
} finally {
  await remote.close();
}
