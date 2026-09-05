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
});
