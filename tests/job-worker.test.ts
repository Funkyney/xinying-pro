import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppPaths } from "../src/core/paths";
import { XinyingDatabase } from "../src/core/database";
import { XinyingService } from "../src/core/service";
import { JobWorker } from "../src/main/job-worker";
import type { PlaywrightXinyingAdapter } from "../src/main/playwright-adapter";

describe("JobWorker", () => {
  let tempDir: string;
  let database: XinyingDatabase;
  let service: XinyingService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-worker-test-"));
    const paths = createAppPaths(tempDir);
    database = new XinyingDatabase(paths.databasePath);
    service = new XinyingService(database, paths);
    const createProject = service.createProject.bind(service);
    service.createProject = (input) => createProject({
      platformWorkspaceId: "workspace-team",
      platformProjectId: "platform-project",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project&sessionId=test-session",
      ...input,
    });
  });

  afterEach(() => {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("submits, monitors, and captures a visible result into the local library", async () => {
    const project = service.createProject({ name: "队列闭环", prompt: "固定机位", mode: "text-to-video" });
    const queued = service.submitGeneration(project.id);
    const outputPath = path.join(tempDir, "captured.mp4");
    fs.writeFileSync(outputPath, "video");
    const adapter = {
      submitGeneration: vi.fn().mockResolvedValue({ status: "running", platformTaskId: "chat:p:s:0", message: "已提交" }),
      submitPortraitReview: vi.fn(),
      inspectRunningJob: vi.fn().mockResolvedValue({ status: "completed", platformTaskId: "chat:p:s:0", outputUrl: "https://media.example/result.mp4", message: "已完成" }),
      inspectPortraitReview: vi.fn(),
      downloadVisibleResult: vi.fn().mockResolvedValue(outputPath),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();
    expect(service.getJob(queued.id).status).toBe("running");
    expect(service.getJob(queued.id).platformTaskId).toBe("chat:p:s:0");

    await (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    const completed = service.getJob(queued.id);
    expect(completed.status).toBe("completed");
    expect(completed.outputPath).toBe(outputPath);
    expect(completed.outputUrl).toBeNull();
    expect(adapter.downloadVisibleResult).toHaveBeenCalledOnce();
    expect(service.listJobEvents(queued.id).at(-1)?.code).toBe("COMPLETED");
  });

  it("moves a visible human checkpoint into the recoverable task state", async () => {
    const project = service.createProject({ name: "人工检查", prompt: "固定机位", mode: "text-to-video" });
    const queued = service.submitGeneration(project.id);
    const adapter = {
      submitGeneration: vi.fn().mockResolvedValue({
        status: "needs-human",
        checkpoint: { reason: "payment", message: "请人工确认付费" },
      }),
      submitPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();
    const paused = service.getJob(queued.id);
    expect(paused.status).toBe("needs-human");
    expect(paused.requiresHumanReason).toBe("请人工确认付费");
    expect(service.listJobEvents(queued.id).at(-1)?.code).toBe("NEEDS_PAYMENT");
  });

  it("serializes overlapping monitor ticks for the shared heart page", async () => {
    const project = service.createProject({ name: "轮询串行化", prompt: "固定机位", mode: "text-to-video" });
    const job = service.submitGeneration(project.id);
    service.updateJob(job.id, { status: "running", platformTaskId: "chat:p:s:0" });
    let release!: (value: { status: "running"; platformTaskId: string; message: string }) => void;
    const pending = new Promise<{ status: "running"; platformTaskId: string; message: string }>((resolve) => { release = resolve; });
    const adapter = {
      inspectRunningJob: vi.fn().mockReturnValue(pending),
      inspectPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    const first = (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    await vi.waitFor(() => expect(adapter.inspectRunningJob).toHaveBeenCalledOnce());
    const overlapping = (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    await overlapping;
    expect(adapter.inspectRunningJob).toHaveBeenCalledOnce();
    release({ status: "running", platformTaskId: "chat:p:s:0", message: "仍在运行" });
    await first;
  });
});
