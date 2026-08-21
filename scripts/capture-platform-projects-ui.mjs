import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
try {
  const renderer = browser.contexts().flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("file:") || page.url().includes("127.0.0.1:5173"));
  if (!renderer) throw new Error("找不到心影Pro渲染页面");
  await renderer.getByRole("button", { name: "空间与项目", exact: true }).click();
  await renderer.getByRole("heading", { name: "空间与项目", exact: true }).waitFor({ timeout: 10_000 });
  await renderer.waitForTimeout(800);
  const outputDir = path.resolve("test-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, "platform-projects-ui.png");
  await renderer.screenshot({ path: screenshotPath, fullPage: true });
  const body = await renderer.locator("body").innerText();
  const required = ["个人空间", "团队成员互通", "在当前空间新建项目"];
  const missing = required.filter((text) => !body.includes(text));
  if (await renderer.getByPlaceholder("搜索项目名称或 ID…").count() === 0) missing.push("搜索项目名称或 ID");
  if (missing.length) throw new Error(`空间与项目页面缺少：${missing.join("、")}`);

  await renderer.getByRole("button", { name: "虚拟人像", exact: true }).click();
  await renderer.getByRole("heading", { name: "虚拟人像管理", exact: true }).waitFor({ timeout: 10_000 });
  const portraitsScreenshotPath = path.join(outputDir, "portraits-library-ui.png");
  await renderer.screenshot({ path: portraitsScreenshotPath, fullPage: true });
  const portraitBody = await renderer.locator("body").innerText();
  for (const text of ["心影共享库 · 可直接调用", "最新上传在前", "加入当前项目", "自动上传并授权"]) {
    if (!portraitBody.includes(text)) throw new Error(`虚拟人像页面缺少：${text}`);
  }

  await renderer.getByRole("button", { name: "生成工作台", exact: true }).click();
  await renderer.getByRole("heading", { name: "APP功能验证-20260821", exact: true }).waitFor({ timeout: 10_000 });
  const authorizeButton = renderer.getByRole("button", { name: "授权为虚拟人像", exact: true });
  if (await authorizeButton.count() === 0) throw new Error("参考素材卡片没有“授权为虚拟人像”入口");
  const studioScreenshotPath = path.join(outputDir, "studio-portrait-authorization-ui.png");
  await renderer.screenshot({ path: studioScreenshotPath, fullPage: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    screenshotPath,
    portraitsScreenshotPath,
    studioScreenshotPath,
    requiredText: required,
    authorizationButtons: await authorizeButton.count(),
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
