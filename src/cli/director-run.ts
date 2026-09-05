import type { DirectorManifest, DirectorRunPreparation, Job, JobStatus } from "../shared/contracts";
import type { XinyingService } from "../core/service";
import { AppError } from "../core/errors";
import { compactJob } from "./compact";

const BLOCKING_STATUSES = new Set<JobStatus>(["failed", "needs-login", "needs-human", "cancelled"]);

export interface DirectorRunOptions {
  count?: number;
  timeoutMs: number;
  ensureAppReady: () => Promise<unknown>;
  syncPortraits?: (projectId: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
}

async function waitForJobs(
  service: XinyingService,
  ids: string[],
  succeeded: ReadonlySet<JobStatus>,
  deadline: number,
  stage: "authorization" | "generation",
  sleep: (milliseconds: number) => Promise<void>,
): Promise<Job[]> {
  while (true) {
    const jobs = ids.map((id) => service.getJob(id));
    const blocked = jobs.filter((job) => BLOCKING_STATUSES.has(job.status));
    if (blocked.length) {
      throw new AppError(
        stage === "authorization" ? "DIRECTOR_AUTHORIZATION_BLOCKED" : "DIRECTOR_SUBMISSION_BLOCKED",
        stage === "authorization" ? "至少一项人物素材授权需要处理" : "至少一条生成任务未能确认提交",
        blocked.map(compactJob),
      );
    }
    if (jobs.every((job) => succeeded.has(job.status))) return jobs;
    if (Date.now() >= deadline) {
      throw new AppError(
        "DIRECTOR_RUN_TIMEOUT",
        stage === "authorization" ? "等待人物素材授权超时" : "等待心影确认生成提交超时",
        { stage, jobs: jobs.map(compactJob) },
      );
    }
    await sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
  }
}

function unresolvedMaterials(preparation: DirectorRunPreparation) {
  return preparation.materials.filter((material) =>
    material.referenceId && material.authorizationState !== "not-needed");
}

export async function runDirectorManifest(
  service: XinyingService,
  manifest: DirectorManifest,
  options: DirectorRunOptions,
) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const readiness = await options.ensureAppReady();
  if (readiness && typeof readiness === "object" && "ready" in readiness && readiness.ready !== true) {
    throw new AppError("APP_NOT_READY", "心影Pro APP 已连接，但本地控制接口尚未就绪");
  }
  let preparation = service.prepareDirectorRun(manifest);
  const authorizationJobs = preparation.authorizationReferenceIds.map((referenceId) =>
    service.authorizeReference(referenceId, manifest.projectId, true));
  const reusedAuthorizationCount = authorizationJobs.filter((job) => job.status === "completed").length;

  if (authorizationJobs.length) {
    await waitForJobs(
      service,
      authorizationJobs.map((job) => job.id),
      new Set<JobStatus>(["completed"]),
      deadline,
      "authorization",
      sleep,
    );
    preparation = service.prepareDirectorRun(manifest);
  }

  if (unresolvedMaterials(preparation).length && options.syncPortraits) {
    await options.syncPortraits(manifest.projectId);
    preparation = service.prepareDirectorRun(manifest);
  }

  const unresolved = unresolvedMaterials(preparation);
  if (unresolved.length || !preparation.preview.ready) {
    throw new AppError(
      "DIRECTOR_NOT_READY",
      unresolved.length ? "人物素材尚未全部替换为心影已授权虚拟人像" : "导演任务尚未达到提交条件",
      {
        unresolved: unresolved.map((material) => ({
          index: material.index,
          sourceName: material.sourcePath,
          authorizationState: material.authorizationState,
          authorizationJobId: material.authorizationJobId,
        })),
        warnings: preparation.preview.warnings,
      },
    );
  }

  const count = options.count ?? manifest.count;
  const batch = service.submitGenerationBatch(manifest.projectId, count);
  const generationJobs = await waitForJobs(
    service,
    batch.jobs.map((job) => job.id),
    new Set<JobStatus>(["running", "completed"]),
    deadline,
    "generation",
    sleep,
  );

  return {
    success: true,
    successBoundary: "heart-generating",
    elapsedMs: Date.now() - startedAt,
    authorization: {
      required: authorizationJobs.length,
      reused: reusedAuthorizationCount,
      jobs: authorizationJobs.map((job) => {
        const current = service.getJob(job.id);
        return { id: current.id, status: current.status };
      }),
    },
    mapping: {
      materialCount: preparation.materialCount,
      orderedLabels: preparation.preview.orderedLabels,
    },
    batch: {
      batchId: batch.batchId,
      count: batch.count,
      jobs: generationJobs.map((job) => ({
        id: job.id,
        status: job.status,
        platformTaskId: job.platformTaskId,
      })),
    },
  };
}
