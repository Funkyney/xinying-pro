import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { _electron as electron } from "playwright-core";
import { createAppPaths } from "../dist-electron/core/paths.js";
import { XinyingDatabase } from "../dist-electron/core/database.js";
import { XinyingService } from "../dist-electron/core/service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-studio-layout-"));
const paths = createAppPaths(temp), database = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(database, paths), stamp = new Date().toISOString();
const initialPrompt = "固定镜头，先确认参考素材的顺序。\n让角色自然转身，画面保持完整构图。";
service.syncPlatformCatalog({
  workspaces: [{ id: "fixture-space", name: "个人创作空间", kind: "personal", description: "隔离验收", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: stamp }],
  projects: [{ id: "fixture-project", workspaceId: "fixture-space", name: "工作台排版验收", shortId: "fixture", remoteId: "fixture-remote", homeUrl: "https://blueaivideo.com/home?projectId=fixture-remote", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: stamp }],
  currentWorkspaceId: "fixture-space", currentProjectId: "fixture-project", customerOptions: [], creationTypeOptions: [], syncedAt: stamp,
});
const local = service.createProject({ name: "工作台排版验收", description: "不应在工作台显示的项目说明", prompt: initialPrompt, mode: "reference-to-video", platformWorkspaceId: "fixture-space", platformProjectId: "fixture-project", platformUrl: "https://blueaivideo.com/agentlab?projectId=fixture-remote&sessionId=fixture-session" });
const ceoFixture = path.join(temp, "参考构图.png");
execFileSync("ffmpeg", ["-v", "error", "-i", path.join(root, "src", "renderer", "assets", "dashboard-ceo.webp"), ceoFixture]);
service.addReferences(local.id, [path.join(root, "src", "renderer", "assets", "dashboard-director.png"), path.join(root, "src", "renderer", "assets", "dashboard-director-dark.jpg"), ceoFixture]);
// Local-only fixture, already submitted before the worker starts; never uploads.
const submitted = service.submitGeneration(local.id);
service.updateJob(submitted.id, { status: "running", automationStage: "submitted", progressLabel: "已提交到心影，等待生成", submittedAt: stamp });
database.close();
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
let app;
try {
  const executablePath = process.env.XINYING_SMOKE_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${path.join(temp, "profile")}`, ...(executablePath ? [] : [root])], cwd: root,
    env: { ...process.env, CODEX_HOME: path.join(temp, "codex-home"), XINYING_DATA_DIR: temp, XINYING_CDP_PORT: String(port), XINYING_DISABLE_AUTO_UPDATE: "1" } });
  await app.firstWindow();
  await app.context().route("https://**/*", route => route.abort());
  await app.evaluate(({ app }) => {
    const { PlaywrightXinyingAdapter } = process.mainModule.require(`${app.getAppPath()}/dist-electron/main/playwright-adapter.js`);
    globalThis.layoutFixture = { historyReads: 0 };
    PlaywrightXinyingAdapter.prototype.sessionState = async () => ({ status: "logged-in", accountLabel: "隔离测试", checkedAt: new Date().toISOString() });
    PlaywrightXinyingAdapter.prototype.listPlatformConversations = async () => [
      { id: "fixture-session", projectId: "fixture-project", title: "主片 · 第三版", isCurrent: true, updatedAt: new Date().toISOString() },
      { id: "fixture-other", projectId: "fixture-project", title: "镜头探索", isCurrent: false, updatedAt: new Date().toISOString() },
    ];
    PlaywrightXinyingAdapter.prototype.conversationHistory = async (_project, sessionId) => { globalThis.layoutFixture.historyReads++; return { sessionId, hasMore: false, entries: [] }; };
  });
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    for (const candidate of app.windows()) if (await candidate.evaluate(() => Boolean(window.xinying)).catch(() => false)) page = candidate;
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page); page.setDefaultTimeout(10_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1120 });
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "导演提示词", exact: true });
  await prompt.waitFor();
  await page.locator(".reference-card").nth(2).waitFor();
  const history = page.locator(".conversation-history"), library = page.locator(".shared-material-library");
  assert.equal(await history.locator(".studio-disclosure-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await library.locator(".studio-disclosure-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await library.locator("img, video, audio, .shared-library-card").count(), 0);
  assert.equal(await app.evaluate(() => globalThis.layoutFixture.historyReads), 0);
  assert.equal(await page.locator(".studio-page .project-description").count(), 0);
  assert.equal(await page.locator(".studio-page").getByText("灵感镜头", { exact: true }).count(), 0);
  const rect = selector => page.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, width: r.width, bottom: r.bottom }; });
  const boardBox = await rect(".reference-board"), parametersBox = await rect(".studio-parameters"), promptBox = await rect(".studio-prompt-panel");
  assert.ok(boardBox.bottom <= parametersBox.y && parametersBox.bottom <= promptBox.y);
  assert.ok(Math.abs(boardBox.width - promptBox.width) < 2 && Math.abs(boardBox.x - promptBox.x) < 2);
  assert.ok((await rect(".studio-model-picker")).right <= (await rect(".studio-model-options")).x);
  assert.equal(await page.locator(".studio-model-options select").count(), 5);
  const status = page.locator(".studio-draft-actions .studio-submission-status");
  assert.equal(await status.count(), 1);
  assert.equal(await page.locator(".studio-page > .studio-submission-status, .studio-submission-status.warning-box, .studio-submission-status .status-pill").count(), 0);
  assert.ok((await rect(".studio-status-link")).bottom - (await rect(".studio-status-link")).y <= 32);
  assert.equal(await status.locator("button").getAttribute("title"), "生成中 · 已提交到心影，等待生成；点击查看任务详情");
  const screenshots = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.querySelector(".page-content").scrollTo(0, 0); }, theme);
    const output = path.join(root, "test-results", `studio-layout-${theme}.png`);
    await page.screenshot({ path: output, animations: "disabled" }); screenshots.push(output);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.getByRole("tab", { name: "高级选项", exact: true }).click();
  assert.equal(await page.locator(".studio-advanced-panel input[type=checkbox]:visible").count(), 6);
  const sample = page.locator(".studio-advanced-panel .switch-row").filter({ has: page.getByText("样片模式", { exact: true }) }).locator("input");
  await sample.check();
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  const resolution = page.locator(".studio-model-options label").filter({ hasText: "分辨率" }).locator("select");
  assert.equal(await resolution.inputValue(), "480p"); assert.equal(await resolution.isDisabled(), true);
  await page.getByRole("tab", { name: "高级选项", exact: true }).click(); await sample.uncheck();
  await page.screenshot({ path: path.join(root, "test-results", "studio-layout-advanced.png") });
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  assert.equal(await prompt.inputValue(), initialPrompt);
  const longPrompt = Array.from({ length: 160 }, (_, i) => `镜头 ${i + 1}：参考 @图1，保持人物身份和空间关系，镜头随可见动作缓缓向前。背景沿用参考图中的材质和光线，不引入多余人物，动作结束后停留片刻再切换下一个镜头。`).join("\n");
  await prompt.fill(longPrompt);
  const measurements = [];
  for (const width of [1440, 1280, 1100, 900, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => innerWidth), width);
    const metrics = await prompt.evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight, height: node.getBoundingClientRect().height, overflow: getComputedStyle(node).overflowY, supported: CSS.supports("field-sizing", "content") }));
    assert.equal(metrics.supported, true); assert.equal(metrics.overflow, "hidden"); assert.ok(metrics.scroll <= metrics.client + 2, `Prompt clipped at ${width}`);
    assert.ok(metrics.height > 3000, "Long script must grow with its content");
    assert.equal(await page.locator(".page-content").evaluate(node => node.scrollWidth > node.clientWidth + 2), false, `Horizontal overflow at ${width}`);
    const save = await page.getByRole("button", { name: "保存草稿", exact: true }).boundingBox();
    const statusBox = await rect(".studio-submission-status"), submitBox = await rect(".studio-prompt-actions > .button");
    assert.ok(save.x + save.width <= statusBox.x && statusBox.right <= submitBox.x, `Status must stay beside Save without overlapping Submit at ${width}`);
    assert.ok(Math.abs(save.y + save.height / 2 - (statusBox.y + statusBox.bottom) / 2) < 2);
    assert.equal(await prompt.inputValue(), longPrompt);
    measurements.push({ width, ...metrics });
  }
  assert.ok(new Set(measurements.map(row => row.height)).size > 1, "Prompt must reflow when the viewport changes");
  await page.setViewportSize({ width: 1440, height: 1120 });
  await prompt.fill(initialPrompt);
  assert.ok((await rect(".studio-prompt-input")).width >= promptBox.width - 2);
  assert.ok(await prompt.evaluate(node => node.clientHeight < 500), "Textarea shrinks after deleting text");
  await page.locator(".studio-prompt-actions").scrollIntoViewIfNeeded();
  await page.locator(".page-content").evaluate(node => node.scrollTo(0, node.scrollHeight));
  assert.equal(await status.locator("button").evaluate(node => {
    const box = node.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return node === top || node.contains(top);
  }), true, "Floating navigation must not cover the quiet status link");
  const promptScreenshot = path.join(root, "test-results", "studio-layout-prompt.png");
  await page.screenshot({ path: promptScreenshot, animations: "disabled" }); screenshots.push(promptScreenshot);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: path.join(root, "test-results", "studio-submission-dark.png"), animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await status.getByRole("button", { name: /^查看任务详情/ }).click();
  await page.getByRole("heading", { name: "任务队列", exact: true }).waitFor();
  if (await page.locator(".global-tabbar.compact").count()) await page.locator(".global-tab-item.active").click();
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  await prompt.waitFor();
  await history.locator(".studio-disclosure-toggle").click();
  await history.getByText("这个对话还没有生成记录。可以在下方开始创作。", { exact: true }).waitFor();
  await history.locator(".studio-disclosure-toggle").click();
  await library.locator(".studio-disclosure-toggle").click();
  await library.locator(".shared-library-card").first().waitFor();
  await library.locator(".studio-disclosure-toggle").click();
  assert.equal(await library.locator("img, video, audio").count(), 0);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  assert.equal((await page.evaluate(id => window.xinying.projects.list().then(rows => rows.find(row => row.id === id)), local.id)).prompt, initialPrompt);
  await page.reload(); await page.getByRole("button", { name: "生成工作台", exact: true }).click(); await prompt.waitFor();
  assert.equal(await history.locator(".studio-disclosure-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await library.locator(".studio-disclosure-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await prompt.inputValue(), initialPrompt);
  assert.equal((await page.evaluate(() => window.xinying.jobs.list())).length, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, packagedExecutable: Boolean(executablePath), defaultCollapsed: true, lazyHistory: true, rememberedDisclosures: true, parameterTabs: true, fullWidthPrompt: true, quietFooterStatus: true, taskDetailsNavigation: true, autoGrowingPrompt: measurements, realGenerations: 0, screenshots }, null, 2));
} finally { if (app) await app.close().catch(() => undefined); }
