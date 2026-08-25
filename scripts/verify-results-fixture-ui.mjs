import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createAppPaths } from "../dist-electron/core/paths.js";
import { XinyingDatabase } from "../dist-electron/core/database.js";
import { XinyingService } from "../dist-electron/core/service.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-results-review-"));
const paths = createAppPaths(dataDir);
const imagePath = path.join(dataDir, "review-reference.png");
const videoPath = path.join(dataDir, "review-result.mp4");
const portraitImagePath = path.join(dataDir, "review-portrait.png");
const portraitVideoPath = path.join(dataDir, "review-portrait.mp4");
fs.copyFileSync(path.join(appDir, "build", "icon.png"), imagePath);
execFileSync("ffmpeg", [
  "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x5f4b8b:s=960x540:d=2",
  "-vf", "drawtext=text='Xinying Pro Review':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", videoPath,
]);
execFileSync("ffmpeg", [
  "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x33275d:s=540x960:d=2",
  "-vf", "drawtext=text='9x16 Portrait':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", portraitVideoPath,
]);
execFileSync("ffmpeg", [
  "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x224c61:s=540x960",
  "-frames:v", "1", "-threads", "1", "-y", portraitImagePath,
]);

const database = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(database, paths);
const project = service.createProject({
  name: "结果库专业审片验收",
  prompt: "@图1 作为角色参考，固定机位，人物缓慢转身。",
  modelName: "Seedance 2.5 全能参考",
  mode: "reference-to-video",
  aspectRatio: "16:9",
  duration: 5,
  resolution: "720p",
  audioEnabled: true,
  platformWorkspaceId: "review-workspace",
  platformProjectId: "review-project",
  platformUrl: "https://blueaivideo.com/avpAgent?projectId=review-project&sessionId=review-session",
});
service.addReferences(project.id, [imagePath]);
const createdAt = new Date().toISOString();
const personalResults = [];
for (let index = 0; index < 4; index += 1) {
  const job = service.submitGeneration(project.id);
  const platformTaskId = `chat:review-project:review-session:${index}`;
  service.updateJob(job.id, { status: "running", platformTaskId });
  personalResults.push({
    id: `review-personal-${index}`,
    projectId: project.id,
    platformProjectId: project.platformProjectId,
    platformTaskId,
    jobId: null,
    source: "personal",
    mediaKind: "video",
    name: `专业审片-${index + 1}.mp4`,
    prompt: index === 0 ? "@图1 作为角色参考，固定机位，人物缓慢转身。" : `第 ${index + 1} 条测试提示词`,
    outputUrl: null,
    previewUrl: null,
    outputPath: index === 0 ? portraitVideoPath : videoPath,
    marked: false,
    available: true,
    createdAt: new Date(Date.parse(createdAt) - index * 1_000).toISOString(),
    lastSeenAt: createdAt,
  });
}
service.syncPlatformResults(project.id, personalResults, "personal");
service.syncPlatformResults(project.id, [
  { ...personalResults[0], id: "review-project-video", platformTaskId: "project-video", jobId: null, source: "project", name: "团队视频.mp4" },
  { ...personalResults[0], id: "review-project-image", platformTaskId: "project-image", jobId: null, source: "project", mediaKind: "image", name: "团队竖屏图片.png", outputPath: portraitImagePath },
], "project");
const seededCounts = service.listResults(project.id).reduce((counts, result) => ({ ...counts, [result.source]: (counts[result.source] ?? 0) + 1 }), {});
const portraitResultId = service.listResults(project.id).find((result) => result.source === "personal" && result.outputPath === portraitVideoPath)?.id;
if (!portraitResultId) throw new Error("没有写入竖屏验收视频");
database.close();

const cdpPort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

let electronApp;
try {
  electronApp = await electron.launch({
    args: [`--user-data-dir=${path.join(dataDir, "electron-user-data")}`, appDir],
    cwd: appDir,
    env: { ...process.env, XINYING_DATA_DIR: dataDir, XINYING_CDP_PORT: String(cdpPort), XINYING_DISABLE_AUTO_UPDATE: "1" },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForSelector("text=心影Pro", { timeout: 20_000 });
  const rendererCounts = await window.evaluate((id) => window.xinying.results.list(id).then((items) => items.reduce((counts, result) => ({ ...counts, [result.source]: (counts[result.source] ?? 0) + 1 }), {})), project.id);
  process.stdout.write(`${JSON.stringify({ seededCounts, rendererCounts })}\n`);
  const child = spawn(process.execPath, [path.join(scriptDir, "verify-results-ui.mjs")], {
    cwd: appDir,
    env: { ...process.env, XINYING_CDP_PORT: String(cdpPort), XINYING_RESULTS_PROJECT_ID: project.id, XINYING_RESULTS_PORTRAIT_ID: portraitResultId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0 || childOutput.includes('"ok": false')) throw new Error(`结果库窗口验收失败（exit=${code ?? "signal"}）`);
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
