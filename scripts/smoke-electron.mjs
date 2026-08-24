import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-electron-smoke-"));
const screenshotDir = path.join(appDir, "test-results");
const screenshotPath = path.join(screenshotDir, "desktop-smoke.png");
fs.mkdirSync(screenshotDir, { recursive: true });

const reserveFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const cdpPort = await reserveFreePort();

let electronApp;
try {
  electronApp = await electron.launch({
    args: [`--user-data-dir=${path.join(dataDir, "electron-user-data")}`, appDir],
    cwd: appDir,
    env: { ...process.env, XINYING_DATA_DIR: dataDir, XINYING_CDP_PORT: String(cdpPort) },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForSelector("text=心影Pro", { timeout: 20_000 });
  const created = await window.evaluate(() => window.xinying.projects.create({
    name: "Playwright 桌面验收",
    mode: "text-to-video",
    prompt: "固定机位",
    platformWorkspaceId: "smoke-personal",
    platformProjectId: "smoke-project",
    platformUrl: "https://blueaivideo.com/avpAgent?projectId=smoke-project&sessionId=smoke-session",
  }));
  await window.waitForTimeout(4_500);
  await window.getByRole("button", { name: "生成工作台", exact: true }).click();
  await window.getByRole("heading", { name: "Playwright 桌面验收" }).waitFor({ timeout: 10_000 });
  await window.getByText("0 / 50", { exact: true }).waitFor({ timeout: 10_000 });
  await window.getByText(/最多 50 项 · 30 图 \/ 10 视频 \/ 10 音频/).waitFor({ timeout: 10_000 });
  await window.getByRole("button", { name: "预览提交", exact: true }).click();
  const generationCount = window.locator(".generation-count-control input");
  await generationCount.waitFor({ state: "visible", timeout: 10_000 });
  await generationCount.fill("3");
  await window.getByText("第 1 条完整提交；后续自动使用心影“重新编辑”复用素材与参数", { exact: true }).waitFor();
  await window.screenshot({ path: screenshotPath, fullPage: true });
  await window.getByRole("button", { name: "返回检查", exact: true }).click();

  const oneClickPages = [
    ["总览", "心影让你当指挥家，心影Pro让你直接把片交了。"],
    ["空间与项目", "空间、项目与对话"],
    ["虚拟人像", "虚拟人像管理"],
    ["任务队列", "任务队列"],
    ["结果库", "结果库"],
    ["Codex扩展", "让 Codex 直接指挥心影Pro"],
    ["生成工作台", "Playwright 桌面验收"],
  ];
  const navigationLatencyMs = {};
  for (const [buttonName, headingName] of oneClickPages) {
    const startedAt = Date.now();
    await window.getByRole("button", { name: buttonName, exact: true }).click();
    await window.getByRole("heading", { name: headingName, exact: true }).waitFor({ state: "visible", timeout: 3_000 });
    navigationLatencyMs[buttonName] = Date.now() - startedAt;
  }
  const title = await window.title();
  const visibleText = await window.locator("body").innerText();
  process.stdout.write(`${JSON.stringify({ ok: true, title, projectId: created.id, screenshotPath, hasStudio: visibleText.includes("参考素材"), hasReuseBatch: true, navigationLatencyMs }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
