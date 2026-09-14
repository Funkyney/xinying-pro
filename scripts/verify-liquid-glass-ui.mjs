import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-liquid-ui-"));
const screenshot = path.join(appDir, "test-results", "liquid-glass-modal.png");
fs.mkdirSync(path.dirname(screenshot), { recursive: true });

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
    env: {
      ...process.env,
      XINYING_DATA_DIR: dataDir,
      XINYING_CDP_PORT: String(cdpPort),
      XINYING_DISABLE_AUTO_UPDATE: "1",
    },
    timeout: 30_000,
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForSelector("text=心影Pro", { timeout: 20_000 });
  await page.evaluate(() => window.xinying.projects.create({
    name: "Liquid Glass 动效验收",
    prompt: "液态玻璃界面动效验收，不提交生成。",
    modelName: "Seedance 2.5 全能参考",
    mode: "reference-to-video",
    aspectRatio: "16:9",
    duration: 5,
    resolution: "720p",
    platformWorkspaceId: "liquid-workspace",
    platformProjectId: "liquid-project",
    platformUrl: "https://blueaivideo.com/avpAgent?projectId=liquid-project",
  }));
  await page.waitForTimeout(1_200);

  const surface = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const topbar = document.querySelector(".topbar");
    const stage = document.querySelector(".page-stage");
    const hero = document.querySelector(".hero-panel");
    const button = document.querySelector(".button.primary");
    if (!(sidebar instanceof HTMLElement) || !(topbar instanceof HTMLElement) || !(stage instanceof HTMLElement) || !(hero instanceof HTMLElement) || !(button instanceof HTMLElement)) {
      throw new Error("液态玻璃关键元素缺失");
    }
    const sidebarStyle = getComputedStyle(sidebar);
    const topbarStyle = getComputedStyle(topbar);
    const stageStyle = getComputedStyle(stage);
    const heroStyle = getComputedStyle(hero);
    const buttonStyle = getComputedStyle(button);
    return {
      sidebarBlur: sidebarStyle.backdropFilter || sidebarStyle.webkitBackdropFilter,
      topbarBlur: topbarStyle.backdropFilter || topbarStyle.webkitBackdropFilter,
      sidebarRadius: sidebarStyle.borderRadius,
      topbarRadius: topbarStyle.borderRadius,
      heroRadius: heroStyle.borderRadius,
      pageAnimation: stageStyle.animationName,
      pageDuration: stageStyle.animationDuration,
      buttonTransitions: buttonStyle.transitionProperty,
      buttonDurations: buttonStyle.transitionDuration,
    };
  });
  if (!surface.sidebarBlur.includes("blur") || !surface.topbarBlur.includes("blur")) throw new Error(`结构玻璃缺少背景模糊：${JSON.stringify(surface)}`);
  if (surface.sidebarRadius !== "26px" || surface.topbarRadius !== "20px" || surface.heroRadius !== "28px") throw new Error(`材质圆角层级异常：${JSON.stringify(surface)}`);
  if (!surface.pageAnimation.includes("liquid-page-in") || surface.pageDuration !== "0.18s") throw new Error(`页面状态过渡异常：${JSON.stringify(surface)}`);
  if (!surface.buttonTransitions.includes("scale") || !surface.buttonDurations.includes("0.14s")) throw new Error(`按钮按压反馈异常：${JSON.stringify(surface)}`);

  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  await page.getByRole("heading", { name: "Liquid Glass 动效验收", exact: true }).waitFor();
  await page.getByRole("button", { name: "预览提交", exact: true }).click();
  const modal = page.locator(".confirm-modal");
  await modal.waitFor({ state: "visible" });
  const modalMotion = await modal.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationName, duration: style.animationDuration, blur: style.backdropFilter || style.webkitBackdropFilter };
  });
  if (!modalMotion.animation.includes("liquid-modal-in") || modalMotion.duration !== "0.24s" || !modalMotion.blur.includes("blur")) {
    throw new Error(`弹窗材质或动效异常：${JSON.stringify(modalMotion)}`);
  }
  await page.waitForTimeout(260);
  await page.screenshot({ path: screenshot, fullPage: true });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "返回检查", exact: true }).click();
  await page.getByRole("button", { name: "总览", exact: true }).click();
  const reducedAnimation = await page.locator(".page-stage").evaluate((element) => getComputedStyle(element).animationName);
  if (!reducedAnimation.includes("liquid-fade-in")) throw new Error(`减少动态效果未生效：${reducedAnimation}`);

  process.stdout.write(`${JSON.stringify({ ok: true, surface, modalMotion, reducedAnimation, screenshot }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
