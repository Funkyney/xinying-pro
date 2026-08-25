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

  it("keeps a submitted video job synchronized until Heart confirms completion", async () => {
    const project = service.createProject({ name: "队列闭环", prompt: "固定机位", mode: "text-to-video" });
    const queued = service.submitGeneration(project.id);
    const adapter = {
      submitGeneration: vi.fn().mockResolvedValue({ status: "running", platformTaskId: "chat:p:s:0", platformExecutionId: "1001", progress: 0, message: "已提交" }),
      submitPortraitReview: vi.fn(),
      inspectGenerationJobs: vi.fn().mockResolvedValue(new Map([["1001", { status: "completed", platformExecutionId: "1001", progress: 100, message: "已完成" }]])),
      inspectRunningJob: vi.fn().mockResolvedValue({ status: "completed", platformTaskId: "chat:p:s:0", outputUrl: "https://media.example/result.mp4", message: "已完成" }),
      inspectPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();
    expect(service.getJob(queued.id).status).toBe("running");
    expect(service.getJob(queued.id).platformTaskId).toBe("chat:p:s:0");

    await (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    expect(service.getJob(queued.id)).toMatchObject({ status: "completed", platformExecutionId: "1001", progress: 100 });
    expect(adapter.inspectGenerationJobs).toHaveBeenCalledOnce();
    expect(adapter.inspectRunningJob).not.toHaveBeenCalled();
  });

  it("locks a newly-created Heart conversation onto the local project after submission", async () => {
    const project = service.createProject({
      name: "自动锁定对话",
      prompt: "固定机位",
      mode: "text-to-video",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project",
    });
    const queued = service.submitGeneration(project.id);
    const adapter = {
      submitGeneration: vi.fn().mockResolvedValue({
        status: "running",
        platformTaskId: "chat:platform-project:new-session:0",
        generationUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project&sessionId=new-session",
        message: "已提交",
      }),
      submitPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();

    expect(service.getProject(project.id).platformUrl).toContain("sessionId=new-session");
    expect(service.listJobEvents(queued.id).some((event) => event.code === "CONVERSATION_BOUND")).toBe(true);
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

  it("submits the first take normally and chains later takes through Heart reuse editing", async () => {
    const project = service.createProject({ name: "连续三条", prompt: "固定机位，角色转身", mode: "text-to-video" });
    const batch = service.submitGenerationBatch(project.id, 3);
    const adapter = {
      submitGeneration: vi.fn().mockImplementation(async (job: { parameters: Record<string, unknown> }, reuseFrom?: string) => ({
        status: "running",
        platformTaskId: `chat:p:s:${Number(job.parameters.takeNumber) - 1}`,
        message: reuseFrom ? "已复用上一条提交" : "已完整提交",
      })),
      submitPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();
    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();
    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();

    expect(adapter.submitGeneration).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: batch.jobs[0].id }), undefined);
    expect(adapter.submitGeneration).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: batch.jobs[1].id }), "chat:p:s:0");
    expect(adapter.submitGeneration).toHaveBeenNthCalledWith(3, expect.objectContaining({ id: batch.jobs[2].id }), "chat:p:s:1");
    expect(batch.jobs.map((job) => service.getJob(job.id).status)).toEqual(["running", "running", "running"]);
    expect(service.listJobEvents(batch.jobs[1].id).some((event) => event.code === "REUSING_PREVIOUS_TAKE")).toBe(true);
  });

  it("starts a result-library reuse batch from the selected Heart task", async () => {
    const project = service.createProject({ name: "结果复用队列", prompt: "原提示词", mode: "text-to-video" });
    const sourceJob = service.submitGeneration(project.id);
    service.updateJob(sourceJob.id, { status: "running", platformTaskId: "chat:platform-project:test-session:5" });
    const [result] = service.syncPlatformResults(project.id, [{
      id: "remote-result",
      projectId: project.id,
      platformProjectId: project.platformProjectId,
      platformTaskId: "chat:platform-project:test-session:5",
      jobId: null,
      source: "personal",
      mediaKind: "video",
      name: "result.mp4",
      prompt: "原提示词",
      outputUrl: "https://media.example/result.mp4",
      previewUrl: null,
      outputPath: null,
      marked: false,
      available: true,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }]);
    const batch = service.submitResultReuse(result.id, {
      prompt: "新提示词",
      modelName: "Seedance 2.5 全能参考",
      mode: "text-to-video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      audioEnabled: true,
      count: 2,
    });
    const adapter = {
      submitGeneration: vi.fn().mockImplementation(async (job: { parameters: Record<string, unknown> }, reuseFrom?: string) => ({
        status: "running",
        platformTaskId: `chat:platform-project:test-session:${Number(job.parameters.takeNumber) + 5}`,
        message: "已复用提交",
      })),
      submitPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();
    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();

    expect(adapter.submitGeneration).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: batch.jobs[0].id }), "chat:platform-project:test-session:5");
    expect(adapter.submitGeneration).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: batch.jobs[1].id }), "chat:platform-project:test-session:6");
  });

  it("stops a later take when the previous take was not confirmed as submitted", async () => {
    const project = service.createProject({ name: "复用前置失败", prompt: "固定机位", mode: "text-to-video" });
    const batch = service.submitGenerationBatch(project.id, 2);
    const adapter = {
      submitGeneration: vi.fn().mockResolvedValue({
        status: "needs-human",
        checkpoint: { reason: "page-changed", message: "第一条未提交" },
      }),
      submitPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();
    await (worker as unknown as { processQueue(): Promise<void> }).processQueue();

    expect(adapter.submitGeneration).toHaveBeenCalledOnce();
    expect(service.getJob(batch.jobs[1].id).status).toBe("needs-human");
    expect(service.getJob(batch.jobs[1].id).requiresHumanReason).toContain("无法安全复用");
    expect(service.listJobEvents(batch.jobs[1].id).at(-1)?.code).toBe("REUSE_SOURCE_UNAVAILABLE");
  });

  it("serializes overlapping portrait-review monitor ticks for the shared heart page", async () => {
    const project = service.createProject({ name: "轮询串行化", prompt: "固定机位", mode: "text-to-video" });
    const portraitPath = path.join(tempDir, "portrait.png");
    fs.writeFileSync(portraitPath, "image");
    const portrait = service.addPortraits([portraitPath], true)[0];
    const job = service.submitPortraitReview(portrait.id, project.id);
    service.updateJob(job.id, { status: "running", platformTaskId: `portrait:${job.id}` });
    let release!: (value: { status: "running"; platformTaskId: string; message: string }) => void;
    const pending = new Promise<{ status: "running"; platformTaskId: string; message: string }>((resolve) => { release = resolve; });
    const adapter = {
      inspectRunningJob: vi.fn(),
      inspectPortraitReview: vi.fn().mockReturnValue(pending),
    } as unknown as PlaywrightXinyingAdapter;
    const worker = new JobWorker(service, adapter);

    const first = (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    await vi.waitFor(() => expect(adapter.inspectPortraitReview).toHaveBeenCalledOnce());
    const overlapping = (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    await overlapping;
    expect(adapter.inspectPortraitReview).toHaveBeenCalledOnce();
    release({ status: "running", platformTaskId: `portrait:${job.id}`, message: "仍在审核" });
    await first;
  });

  it("reconciles all due portraits in one silent background operation", async () => {
    const project = service.createProject({ name: "后台审核轮询", prompt: "固定机位", mode: "text-to-video" });
    const portraitPaths = [path.join(tempDir, "portrait-a.png"), path.join(tempDir, "portrait-b.png")];
    portraitPaths.forEach((portraitPath) => fs.writeFileSync(portraitPath, "image"));
    const portraits = service.addPortraits(portraitPaths, true);
    const jobs = portraits.map((portrait) => service.submitPortraitReview(portrait.id, project.id));
    jobs.forEach((job) => service.updateJob(job.id, { status: "running", platformTaskId: `portrait:${job.id}` }));
    const adapter = {
      inspectRunningJob: vi.fn(),
      inspectPortraitReview: vi.fn().mockImplementation(async (job: { id: string }) => ({
        status: "running",
        platformTaskId: `portrait:${job.id}`,
        message: "仍在审核",
      })),
    } as unknown as PlaywrightXinyingAdapter;
    const foreground = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const background = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const worker = new JobWorker(service, adapter, foreground, background);

    await (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    expect(background).toHaveBeenCalledOnce();
    expect(foreground).not.toHaveBeenCalled();
    expect(adapter.inspectPortraitReview).toHaveBeenCalledTimes(2);
    expect(adapter.inspectPortraitReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobs[0].id }),
      expect.objectContaining({ id: portraits[0].id }),
      { timeoutMs: 5_000 },
    );
    expect(adapter.inspectPortraitReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobs[1].id }),
      expect.objectContaining({ id: portraits[1].id }),
      { timeoutMs: 5_000 },
    );

    await (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    expect(adapter.inspectPortraitReview).toHaveBeenCalledTimes(2);
  });

  it("defers portrait polling when foreground platform work is active", async () => {
    const project = service.createProject({ name: "审核让路", prompt: "固定机位", mode: "text-to-video" });
    const portraitPath = path.join(tempDir, "portrait.png");
    fs.writeFileSync(portraitPath, "image");
    const portrait = service.addPortraits([portraitPath], true)[0];
    const job = service.submitPortraitReview(portrait.id, project.id);
    service.updateJob(job.id, { status: "running", platformTaskId: `portrait:${job.id}` });
    const adapter = {
      inspectRunningJob: vi.fn(),
      inspectPortraitReview: vi.fn(),
    } as unknown as PlaywrightXinyingAdapter;
    const background = vi.fn(async () => undefined);
    const worker = new JobWorker(service, adapter, undefined, background);

    await (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();
    await (worker as unknown as { monitorRunning(): Promise<void> }).monitorRunning();

    expect(background).toHaveBeenCalledOnce();
    expect(adapter.inspectPortraitReview).not.toHaveBeenCalled();
    expect(service.getJob(job.id).status).toBe("running");
  });
});
