import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createAppPaths } from "../dist-electron/core/paths.js";
import { XinyingDatabase } from "../dist-electron/core/database.js";
import { XinyingService } from "../dist-electron/core/service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-studio-draft-"));
const paths = createAppPaths(temp), database = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(database, paths), stamp = new Date().toISOString();
service.syncPlatformCatalog({
  workspaces: [{ id: "fixture-space", name: "草稿测试空间", kind: "personal", description: "仅隔离测试", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: stamp }],
  projects: [{ id: "fixture-project", workspaceId: "fixture-space", name: "草稿测试项目", shortId: "fixture", remoteId: "fixture-remote", homeUrl: "https://blueaivideo.com/home?projectId=fixture-remote", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: stamp }],
  currentWorkspaceId: "fixture-space", currentProjectId: "fixture-project", customerOptions: [], creationTypeOptions: [], syncedAt: stamp,
});
const local = service.createProject({ name: "草稿测试项目", mode: "reference-to-video", prompt: "已保存的旧提示词", platformWorkspaceId: "fixture-space", platformProjectId: "fixture-project", platformUrl: "https://blueaivideo.com/agentlab?projectId=fixture-remote&sessionId=fixture-session" });
const synthetic = path.join(temp, "synthetic-reference.png");
fs.writeFileSync(synthetic, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMzwAAAAASUVORK5CYII=", "base64"));
service.addSharedMedia([synthetic]); database.close();
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
    PlaywrightXinyingAdapter.prototype.sessionState = async () => ({ status: "logged-in", accountLabel: "隔离测试", checkedAt: new Date().toISOString() });
    PlaywrightXinyingAdapter.prototype.listPlatformConversations = async () => [{ id: "fixture-session", projectId: "fixture-project", title: "隔离对话", isCurrent: true, updatedAt: new Date().toISOString() }];
    PlaywrightXinyingAdapter.prototype.conversationHistory = async (_project, sessionId) => ({ sessionId, hasMore: false, beforeEventId: "", entries: [] });
  });
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    for (const candidate of app.windows()) if (await candidate.evaluate(() => Boolean(window.xinying)).catch(() => false)) page = candidate;
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page); page.setDefaultTimeout(10_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  const prompt = page.locator(".prompt-panel textarea");
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), "已保存的旧提示词");
  await prompt.fill("加入素材前刚输入的新提示词");
  await page.locator(".shared-material-library .studio-disclosure-toggle").click();
  const shared = page.locator(".shared-library-card").filter({ hasText: "synthetic-reference.png" });
  await shared.click(); await shared.filter({ hasText: "已加入当前项目" }).waitFor();
  assert.equal(await prompt.inputValue(), "加入素材前刚输入的新提示词");
  await prompt.fill("移除素材前继续输入的新提示词");
  await shared.click(); await shared.filter({ hasText: "点击加入当前项目" }).waitFor();
  assert.equal(await prompt.inputValue(), "移除素材前继续输入的新提示词");
  await page.waitForFunction(id => window.xinying.projects.list().then(rows => rows.find(row => row.id === id)?.prompt === "移除素材前继续输入的新提示词"), local.id);

  const goHome = async () => {
    if (await page.locator(".global-tabbar.compact").count()) await page.getByRole("button", { name: "生成工作台", exact: true }).click();
    await page.getByRole("button", { name: "总览", exact: true }).click();
  };
  await prompt.fill("最后一次输入：不等自动保存立即离开");
  await goHome();
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), "最后一次输入：不等自动保存立即离开");
  await page.waitForFunction(id => window.xinying.projects.list().then(rows => rows.find(row => row.id === id)?.prompt === "最后一次输入：不等自动保存立即离开"), local.id);

  // Reload immediately after a keystroke: recovery cannot depend on debounce.
  await prompt.fill("刷新后也必须恢复最后一个字");
  await page.reload();
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), "刷新后也必须恢复最后一个字");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  assert.equal((await page.evaluate(id => window.xinying.projects.list().then(rows => rows.find(row => row.id === id)), local.id)).prompt, "刷新后也必须恢复最后一个字");
  assert.equal((await page.evaluate(() => window.xinying.jobs.list())).length, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, packagedExecutable: Boolean(executablePath), realRendererIpcAndDatabase: true, addRemoveKeepsPrompt: true, autosave: true, immediateNavigationRecovery: true, immediateReloadRecovery: true, realGenerations: 0 }, null, 2));
} finally { if (app) await app.close().catch(() => undefined); }
