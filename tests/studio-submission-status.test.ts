// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioSubmissionStatus } from "../src/renderer/components/StudioSubmissionStatus";
import type { Job } from "../src/shared/contracts";

let host: HTMLDivElement, root: Root;
const job = { status: "running", requiresHumanReason: null, errorMessage: null, progressLabel: "已提交到心影，等待生成" } as Job;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps the full status accessible in a quiet task-details link", () => {
  const onDetails = vi.fn();
  act(() => root.render(createElement(StudioSubmissionStatus, { job, label: "生成中", onDetails })));
  const button = host.querySelector("button")!;
  expect(button.type).toBe("button");
  expect(button.title).toContain("已提交到心影，等待生成");
  expect(button.getAttribute("aria-label")).toContain("查看任务详情：生成中");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.querySelector(".warning-box, .status-pill, .button")).toBeNull();
  act(() => button.click()); expect(onDetails).toHaveBeenCalledOnce();
});

it.each(["completed", "cancelled"] as const)("hides %s jobs as before", status => {
  act(() => root.render(createElement(StudioSubmissionStatus, { job: { ...job, status }, label: status, onDetails: vi.fn() })));
  expect(host.textContent).toBe("");
});

it("preserves actionable error reasons without reintroducing a warning panel", () => {
  act(() => root.render(createElement(StudioSubmissionStatus, { job: { ...job, status: "needs-human", requiresHumanReason: "请在原网页处理审核", errorMessage: "旧错误" }, label: "需要人工处理", onDetails: vi.fn() })));
  expect(host.querySelector("button")!.dataset.attention).toBe("true");
  expect(host.textContent).toContain("请在原网页处理审核");
  expect(host.textContent).not.toContain("旧错误");
});

it("retains the queue fallback when no progress message is available", () => {
  act(() => root.render(createElement(StudioSubmissionStatus, { job: { ...job, status: "queued", progressLabel: "" }, label: "排队中", onDetails: vi.fn() })));
  expect(host.textContent).toContain("任务已进入本地队列，等待心影确认");
});
