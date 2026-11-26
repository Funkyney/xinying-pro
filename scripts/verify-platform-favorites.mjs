import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

// Isolated data/profile; only adapter reads are replaced. Real IPC/SQLite/UI run.
// Never touches the user's account or calls favorite mutation endpoints.
const require = createRequire(import.meta.url);
const { createAppPaths } = require("../dist-electron/core/paths.js");
const { XinyingDatabase } = require("../dist-electron/core/database.js");
const { XinyingService } = require("../dist-electron/core/service.js");
const directory = fs.mkdtempSync(path.resolve("test-results/platform-favorites-"));
const paths = createAppPaths(directory), db = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(db, paths);
const project = service.createProject({ name: "官网收藏验收", platformProjectId: "fixture", platformWorkspaceId: "fixture", platformUrl: "https://blueaivideo.com/agentlab?projectId=fixture&sessionId=test" });
const rows = ["website", "local", "plain"].map((id, i) => ({ id, projectId: project.id, platformProjectId: "fixture", platformTaskId: "chat:fixture:test:" + i,
  source: "personal", mediaKind: "video", jobId: null, name: id + ".mp4", prompt: id, available: true, marked: false,
  outputUrl: `https://favorite-fixture.invalid/${id}.mp4`, outputPath: null, previewUrl: null, createdAt: "2026-11-25", lastSeenAt: "2026-11-25" }));
service.syncPlatformResults(project.id, rows);
service.setClipMarker("local", 1000, true);
db.close();
const server = net.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const packaged = process.env.XINYING_SMOKE_EXECUTABLE;
const app = await electron.launch({
  ...(packaged ? { executablePath: path.resolve(packaged) } : {}),
  args: ["--user-data-dir=" + path.join(directory, "browser"), ...(packaged ? [] : ["."])],
  env: { ...process.env, XINYING_DISABLE_AUTO_UPDATE: "1", XINYING_DATA_DIR: directory, CODEX_HOME: path.join(directory, "codex"), XINYING_CDP_PORT: String(port) },
});
try {
  await app.firstWindow();
  let page;
  for (let attempt = 0; attempt < 80 && !page; attempt++) {
    for (const candidate of app.windows()) if (await candidate.evaluate(() => Boolean(window.xinying)).catch(() => false)) page = candidate;
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, "main renderer");
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("https://favorite-fixture.invalid/**", route => route.fulfill({ status: 404, body: "isolated fixture" }));
  await app.evaluate(({ app }, fixtures) => {
    const { PlaywrightXinyingAdapter } = process.mainModule.require(`${app.getAppPath()}/dist-electron/main/playwright-adapter.js`);
    const state = globalThis.favoriteFixture = { marked: true, fail: false, calls: 0 };
    PlaywrightXinyingAdapter.prototype.syncProjectResults = async () => {
      state.calls++;
      if (state.fail) throw Error("官网收藏同步失败，已保留原有标记：模拟分页中断");
      return fixtures.map(row => ({ ...row, platformMarked: row.id === "website" && state.marked }));
    };
    PlaywrightXinyingAdapter.prototype.syncProjectMaterials = async () => [{ ...fixtures[2], id: "project-image", source: "project", mediaKind: "image",
      name: "image.jpg", outputUrl: "https://favorite-fixture.invalid/image.jpg", platformMarked: true }];
  }, rows);
  await page.getByRole("button", { name: "结果库", exact: true }).click();
  const cards = page.locator(".result-card"), website = page.locator('[data-drag-select-id="website"]');
  await page.getByRole("button", { name: "同步我的生成", exact: true }).click();
  await website.locator(".result-mark").getByText("官网收藏", { exact: true }).waitFor();
  assert.equal(await cards.count(), 3);
  const filter = page.locator(".result-filter-chips button").filter({ hasText: "官网收藏" });
  await filter.click();
  assert.equal(await cards.count(), 1);
  await website.locator(".result-preview").click();
  const viewer = page.getByRole("dialog", { name: "结果详情" });
  await viewer.getByRole("button", { name: "按 1 标记", exact: true }).click();
  await viewer.getByRole("button", { name: "已标记", exact: true }).waitFor();
  await viewer.getByRole("button", { name: "已标记", exact: true }).click();
  await viewer.getByRole("button", { name: "按 1 标记", exact: true }).waitFor();
  assert.ok((await viewer.locator("header").textContent()).includes("官网收藏"));
  await viewer.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await cards.count(), 1, "local unmark does not remove website favorite");
  await page.screenshot({ path: path.join(directory, "website-favorites.png") });
  await app.evaluate(() => { globalThis.favoriteFixture.fail = true; });
  const failure = await page.evaluate(async id => { try { await window.xinying.results.sync(id, "personal"); return "unexpected success"; } catch (error) { return error.message; } }, project.id);
  assert.match(failure, /已保留原有标记/);
  assert.equal((await page.evaluate(() => window.xinying.results.list())).find(row => row.id === "website").platformMarked, true);
  await app.evaluate(() => { globalThis.favoriteFixture.fail = false; globalThis.favoriteFixture.marked = false; });
  await page.getByRole("button", { name: "同步我的生成", exact: true }).click();
  await page.getByText("当前分类还没有官网收藏", { exact: true }).waitFor();
  await page.locator(".result-filter-chips button").filter({ hasText: "全部素材" }).click();
  await website.waitFor();
  assert.equal(await website.locator(".result-mark").count(), 0);
  const stored = await page.evaluate(() => window.xinying.results.list());
  assert.deepEqual(stored.find(row => row.id === "local").clipMarkersMs, [1000]);
  assert.equal(stored.find(row => row.id === "local").marked, true);
  await page.getByRole("tab", { name: /项目素材库/ }).click();
  await page.getByRole("button", { name: /同步项目素材库/ }).click();
  await page.locator('[data-drag-select-id="project-image"] .result-mark').getByText("官网收藏", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, directory, checks: "sync, website filter/badge, local independence, failure preservation, unfavorite, PR preservation, project image favorite" }));
} finally { await app.close(); }
