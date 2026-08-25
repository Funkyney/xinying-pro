import type { Job } from "../shared/contracts";
import type { XinyingService } from "../core/service";
import { asAppError } from "../core/errors";
import type { PlaywrightXinyingAdapter, AdapterOutcome } from "./playwright-adapter";

type AutomationViewRunner = <T>(operation: () => Promise<T>, label?: string) => Promise<T>;
type BackgroundAutomationRunner = <T>(operation: () => Promise<T>) => Promise<T | undefined>;

const PORTRAIT_MONITOR_INTERVAL_MS = 30_000;
const PORTRAIT_INSPECTION_TIMEOUT_MS = 5_000;
const PORTRAIT_RETRY_AFTER_SKIP_MS = 15_000;

function portraitMonitorDelay(job: Job, attempt: number, now = Date.now()): number {
  const submittedAt = Date.parse(job.submittedAt ?? job.createdAt);
  const reviewAge = Number.isFinite(submittedAt) ? Math.max(0, now - submittedAt) : 0;
  if (reviewAge >= 30 * 60_000) return 5 * 60_000;
  if (reviewAge >= 10 * 60_000 || attempt >= 5) return 2 * 60_000;
  return 60_000;
}

function stringJobParameter(job: Job, key: string): string {
  const value = job.parameters[key];
  return typeof value === "string" ? value : "";
}

function integerJobParameter(job: Job, key: string): number | null {
  const value = job.parameters[key];
  return Number.isInteger(value) ? Number(value) : null;
}

export class JobWorker {
  private queueTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private processing = false;
  private readonly portraitCheckNotBefore = new Map<string, number>();
  private readonly portraitCheckAttempts = new Map<string, number>();

  constructor(
    private readonly service: XinyingService,
    private readonly adapter: PlaywrightXinyingAdapter,
    private readonly runWithAutomationView: AutomationViewRunner = async (operation) => operation(),
    private readonly runWithBackgroundAutomation: BackgroundAutomationRunner = async (operation) => operation(),
  ) {}

  start(): void {
    if (this.queueTimer) return;
    this.queueTimer = setInterval(() => void this.processQueue(), 2_000);
    this.monitorTimer = setInterval(() => void this.monitorRunning(), PORTRAIT_MONITOR_INTERVAL_MS);
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
      let reuseFromPlatformTaskId: string | undefined;
      if (job.kind === "generation") {
        reuseFromPlatformTaskId = stringJobParameter(job, "reuseFromPlatformTaskId") || undefined;
        const batchId = stringJobParameter(job, "batchId");
        const takeNumber = integerJobParameter(job, "takeNumber");
        if (batchId && takeNumber && takeNumber > 1) {
          const predecessor = this.service.listJobs().find((candidate) =>
            candidate.kind === "generation"
            && stringJobParameter(candidate, "batchId") === batchId
            && integerJobParameter(candidate, "takeNumber") === takeNumber - 1,
          );
          if (!predecessor || !["running", "completed"].includes(predecessor.status) || !predecessor.platformTaskId?.startsWith("chat:")) {
            const message = `批次第 ${takeNumber - 1} 条尚未在心影确认提交，无法安全复用生成第 ${takeNumber} 条`;
            this.service.updateJob(job.id, { status: "needs-human", requiresHumanReason: message });
            this.service.addJobEvent(job.id, "warning", "REUSE_SOURCE_UNAVAILABLE", message, { batchId, takeNumber });
            return;
          }
          reuseFromPlatformTaskId = predecessor.platformTaskId;
        }
      }
      this.service.updateJob(job.id, { status: "submitting", submittedAt: new Date().toISOString() });
      this.service.addJobEvent(
        job.id,
        "info",
        reuseFromPlatformTaskId ? "REUSING_PREVIOUS_TAKE" : "SUBMITTING",
        reuseFromPlatformTaskId ? "正在通过心影“重新编辑”复用上一条并再次提交" : "正在通过心影可见页面提交任务",
        reuseFromPlatformTaskId ? { sourcePlatformTaskId: reuseFromPlatformTaskId } : {},
      );
      const outcome = await this.runWithAutomationView(() => job.kind === "generation"
        ? this.adapter.submitGeneration(job, reuseFromPlatformTaskId)
        : this.adapter.submitPortraitReview(job, this.service.getPortrait(job.portraitId!)),
      job.kind === "generation" ? "正在向心影提交视频生成" : "正在向心影提交虚拟人像审核");
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
      // A video-generation run is complete for automation as soon as Heart
      // confirms it is generating. Do not keep taking over the shared page to
      // poll or download it; the user can inspect/sync results when desired.
      // Portrait authorization still needs monitoring because later reference
      // submission depends on its approved/rejected state.
      const now = Date.now();
      const running = this.service.listJobs()
        .filter((job) => job.status === "running" && job.kind === "portrait-review")
        .filter((job) => (this.portraitCheckNotBefore.get(job.id) ?? 0) <= now)
        .sort((left, right) => {
          const scheduled = (this.portraitCheckNotBefore.get(left.id) ?? 0) - (this.portraitCheckNotBefore.get(right.id) ?? 0);
          return scheduled || left.createdAt.localeCompare(right.createdAt);
        });
      const due = running.slice(0, 50);
      if (!due.length) return;
      const results = await this.runWithBackgroundAutomation(async () => {
        const inspected: Array<{ job: Job; outcome?: AdapterOutcome; error?: unknown }> = [];
        for (const job of due) {
          try {
            inspected.push({
              job,
              outcome: await this.adapter.inspectPortraitReview(
                job,
                this.service.getPortrait(job.portraitId!),
                { timeoutMs: PORTRAIT_INSPECTION_TIMEOUT_MS },
              ),
            });
          } catch (error) {
            inspected.push({ job, error });
          }
        }
        return inspected;
      });
      if (!results) {
        for (const job of due) this.portraitCheckNotBefore.set(job.id, now + PORTRAIT_RETRY_AFTER_SKIP_MS);
        return;
      }
      for (const result of results) {
        const { job, outcome, error } = result;
        if (error || !outcome) {
          const appError = asAppError(error ?? new Error("心影审核状态检查未返回结果"));
          const attempt = (this.portraitCheckAttempts.get(job.id) ?? 0) + 1;
          this.portraitCheckAttempts.set(job.id, attempt);
          this.portraitCheckNotBefore.set(job.id, Date.now() + portraitMonitorDelay(job, attempt));
          this.service.addJobEvent(job.id, "warning", "MONITOR_RETRY", appError.message);
          continue;
        }
        this.applyOutcome(job, outcome, false);
        if (outcome.status === "running") {
          const attempt = (this.portraitCheckAttempts.get(job.id) ?? 0) + 1;
          this.portraitCheckAttempts.set(job.id, attempt);
          this.portraitCheckNotBefore.set(job.id, Date.now() + portraitMonitorDelay(job, attempt));
        } else {
          this.portraitCheckAttempts.delete(job.id);
          this.portraitCheckNotBefore.delete(job.id);
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
        if (outcome.platformPortrait) this.service.approvePortraitFromPlatform(job.portraitId, outcome.platformPortrait, outcome.message);
        else this.service.updatePortraitReviewState(job.portraitId, "approved", outcome.message);
      }
      this.service.addJobEvent(job.id, "info", "COMPLETED", outcome.message);
      return;
    }
    this.service.updateJob(job.id, {
      status: "running",
      platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
      requiresHumanReason: null,
    });
    if (job.kind === "generation" && job.projectId) {
      const before = this.service.getProject(job.projectId).platformUrl;
      const remembered = this.service.rememberProjectConversation(job.projectId, outcome.generationUrl, outcome.platformTaskId);
      if (remembered.platformUrl !== before) {
        this.service.addJobEvent(job.id, "info", "CONVERSATION_BOUND", "已锁定本次心影对话；该项目后续生成将默认继续追加到同一对话");
      }
    }
    if (job.kind === "portrait-review" && job.portraitId) {
      this.service.updatePortraitReviewState(job.portraitId, "reviewing", outcome.message);
    }
    if (logRunning) this.service.addJobEvent(job.id, "info", "RUNNING", outcome.message);
  }
}
