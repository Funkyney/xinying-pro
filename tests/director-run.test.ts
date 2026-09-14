import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDirectorManifest } from "../src/cli/director-run";
import { createAppPaths } from "../src/core/paths";
import { XinyingDatabase } from "../src/core/database";
import { XinyingService } from "../src/core/service";
import type { DirectorManifest } from "../src/shared/contracts";

describe("director run", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    temporaryDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  });

  it("returns once every take is confirmed as running without exposing prompt snapshots", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-director-run-test-"));
    temporaryDirectories.push(directory);
    const database = new XinyingDatabase(createAppPaths(directory).databasePath);
    const service = new XinyingService(database, createAppPaths(directory));
    const project = service.createProject({
      name: "极速提交",
      prompt: "占位",
      mode: "text-to-video",
      platformWorkspaceId: "workspace-team",
      platformProjectId: "platform-project",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project&sessionId=test-session",
    });
    const manifest: DirectorManifest = {
      version: 1,
      projectId: project.id,
      prompt: "一段很长但不应出现在命令回传中的提示词",
      count: 2,
      replaceMaterials: true,
      settings: { mode: "text-to-video" },
      materials: [],
    };
    const ensureAppReady = vi.fn(async () => ({ ready: true }));

    const result = await runDirectorManifest(service, manifest, {
      timeoutMs: 10_000,
      ensureAppReady,
      sleep: async () => {
        service.listJobs().filter((job) => job.kind === "generation").forEach((job, index) => {
          service.updateJob(job.id, {
            status: "running",
            platformTaskId: `chat:p:s:${index}`,
            progressLabel: "已在心影生成中",
          });
        });
      },
    });

    expect(ensureAppReady).toHaveBeenCalledOnce();
    expect(result.successBoundary).toBe("heart-generating");
    expect(result.batch.jobs.map((job) => job.status)).toEqual(["running", "running"]);
    expect(JSON.stringify(result)).not.toContain(manifest.prompt);
    database.close();
  });

  it("reuses an existing running batch when Codex repeats the same request id", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-director-run-idempotency-test-"));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const database = new XinyingDatabase(paths.databasePath);
    const service = new XinyingService(database, paths);
    const project = service.createProject({
      name: "请求去重",
      prompt: "占位",
      mode: "text-to-video",
      platformWorkspaceId: "workspace-team",
      platformProjectId: "platform-project",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project&sessionId=test-session",
    });
    const manifest: DirectorManifest = {
      version: 1,
      projectId: project.id,
      prompt: "固定机位",
      count: 1,
      replaceMaterials: true,
      settings: { mode: "text-to-video" },
      materials: [],
    };
    const options = {
      requestId: "codex-same-request",
      timeoutMs: 10_000,
      ensureAppReady: async () => ({ ready: true }),
      sleep: async () => {
        service.listJobsByKind("generation").forEach((job) => service.updateJob(job.id, {
          status: "running",
          platformTaskId: "chat:p:s:0",
        }));
      },
    };

    const first = await runDirectorManifest(service, manifest, options);
    const second = await runDirectorManifest(service, manifest, options);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.batch.jobs[0].id).toBe(first.batch.jobs[0].id);
    expect(service.listJobsByKind("generation")).toHaveLength(1);
    database.close();
  });

  it("resumes an interrupted authorization and continues through generation without user intervention", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-director-run-recovery-test-"));
    temporaryDirectories.push(directory);
    const paths = createAppPaths(directory);
    const database = new XinyingDatabase(paths.databasePath);
    const service = new XinyingService(database, paths);
    const personPath = path.join(directory, "person.png");
    fs.writeFileSync(personPath, "person");
    const project = service.createProject({
      name: "授权自动恢复",
      prompt: "@图1 向镜头挥手",
      mode: "reference-to-video",
      platformWorkspaceId: "workspace-team",
      platformProjectId: "platform-project",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project&sessionId=test-session",
    });
    const manifest: DirectorManifest = {
      version: 1,
      projectId: project.id,
      prompt: "@图1 向镜头挥手",
      count: 1,
      replaceMaterials: true,
      settings: { mode: "reference-to-video" },
      materials: [{ kind: "file", path: personPath, role: "character", containsPerson: true }],
    };
    const preparation = service.prepareDirectorRun(manifest);
    const interrupted = service.authorizeReference(preparation.authorizationReferenceIds[0], project.id, true);
    service.updateJob(interrupted.id, { status: "needs-human", requiresHumanReason: "心影未关闭虚拟人像提交表单" });

    const result = await runDirectorManifest(service, manifest, {
      timeoutMs: 10_000,
      ensureAppReady: async () => ({ ready: true }),
      sleep: async () => {
        const review = service.getJob(interrupted.id);
        if (review.status === "queued") {
          const portrait = service.getPortrait(review.portraitId!);
          service.approvePortraitFromPlatform(portrait.id, {
            id: "platform-person",
            displayName: portrait.displayName,
            previewUrl: "https://blueaivideo.com/platform-person.png",
            platformAssetId: "platform-person",
            workspaceId: "workspace-team",
            mediaKind: "image",
            sortOrder: 0,
            deleteSortOrder: 0,
            canDelete: true,
            available: true,
            lastSeenAt: new Date().toISOString(),
          }, "审核通过");
          service.updateJob(review.id, { status: "completed", completedAt: new Date().toISOString() });
        }
        service.listJobsByKind("generation").forEach((job) => service.updateJob(job.id, {
          status: "running",
          platformTaskId: "chat:platform-project:test-session:0",
        }));
      },
    });

    expect(result.successBoundary).toBe("heart-generating");
    expect(service.getJob(interrupted.id)).toMatchObject({ status: "completed", retryCount: 1 });
    expect(service.listJobEvents(interrupted.id).some((event) => event.code === "DIRECTOR_AUTO_RESUMED")).toBe(true);
    database.close();
  });
});
