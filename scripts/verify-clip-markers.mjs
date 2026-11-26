import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const { createAppPaths } = require("../dist-electron/core/paths.js");
const { XinyingDatabase } = require("../dist-electron/core/database.js");
const { XinyingService } = require("../dist-electron/core/service.js");
const directory = fs.mkdtempSync(path.resolve("test-results/clip-markers-"));
const paths = createAppPaths(directory);
const db = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(db, paths);
const project = service.createProject({ name: "剪辑标记验收", mode: "text-to-video", platformWorkspaceId: "fixture", platformProjectId: "fixture", platformUrl: "https://blueaivideo.com/agentlab?projectId=fixture&sessionId=test" });
const sources = ["mp4", "mov"].map(ext => path.join(directory, "source." + ext));
const exportsDir = path.join(directory, "中文导出");
fs.mkdirSync(exportsDir);
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "4", "-c:v", "libx264", "-c:a", "aac", sources[0]]);
execFileSync("ffmpeg", ["-v", "error", "-i", sources[0], "-map", "0", "-c", "copy", sources[1]]);
const records = sources.map((outputPath, i) => ({
  id: "clip" + i, projectId: project.id, platformProjectId: "fixture", platformTaskId: "chat:fixture:test:" + i,
  conversationId: "test", platformMaterialId: "material" + i, source: "personal", mediaKind: "video", jobId: null,
  name: path.basename(outputPath), prompt: "marker_" + i, available: true, marked: false, outputPath, outputUrl: null,
  previewUrl: null, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
}));
service.syncPlatformResults(project.id, records);
service.setClipMarker("clip1", 2080, true);
service.syncPlatformResults(project.id, records);
db.close();
const server = net.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const dev = !process.argv.includes("--packaged") && !process.env.XINYING_SMOKE_EXECUTABLE;
const app = await electron.launch({
  executablePath: path.resolve(process.env.XINYING_SMOKE_EXECUTABLE ?? (dev ? "node_modules/electron/dist/electron.exe" : "release/win-unpacked/心影Pro.exe")), args: ["--user-data-dir=" + path.join(directory, "browser"), ...(dev ? ["."] : [])],
  env: { ...process.env, XINYING_DISABLE_AUTO_UPDATE: "1", XINYING_DATA_DIR: directory, CODEX_HOME: path.join(directory, "codex"), XINYING_CDP_PORT: String(port) },
});
try {
  const page = app.windows().find(win => win.url().startsWith("file:")) ?? await app.waitForEvent("window", win => win.url().startsWith("file:"));
  await page.getByRole("button", { name: "结果库", exact: true }).click();
  const card = page.locator('[data-drag-select-id="clip0"]');
  const readMarkers = async () => page.evaluate(async () => (await window.xinying.results.list()).find(r => r.id === "clip0").clipMarkersMs);
  async function seek(video, time) {
    await video.evaluate(async (el, t) => {
      await el.play();
      el.pause();
      await new Promise(resolve => { el.addEventListener("seeked", resolve, { once: true }); el.currentTime = t; });
      if (Math.abs(el.currentTime - t) > .001) throw Error("seek expected " + t + " got " + el.currentTime + " seekable: " + (el.seekable.length && el.seekable.end(0)));
    }, time);
  }
  await card.hover();
  await seek(card.locator("video"), 1);
  await page.keyboard.press("2");
  assert.deepEqual(await readMarkers(), [1000]);
  await card.locator(".result-preview").click();
  const viewer = page.getByRole("dialog", { name: "结果详情" });
  await seek(viewer.locator(".result-viewer-stage video"), 2.08);
  await page.keyboard.press("2");
  await viewer.getByRole("button", { name: "删除打点 00:00:02.080" }).waitFor();
  await page.keyboard.press("2");
  assert.deepEqual(await readMarkers(), [1000, 2080]);
  await viewer.getByRole("button", { name: "删除打点 00:00:01.000" }).click();
  await viewer.getByRole("button", { name: "删除打点 00:00:01.000" }).waitFor({ state: "detached" });
  await seek(viewer.locator(".result-viewer-stage video"), 1);
  await page.keyboard.press("2");
  await viewer.getByRole("button", { name: "删除打点 00:00:01.000" }).waitFor();
  await page.screenshot({ path: path.join(directory, "pr-markers.png") });
  await app.evaluate(({ dialog }, dest) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest + "/单个.mp4" });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dest] });
  }, exportsDir);
  await page.evaluate(() => window.xinying.results.download("clip0"));
  await page.evaluate(() => window.xinying.results.batchDownload(["clip0", "clip1"]));
  const files = fs.readdirSync(exportsDir);
  assert.equal(files.length, 3);
  const packetHashes = file => execFileSync("ffprobe", ["-v", "error", "-show_packets", "-show_entries", "packet=stream_index,pts,duration,data_hash", "-show_data_hash", "sha256", "-of", "csv=p=0", file], { encoding: "utf8" });
  for (const filename of files) {
    const mov = filename.endsWith(".mov");
    const video = path.join(exportsDir, filename);
    const metadata = JSON.parse(execFileSync(require(process.platform === "win32" ? "exiftool-vendored.exe" : "exiftool-vendored.pl"), ["-j", "-struct", "-XMP-xmpDM:Tracks", "-charset", "filename=UTF8", "-@", "-"], { input: video + "\n", encoding: "utf8" }))[0];
    assert.deepEqual(metadata.Tracks.flatMap(t => t.Markers.map(m => Number(m.StartTime))), mov ? [2080] : [1000, 2080]);
    assert.ok(metadata.Tracks.every(t => t.TrackType === "Comment" && t.FrameRate === "f1000"));
    assert.equal(packetHashes(video), packetHashes(sources[mov ? 1 : 0]));
  }
  console.log(JSON.stringify({ ok: true, files, directory: exportsDir, tests: "hover + viewer, deduplication, deletion, resync, single/batch, MP4/MOV marker readback and identical audio/video packets" }));
} finally { await app.close(); }
