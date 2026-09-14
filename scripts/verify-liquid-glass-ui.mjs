import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-ios27-ui-"));
const screenshot = path.join(appDir, "test-results", "ios27-dashboard.png");
const darkScreenshot = path.join(appDir, "test-results", "ios27-dashboard-dark.png");
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
  await page.getByText("心影Pro", { exact: true }).first().waitFor({ timeout: 20_000 });
  await page.evaluate(() => window.xinying.projects.create({
    name: "Liquid Glass 一屏验收",
    prompt: "只检查总览、顶栏和底栏，不提交生成。",
    modelName: "Seedance 2.5 全能参考",
    mode: "reference-to-video",
    aspectRatio: "16:9",
    duration: 5,
    resolution: "720p",
    platformWorkspaceId: "ios27-workspace",
    platformProjectId: "ios27-project",
    platformUrl: "https://blueaivideo.com/avpAgent?projectId=ios27-project",
  }));
  await page.waitForTimeout(1_000);

  const surface = await page.evaluate(() => {
    const topbar = document.querySelector(".topbar");
    const tabbar = document.querySelector(".global-tabbar");
    const hero = document.querySelector(".dashboard-feature");
    const featureGlass = document.querySelector(".featured-project-glass");
    if (!(topbar instanceof HTMLElement) || !(tabbar instanceof HTMLElement) || !(hero instanceof HTMLElement) || !(featureGlass instanceof HTMLElement)) {
      throw new Error("总览 Liquid Glass 关键结构缺失");
    }
    const style = (element) => {
      const computed = getComputedStyle(element);
      return {
        radius: computed.borderRadius,
        background: computed.backgroundColor,
        blur: computed.backdropFilter || computed.webkitBackdropFilter,
        shadow: computed.boxShadow,
      };
    };
    return {
      topbar: style(topbar),
      tabbar: style(tabbar),
      hero: style(hero),
      featureGlass: style(featureGlass),
      primaryTabs: tabbar.querySelectorAll(".global-tab-item").length,
      topbarButtons: topbar.querySelectorAll(".topbar-actions > button").length,
      topbarSelects: topbar.querySelectorAll("select").length,
      hasLogo: Boolean(topbar.querySelector(".app-logo")),
      hasPath: Boolean(topbar.querySelector(".breadcrumb")),
      hasShader: Boolean(document.querySelector(".refractive-chrome-canvas, [data-refractive]")),
      hasMetrics: Boolean(document.querySelector(".metric-grid")),
      hasRecentTasks: document.body.textContent?.includes("最近任务") ?? false,
      coverCount: document.querySelectorAll(".dashboard-cover-card").length,
      heroImageFit: getComputedStyle(hero.querySelector("img")).objectFit,
      heroImageCount: hero.querySelectorAll(".hero-visual > img").length,
      lightHeroOpacity: getComputedStyle(hero.querySelector(".hero-image-light")).opacity,
      darkHeroOpacity: getComputedStyle(hero.querySelector(".hero-image-dark")).opacity,
      heroImageTransition: getComputedStyle(hero.querySelector(".hero-image-dark")).transition,
    };
  });

  if (surface.hasShader) throw new Error("正式 APP 中仍存在 WebGL/折射跟踪层");
  if (surface.primaryTabs !== 5) throw new Error(`底栏必须恰好 5 个一级入口：${JSON.stringify(surface)}`);
  if (surface.topbarButtons !== 2 || surface.topbarSelects !== 0 || !surface.hasLogo || !surface.hasPath) throw new Error(`顶栏未精简为 Logo、路径、项目、连接：${JSON.stringify(surface)}`);
  if (!surface.topbar.blur.includes("blur(6px)") || surface.topbar.radius !== "34px") throw new Error(`顶栏材质 Token 异常：${JSON.stringify(surface.topbar)}`);
  if (!surface.tabbar.blur.includes("blur(6px)") || surface.tabbar.radius !== "34px") throw new Error(`底栏材质 Token 异常：${JSON.stringify(surface.tabbar)}`);
  if (!surface.featureGlass.blur.includes("blur(6px)") || surface.featureGlass.radius !== "34px") throw new Error(`英雄下沿玻璃条异常：${JSON.stringify(surface.featureGlass)}`);
  if (surface.hero.blur !== "none" || surface.hasMetrics || surface.hasRecentTasks || surface.coverCount < 1) throw new Error(`总览仍像后台卡片布局：${JSON.stringify(surface)}`);
  if (surface.heroImageFit !== "contain") throw new Error(`英雄人物可能被裁切：${surface.heroImageFit}`);
  if (surface.heroImageCount !== 2 || surface.lightHeroOpacity !== "1" || surface.darkHeroOpacity !== "0" || !surface.heroImageTransition.includes("opacity 0.24s")) throw new Error(`昼夜英雄图初始状态或交叉淡化异常：${JSON.stringify(surface)}`);

  await page.screenshot({ path: screenshot, fullPage: true });

  await page.getByRole("button", { name: "更多", exact: true }).click();
  const popover = page.locator(".global-nav-popover");
  await popover.waitFor({ state: "visible" });
  await popover.getByRole("button", { name: "夜间模式", exact: true }).click();
  await page.waitForTimeout(280);
  const darkHero = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    lightOpacity: getComputedStyle(document.querySelector(".hero-image-light")).opacity,
    darkOpacity: getComputedStyle(document.querySelector(".hero-image-dark")).opacity,
  }));
  if (darkHero.theme !== "dark" || darkHero.lightOpacity !== "0" || darkHero.darkOpacity !== "1") throw new Error(`暗夜英雄图切换失败：${JSON.stringify(darkHero)}`);
  await page.screenshot({ path: darkScreenshot, fullPage: true });
  await popover.getByRole("button", { name: "日间模式", exact: true }).click();
  await page.waitForTimeout(280);
  const secondaryRoutes = await popover.locator(".global-nav-popover-links > button").count();
  if (secondaryRoutes !== 4) throw new Error(`二级路由未完整保留：${secondaryRoutes}`);

  await popover.getByRole("button", { name: "原网页模式", exact: true }).click();
  const platformContainer = page.locator(".platform-container");
  await platformContainer.waitFor({ state: "visible" });
  await page.waitForTimeout(350);
  const platformLayout = await platformContainer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      viewportHeight: window.innerHeight,
      safeBottom: window.innerHeight - 96,
    };
  });
  if (platformLayout.bottom > platformLayout.safeBottom + 1) throw new Error(`原网页覆盖底栏安全区：${JSON.stringify(platformLayout)}`);
  await page.getByRole("button", { name: "总览", exact: true }).click();
  await page.locator(".dashboard-feature").waitFor({ state: "visible" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  await page.getByRole("button", { name: "总览", exact: true }).click();
  const reducedAnimation = await page.locator(".page-stage").evaluate((element) => getComputedStyle(element).animationName);
  if (!reducedAnimation.includes("ios27-reduced-fade")) throw new Error(`减少动态效果未生效：${reducedAnimation}`);

  process.stdout.write(`${JSON.stringify({ ok: true, surface, darkHero, secondaryRoutes, platformLayout, reducedAnimation, screenshot, darkScreenshot }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
