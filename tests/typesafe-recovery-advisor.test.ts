import { describe, expect, it } from "vitest";
import { classifyAutomationFailure } from "../src/main/recovery-engine";
import { applyTypeSafeAssessment } from "../src/main/typesafe-recovery-advisor";
import type { Job } from "../src/shared/contracts";

function job(overrides: Partial<Job> = {}): Job {
  const timestamp = new Date().toISOString();
  return {
    id: "job-typesafe",
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
    createdAt: timestamp,
    submittedAt: timestamp,
    completedAt: null,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("TypeSafe recovery advice", () => {
  it("turns a confident unknown page-state diagnosis into a bounded retry", () => {
    const current = job();
    const failure = { code: "INTERNAL_ERROR", message: "unexpected dialog state 73" };
    const fallback = classifyAutomationFailure(current, failure);

    const decision = applyTypeSafeAssessment(current, failure, fallback, {
      category: "page_state",
      confidence: 0.91,
      safeToRetry: 0.94,
    });

    expect(decision).toMatchObject({
      action: "retry",
      category: "page-state",
      maxAttempts: 3,
      source: "typesafe",
      confidence: 0.91,
    });
  });

  it("keeps the local fallback when the semantic diagnosis is uncertain", () => {
    const current = job();
    const failure = { code: "INTERNAL_ERROR", message: "opaque failure" };
    const fallback = classifyAutomationFailure(current, failure);

    const decision = applyTypeSafeAssessment(current, failure, fallback, {
      category: "connection",
      confidence: 0.51,
      safeToRetry: 0.98,
    });

    expect(decision).toEqual(fallback);
  });

  it("never lets an AI diagnosis bypass a human-only checkpoint", () => {
    const current = job();
    const failure = { code: "INTERNAL_ERROR", message: "operation requires an unclear confirmation" };
    const fallback = classifyAutomationFailure(current, failure);

    const decision = applyTypeSafeAssessment(current, failure, fallback, {
      category: "human_approval",
      confidence: 0.93,
      safeToRetry: 0.02,
    });

    expect(decision).toMatchObject({
      action: "manual",
      category: "human-approval",
      maxAttempts: 0,
      source: "typesafe",
    });
  });

  it("respects the retry budget on repeated AI-classified failures", () => {
    const current = job({ retryCount: 3 });
    const failure = { code: "INTERNAL_ERROR", message: "page state still inconsistent" };
    const fallback = classifyAutomationFailure(current, failure);

    const decision = applyTypeSafeAssessment(current, failure, fallback, {
      category: "page_state",
      confidence: 0.9,
      safeToRetry: 0.9,
    });

    expect(decision).toMatchObject({ action: "manual", maxAttempts: 3, source: "typesafe" });
  });
});
