import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Job } from "../shared/contracts";
import type {
  RecoveryAdvisor,
  RecoveryCategory,
  RecoveryDecision,
  RecoveryFailure,
} from "./recovery-engine";

type TypeSafeCategory =
  | "connection"
  | "page_state"
  | "platform_busy"
  | "database_pressure"
  | "login"
  | "human_approval"
  | "permanent"
  | "unknown";

interface TypeSafeAssessment {
  category: TypeSafeCategory;
  confidence: number;
  safeToRetry: number;
}

interface CachedAssessment {
  value: TypeSafeAssessment;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60_000;
const CIRCUIT_BREAKER_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 100;
const DEFAULT_TIMEOUT_MS = 1_000;
const MIN_CATEGORY_CONFIDENCE = 0.72;
const MIN_MANUAL_CONFIDENCE = 0.82;
const MIN_RETRY_PROBABILITY = 0.72;

const RECOVERY_MESSAGES: Record<Exclude<RecoveryCategory, "login" | "human-approval" | "permanent" | "unknown">, string> = {
  connection: "智能诊断为临时连接中断，正在重新连接并继续",
  "page-state": "智能诊断为心影页面状态变化，正在重新定位后继续",
  "platform-busy": "智能诊断为心影繁忙或限流，正在等待后继续",
  "database-pressure": "智能诊断为本地数据库压力，正在释放资源后继续",
};

const RETRY_BUDGETS: Record<Exclude<RecoveryCategory, "login" | "human-approval" | "permanent" | "unknown">, number> = {
  connection: 3,
  "page-state": 3,
  "platform-busy": 4,
  "database-pressure": 2,
};

function sanitizeFailureText(value: string): string {
  return value
    .replace(/apikey_[A-Za-z0-9_-]+/gi, "[REDACTED_API_KEY]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[REDACTED_LOCAL_PATH]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[REDACTED_ID]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[REDACTED_TOKEN]")
    .slice(0, 1_200);
}

function cacheKey(job: Job, failure: RecoveryFailure): string {
  return JSON.stringify({
    kind: job.kind,
    stage: job.automationStage,
    code: failure.code,
    reason: failure.reason ?? "",
    pendingSubmission: Boolean(failure.pendingSubmission),
    message: sanitizeFailureText(failure.message),
  });
}

function retryDelay(attempt: number, category: RecoveryCategory): number {
  const base = category === "platform-busy" || category === "database-pressure" ? 4_000 : 1_500;
  return Math.min(30_000, base * (2 ** Math.max(0, attempt - 1)));
}

function normalizedCategory(category: TypeSafeCategory): RecoveryCategory {
  if (category === "page_state") return "page-state";
  if (category === "platform_busy") return "platform-busy";
  if (category === "database_pressure") return "database-pressure";
  if (category === "human_approval") return "human-approval";
  return category;
}

export function applyTypeSafeAssessment(
  job: Job,
  failure: RecoveryFailure,
  fallback: RecoveryDecision,
  assessment: TypeSafeAssessment,
): RecoveryDecision {
  const category = normalizedCategory(assessment.category);
  const confidence = Math.max(0, Math.min(1, assessment.confidence));
  const safeToRetry = Math.max(0, Math.min(1, assessment.safeToRetry));

  if (category === "unknown" || confidence < MIN_CATEGORY_CONFIDENCE) return fallback;

  if (category === "login" || category === "human-approval" || category === "permanent") {
    if (confidence < MIN_MANUAL_CONFIDENCE) return fallback;
    const message = category === "login"
      ? "智能诊断认为心影登录状态需要人工恢复"
      : category === "human-approval"
        ? "智能诊断认为该步骤需要人工确认，已停止自动重试"
        : "智能诊断认为重复执行无法解决该错误，请人工检查后恢复任务";
    return {
      action: "manual",
      category,
      code: failure.code,
      message,
      delayMs: 0,
      maxAttempts: 0,
      source: "typesafe",
      confidence,
    };
  }

  if (safeToRetry < MIN_RETRY_PROBABILITY) return fallback;
  const maxAttempts = RETRY_BUDGETS[category];
  const nextAttempt = job.retryCount + 1;
  return {
    action: nextAttempt <= maxAttempts ? "retry" : "manual",
    category,
    code: failure.code,
    message: nextAttempt <= maxAttempts
      ? RECOVERY_MESSAGES[category]
      : `智能恢复已尝试 ${job.retryCount} 次：${sanitizeFailureText(failure.message)}`,
    delayMs: retryDelay(nextAttempt, category),
    maxAttempts,
    source: "typesafe",
    confidence,
  };
}

export class TypeSafeRecoveryAdvisor implements RecoveryAdvisor {
  private readonly client: TypeSafeClient;
  private readonly cache = new Map<string, CachedAssessment>();
  private readonly inFlight = new Map<string, Promise<TypeSafeAssessment>>();
  private disabledUntil = 0;

  constructor(apiKey: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.client = new TypeSafeClient({
      apiKey,
      timeout: timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "error",
    });
  }

  async advise(job: Job, failure: RecoveryFailure, fallback: RecoveryDecision): Promise<RecoveryDecision> {
    if (Date.now() < this.disabledUntil) return fallback;
    const key = cacheKey(job, failure);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return applyTypeSafeAssessment(job, failure, fallback, cached.value);
    }
    if (cached) this.cache.delete(key);

    try {
      const pending = this.inFlight.get(key) ?? this.assess(job, failure);
      this.inFlight.set(key, pending);
      const assessment = await pending;
      this.remember(key, assessment);
      return applyTypeSafeAssessment(job, failure, fallback, assessment);
    } catch {
      this.disabledUntil = Date.now() + CIRCUIT_BREAKER_MS;
      return fallback;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async assess(job: Job, failure: RecoveryFailure): Promise<TypeSafeAssessment> {
    const response = await this.client.systemOne({
      model: "jev-latest",
      state: {
        application: "心影Pro desktop automation",
        jobKind: job.kind,
        automationStage: job.automationStage,
        retryCount: job.retryCount,
        hasPendingSubmission: Boolean(failure.pendingSubmission),
        failure: {
          code: sanitizeFailureText(failure.code),
          reason: failure.reason ?? null,
          message: sanitizeFailureText(failure.message),
        },
      },
      questions: {
        category: choice("Which single recovery category best explains this automation failure?", {
          connection: "Temporary transport, browser connection, network, timeout, EOF, or closed-target failure",
          page_state: "The web page, selector, dialog, form, or navigation state changed or is incomplete",
          platform_busy: "The remote platform is busy, rate limited, or another task is still running",
          database_pressure: "Local SQLite locking, memory pressure, or database resource exhaustion",
          login: "Authentication expired or the user must sign in again",
          human_approval: "Payment, consent, CAPTCHA, identity, compliance, or another explicit human-only action is required",
          permanent: "The request or data is invalid and repeating the exact same operation cannot fix it",
          unknown: "There is not enough evidence to select another category",
        }),
        safeToRetry: noul("Is it safe and useful to retry the same automation job without changing user data or creating a duplicate submission?", {
          true: "A bounded retry is unlikely to duplicate a submitted task or bypass a human approval",
          false: "Retrying may duplicate work, repeat a deterministic failure, or bypass a required human step",
        }),
      },
    }, {
      timeout: this.timeoutMs,
      retry: { maxRetries: 0 },
    });

    return {
      category: response.answers.category.choice,
      confidence: response.answers.category.confidence,
      safeToRetry: response.answers.safeToRetry.noul,
    };
  }

  private remember(key: string, value: TypeSafeAssessment): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

export function createTypeSafeRecoveryAdvisor(apiKey = process.env.TYPESAFE_API_KEY): RecoveryAdvisor | null {
  const normalized = apiKey?.trim();
  return normalized ? new TypeSafeRecoveryAdvisor(normalized) : null;
}
