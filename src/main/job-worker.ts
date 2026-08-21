import type { Job } from "../shared/contracts";
import type { XinyingService } from "../core/service";
import { asAppError } from "../core/errors";
import type { PlaywrightXinyingAdapter, AdapterOutcome } from "./playwright-adapter";

type AutomationViewRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export class JobWorker {
  private queueTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(
    private readonly service: XinyingService,
    private readonly adapter: PlaywrightXinyingAdapter,
    private readonly runWithAutomationView: AutomationViewRunner = async (operation) => operation(),
  ) {}

  start(): void {
    if (this.queueTimer) return;
    this.queueTimer = setInterval(() => void this.processQueue(), 2_000);
    this.monitorTimer = setInterval(() => void this.monitorRunning(), 12_000);
    void this.processQueue();
  }

  stop(): void {
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.queueTimer = null;
    this.monitorTimer = null;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    const job = this.service.listQueuedJobs()[0];
    if (!job) return;
    this.processing = true;
    try {
      this.service.updateJob(job.id, { status: "submitting", submittedAt: new Date().toISOString() });
      this.service.addJobEvent(job.id, "info", "SUBMITTING", "正在通过心影可见页面提交任务");
      const outcome = await this.runWithAutomationView(() => job.kind === "generation"
        ? this.adapter.submitGeneration(job)
        : this.adapter.submitPortraitReview(job, this.service.getPortrait(job.portraitId!)));
      this.applyOutcome(job, outcome);
    } catch (error) {
      const appError = asAppError(error);
      const status = appError.code === "PLAYWRIGHT_NOT_CONNECTED" || appError.code === "PLATFORM_PAGE_NOT_FOUND" ? "needs-login" : "failed";
      this.service.updateJob(job.id, {
        status,
        errorCode: appError.code,
        errorMessage: appError.message,
        requiresHumanReason: status === "needs-login" ? "请打开 APP 并完成飞书扫码登录" : null,
      });
      this.service.addJobEvent(job.id, "error", appError.code, appError.message);
    } finally {
      this.processing = false;
    }
  }

  private async monitorRunning(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const running = this.service.listJobs().filter((job) => job.status === "running");
      for (const job of running.slice(0, 3)) {
        try {
          const outcome = await this.runWithAutomationView(async () => {
            let inspected = job.kind === "generation"
              ? await this.adapter.inspectRunningJob(job)
              : await this.adapter.inspectPortraitReview(job, this.service.getPortrait(job.portraitId!));
            if (job.kind === "generation" && inspected.status === "completed" && !inspected.outputPath) {
              try {
                const outputPath = await this.adapter.downloadVisibleResult(job);
                inspected = { ...inspected, outputPath, message: `${inspected.message}；结果已保存到本地结果库` };
              } catch (error) {
                const appError = asAppError(error);
                this.service.addJobEvent(job.id, "warning", "AUTO_DOWNLOAD_FAILED", appError.message);
              }
            }
            return inspected;
          });
          this.applyOutcome(job, outcome, false);
        } catch (error) {
          const appError = asAppError(error);
          this.service.addJobEvent(job.id, "warning", "MONITOR_RETRY", appError.message);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private applyOutcome(job: Job, outcome: AdapterOutcome, logRunning = true): void {
    if (outcome.status === "needs-login") {
      this.service.updateJob(job.id, { status: "needs-login", requiresHumanReason: outcome.message });
      this.service.addJobEvent(job.id, "warning", "NEEDS_LOGIN", outcome.message);
      return;
    }
    if (outcome.status === "needs-human") {
      this.service.updateJob(job.id, {
        status: "needs-human",
        platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
        requiresHumanReason: outcome.checkpoint.message,
      });
      if (job.kind === "portrait-review" && job.portraitId) {
        this.service.updatePortraitReviewState(job.portraitId, "needs-human", outcome.checkpoint.message);
      }
      this.service.addJobEvent(job.id, "warning", `NEEDS_${outcome.checkpoint.reason.toUpperCase()}`, outcome.checkpoint.message);
      return;
    }
    if (outcome.status === "failed") {
      this.service.updateJob(job.id, {
        status: "failed",
        platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
        errorCode: outcome.code,
        errorMessage: outcome.message,
        requiresHumanReason: null,
        completedAt: new Date().toISOString(),
      });
      if (job.kind === "portrait-review" && job.portraitId) {
        this.service.updatePortraitReviewState(job.portraitId, "rejected", outcome.message);
      }
      this.service.addJobEvent(job.id, "error", outcome.code, outcome.message);
      return;
    }
    if (outcome.status === "completed") {
      this.service.updateJob(job.id, {
        status: "completed",
        platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
        outputUrl: outcome.outputPath ? null : outcome.outputUrl ?? null,
        outputPath: outcome.outputPath ?? null,
        completedAt: new Date().toISOString(),
        requiresHumanReason: null,
      });
      if (job.kind === "portrait-review" && job.portraitId) {
        this.service.updatePortraitReviewState(job.portraitId, "approved", outcome.message);
      }
      this.service.addJobEvent(job.id, "info", "COMPLETED", outcome.message);
      return;
    }
    this.service.updateJob(job.id, {
      status: "running",
      platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
      requiresHumanReason: null,
    });
    if (job.kind === "portrait-review" && job.portraitId) {
      this.service.updatePortraitReviewState(job.portraitId, "reviewing", outcome.message);
    }
    if (logRunning) this.service.addJobEvent(job.id, "info", "RUNNING", outcome.message);
  }
}
