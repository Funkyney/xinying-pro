import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const port = Number(process.env.XINYING_CDP_PORT ?? 9333);
const remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });

try {
  const pages = remote.contexts().flatMap((context) => context.pages());
  const renderer = pages.find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!renderer) throw new Error("找不到心影Pro主窗口");

  const before = await renderer.evaluate(() => window.xinying.session.status());
  if (before.status !== "logged-in") {
    throw new Error(`当前会话未登录，无法自动验收登录成功回调：${JSON.stringify(before)}`);
  }

  await renderer.evaluate(() => window.xinying.session.openLogin());
  const loginPage = remote.contexts().flatMap((context) => context.pages()).find((candidate) => {
    try {
      const url = new URL(candidate.url());
      return url.hostname === "blueaivideo.com" || url.hostname.endsWith(".blueaivideo.com");
    } catch {
      return false;
    }
  });
  if (!loginPage) {
    const available = await Promise.all(remote.contexts().flatMap((context) => context.pages()).map(async (page) => ({
      url: page.url(),
      title: await page.title().catch(() => ""),
    })));
    throw new Error(`未观察到心影登录页：${JSON.stringify(available)}`);
  }
  await loginPage.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
  await loginPage.goto(before.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await renderer.getByText("飞书登录成功，已返回工作台", { exact: true }).waitFor({ timeout: 30_000 });
  await renderer.waitForTimeout(1_000);

  const after = await renderer.evaluate(() => window.xinying.session.status());
  const platformVisible = await renderer.evaluate(() => window.xinying.platformView.isVisible());
  const activeNavigation = (await renderer.locator("nav button.active").innerText()).trim();
  const platformPages = remote.contexts().flatMap((context) => context.pages()).filter((candidate) => {
    try {
      const host = new URL(candidate.url()).hostname;
      return host === "blueaivideo.com" || host.endsWith(".blueaivideo.com") || host.endsWith(".feishu.cn") || host.endsWith(".larksuite.com");
    } catch {
      return false;
    }
  });
  const authPopupCount = platformPages.filter((page) => {
    try {
      const host = new URL(page.url()).hostname;
      return host.endsWith("feishu.cn") || host.endsWith("larksuite.com");
    } catch {
      return false;
    }
  }).length;

  if (after.status !== "logged-in" || platformVisible || activeNavigation !== "总览" || authPopupCount !== 0) {
    throw new Error(`登录成功后未完全收起网页：${JSON.stringify({ after, platformVisible, activeNavigation, authPopupCount })}`);
  }

  const output = path.resolve("test-results", "login-lifecycle.png");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await renderer.screenshot({ path: output, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, before, after, platformVisible, activeNavigation, authPopupCount, output }, null, 2)}\n`);
} finally {
  await remote.close();
}
