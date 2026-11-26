import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { _electron as electron } from "playwright-core";
import { createAppPaths } from "../dist-electron/core/paths.js";
import { XinyingDatabase } from "../dist-electron/core/database.js";
import { XinyingService } from "../dist-electron/core/service.js";

// Real MCP stdio -> CDP -> renderer -> IPC -> service -> queue -> SQLite.
// Only the remote platform adapter is mocked. No live account or paid task.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-mcp-automation-"));
const paths = createAppPaths(temp), database = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(database, paths);
const project = service.createProject({ name: "隔离 MCP 验收", prompt: "占位", modelName: "Seedance 2.5 全能参考", mode: "reference-to-video", autoPortraitAudit: true,
  platformWorkspaceId: "fixture-space", platformProjectId: "fixture-project", platformUrl: "https://blueaivideo.com/agentlab?projectId=fixture-project&sessionId=fixture-session" });
database.close();
const image = path.join(temp, "synthetic-image.png"), video = path.join(temp, "synthetic-video.mp4");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gold:s=128x128", "-frames:v", "1", image]);
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=128x128:d=1", "-pix_fmt", "yuv420p", video]);
const manifestPath = path.join(temp, "run.json");
fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, projectId: project.id, prompt: "参考 @图1 的构图，动作参考 @视频1。", count: 2, replaceMaterials: true,
  settings: { modelName: "Seedance 2.5 全能参考", mode: "reference-to-video", autoPortraitAudit: true },
  materials: [{ kind: "file", path: image, role: "character", containsPerson: true, authorizeAsPortrait: true },
    { kind: "file", path: video, role: "motion", containsPerson: true, authorizeAsPortrait: true }] }));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const executablePath = process.env.XINYING_SMOKE_EXECUTABLE;
const environment = { ...process.env, CODEX_HOME: path.join(temp, "codex-home"), XINYING_DATA_DIR: temp, XINYING_CDP_PORT: String(port), XINYING_DISABLE_AUTO_UPDATE: "1" };
let app, mcp, stderr = "";
const pending = new Map();
let nextId = 1;
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timeout: ${stderr.slice(-1000)}`)); }, 45_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
async function tool(name, args = {}) {
  const response = await request("tools/call", { name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
try {
  app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${path.join(temp, "profile")}`, ...(executablePath ? [] : [root])], cwd: root, env: environment });
  await app.firstWindow();
  await app.context().route("https://**/*", route => route.abort());
  await app.evaluate(({ app }) => {
    const { PlaywrightXinyingAdapter } = process.mainModule.require(`${app.getAppPath()}/dist-electron/main/playwright-adapter.js`);
    globalThis.mcpFixture = { generations: [], reviews: [], syncs: 0 };
    const adapter = PlaywrightXinyingAdapter.prototype;
    adapter.sessionState = async () => ({ status: "logged-in", accountLabel: "隔离测试", checkedAt: new Date().toISOString() });
    adapter.listPlatformPortraits = async () => { globalThis.mcpFixture.syncs++; throw new Error("Unexpected portrait sync"); };
    adapter.submitPortraitReview = async (job, portrait) => {
      globalThis.mcpFixture.reviews.push({ jobId: job.id, name: portrait.name });
      assertVideo(portrait);
      return { status: "completed", message: "隔离审核通过", platformPortrait: {
        id: "fixture-video-portrait", displayName: portrait.displayName, previewUrl: "https://blueaivideo.com/fixture.png", platformAssetId: "fixture-video-portrait",
        workspaceId: "fixture-space", mediaKind: "video", sortOrder: 0, deleteSortOrder: 0, canDelete: true, available: true, lastSeenAt: new Date().toISOString(),
      } };
    };
    function assertVideo(portrait) { if (!portrait.filePath.endsWith(".mp4")) throw new Error("Image incorrectly sent for separate review"); }
    adapter.submitGeneration = async (job, reuse) => {
      if (!job.parameters.autoPortraitAudit) throw new Error("Missing official image audit");
      if (job.references.length !== 1 || !job.references[0].filePath.endsWith(".png")) throw new Error("Image reference not preserved");
      if (job.parameters.platformPortraits?.[0]?.mediaKind !== "video") throw new Error("Video not rebound to authorized portrait");
      globalThis.mcpFixture.generations.push({ id: job.id, reuse, materialOrder: job.parameters.materialOrder, referenceIds: job.references.map(item => item.id) });
      // Leave enough time to query status/jobs while a real queued job is submitting.
      await new Promise(resolve => setTimeout(resolve, 900));
      return { status: "running", message: "隔离心影已进入生成中", progressLabel: "已提交到心影，等待生成", platformTaskId: `chat:fixture-project:fixture-session:${globalThis.mcpFixture.generations.length - 1}` };
    };
    adapter.inspectGenerationJobs = async () => new Map();
    adapter.inspectRunningJob = async job => ({ status: "running", message: "隔离生成中", platformTaskId: job.platformTaskId });
  });
  const entry = executablePath
    ? path.join(path.dirname(executablePath), "resources", "app.asar", "dist-electron", "mcp", "server.mjs")
    : path.join(root, "dist-electron", "mcp", "server.mjs");
  mcp = spawn(executablePath || process.execPath, [entry], { cwd: root, windowsHide: true, env: { ...environment, ...(executablePath ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  mcp.stderr.on("data", chunk => { stderr += chunk; });
  mcp.on("exit", code => { for (const request of pending.values()) request.reject(new Error(`MCP exited ${code}: ${stderr.slice(-1000)}`)); pending.clear(); });
  createInterface({ input: mcp.stdout }).on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "xinying-isolated-verifier", version: "1.0.0" } });
  assert.equal(initialized.serverInfo.version, "0.2.0");
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await request("tools/list");
  assert.ok(list.tools.some(item => item.name === "generate"));
  const denied = await request("tools/call", { name: "generate", arguments: { manifestPath, requestId: "fixture-run", confirm: false } });
  assert.equal(denied.isError, true, "Explicit confirm must remain mandatory");
  assert.equal((await app.evaluate(() => globalThis.mcpFixture.generations)).length, 0);
  const args = { manifestPath, requestId: "fixture-run", confirm: true, timeoutMinutes: 1 };
  const first = tool("generate", args);
  // Attach immediately so a failed IPC assertion cannot become unhandled
  // while the verifier is observing the queue in a separate request.
  first.catch(() => undefined);
  // Observe submitting, not only running; queries must not hide the active upload.
  let observedSubmitting = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const rows = await tool("jobs");
    if (rows.jobs.some(job => job.kind === "generation" && job.status === "submitting")) { observedSubmitting = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(observedSubmitting, true);
  const current = await tool("status");
  assert.ok(current.activeJobs.some(job => job.kind === "generation" && ["submitting", "running"].includes(job.status)));
  const duplicate = tool("generate", args);
  const [result, same] = await Promise.all([first, duplicate]);
  assert.equal(result.successBoundary, "heart-generating");
  assert.deepEqual(result.batch.jobs.map(job => job.status), ["running", "running"]);
  assert.deepEqual(same.batch.jobs.map(job => job.id), result.batch.jobs.map(job => job.id));
  assert.equal(result.authorization.required, 1);
  assert.equal(result.materialRouting.officialImages, 1);
  assert.ok(!JSON.stringify(result).includes("参考 @图1 的构图"), "Do not echo full prompts in MCP output");
  const retry = await tool("generate", args);
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.batch.jobs.map(job => job.id), result.batch.jobs.map(job => job.id));
  const fixture = await app.evaluate(() => globalThis.mcpFixture);
  assert.equal(fixture.generations.length, 2);
  assert.equal(fixture.reviews.length, 1);
  assert.equal(fixture.syncs, 0);
  assert.equal(fixture.generations[0].reuse, undefined);
  assert.equal(fixture.generations[1].reuse, result.batch.jobs[0].platformTaskId);
  assert.equal(fixture.generations[0].materialOrder[0], `reference:${fixture.generations[0].referenceIds[0]}`);
  assert.equal(fixture.generations[0].materialOrder[1], "portrait:fixture-video-portrait");
  console.log(JSON.stringify({ ok: true, packagedExecutable: Boolean(executablePath), mcpVersion: initialized.serverInfo.version, officialImageAudit: true, videoBackgroundAuthorization: true,
    inFlightAndPersistedDeduplication: true, submittingVisible: true, batchCount: fixture.generations.length, separateVideoReviews: fixture.reviews.length, unnecessaryPortraitSyncs: fixture.syncs, realGenerations: 0 }, null, 2));
} finally {
  mcp?.stdin.end();
  mcp?.kill();
  for (const request of pending.values()) request.reject(new Error("Verifier closed"));
  pending.clear();
  if (app) await app.close().catch(() => undefined);
}
