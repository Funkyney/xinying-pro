import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const packagedExecutable = process.env.XINYING_SMOKE_EXECUTABLE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-electron-smoke-"));
const screenshotDir = path.join(appDir, "test-results");
const screenshotPath = path.join(screenshotDir, "desktop-smoke.png");
const typeSafeScreenshotPath = path.join(screenshotDir, "typesafe-settings.png");
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
const rendererErrors = [];
try {
  electronApp = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: [`--user-data-dir=${path.join(dataDir, "electron-user-data")}`, ...(packagedExecutable ? [] : [appDir])],
    cwd: appDir,
    env: { ...process.env, CODEX_HOME: path.join(dataDir, "codex-home"), XINYING_DATA_DIR: dataDir, XINYING_CDP_PORT: String(cdpPort), XINYING_DISABLE_AUTO_UPDATE: "1" },
    timeout: 30_000,
  });
  await electronApp.firstWindow();
  // A packaged build may create the official WebContentsView before the main
  // renderer is announced. Select our bridged app page, not the login WebView.
  let window;
  for (let attempt = 0; attempt < 80 && !window; attempt += 1) {
    for (const candidate of electronApp.windows()) {
      if (await candidate.evaluate(() => Boolean(window.xinying)).catch(() => false)) {
        window = candidate;
        break;
      }
    }
    if (!window) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!window) throw new Error("The main app renderer was not created");
  window.on("pageerror", (error) => rendererErrors.push(error.message));
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
  await window.getByRole("heading", { name: "生成工作台", exact: true }).waitFor({ timeout: 10_000 });
  await window.getByText("0 / 50", { exact: true }).waitFor({ timeout: 10_000 });
  await window.getByText(/最多 50 项 · 30 图 \/ 10 视频 \/ 10 音频/).waitFor({ timeout: 10_000 });
  const advancedControls = window.locator(".advanced-generation-controls");
  await window.getByRole("tab", { name: "高级选项", exact: true }).click();
  await advancedControls.getByRole("heading", { name: "官网高级配置" }).waitFor();
  const advancedSwitch = (name) => advancedControls.locator(".switch-row").filter({ has: window.getByText(name, { exact: true }) }).locator("input");
  if (!await advancedSwitch("自动图片人像审核").isChecked()) throw new Error("Native image review is not enabled by default");
  await advancedSwitch("样片模式").check();
  await window.getByRole("tab", { name: "模型", exact: true }).click();
  const resolutionSelect = window.locator(".form-grid label").filter({ hasText: "分辨率" }).locator("select");
  const formatSelect = window.locator(".form-grid label").filter({ hasText: "视频格式" }).locator("select");
  if (!await resolutionSelect.isDisabled() || await resolutionSelect.inputValue() !== "480p") throw new Error("Draft mode did not lock 480p");
  if (!await formatSelect.isDisabled() || await formatSelect.inputValue() !== "mp4") throw new Error("Draft mode did not lock MP4");
  if (!await advancedSwitch("智能均衡模式").isDisabled()) throw new Error("Draft mode did not disable smart balance");
  await window.getByRole("tab", { name: "高级选项", exact: true }).click();
  await advancedSwitch("样片模式").uncheck();
  await window.getByRole("tab", { name: "模型", exact: true }).click();
  await window.getByRole("button", { name: "预览提交", exact: true }).click();
  const generationCount = window.locator(".generation-count-control input");
  await generationCount.waitFor({ state: "visible", timeout: 10_000 });
  await generationCount.fill("3");
  await window.getByText("第 1 条完整提交；后续自动使用心影“重新编辑”复用素材与参数", { exact: true }).waitFor();
  await window.screenshot({ path: screenshotPath, fullPage: true });
  await window.getByRole("button", { name: "返回检查", exact: true }).click();

  const typeSafeStatus = await window.evaluate(() => window.xinying.typeSafe.status());
  if (Object.prototype.hasOwnProperty.call(typeSafeStatus, "apiKey")) throw new Error("TypeSafe status exposed the plaintext API key");
  const rejectedInvalidTypeSafeKey = await window.evaluate(async () => {
    try {
      await window.xinying.typeSafe.save("short");
      return false;
    } catch {
      return true;
    }
  });
  if (!rejectedInvalidTypeSafeKey) throw new Error("TypeSafe settings accepted an invalid API key");

  const oneClickPages = [
    ["总览", "心影让你当指挥家，心影Pro让你直接把片交了。"],
    ["空间与项目", "空间、项目与对话"],
    ["虚拟人像", "虚拟人像管理"],
    ["任务队列", "任务队列"],
    ["结果库", "结果库"],
    ["Codex扩展", "让 Codex 直接指挥心影Pro"],
    ["设置", "TypeSafe Jev"],
    ["生成工作台", "生成工作台"],
  ];
  const navigationLatencyMs = {};
  for (const [buttonName, headingName] of oneClickPages) {
    if (await window.locator(".global-tabbar.compact").count()) {
      await window.locator(".global-tabbar.compact .global-tab-item.active").click();
      await window.locator(".global-tabbar:not(.compact)").waitFor({ state: "visible" });
    }
    const startedAt = Date.now();
    const destination = window.getByRole("button", { name: buttonName, exact: true });
    if (await destination.count() === 0) {
      await window.getByRole("button", { name: "更多", exact: true }).click();
      await destination.waitFor({ state: "visible", timeout: 3_000 });
    }
    await destination.click();
    await window.getByRole("heading", { name: headingName, exact: true }).waitFor({ state: "visible", timeout: 3_000 });
    navigationLatencyMs[buttonName] = Date.now() - startedAt;
    if (buttonName === "设置") {
      await window.waitForTimeout(500);
      await window.screenshot({ path: typeSafeScreenshotPath, fullPage: true });
    }
  }
  const title = await window.title();
  const version = await electronApp.evaluate(({ app }) => app.getVersion());
  const visibleText = await window.locator("body").innerText();
  process.stdout.write(`${JSON.stringify({ ok: true, title, version, packaged: Boolean(packagedExecutable), projectId: created.id, screenshotPath, typeSafeScreenshotPath, hasStudio: visibleText.includes("参考素材"), hasReuseBatch: true, hasNativeReviewControls: true, typeSafeConfigured: typeSafeStatus.configured, navigationLatencyMs }, null, 2)}\n`);
} catch (error) {
  const pages = await Promise.all((electronApp?.windows() ?? []).map(async (page) => ({
    url: page.url(), title: await page.title().catch(() => ""),
    bridgePresent: await page.evaluate(() => Boolean(window.xinying)).catch(() => false),
  })));
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), rendererErrors, pages }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
