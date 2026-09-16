import type { Job } from "../shared/contracts";
import type { XinyingService } from "../core/service";
import { asAppError } from "../core/errors";
import type { PlaywrightXinyingAdapter, AdapterOutcome } from "./playwright-adapter";
import { classifyAutomationFailure, classifyThrownAutomationError, type RecoveryDecision } from "./recovery-engine";

type AutomationViewRunner = <T>(operation: () => Promise<T>, label?: string) => Promise<T>;
type BackgroundAutomationRunner = <T>(operation: () => Promise<T>) => Promise<T | undefined>;

const PORTRAIT_MONITOR_INTERVAL_MS = 5_000;
const PORTRAIT_INSPECTION_TIMEOUT_MS = 5_000;
const PORTRAIT_RETRY_AFTER_SKIP_MS = 3_000;
const PORTRAIT_SUBMISSION_BATCH_SIZE = 20;

function portraitMonitorDelay(job: Job, attempt: number, now = Date.now()): number {
  const submittedAt = Date.parse(job.submittedAt ?? job.createdAt);
  const reviewAge = Number.isFinite(submittedAt) ? Math.max(0, now - submittedAt) : 0;
  if (reviewAge >= 30 * 60_000) return 2 * 60_000;
  if (reviewAge >= 10 * 60_000 || attempt >= 20) return 60_000;
  if (reviewAge >= 2 * 60_000 || attempt >= 8) return 15_000;
  return 5_000;
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
    this.queueTimer = setInterval(() => this.kickQueue(), 2_000);
    this.monitorTimer = setInterval(() => this.kickMonitor(), PORTRAIT_MONITOR_INTERVAL_MS);
    this.kickQueue();
  }

  stop(): void {
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.queueTimer = null;
    this.monitorTimer = null;
  }

  private kickQueue(): void {
    void this.processQueue().catch((error: unknown) => {
      // Never let an infrastructure failure escape the timer as an unhandled
      // main-process rejection. A later tick will retry reading the queue.
      const appError = asAppError(error);
      process.stderr.write(`[job-worker] queue tick failed: ${appError.code} ${appError.message}\n`);
    });
  }

  private kickMonitor(): void {
    void this.monitorRunning().catch((error: unknown) => {
      const appError = asAppError(error);
      process.stderr.write(`[job-worker] monitor tick failed: ${appError.code} ${appError.message}\n`);
    });
  }

  async refreshGenerationJobs(ids?: string[]): Promise<Job[]> {
    if (this.processing) return this.service.listJobSummaries();
    this.processing = true;
    try {
      await this.inspectGenerationJobs(ids, 20);
      return this.service.listJobSummaries();
    } finally {
      this.processing = false;
    }
  }

  private async inspectGenerationJobs(ids?: string[], fallbackLimit = 2): Promise<void> {
    const selectedIds = ids?.length ? new Set(ids) : null;
    const running = this.service.listJobsByKindAndStatus("generation", "running")
      .filter((job) => !selectedIds || selectedIds.has(job.id));
    if (!running.length) return;
    const results = await this.runWithBackgroundAutomation(async () => {
      const byExecutionId = await this.adapter.inspectGenerationJobs(running).catch(() => new Map<string, AdapterOutcome>());
      const inspected: Array<{ job: Job; outcome?: AdapterOutcome; error?: unknown }> = [];
      const fallback: Job[] = [];
      for (const job of running) {
        const outcome = job.platformExecutionId ? byExecutionId.get(job.platformExecutionId) : undefined;
        if (outcome) inspected.push({ job, outcome });
        else fallback.push(job);
      }
      for (const job of fallback.slice(0, fallbackLimit)) {
        try {
          inspected.push({ job, outcome: await this.adapter.inspectRunningJob(job) });
        } catch (error) {
          inspected.push({ job, error });
        }
      }
      return inspected;
    });
    if (!results) return;
    for (const { job, outcome, error } of results) {
      if (error || !outcome) {
        const appError = asAppError(error ?? new Error("心影任务状态查询未返回结果"));
        this.service.updateJob(job.id, { lastCheckedAt: new Date().toISOString() });
        this.service.addJobEvent(job.id, "warning", "GENERATION_MONITOR_RETRY", appError.message);
        continue;
      }
      this.applyOutcome(job, outcome, false);
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    const queuedJob = this.service.nextQueuedJob();
    if (!queuedJob) return;
    this.processing = true;
    let job = queuedJob;
    try {
      const portraitBatch = this.queuedPortraitBatch(job);
      if (portraitBatch.length > 1) {
        await this.processPortraitBatch(portraitBatch);
        return;
      }
      if (job.recoveryState === "scheduled") {
        job = this.service.updateJob(job.id, {
          automationStage: "recovering",
          recoveryState: "recovering",
          nextRetryAt: null,
          progressLabel: `自动修复第 ${job.retryCount} 次：正在恢复心影操作`,
        });
        this.service.addJobEvent(job.id, "info", "AUTO_RECOVERY_STARTED", `开始第 ${job.retryCount} 次自动恢复`, {
          previousCode: job.lastRecoveryCode,
        });
      }
      let reuseFromPlatformTaskId: string | undefined;
      if (job.kind === "generation") {
        reuseFromPlatformTaskId = stringJobParameter(job, "reuseFromPlatformTaskId") || undefined;
        const batchId = stringJobParameter(job, "batchId");
        const takeNumber = integerJobParameter(job, "takeNumber");
        if (batchId && takeNumber && takeNumber > 1) {
          const predecessor = this.service.findGenerationBatchTake(batchId, takeNumber - 1);
          if (!predecessor || !["running", "completed"].includes(predecessor.status) || !predecessor.platformTaskId?.startsWith("chat:")) {
            const message = `批次第 ${takeNumber - 1} 条尚未在心影确认提交，无法安全复用生成第 ${takeNumber} 条`;
            this.service.updateJob(job.id, {
              status: "needs-human",
              automationStage: "attention",
              recoveryState: "manual",
              nextRetryAt: null,
              lastRecoveryCode: "REUSE_SOURCE_UNAVAILABLE",
              requiresHumanReason: message,
            });
            this.service.addJobEvent(job.id, "warning", "REUSE_SOURCE_UNAVAILABLE", message, { batchId, takeNumber });
            return;
          }
          reuseFromPlatformTaskId = predecessor.platformTaskId;
        }
      }
      job = this.service.updateJob(job.id, {
        status: "submitting",
        automationStage: job.kind === "generation" ? "preparing" : "authorizing",
        recoveryState: job.recoveryState === "recovering" ? "recovering" : "none",
        nextRetryAt: null,
        submittedAt: job.submittedAt ?? new Date().toISOString(),
      });
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
      const current = this.service.getJob(job.id);
      this.applyRecoveryDecision(current, classifyThrownAutomationError(current, error));
    } finally {
      this.processing = false;
    }
  }

  private queuedPortraitBatch(first: Job): Job[] {
    if (first.kind !== "portrait-review" || first.recoveryState !== "none" || first.retryCount > 0 || first.platformTaskId) return [first];
    const firstPortrait = this.service.getPortrait(first.portraitId!);
    const firstUrl = stringJobParameter(first, "platformUrl");
    const firstWorkspace = stringJobParameter(first, "platformWorkspaceId");
    const now = new Date().toISOString();
    const queued = this.service.listQueuedJobs();
    const start = queued.findIndex((candidate) => candidate.id === first.id);
    if (start < 0) return [first];
    const batch: Job[] = [];
    for (const candidate of queued.slice(start)) {
      if (batch.length >= PORTRAIT_SUBMISSION_BATCH_SIZE) break;
      if (candidate.kind !== "portrait-review") break;
      if (candidate.recoveryState !== "none" || candidate.retryCount > 0 || candidate.platformTaskId) break;
      if (candidate.nextRetryAt && candidate.nextRetryAt > now) break;
      if (candidate.projectId !== first.projectId
        || stringJobParameter(candidate, "platformUrl") !== firstUrl
        || stringJobParameter(candidate, "platformWorkspaceId") !== firstWorkspace) break;
      const portrait = this.service.getPortrait(candidate.portraitId!);
      if (portrait.applicationScope !== firstPortrait.applicationScope) break;
      batch.push(candidate);
    }
    return batch.length ? batch : [first];
  }

  private async processPortraitBatch(jobs: Job[]): Promise<void> {
    const submittedAt = new Date().toISOString();
    const active = jobs.map((job) => {
      const updated = this.service.updateJob(job.id, {
        status: "submitting",
        automationStage: "authorizing",
        recoveryState: "none",
        nextRetryAt: null,
        submittedAt: job.submittedAt ?? submittedAt,
        progressLabel: `正在批量提交 ${jobs.length} 项虚拟人像授权`,
      });
      this.service.addJobEvent(job.id, "info", "BATCH_SUBMITTING", `正在通过一个心影表单批量提交 ${jobs.length} 项虚拟人像`, {
        batchSize: jobs.length,
      });
      return updated;
    });
    try {
      const entries = active.map((job) => ({ job, portrait: this.service.getPortrait(job.portraitId!) }));
      const outcomes = await this.runWithAutomationView(
        () => this.adapter.submitPortraitReviews(entries),
        `正在向心影批量提交 ${jobs.length} 项虚拟人像审核`,
      );
      const missing = active.find((job) => !outcomes.has(job.id));
      if (missing) throw new Error(`心影批量提交未返回任务 ${missing.id} 的状态`);
      for (const job of active) {
        this.applyOutcome(job, outcomes.get(job.id)!);
      }
    } catch (error) {
      for (const job of active) {
        const current = this.service.getJob(job.id);
        this.applyRecoveryDecision(current, classifyThrownAutomationError(current, error));
      }
    }
  }

  private async monitorRunning(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      // A generation job reaching `running` already crossed the automation
      // success boundary. Only explicit result refreshes inspect it again, so
      // old generations cannot occupy the shared Heart page while a new run
      // is authorizing portraits or submitting takes.
      const now = Date.now();
      const running = this.service.listJobsByKindAndStatus("portrait-review", "running")
        .filter((job) => (this.portraitCheckNotBefore.get(job.id) ?? 0) <= now)
        .sort((left, right) => {
          const scheduled = (this.portraitCheckNotBefore.get(left.id) ?? 0) - (this.portraitCheckNotBefore.get(right.id) ?? 0);
          return scheduled || left.createdAt.localeCompare(right.createdAt);
        });
      const due = running.slice(0, 50);
      if (!due.length) return;
      const results = await this.runWithBackgroundAutomation(async () => {
        if (typeof this.adapter.inspectPortraitReviews === "function") {
          const entries = due.map((job) => ({ job, portrait: this.service.getPortrait(job.portraitId!) }));
          try {
            const outcomes = await this.adapter.inspectPortraitReviews(entries, { timeoutMs: PORTRAIT_INSPECTION_TIMEOUT_MS });
            return due.map((job) => ({ job, outcome: outcomes.get(job.id), error: undefined }));
          } catch (error) {
            return due.map((job) => ({ job, outcome: undefined, error }));
          }
        }
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

  private applyRecoveryDecision(job: Job, decision: RecoveryDecision): void {
    if (decision.action === "retry") {
      const retryCount = job.retryCount + 1;
      const nextRetryAt = new Date(Date.now() + decision.delayMs).toISOString();
      this.service.updateJob(job.id, {
        status: "queued",
        automationStage: "recovering",
        recoveryState: "scheduled",
        nextRetryAt,
        lastRecoveryCode: decision.code,
        errorCode: decision.code,
        errorMessage: decision.message,
        requiresHumanReason: null,
        retryCount,
        progressLabel: `自动修复 ${retryCount}/${decision.maxAttempts}：${decision.message}`,
      });
      if (job.kind === "portrait-review" && job.portraitId) {
        this.service.updatePortraitReviewState(job.portraitId, "queued", `自动修复 ${retryCount}/${decision.maxAttempts}：${decision.message}`);
      }
      this.service.addJobEvent(job.id, "warning", "AUTO_RECOVERY_SCHEDULED", decision.message, {
        category: decision.category,
        failureCode: decision.code,
        retryCount,
        maxAttempts: decision.maxAttempts,
        nextRetryAt,
        verifiesPendingSubmission: job.platformTaskId?.startsWith("pending-chat:") || false,
      });
      return;
    }

    if (decision.action === "manual") {
      const exhausted = decision.maxAttempts > 0 && job.retryCount >= decision.maxAttempts;
      const status = decision.category === "login" ? "needs-login" : "needs-human";
      this.service.updateJob(job.id, {
        status,
        automationStage: "attention",
        recoveryState: exhausted ? "exhausted" : "manual",
        nextRetryAt: null,
        lastRecoveryCode: decision.code,
        errorCode: decision.code,
        errorMessage: decision.message,
        requiresHumanReason: decision.category === "login" ? "请在心影Pro完成飞书扫码登录，任务会保留当前检查点" : decision.message,
        progressLabel: exhausted ? "自动修复次数已用完，等待人工确认" : "需要人工完成安全检查",
      });
      this.service.addJobEvent(job.id, "warning", exhausted ? "AUTO_RECOVERY_EXHAUSTED" : "AUTO_RECOVERY_NEEDS_HUMAN", decision.message, {
        category: decision.category,
        failureCode: decision.code,
        retryCount: job.retryCount,
      });
      return;
    }

    this.service.updateJob(job.id, {
      status: "failed",
      automationStage: "failed",
      recoveryState: "exhausted",
      nextRetryAt: null,
      lastRecoveryCode: decision.code,
      errorCode: decision.code,
      errorMessage: decision.message,
      requiresHumanReason: null,
      progressLabel: decision.message,
      completedAt: new Date().toISOString(),
    });
    if (job.kind === "portrait-review" && job.portraitId) {
      this.service.updatePortraitReviewState(job.portraitId, "rejected", decision.message);
    }
    this.service.addJobEvent(job.id, "error", decision.code, decision.message, { category: decision.category });
  }

  private applyOutcome(job: Job, outcome: AdapterOutcome, logRunning = true): void {
    if (outcome.status === "needs-login") {
      this.applyRecoveryDecision(job, classifyAutomationFailure(job, {
        code: "NEEDS_LOGIN",
        message: outcome.message,
        reason: "login",
      }));
      return;
    }
    if (outcome.status === "needs-human") {
      const current = outcome.platformTaskId && outcome.platformTaskId !== job.platformTaskId
        ? this.service.updateJob(job.id, { platformTaskId: outcome.platformTaskId })
        : job;
      this.applyRecoveryDecision(current, classifyAutomationFailure(current, {
        code: `NEEDS_${outcome.checkpoint.reason.toUpperCase()}`,
        message: outcome.checkpoint.message,
        reason: outcome.checkpoint.reason,
        pendingSubmission: current.platformTaskId?.startsWith("pending-chat:") || false,
      }));
      return;
    }
    if (outcome.status === "failed") {
      const decision = classifyAutomationFailure(job, { code: outcome.code, message: outcome.message });
      if (decision.action !== "fail") {
        this.applyRecoveryDecision(job, decision);
        return;
      }
      this.service.updateJob(job.id, {
        status: "failed",
        automationStage: "failed",
        recoveryState: "exhausted",
        nextRetryAt: null,
        lastRecoveryCode: outcome.code,
        platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
        platformExecutionId: outcome.platformExecutionId ?? job.platformExecutionId,
        progress: outcome.progress ?? job.progress,
        progressLabel: outcome.progressLabel ?? outcome.message,
        lastCheckedAt: new Date().toISOString(),
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
        automationStage: "completed",
        recoveryState: "none",
        nextRetryAt: null,
        lastRecoveryCode: null,
        platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
        platformExecutionId: outcome.platformExecutionId ?? job.platformExecutionId,
        progress: outcome.progress ?? 100,
        progressLabel: outcome.progressLabel ?? "心影生成完成",
        lastCheckedAt: new Date().toISOString(),
        outputUrl: outcome.outputPath ? null : outcome.outputUrl ?? null,
        outputPath: outcome.outputPath ?? null,
        completedAt: new Date().toISOString(),
        errorCode: null,
        errorMessage: null,
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
      automationStage: job.kind === "generation" ? "submitted" : "monitoring",
      recoveryState: "none",
      nextRetryAt: null,
      lastRecoveryCode: null,
      platformTaskId: outcome.platformTaskId ?? job.platformTaskId,
      platformExecutionId: outcome.platformExecutionId ?? job.platformExecutionId,
      progress: outcome.progress ?? job.progress,
      progressLabel: outcome.progressLabel ?? outcome.message,
      lastCheckedAt: job.kind === "generation" ? new Date().toISOString() : job.lastCheckedAt,
      errorCode: null,
      errorMessage: null,
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
