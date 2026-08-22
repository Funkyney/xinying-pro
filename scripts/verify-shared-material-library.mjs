import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const { createAppPaths } = require("../dist-electron/core/paths.js");
const { XinyingDatabase } = require("../dist-electron/core/database.js");
const { XinyingService } = require("../dist-electron/core/service.js");
const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-shared-library-"));
const fixtureDir = path.join(dataDir, "fixtures");
const outputDir = path.join(root, "test-results");
const screenshotPath = path.join(outputDir, "shared-material-library.png");
const reportPath = path.join(outputDir, "shared-material-library.json");
fs.mkdirSync(fixtureDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const reserveFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const imagePath = path.join(fixtureDir, "共享产品图.png");
const videoPath = path.join(fixtureDir, "共享动作视频.mp4");
const audioPath = path.join(fixtureDir, "共享配乐.mp3");
fs.copyFileSync(path.join(root, "build", "icon.png"), imagePath);
fs.writeFileSync(videoPath, "synthetic-video-fixture", "utf8");
fs.writeFileSync(audioPath, "synthetic-audio-fixture", "utf8");

const paths = createAppPaths(dataDir);
const database = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(database, paths);
const project = service.createProject({
  name: "共享素材库桌面验收",
  prompt: "固定机位",
  platformWorkspaceId: "workspace-team",
  platformProjectId: "project-shared-library",
  platformUrl: "https://blueaivideo.com/avpAgent?projectId=project-shared-library&sessionId=shared-library",
});
const library = service.addSharedMedia([imagePath, videoPath, audioPath]);
service.addSharedMediaToProject(project.id, library.find((asset) => asset.mediaKind === "image").id);
service.syncPlatformPortraits([
  { id: "portrait-a", displayName: "共享虚拟人像 A", previewUrl: "https://blueaivideo.com/favicon.ico", platformAssetId: "portrait-a", workspaceId: "workspace-team", mediaKind: "image", sortOrder: 0, deleteSortOrder: null, canDelete: false, available: true, lastSeenAt: new Date().toISOString() },
  { id: "portrait-b", displayName: "共享虚拟人像 B", previewUrl: "https://blueaivideo.com/favicon.ico", platformAssetId: "portrait-b", workspaceId: "workspace-team", mediaKind: "video", sortOrder: 1, deleteSortOrder: null, canDelete: false, available: true, lastSeenAt: new Date().toISOString() },
], "workspace-team");
database.close();

const cdpPort = await reserveFreePort();
let electronApp;
try {
  electronApp = await electron.launch({
    args: [`--user-data-dir=${path.join(dataDir, "electron-user-data")}`, root],
    cwd: root,
    env: { ...process.env, XINYING_DATA_DIR: dataDir, XINYING_CDP_PORT: String(cdpPort), XINYING_DISABLE_AUTO_UPDATE: "1" },
    timeout: 30_000,
  });
  const page = await electronApp.firstWindow();
  await page.getByRole("button", { name: "生成工作台", exact: true }).click();
  const libraryPanel = page.locator(".shared-material-library");
  await libraryPanel.waitFor({ state: "visible", timeout: 15_000 });

  const tabText = await libraryPanel.locator(".shared-library-tabs").innerText();
  for (const expected of ["全部", "5", "虚拟人像", "2", "图片", "1", "视频", "1", "音频", "1"]) {
    if (!tabText.includes(expected)) throw new Error(`分类计数缺少：${expected}`);
  }
  const selectedImage = libraryPanel.locator(".shared-library-card.selected").filter({ hasText: "共享产品图.png" });
  await selectedImage.waitFor({ state: "visible" });
  if (!(await selectedImage.innerText()).includes("@图1")) throw new Error("共享图片没有显示当前项目编号 @图1");

  const videoCard = libraryPanel.locator(".shared-library-card").filter({ hasText: "共享动作视频.mp4" });
  await videoCard.click();
  await page.locator(".reference-card").filter({ hasText: "共享动作视频.mp4" }).waitFor({ state: "visible" });
  if (!(await videoCard.innerText()).includes("@视频1")) throw new Error("点击共享视频后没有显示 @视频1");
  await videoCard.click();
  await page.locator(".reference-card").filter({ hasText: "共享动作视频.mp4" }).waitFor({ state: "detached" });

  await libraryPanel.locator(".shared-library-tabs > button").filter({ hasText: "音频" }).click();
  const visibleCards = libraryPanel.locator(".shared-library-card");
  if (await visibleCards.count() !== 1 || !(await visibleCards.first().innerText()).includes("共享配乐.mp3")) throw new Error("音频分类没有只显示音频素材");
  if (await visibleCards.first().locator("audio").count() !== 1) throw new Error("音频素材卡缺少播放器");
  await libraryPanel.locator(".shared-library-tabs > button").filter({ hasText: "全部" }).click();

  await libraryPanel.screenshot({ path: screenshotPath });
  const report = {
    ok: true,
    generated: false,
    counts: { all: 5, portraits: 2, images: 1, videos: 1, audio: 1 },
    selectedImageLabel: "@图1",
    toggledVideoLabel: "@视频1",
    screenshotPath,
    verifiedAt: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
