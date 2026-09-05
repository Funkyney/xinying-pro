import { describe, expect, it } from "vitest";
import { compactJob, compactProject } from "../src/cli/compact";
import type { Job, Project } from "../src/shared/contracts";

describe("compact CLI output", () => {
  it("omits token-heavy prompt, parameters, references, and material order", () => {
    const project = {
      id: "project",
      name: "项目",
      description: "说明",
      prompt: "x".repeat(10_000),
      modelName: "Seedance 2.5 全能参考",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=p&sessionId=s",
      platformWorkspaceId: "w",
      platformProjectId: "p",
      mode: "reference-to-video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      audioEnabled: true,
      videoFormat: "mp4",
      networkEnabled: true,
      portraitIds: ["portrait"],
      materialOrder: ["portrait:portrait"],
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies Project;
    const job = {
      id: "job",
      kind: "generation",
      projectId: project.id,
      portraitId: null,
      status: "running",
      platformTaskId: "chat:p:s:0",
      platformExecutionId: "1",
      progress: 0,
      progressLabel: "生成中",
      lastCheckedAt: null,
      promptSnapshot: project.prompt,
      parameters: { huge: "x".repeat(10_000) },
      references: [{ huge: "x".repeat(10_000) }],
      outputPath: null,
      outputUrl: null,
      errorCode: null,
      errorMessage: null,
      requiresHumanReason: null,
      retryCount: 0,
      createdAt: project.createdAt,
      submittedAt: project.createdAt,
      completedAt: null,
      updatedAt: project.updatedAt,
    } as unknown as Job;

    const serialized = JSON.stringify({ project: compactProject(project), job: compactJob(job) });
    expect(serialized.length).toBeLessThan(1_500);
    expect(serialized).not.toContain(project.prompt);
    expect(serialized).not.toContain("materialOrder");
    expect(serialized).not.toContain("references");
  });
});
