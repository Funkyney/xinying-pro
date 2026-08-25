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
  const page = remote.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("找不到心影Pro主窗口");

  await page.getByRole("button", { name: "Codex扩展", exact: true }).click();
  await page.getByRole("heading", { name: "让 Codex 直接指挥心影Pro" }).waitFor();
  const initialStatus = await page.evaluate(() => window.xinying.codexExtension.status());
  if (process.env.XINYING_INSTALL_CODEX_EXTENSION === "1" && (!initialStatus.installed || initialStatus.needsUpdate)) {
    await page.locator(".codex-extension-actions .button.primary").click();
    await page.locator(".extension-state.extension-installed").waitFor();
  }
  const status = await page.evaluate(() => window.xinying.codexExtension.status());
  const action = (await page.locator(".codex-extension-actions .button.primary").innerText()).trim();
  if (!status.available || !status.skillPath.endsWith("xinying-pro-generate") || !action) {
    throw new Error(`Codex扩展页面状态不符合预期：${JSON.stringify({ status, action })}`);
  }

  const output = path.resolve("test-results", "codex-extension-page.png");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, initialStatus, status, action, output }, null, 2)}\n`);
} finally {
  await remote.close();
}
