import type { Job } from "../shared/contracts";
import { asAppError } from "../core/errors";

export type RecoveryCategory =
  | "connection"
  | "page-state"
  | "platform-busy"
  | "database-pressure"
  | "login"
  | "human-approval"
  | "permanent"
  | "unknown";

export interface RecoveryFailure {
  code: string;
  message: string;
  reason?: string;
  pendingSubmission?: boolean;
}

export interface RecoveryDecision {
  action: "retry" | "manual" | "fail";
  category: RecoveryCategory;
  code: string;
  message: string;
  delayMs: number;
  maxAttempts: number;
  source?: "rules" | "typesafe" | "fallback";
  confidence?: number;
}

export interface RecoveryAdvisor {
  advise(job: Job, failure: RecoveryFailure, fallback: RecoveryDecision): Promise<RecoveryDecision>;
}

const PERMANENT_CODES = new Set([
  "CONSENT_REQUIRED",
  "DIRECTOR_RUN_KEY_CONFLICT",
  "INVALID_DIRECTOR_MANIFEST",
  "INVALID_DIRECTOR_MANIFEST_JSON",
  "INVALID_GENERATION_COUNT",
  "PLATFORM_TASK_FAILED",
  "PROJECT_NOT_READY",
  "REFERENCE_CHANGED",
  "REFERENCE_FILE_MISSING",
]);

const TRANSIENT_CODES = new Set([
  "INTERNAL_ERROR",
  "PLATFORM_PAGE_NOT_FOUND",
  "PLATFORM_PAGE_NOT_READY",
  "PLAYWRIGHT_NOT_CONNECTED",
  "PORTRAIT_FORM_RESET_FAILED",
  "PROJECT_LIST_NOT_FOUND",
  "PROJECT_SELECTOR_NOT_FOUND",
  "WORKSPACE_LIST_NOT_FOUND",
]);

function backoffDelay(attempt: number, category: RecoveryCategory): number {
  const base = category === "platform-busy" || category === "database-pressure" ? 4_000 : 1_500;
  return Math.min(30_000, base * (2 ** Math.max(0, attempt - 1)));
}

export function classifyAutomationFailure(job: Job, failure: RecoveryFailure): RecoveryDecision {
  const normalized = `${failure.code} ${failure.message}`.toLowerCase();
  const nextAttempt = job.retryCount + 1;
  const retry = (category: RecoveryCategory, maxAttempts: number, message: string): RecoveryDecision => ({
    action: nextAttempt <= maxAttempts ? "retry" : "manual",
    category,
    code: failure.code,
    message: nextAttempt <= maxAttempts ? message : `自动修复已尝试 ${job.retryCount} 次：${failure.message}`,
    delayMs: backoffDelay(nextAttempt, category),
    maxAttempts,
    source: "rules",
  });

  if (PERMANENT_CODES.has(failure.code)) {
    return { action: "fail", category: "permanent", code: failure.code, message: failure.message, delayMs: 0, maxAttempts: 0, source: "rules" };
  }
  if (failure.reason === "login" || /登录|扫码|login|unauthorized|401|403/.test(normalized)) {
    return { action: "manual", category: "login", code: failure.code, message: failure.message, delayMs: 0, maxAttempts: 0, source: "rules" };
  }
  if (failure.reason === "payment" || /付款|付费|余额|额度|验证码|captcha|实名|承诺|合规确认/.test(normalized)) {
    return { action: "manual", category: "human-approval", code: failure.code, message: failure.message, delayMs: 0, maxAttempts: 0, source: "rules" };
  }
  if (/sqlite_busy|database is locked|out of memory|sqlite_nomem/.test(normalized)) {
    return retry("database-pressure", 2, "本地数据库暂时繁忙，正在释放资源后重试");
  }
  if (/task.*running|任务正在运行|操作正在进行|稍后再试|too many requests|429|限流|busy/.test(normalized)) {
    return retry("platform-busy", 5, "心影当前繁忙，已排队等待后自动继续");
  }
  if (/选项不可用|无法唯一确认.*实际编号|无法唯一确认.*编号/.test(failure.message)) {
    return {
      action: "manual",
      category: "human-approval",
      code: failure.code,
      message: failure.message,
      delayMs: 0,
      maxAttempts: 0,
      source: "rules",
    };
  }
  if (failure.reason === "page-changed" || /selector|找不到|页面|素材槽位|表单|按钮|detached|execution context/.test(normalized)) {
    return retry("page-state", job.kind === "portrait-review" ? 5 : 4, "心影页面状态发生变化，正在重新定位并继续");
  }
  if (failure.reason === "approval" && /表单|提交条件|未关闭|素材槽位|角色库|虚拟人像|上传未完成/.test(failure.message)) {
    return retry("page-state", job.kind === "portrait-review" ? 5 : 4, "授权或素材表单未完成，正在清理页面草稿后重试");
  }
  if (failure.pendingSubmission) {
    return retry("connection", 4, "提交确认中断，正在先查重再安全续跑");
  }
  if (TRANSIENT_CODES.has(failure.code) || /timeout|timed out|econnreset|econnrefused|eof|e_pipe|epipe|target .* closed|browser.*closed|network/.test(normalized)) {
    return retry("connection", 4, "控制连接暂时中断，正在自动重连并继续");
  }
  if (failure.reason === "unknown") {
    return { action: "manual", category: "unknown", code: failure.code, message: failure.message, delayMs: 0, maxAttempts: 0, source: "rules" };
  }
  return { ...retry("unknown", 2, "发生未识别的临时错误，正在进行受限重试"), source: "fallback" };
}

export function classifyThrownAutomationError(job: Job, error: unknown): RecoveryDecision {
  const appError = asAppError(error);
  return classifyAutomationFailure(job, {
    code: appError.code,
    message: appError.message,
    pendingSubmission: job.platformTaskId?.startsWith("pending-chat:") || false,
  });
}
