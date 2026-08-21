import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const appDir = path.resolve(".");
const fixtures = [
  path.join(appDir, "test-results", "reference-fixtures", "reference-1.png"),
  path.join(appDir, "test-results", "media-fixtures", "reference-video.mp4"),
  path.join(appDir, "test-results", "media-fixtures", "reference-audio.wav"),
];
for (const fixture of fixtures) {
  if (!fs.existsSync(fixture)) throw new Error(`Missing media fixture: ${fixture}`);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
let projectId = "";
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("找不到心影Pro主窗口");

  const rendererErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 15_000 });

  const project = await page.evaluate(() => window.xinying.projects.create({
    name: `媒体类型回归 ${Date.now()}`,
    description: "自动验证图片、视频和音频参考素材",
    prompt: "按图1、视频1、音频1作为参考。",
    modelName: "Seedance 2.5 全能参考",
    platformUrl: "https://blueaivideo.com/avpAgent?projectId=media-ui-regression",
    platformWorkspaceId: "media-ui-workspace",
    platformProjectId: "media-ui-project",
    mode: "reference-to-video",
    aspectRatio: "16:9",
    duration: 5,
    resolution: "auto",
    audioEnabled: true,
  }));
  projectId = project.id;

  const cli = spawnSync(process.execPath, [
    path.join(appDir, "dist-electron", "cli", "index.js"),
    "refs", "add", projectId, "--file", ...fixtures,
  ], { cwd: appDir, encoding: "utf8" });
  if (cli.status !== 0) throw new Error(`CLI添加媒体失败: ${cli.stderr || cli.stdout}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  const projectSelect = page.locator(".topbar-actions > select");
  await projectSelect.waitFor({ state: "visible", timeout: 15_000 });
  await projectSelect.selectOption(projectId);
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  await page.getByRole("heading", { name: project.name, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".reference-card").filter({ has: page.locator(".reference-meta strong") }).first().waitFor({ state: "visible", timeout: 15_000 });

  const references = await page.evaluate((id) => window.xinying.references.list(id), projectId);
  const byKind = Object.fromEntries(references.map((item) => [item.mimeType.split("/")[0], item]));
  if (!byKind.image || !byKind.video || !byKind.audio) throw new Error(`媒体类型不完整: ${references.map((item) => item.mimeType).join(", ")}`);
  const mediaElements = {
    images: await page.locator(".reference-card .reference-preview img").count(),
    videos: await page.locator(".reference-card .reference-preview video").count(),
    audios: await page.locator(".reference-card .reference-preview audio").count(),
  };
  if (!mediaElements.images || !mediaElements.videos || !mediaElements.audios) {
    throw new Error(`媒体预览控件缺失: ${JSON.stringify(mediaElements)}`);
  }
  const labels = await page.locator(".reference-card .reference-index").allInnerTexts();
  if (!labels.includes("@图1") || !labels.includes("@视频1") || !labels.includes("@音频1")) {
    throw new Error(`媒体编号不正确: ${labels.join(", ")}`);
  }
  const audioCard = page.locator(".reference-card").filter({ hasText: byKind.audio.name });
  const audioAuthorization = audioCard.locator(".authorize-reference-button");
  if (!(await audioAuthorization.isDisabled()) || !(await audioAuthorization.innerText()).includes("不可授权")) {
    throw new Error("音频素材错误地允许授权为虚拟人像");
  }

  const reorderedIds = [byKind.audio.id, byKind.image.id, byKind.video.id];
  await page.evaluate(({ id, ids }) => window.xinying.references.reorder(id, ids), { id: projectId, ids: reorderedIds });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".topbar-actions > select").selectOption(projectId);
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  await page.getByRole("heading", { name: project.name, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".reference-card").first().waitFor({ state: "visible", timeout: 15_000 });
  const orderedNames = await page.locator(".reference-card .reference-meta strong").allInnerTexts();
  if (orderedNames.slice(0, 3).join("|") !== [byKind.audio.name, byKind.image.name, byKind.video.name].join("|")) {
    throw new Error(`跨媒体排序未持久化: ${orderedNames.join(" | ")}`);
  }
  const preview = await page.evaluate((id) => window.xinying.jobs.preview(id), projectId);
  if (!preview.ready || !preview.orderedLabels[0]?.includes("@音频1") || !preview.orderedLabels[1]?.includes("@图1") || !preview.orderedLabels[2]?.includes("@视频1")) {
    throw new Error(`提交预览未保持跨媒体顺序: ${preview.orderedLabels.join(" | ")}`);
  }
  const relevantRendererErrors = rendererErrors.filter((message) => /uncontrolled|controlled input|uncaught|TypeError/i.test(message));
  if (relevantRendererErrors.length) throw new Error(`渲染器控制台错误: ${relevantRendererErrors.join(" | ")}`);

  const screenshot = path.join(appDir, "test-results", "media-types-ui.png");
  await page.screenshot({ path: screenshot, fullPage: true });

  const imageCard = page.locator(".reference-card").filter({ hasText: byKind.image.name });
  await imageCard.locator(".icon-button.danger").click();
  const deleteModal = page.locator(".reference-delete-modal");
  await deleteModal.waitFor({ state: "visible", timeout: 5_000 });
  await deleteModal.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteModal.waitFor({ state: "detached", timeout: 8_000 });
  const remaining = await page.evaluate((id) => Promise.all([
    window.xinying.references.list(id),
    window.xinying.projects.list(),
  ]), projectId);
  if (remaining[0].length !== 2 || remaining[0].some((item) => item.id === byKind.image.id)) {
    throw new Error("本地参考素材删除未生效");
  }
  const remainingProject = remaining[1].find((item) => item.id === projectId);
  if (!remainingProject || remainingProject.materialOrder.some((key) => key === `reference:${byKind.image.id}`)) {
    throw new Error("删除本地参考素材后最终顺序仍残留旧 ID");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mediaElements,
    initialLabels: labels,
    reorderedNames: orderedNames.slice(0, 3),
    previewLabels: preview.orderedLabels,
    deletedReference: byKind.image.name,
    remainingReferences: remaining[0].map((item) => item.name),
    rendererErrors: relevantRendererErrors,
    screenshot,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (projectId) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
    await page?.evaluate((id) => window.xinying.projects.remove(id), projectId).catch(() => undefined);
  }
  await browser.close().catch(() => undefined);
}
