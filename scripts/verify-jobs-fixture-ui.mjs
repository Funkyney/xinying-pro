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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-jobs-review-"));
const paths = createAppPaths(dataDir);
const database = new XinyingDatabase(paths.databasePath);
const service = new XinyingService(database, paths);
const project = service.createProject({
  name: "任务中心验收项目",
  prompt: "固定机位",
  mode: "text-to-video",
  platformWorkspaceId: "review-workspace",
  platformProjectId: "review-project",
  platformUrl: "https://blueaivideo.com/avpAgent?projectId=review-project&sessionId=review-session",
});
const running = service.submitGeneration(project.id);
service.updateJob(running.id, { status: "running", platformTaskId: "chat:review-project:review-session:0", platformExecutionId: "1687009", progress: 43, progressLabel: "Seedance 2.5 正在生成", lastCheckedAt: new Date().toISOString() });
const completed = service.submitGeneration(project.id);
service.updateJob(completed.id, { status: "completed", platformTaskId: "chat:review-project:review-session:1", platformExecutionId: "1687010", progress: 100, progressLabel: "心影生成完成", completedAt: new Date().toISOString() });
const failed = service.submitGeneration(project.id);
service.updateJob(failed.id, { status: "failed", platformTaskId: "chat:review-project:review-session:2", platformExecutionId: "1687011", progress: 61, progressLabel: "心影生成失败", errorCode: "PLATFORM_TASK_FAILED", errorMessage: "测试失败", completedAt: new Date().toISOString() });
const cancelled = service.submitGeneration(project.id);
service.cancelJob(cancelled.id);
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
  await window.getByRole("button", { name: "任务队列", exact: true }).click();
  await window.getByRole("heading", { name: "任务队列", exact: true }).waitFor({ state: "visible" });
  const runningRow = window.locator("tbody tr").filter({ hasText: running.id.slice(0, 8) });
  await runningRow.waitFor({ state: "visible" });
  if (!(await runningRow.innerText()).includes("43%") || !(await runningRow.innerText()).includes("#1687009")) throw new Error("任务中心没有显示心影真实进度或任务号");
  if ((await window.getByRole("button", { name: "同步状态", exact: true }).count()) !== 1) throw new Error("任务中心缺少手动同步状态入口");
  await window.getByRole("button", { name: "管理记录", exact: true }).click();
  const clearButton = window.getByRole("button", { name: /清空全部已结束/ });
  if ((await clearButton.count()) !== 1) throw new Error("任务中心缺少清空全部已结束记录入口");
  window.once("dialog", (dialog) => dialog.accept());
  await clearButton.click();
  await window.waitForFunction(() => window.xinying.jobs.list().then((jobs) => jobs.length === 1));
  const remaining = await window.evaluate(() => window.xinying.jobs.list());
  if (remaining.length !== 1 || remaining[0].status !== "running") throw new Error("批量清理删除了活动任务或没有清空全部结束记录");
  const screenshot = path.join(appDir, "test-results", "jobs-management-ui.png");
  await window.screenshot({ path: screenshot, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, remainingStatus: remaining[0].status, progress: remaining[0].progress, screenshot }, null, 2)}\n`);
} finally {
  await electronApp?.close().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
