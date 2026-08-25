import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlaywrightXinyingAdapter } from "../dist-electron/main/playwright-adapter.js";
import { createAppPaths } from "../dist-electron/core/paths.js";

const marker = path.join(process.env.APPDATA, "xinying-director", "automation-port");
const port = Number(fs.readFileSync(marker, "utf8").trim());
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-task-api-"));
const selectors = JSON.parse(fs.readFileSync(path.resolve("config", "xinying-selectors.json"), "utf8"));
const adapter = new PlaywrightXinyingAdapter(port, selectors, createAppPaths(dataDir));
const now = new Date().toISOString();
const fakeJob = {
  id: "status-api-probe",
  kind: "generation",
  projectId: null,
  portraitId: null,
  status: "running",
  platformTaskId: "chat:probe-project:probe-session:0",
  platformExecutionId: "999999999",
  progress: 0,
  progressLabel: "",
  lastCheckedAt: null,
  promptSnapshot: "",
  parameters: {},
  references: [],
  outputPath: null,
  outputUrl: null,
  errorCode: null,
  errorMessage: null,
  requiresHumanReason: null,
  retryCount: 0,
  createdAt: now,
  submittedAt: now,
  completedAt: null,
  updatedAt: now,
};

try {
  const outcomes = await adapter.inspectGenerationJobs([fakeJob]);
  process.stdout.write(`${JSON.stringify({ ok: true, matched: outcomes.size, note: "心影任务管理 PROCESS / FAIL / SUCCESS 查询已完成" }, null, 2)}\n`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
