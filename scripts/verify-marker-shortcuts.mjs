import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const { createAppPaths } = require("../dist-electron/core/paths.js");
const { XinyingDatabase } = require("../dist-electron/core/database.js");
const { XinyingService } = require("../dist-electron/core/service.js");
const video = path.resolve(process.argv[2]); // A local video of at least four seconds.
assert.ok(fs.existsSync(video));
const directory = fs.mkdtempSync(path.resolve("test-results/marker-shortcuts-"));
const paths = createAppPaths(directory);
const db = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(db, paths);
const project = service.createProject({ name: "按键响应测试", platformProjectId: "fixture", platformWorkspaceId: "fixture",
  platformUrl: "https://blueaivideo.com/agentlab?projectId=fixture&sessionId=test" });
const record = { id: "clip", projectId: project.id, platformProjectId: "fixture", platformTaskId: "chat:fixture:test:clip",
  conversationId: "test", platformMaterialId: "clip", source: "personal", mediaKind: "video", jobId: null,
  name: "快捷键测试.mp4", prompt: "快捷键测试", available: true, marked: false, outputPath: video,
  outputUrl: "https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/fixture/one.mp4", previewUrl: null, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
service.syncPlatformResults(project.id, [record]);
service.syncPlatformResults(project.id, [{ ...record, id: "team", source: "project" }], "project");
db.close();
const server = net.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const packaged = process.argv.includes("--packaged") || Boolean(process.env.XINYING_SMOKE_EXECUTABLE);
const app = await electron.launch({
  executablePath: path.resolve(process.env.XINYING_SMOKE_EXECUTABLE ?? (packaged ? "release/win-unpacked/心影Pro.exe" : "node_modules/electron/dist/electron.exe")),
  args: ["--user-data-dir=" + path.join(directory, "browser"), ...(packaged ? [] : ["."])],
  env: { ...process.env, XINYING_DISABLE_AUTO_UPDATE: "1", XINYING_DATA_DIR: directory, CODEX_HOME: path.join(directory, "codex"), XINYING_CDP_PORT: String(port) },
});
try {
  const page = app.windows().find(win => win.url().startsWith("file:")) ?? await app.waitForEvent("window", win => win.url().startsWith("file:"));
  await page.getByRole("button", { name: "结果库", exact: true }).click();
  const card = page.locator('[data-drag-select-id="clip"]');
  await card.locator(".result-preview").click();
  const viewer = page.getByRole("dialog", { name: "结果详情" });
  const player = viewer.locator(".result-viewer-stage video");
  async function pressDigit(key) {
    // CDP Input.dispatchKeyEvent bypasses Electron's before-input-event hook.
    // Exercise the actual Electron input pipeline used by hardware keys.
    await app.evaluate(({ BrowserWindow }, digit) => {
      const contents = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith("file:")).webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: digit });
      contents.sendInputEvent({ type: "char", keyCode: digit });
      contents.sendInputEvent({ type: "keyUp", keyCode: digit });
    }, key);
  }
  async function seek(t) {
    await player.evaluate(async (el, time) => {
      await el.play(); el.pause();
      await new Promise(resolve => { el.addEventListener("seeked", resolve, { once: true }); el.currentTime = time; });
    }, t);
  }
  const cdp = await page.context().newCDPSession(page);
  async function focusNativeControl(pseudo) {
    const videoObject = await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.result-viewer-stage video')" });
    const tree = await cdp.send("DOM.describeNode", { objectId: videoObject.result.objectId, depth: -1, pierce: true });
    const candidates = [];
    function visit(node) {
      const attrs = node.attributes ?? [];
      if (attrs.includes(pseudo) && !attrs.includes("disabled") && !attrs.includes("display: none;")) candidates.push(node);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
    }
    visit(tree.node);
    assert.equal(candidates.length, 1, "Expected one visible native " + pseudo);
    const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: candidates[0].backendNodeId });
    const focused = await cdp.send("Runtime.callFunctionOn", { objectId: resolved.object.objectId,
      functionDeclaration: "function(){this.focus();return this.getRootNode().activeElement===this}", returnByValue: true });
    assert.equal(focused.result.value, true, "Native control must actually receive focus");
    await cdp.send("Runtime.releaseObject", { objectId: resolved.object.objectId });
    await cdp.send("Runtime.releaseObject", { objectId: videoObject.result.objectId });
  }
  // Count actual IPC library reloads; a marker edit must not trigger one.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("results:list");
    globalThis.markerReloads = 0;
    ipcMain.removeHandler("results:list");
    ipcMain.handle("results:list", (...args) => { ++globalThis.markerReloads; return original(...args); });
    const marker = ipcMain._invokeHandlers.get("results:set-clip-marker");
    globalThis.markerWrites = 0;
    ipcMain.removeHandler("results:set-clip-marker");
    ipcMain.handle("results:set-clip-marker", (...args) => { ++globalThis.markerWrites; return marker(...args); });
  });
  const timings = [];
  for (const t of [1, 2, 3]) {
    await seek(t);
    await page.evaluate(() => {
      globalThis.markerStarted = performance.now();
      globalThis.markerPaint = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('[aria-label="删除打点 ' + globalThis.markerExpected + '"]')) {
            observer.disconnect(); requestAnimationFrame(() => resolve(performance.now() - globalThis.markerStarted));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    });
    await page.evaluate(t => { globalThis.markerExpected = `00:00:0${t}.000`; }, t);
    await pressDigit("2");
    await viewer.getByRole("button", { name: `删除打点 00:00:0${t}.000` }).waitFor();
    timings.push(await page.evaluate(() => globalThis.markerPaint));
    await viewer.getByRole("button", { name: "已标记", exact: true }).waitFor();
  }
  await pressDigit("2"); // Duplicate time must not toggle the favorite.
  await viewer.getByRole("button", { name: "已标记", exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.markerReloads), 0);
  await viewer.getByRole("button", { name: "删除打点 00:00:02.000" }).click();
  await viewer.getByRole("button", { name: "删除打点 00:00:02.000" }).waitFor({ state: "detached" });
  await viewer.getByRole("button", { name: "已标记", exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.markerReloads), 0);
  for (const [control, time, label] of [
    ["-webkit-media-controls-play-button", 2.25, "00:00:02.250"],
    ["-webkit-media-controls-timeline", 2.5, "00:00:02.500"],
    [null, 2.75, "00:00:02.750"],
  ]) {
    await seek(time);
    if (control) await focusNativeControl(control); else await player.focus();
    const writes = await app.evaluate(() => globalThis.markerWrites);
    await pressDigit("2");
    const button = viewer.getByRole("button", { name: "删除打点 " + label });
    await button.waitFor({ timeout: 3000 });
    assert.equal(await app.evaluate(() => globalThis.markerWrites), writes + 1, "Exactly one write per keypress");
    assert.equal(await player.evaluate(el => el.currentTime), time, "Native control must not seek on 2");
    assert.equal(await player.evaluate(el => el.paused), true, "Native control must not start playback on 2");
    await button.click();
    await button.waitFor({ state: "detached" });
  }
  // Native play/pause must still work, and native key 1 must toggle only once.
  await focusNativeControl("-webkit-media-controls-play-button");
  await page.keyboard.press("Space");
  assert.equal(await player.evaluate(el => el.paused), false);
  await page.keyboard.press("Space");
  assert.equal(await player.evaluate(el => el.paused), true);
  await pressDigit("1");
  await viewer.getByRole("button", { name: "按 1 标记", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-drag-select-id="clip"] .result-mark'));
  await pressDigit("1");
  await viewer.getByRole("button", { name: "已标记", exact: true }).waitFor();
  // A focused text field must receive digits normally, including the IPC path.
  const writes = await app.evaluate(() => globalThis.markerWrites);
  await page.evaluate(() => {
    const field = document.createElement("textarea"); field.id = "shortcut-input-fixture";
    document.body.append(field); field.focus();
  });
  await pressDigit("1"); await pressDigit("2");
  assert.equal(await page.locator("#shortcut-input-fixture").inputValue(), "12");
  assert.equal(await app.evaluate(() => globalThis.markerWrites), writes);
  await page.locator("#shortcut-input-fixture").evaluate(el => el.remove());
  console.log("Native play button, timeline, video focus, no duplicate writes, normal playback and text input passed");
  await pressDigit("1");
  await viewer.getByRole("button", { name: "按 1 标记", exact: true }).waitFor();
  // Wait for the existing favorite refresh before continuing.
  await page.waitForFunction(() => !document.querySelector('[data-drag-select-id="clip"] .result-mark'));
  await seek(1.5);
  await pressDigit("2");
  await viewer.getByRole("button", { name: "删除打点 00:00:01.500" }).waitFor();
  await viewer.getByRole("button", { name: "已标记", exact: true }).waitFor();
  const rows = await page.evaluate(() => window.xinying.results.list());
  assert.ok(rows.every(r => r.marked && JSON.stringify(r.clipMarkersMs) === "[1000,1500,3000]"));
  console.log(JSON.stringify({ ok: true, directory, markerFeedbackMs: timings, markerTriggeredLibraryReloads: 0,
    checks: "time points + favorite, duplicate, delete, key 1 unmark, key 2 re-favorite, shared aliases" }));
} finally { await app.close(); }
const reopened = new XinyingDatabase(paths.databasePath);
try {
  const restored = new XinyingService(reopened, paths).listResults();
  assert.ok(restored.every(r => r.marked && JSON.stringify(r.clipMarkersMs) === "[1000,1500,3000]"));
  console.log("Restart persistence passed");
} finally { reopened.close(); }
