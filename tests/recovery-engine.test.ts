import { describe, expect, it } from "vitest";
import { classifyAutomationFailure, classifyThrownAutomationError } from "../src/main/recovery-engine";
import type { Job } from "../src/shared/contracts";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    kind: "generation",
    projectId: "project-1",
    portraitId: null,
    status: "submitting",
    platformTaskId: null,
    platformExecutionId: null,
    progress: 0,
    progressLabel: "正在提交",
    lastCheckedAt: null,
    promptSnapshot: "固定机位",
    parameters: {},
    references: [],
    outputPath: null,
    outputUrl: null,
    errorCode: null,
    errorMessage: null,
    requiresHumanReason: null,
    retryCount: 0,
    automationStage: "submitting",
    recoveryState: "none",
    nextRetryAt: null,
    lastRecoveryCode: null,
    createdAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    completedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("automation recovery classification", () => {
  it("retries a main-process EOF as a bounded connection recovery", () => {
    const decision = classifyThrownAutomationError(job(), new Error("write EOF"));

    expect(decision).toMatchObject({ action: "retry", category: "connection", maxAttempts: 4 });
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it("checks a persisted pending submission before safely continuing", () => {
    const decision = classifyAutomationFailure(job({ platformTaskId: "pending-chat:p:s:3" }), {
      code: "INTERNAL_ERROR",
      message: "connection closed",
      pendingSubmission: true,
    });

    expect(decision).toMatchObject({ action: "retry", category: "connection", maxAttempts: 4 });
    expect(decision.message).toContain("查重");
  });

  it("never retries payment or login checkpoints", () => {
    expect(classifyAutomationFailure(job(), {
      code: "NEEDS_PAYMENT",
      message: "请确认付费",
      reason: "payment",
    }).action).toBe("manual");
    expect(classifyAutomationFailure(job(), {
      code: "NEEDS_LOGIN",
      message: "请扫码登录",
      reason: "login",
    })).toMatchObject({ action: "manual", category: "login" });
  });

  it("stops after the retry budget is exhausted", () => {
    const decision = classifyThrownAutomationError(job({ retryCount: 4 }), new Error("write EOF"));

    expect(decision).toMatchObject({ action: "manual", category: "connection", maxAttempts: 4 });
    expect(decision.message).toContain("自动修复已尝试");
  });

  it("fails permanent manifest and platform task errors immediately", () => {
    expect(classifyAutomationFailure(job(), {
      code: "PLATFORM_TASK_FAILED",
      message: "心影任务失败",
    })).toMatchObject({ action: "fail", category: "permanent", maxAttempts: 0 });
  });
});
