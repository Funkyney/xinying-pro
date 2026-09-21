import { describe, expect, it } from "vitest";
import {
  acceptedPageRecoveryCandidate,
  pageRecoveryCriteria,
  type PageRecoveryRequest,
} from "../src/main/typesafe-page-recovery";

function request(): PageRecoveryRequest {
  return {
    route: "https://blueaivideo.com/avpAgent",
    title: "心影",
    intent: "提交当前提示词并开始生成",
    action: "click",
    candidates: [
      { id: "control_1", role: "button", tag: "button", label: "取消", placeholder: "", disabled: false },
      { id: "control_2", role: "button", tag: "button", label: "生成", placeholder: "", disabled: false },
      { id: "control_3", role: "button", tag: "button", label: "生成", placeholder: "", disabled: true },
    ],
  };
}

describe("TypeSafe page control recovery", () => {
  it("builds a closed choice set with an explicit no-match outcome", () => {
    const criteria = pageRecoveryCriteria(request().candidates);

    expect(Object.keys(criteria)).toEqual(["control_1", "control_2", "control_3", "none"]);
    expect(criteria.control_2).toMatchObject({ kind: "button", label: "生成", disabled: false });
  });

  it("accepts only confident, enabled candidates from the current snapshot", () => {
    const current = request();

    expect(acceptedPageRecoveryCandidate(current, {
      candidateId: "control_2",
      confidence: 0.92,
      source: "typesafe",
    })?.id).toBe("control_2");
    expect(acceptedPageRecoveryCandidate(current, {
      candidateId: "control_3",
      confidence: 0.99,
      source: "typesafe",
    })).toBeNull();
    expect(acceptedPageRecoveryCandidate(current, {
      candidateId: "control_2",
      confidence: 0.6,
      source: "typesafe",
    })).toBeNull();
    expect(acceptedPageRecoveryCandidate(current, {
      candidateId: "control_99",
      confidence: 0.99,
      source: "typesafe",
    })).toBeNull();
  });
});
