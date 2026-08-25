import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-theme-ui-"));
const outputs = {
  dashboard: path.join(appDir, "test-results", "theme-dashboard.png"),
  studio: path.join(appDir, "test-results", "theme-studio.png"),
  projects: path.join(appDir, "test-results", "theme-projects.png"),
  portraits: path.join(appDir, "test-results", "theme-portraits.png"),
  results: path.join(appDir, "test-results", "theme-results.png"),
  codex: path.join(appDir, "test-results", "theme-codex.png"),
};
fs.mkdirSync(path.dirname(outputs.dashboard), { recursive: true });

const cdpPort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

let electronApp;
try {
  electronApp = await electron.launch({
    args: [`--user-data-dir=${path.join(dataDir, "electron-user-data")}`, appDir],
    cwd: appDir,
    env: { ...process.env, XINYING_DATA_DIR: dataDir, XINYING_CDP_PORT: String(cdpPort), XINYING_DISABLE_AUTO_UPDATE: "1" },
    timeout: 30_000,
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.waitForSelector("text=心影Pro", { timeout: 20_000 });
  await page.evaluate(() => window.xinying.projects.create({
    name: "NEWX4_第二段30秒_水晶钥匙与时间机器_T01",
    mode: "reference-to-video",
    prompt: "导演工作台主题视觉验收",
    platformWorkspaceId: "theme-workspace",
    platformProjectId: "theme-project",
    platformUrl: "https://blueaivideo.com/avpAgent?projectId=theme-project",
  }));
  await page.waitForTimeout(4_500);
  await page.getByRole("button", { name: "总览", exact: true }).click();
  await page.getByRole("heading", { name: "心影让你当指挥家，心影Pro让你直接把片交了。", exact: true }).waitFor();
  await page.locator(".hero-visual img").waitFor({ state: "visible" });

  const visual = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const hero = document.querySelector(".hero-panel");
    const director = document.querySelector(".hero-visual img");
    const activeNav = document.querySelector("nav button.active");
    if (!(sidebar instanceof HTMLElement) || !(hero instanceof HTMLElement) || !(director instanceof HTMLImageElement) || !(activeNav instanceof HTMLElement)) throw new Error("主题关键元素缺失");
    const colorNumbers = (value) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (value) => colorNumbers(value).reduce((sum, channel) => sum + channel, 0) / 3;
    const heroRect = hero.getBoundingClientRect();
    const imageRect = director.getBoundingClientRect();
    return {
      bodyColor: getComputedStyle(document.documentElement).color,
      shellBackground: getComputedStyle(document.querySelector(".app-shell")).backgroundImage,
      sidebarBackground: getComputedStyle(sidebar).backgroundColor,
      sidebarLuminance: luminance(getComputedStyle(sidebar).backgroundColor),
      activeNavBackground: getComputedStyle(activeNav).backgroundImage,
      heroHeight: Math.round(heroRect.height),
      imageWidth: Math.round(imageRect.width),
      imageHeight: Math.round(imageRect.height),
      imageNaturalWidth: director.naturalWidth,
      imageNaturalHeight: director.naturalHeight,
    };
  });
  if (visual.sidebarLuminance < 210) throw new Error(`侧栏不是暖白主题：${visual.sidebarBackground}`);
  if (visual.heroHeight < 250) throw new Error(`首页 BAR 高度不足：${visual.heroHeight}px`);
  if (visual.imageWidth < 500 || visual.imageNaturalWidth < 1500) throw new Error(`女生主视觉尺寸不足：${visual.imageWidth}px / ${visual.imageNaturalWidth}px`);
  if (!visual.activeNavBackground.includes("gradient")) throw new Error("当前导航没有香槟金渐变选中态");

  await page.screenshot({ path: outputs.dashboard, fullPage: true });

  const pages = [
    ["生成工作台", "NEWX4_第二段30秒_水晶钥匙与时间机器_T01", outputs.studio],
    ["空间与项目", "空间、项目与对话", outputs.projects],
    ["虚拟人像", "虚拟人像管理", outputs.portraits],
    ["结果库", "结果库", outputs.results],
    ["Codex扩展", "让 Codex 直接指挥心影Pro", outputs.codex],
  ];
  for (const [button, heading, screenshot] of pages) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: screenshot, fullPage: true });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, outputs, visual }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
