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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-conversations-ui-"));
const previewVideos = Object.fromEntries(["portrait", "landscape"].map(kind => {
  const output = path.join(temp, `${kind}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${kind === "portrait" ? "180x320" : "320x180"}:rate=10`, "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
  return [kind, fs.readFileSync(output)];
}));
const paths = createAppPaths(temp);
const database = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(database, paths);
const stamp = new Date().toISOString();
service.syncPlatformCatalog({
  workspaces: [{ id: "fixture-space", name: "个人空间", kind: "personal", description: "仅本地测试", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: stamp }],
  projects: [{ id: "fixture-project", workspaceId: "fixture-space", name: "心影对话验收项目", shortId: "fixture", remoteId: "fixture-remote", homeUrl: "https://blueaivideo.com/home?projectId=fixture-remote", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: stamp }],
  currentWorkspaceId: "fixture-space", currentProjectId: "fixture-project", customerOptions: [], creationTypeOptions: [], syncedAt: stamp,
});
const local = service.createProject({ name: "对话选择与草稿验收", mode: "text-to-video", prompt: "原始草稿", platformWorkspaceId: "fixture-space", platformProjectId: "fixture-project", platformUrl: "https://blueaivideo.com/agentlab?tab=generation&projectId=fixture-remote&sessionId=session-first" });
database.close();
const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); });
});
let app;
try {
  const executablePath = process.env.XINYING_SMOKE_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${path.join(temp, "profile")}`, ...(executablePath ? [] : [root])], cwd: root,
    env: { ...process.env, CODEX_HOME: path.join(temp, "codex-home"), XINYING_DATA_DIR: temp, XINYING_CDP_PORT: String(port), XINYING_DISABLE_AUTO_UPDATE: "1" } });
  await app.firstWindow();
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt += 1) {
    for (const candidate of app.windows()) if (await candidate.evaluate(() => Boolean(window.xinying)).catch(() => false)) page = candidate;
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page, "Main renderer missing");
  const previewRequests = [];
  await page.route("https://history-preview.invalid/**", async (route) => {
    const target = new URL(route.request().url());
    previewRequests.push(target.pathname + target.search);
    if (target.pathname.startsWith("/result-") && target.pathname.endsWith(".mp4")) {
      await route.fulfill({ status: 200, contentType: "video/mp4", body: previewVideos[target.pathname === "/result-202.mp4" ? "portrait" : "landscape"] });
    } else if (target.searchParams.has("x-tos-process") || target.pathname.includes("missing") || target.pathname === "/thumb.png") {
      await route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"Invalid frame capture"}' });
    } else {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#aab7c8"/></svg>' });
    }
  });
  await app.evaluate(({ app }) => {
    const { PlaywrightXinyingAdapter } = process.mainModule.require(`${app.getAppPath()}/dist-electron/main/playwright-adapter.js`);
    const state = globalThis.conversationFixture = { lists: 0, opens: [], created: 0, fail: false, historyReads: [], pickerQueue: [], picks: [] };
    const { dialog } = process.mainModule.require("electron");
    dialog.showOpenDialog = async (_window, options) => {
      state.picks.push(options);
      const filePaths = state.pickerQueue.shift() ?? [];
      return { canceled: filePaths.length === 0, filePaths };
    };
    const rows = [
      { id: "session-first", projectId: "fixture-project", title: "产品宣传片 · 已置顶", isPinned: true, updatedAt: "2026-11-20T08:00:00Z", isCurrent: true },
      { id: "session-second", projectId: "fixture-project", title: "城市漫游 · 第二版", updatedAt: "2026-11-24T03:00:00Z", isCurrent: false },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `history-${i}`, projectId: "fixture-project", title: `历史创作 ${i + 1}`, updatedAt: "2026-11-20T03:00:00Z", isCurrent: false })),
    ];
    // Only these two adapter methods are replaced, in this isolated process.
    // Real IPC and local persistence still run; no remote mutation can happen.
    PlaywrightXinyingAdapter.prototype.listPlatformConversations = async () => { state.lists += 1; if (state.fail) throw Error("测试读取失败"); return rows; };
    PlaywrightXinyingAdapter.prototype.conversationHistory = async (project, sessionId, beforeEventId) => {
      state.historyReads.push({ sessionId, beforeEventId });
      const id = beforeEventId ? "99" : sessionId === "session-first" ? "101" : "202";
      const prompt = `${sessionId} 的历史生成 @图1`;
      const source = { remoteProjectId: "fixture-remote", sessionId, eventId: id, prompt,
        materials: [
          { key: "image:0", kind: "image", name: "旧草稿参考.png", previewUrl: "https://history-preview.invalid/legacy.png?x-tos-process=video/snapshot,t_0,f_jpg", label: "@图1" },
          { key: "image:1", kind: "image", name: "可回退原图.png", previewUrl: "https://history-preview.invalid/thumb.png", originalUrl: "https://history-preview.invalid/original.png", label: "@图2" },
          { key: "image:2", kind: "image", name: "已失效预览.png", previewUrl: "https://history-preview.invalid/missing-thumb.png", originalUrl: "https://history-preview.invalid/missing-original.png", label: "@图3" },
        ] };
      return { sessionId, hasMore: !beforeEventId, beforeEventId: id, entries: [{ eventId: id, prompt, status: "completed", createdAt: "2026-11-24T03:00:00Z",
        mediaKind: beforeEventId ? "image" : "video", previewUrl: `https://history-preview.invalid/cover-${id}.png`, outputUrl: `https://history-preview.invalid/result-${id}.${beforeEventId ? "png" : "mp4"}`, source, editUnavailableReason: "", settings: { prompt, modelName: "Seedance 2.5 全能参考", mode: "reference-to-video", duration: 8,
          aspectRatio: "9:16", resolution: "1080p", audioEnabled: false, networkEnabled: false, autoPortraitAudit: true, videoFormat: "mov" } }] };
    };
    PlaywrightXinyingAdapter.prototype.openPlatformProject = async (catalog, id, sessionId) => {
      state.opens.push({ id, sessionId });
      const target = sessionId || `new-confirmed-${++state.created}`;
      if (!sessionId) rows.unshift({ id: target, projectId: id, title: "新会话", updatedAt: new Date().toISOString(), isCurrent: false });
      return { workspace: catalog.workspaces[0], project: catalog.projects[0], generationUrl: `https://blueaivideo.com/agentlab?tab=generation&projectId=fixture-remote&sessionId=${target}` };
    };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  const sidebar = page.locator(".project-conversations");
  await sidebar.locator(".project-conversation-item").first().waitFor();
  assert.equal(await sidebar.locator(".project-conversation-item").count(), 14);
  await page.locator(".prompt-panel textarea").fill("切换对话时必须保留的本地提示词");
  await sidebar.getByRole("button", { name: /城市漫游/ }).click();
  await sidebar.locator('.project-conversation-item.selected').filter({ hasText: "城市漫游" }).waitFor();
  assert.equal(await page.locator(".prompt-panel textarea").inputValue(), "切换对话时必须保留的本地提示词");
  const historyPanel = page.getByRole("region", { name: "当前对话的生成记录", exact: true });
  await historyPanel.getByText("session-second 的历史生成 @图1", { exact: true }).first().waitFor();
  assert.equal(await historyPanel.getByText("session-first 的历史生成 @图1", { exact: true }).count(), 0);
  const firstCover = historyPanel.locator(".conversation-history-cover").first();
  assert.equal(await historyPanel.locator("video").count(), 0, "No eager video loads");
  assert.equal(previewRequests.some(url => url.endsWith(".mp4")), false);
  await firstCover.hover();
  await firstCover.locator("video").evaluate(video => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error("Hover video did not start")), 5000);
    video.addEventListener("timeupdate", () => { if (!video.paused && video.currentTime > .05) { clearTimeout(deadline); resolve(); } });
  }));
  assert.equal(await firstCover.locator("video").evaluate(video => video.muted && video.loop), true);
  await page.getByRole("heading", { name: "当前对话的生成记录", exact: true }).hover();
  await firstCover.locator("video").waitFor({ state: "detached" });
  assert.equal(await page.locator(".prompt-panel textarea").inputValue(), "切换对话时必须保留的本地提示词");
  await firstCover.click();
  const previewDialog = page.getByRole("dialog", { name: "历史生成预览", exact: true });
  const previewVideo = previewDialog.locator(".history-result-stage video");
  await previewVideo.evaluate(video => new Promise((resolve, reject) => {
    if (video.readyState >= 2) return resolve();
    video.addEventListener("loadeddata", resolve, { once: true }); video.addEventListener("error", () => reject(Error("Preview media failed")), { once: true });
  }));
  assert.equal(await previewVideo.evaluate(video => video.videoHeight > video.videoWidth && getComputedStyle(video).objectFit === "contain"), true, "Portrait fits without cropping");
  assert.equal(await historyPanel.locator("video").count(), 0, "Hover playback stops while modal is open");
  const dialogBox = await previewDialog.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= viewport.width && dialogBox.y + dialogBox.height <= viewport.height, "Preview stays inside viewport");
  for (let tab = 0; tab < 8; tab++) { await page.keyboard.press("Tab"); assert.equal(await previewDialog.evaluate(node => node.contains(document.activeElement)), true); }
  await page.screenshot({ path: path.join(root, "test-results", "history-portrait-preview.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: path.join(root, "test-results", "history-portrait-preview-dark.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.keyboard.press("Escape"); await previewDialog.waitFor({ state: "detached" });
  assert.equal(await firstCover.evaluate(node => document.activeElement === node), true, "Return focus to source cover");
  assert.equal(await page.locator(".prompt-panel textarea").inputValue(), "切换对话时必须保留的本地提示词");
  await firstCover.click();
  await previewDialog.getByRole("button", { name: "重新编辑", exact: true }).click();
  await previewDialog.waitFor({ state: "detached" });
  assert.equal(await page.locator(".prompt-panel textarea").inputValue(), "session-second 的历史生成 @图1");
  await page.getByRole("region", { name: "历史记录参考素材" }).waitFor();
  await page.waitForFunction(() => {
    const figures = [...document.querySelectorAll(".history-material-items figure")];
    return figures.length === 3 && figures.slice(0, 2).every((figure) => figure.querySelector("img")?.naturalWidth > 0)
      && figures[2].querySelector('[role="img"]')?.textContent.includes("预览暂不可用");
  });
  assert.deepEqual(await page.locator(".history-material-items figcaption strong").allTextContents(), ["@图1", "@图2", "@图3"]);
  assert.equal(previewRequests.some((url) => url.includes("video/snapshot")), false, "PNG previews must not request video snapshots");
  assert.equal(previewRequests.filter((url) => url === "/thumb.png").length, 1, "Failed thumbnails must not loop");
  assert.ok(previewRequests.includes("/original.png"), "Failed image preview must fall back to the original");
  await page.screenshot({ path: path.join(root, "test-results", "history-preview-fallbacks.png") });
  assert.equal(await page.locator(".reference-board").isVisible(), false);
  assert.equal((await page.evaluate(() => window.xinying.jobs.list())).length, 0, "Editing must not create a generation");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.waitForFunction((id) => window.xinying.projects.list().then((rows) => rows.find((p) => p.id === id)?.historySource?.eventId === "202"), local.id);
  assert.equal((await page.evaluate((id) => window.xinying.jobs.preview(id), local.id)).ready, true);
  // Real native-picker IPC, persistence, and selected-only preview; no generation.
  const editor = page.getByRole("region", { name: "历史记录参考素材", exact: true });
  const editorKeys = () => editor.locator("figure").evaluateAll((nodes) => nodes.map((node) => node.dataset.materialKey));
  await editor.getByRole("button", { name: "前移 @图3", exact: true }).click();
  assert.deepEqual(await editorKeys(), ["history:image:0", "history:image:2", "history:image:1"]);
  const replacement = path.join(temp, "replacement.png"), addition = path.join(temp, "addition.png");
  fs.copyFileSync(path.join(root, "test-results", "desktop-smoke.png"), replacement);
  fs.copyFileSync(path.join(root, "test-results", "history-preview-fallbacks.png"), addition);
  const queuePicker = (files) => app.evaluate((_electron, files) => { globalThis.conversationFixture.pickerQueue.push(files); }, files);
  await queuePicker([replacement]);
  await editor.getByRole("button", { name: "替换 @图2", exact: true }).click();
  await editor.getByText("replacement.png", { exact: true }).waitFor();
  let editedKeys = await editorKeys();
  assert.equal(editedKeys.length, 3); assert.match(editedKeys[1], /^reference:/);
  assert.deepEqual((await app.evaluate(() => globalThis.conversationFixture.picks)).at(-1).properties, ["openFile"]);
  await queuePicker([addition, replacement]);
  await editor.getByRole("button", { name: "添加图片/视频/音频", exact: true }).click();
  await editor.getByText("addition.png", { exact: true }).waitFor();
  assert.equal((await editorKeys()).length, 4, "Selecting an existing file must not duplicate it");
  await editor.getByRole("button", { name: "移除 @图2", exact: true }).click();
  assert.equal(await editor.getByText("replacement.png", { exact: true }).count(), 0);
  await queuePicker([replacement]);
  await editor.getByRole("button", { name: "添加图片/视频/音频", exact: true }).click();
  await editor.getByText("replacement.png", { exact: true }).waitFor();
  editedKeys = await editorKeys();
  assert.equal(editedKeys.length, 4, "A removed imported file must be selectable again");
  assert.match(editedKeys.at(-1), /^reference:/);
  await queuePicker([]);
  await editor.getByRole("button", { name: "替换 @图1", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".history-material-editor")?.getAttribute("aria-busy")?.includes("true"));
  assert.deepEqual(await editorKeys(), editedKeys, "Canceling the file picker must retain the draft");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.waitForFunction(({ id, order }) => window.xinying.projects.list().then((rows) => JSON.stringify(rows.find((p) => p.id === id)?.historySource?.materialOrder) === JSON.stringify(order)), { id: local.id, order: editedKeys });
  const editedPreview = await page.evaluate((id) => window.xinying.jobs.preview(id), local.id);
  assert.equal(editedPreview.ready, true);
  assert.deepEqual(editedPreview.references.map((item) => item.name), ["addition.png", "replacement.png"]);
  assert.equal((await page.evaluate(() => window.xinying.jobs.list())).length, 0);
  await editor.evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: path.join(root, "test-results", "history-material-editing.png") });
  await editor.getByRole("button", { name: "恢复原素材", exact: true }).click();
  assert.deepEqual(await editorKeys(), ["history:image:0", "history:image:1", "history:image:2"]);
  await page.getByRole("button", { name: "退出历史编辑", exact: true }).click();
  assert.equal(await page.locator(".prompt-panel textarea").inputValue(), "切换对话时必须保留的本地提示词");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.waitForFunction((id) => window.xinying.projects.list().then((rows) => !rows.find((p) => p.id === id)?.historySource), local.id);
  await historyPanel.getByRole("button", { name: "加载更早记录", exact: true }).click();
  await historyPanel.locator("article").nth(1).waitFor();
  await historyPanel.locator(".conversation-history-cover").nth(1).click();
  await previewDialog.locator(".history-result-stage img").waitFor();
  assert.equal(await previewDialog.locator("video").count(), 0, "Image result uses image viewer");
  await page.keyboard.press("Escape"); await previewDialog.waitFor({ state: "detached" });
  let saved = await page.evaluate((id) => window.xinying.projects.list().then((rows) => rows.find((p) => p.id === id)), local.id);
  assert.match(saved.platformUrl, /sessionId=session-second/);
  assert.equal(saved.prompt, "切换对话时必须保留的本地提示词");
  await sidebar.getByRole("button", { name: "新建会话", exact: true }).click();
  await sidebar.locator('.project-conversation-item.selected').filter({ hasText: "新会话" }).waitFor();
  assert.equal(await page.locator(".prompt-panel textarea").inputValue(), saved.prompt);
  saved = await page.evaluate((id) => window.xinying.projects.list().then((rows) => rows.find((p) => p.id === id)), local.id);
  assert.match(saved.platformUrl, /sessionId=new-confirmed-1/);
  assert.equal((await page.evaluate(() => window.xinying.jobs.list())).length, 0);
  await sidebar.getByRole("textbox", { name: "搜索聊天" }).fill("城市");
  assert.equal(await sidebar.locator(".project-conversation-item").count(), 1);
  await sidebar.getByRole("textbox", { name: "搜索聊天" }).fill("");
  // A failed refresh retains the selected binding and does not open anything.
  await app.evaluate(() => { globalThis.conversationFixture.fail = true; });
  await sidebar.getByRole("button", { name: "刷新对话" }).click();
  await sidebar.getByRole("alert").waitFor();
  assert.match((await page.evaluate((id) => window.xinying.projects.list().then((rows) => rows.find((p) => p.id === id)), local.id)).platformUrl, /sessionId=new-confirmed-1/);
  await app.evaluate(() => { globalThis.conversationFixture.fail = false; });
  await sidebar.getByRole("button", { name: "刷新对话" }).click();
  await sidebar.getByRole("alert").waitFor({ state: "hidden" });
  const screenshots = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.querySelector(".page-content")?.scrollTo(0, 0); }, theme);
    const overflow = await page.locator(".page-content").evaluate((el) => el.scrollWidth > el.clientWidth + 2);
    assert.equal(overflow, false, "Studio overflows horizontally");
    const screenshot = path.join(root, "test-results", `conversations-${theme}.png`);
    await page.screenshot({ path: screenshot }); screenshots.push(screenshot);
  }
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "空间与项目", exact: true }).click();
  await page.getByRole("button", { name: "管理已绑定对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择项目对话" });
  await dialog.locator(".project-conversation-item").first().waitFor();
  assert.equal(await dialog.locator(".project-conversation-item").count(), 15);
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  assert.equal((await app.evaluate(() => globalThis.conversationFixture)).created, 1);
  assert.deepEqual(errors, []);
  await app.close(); app = null;
  const reopened = new XinyingDatabase(paths.databasePath);
  assert.match(new XinyingService(reopened, paths).getProject(local.id).platformUrl, /sessionId=new-confirmed-1/);
  reopened.close();
  process.stdout.write(JSON.stringify({ ok: true, officialStyleRows: 14, draftPreserved: true, bindingPersisted: true, imagePreviewFallbacks: true, historyMaterialEditing: true, pickerCancelAndReselect: true, hoverPlayback: true, portraitPreview: true, imagePreview: true, focusAndEscape: true, realGenerations: 0, screenshots }, null, 2) + "\n");
} finally {
  await app?.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
