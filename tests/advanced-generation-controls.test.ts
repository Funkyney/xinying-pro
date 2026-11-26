// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdvancedGenerationControls } from "../src/renderer/components/AdvancedGenerationControls";
import type { GenerationCapabilities, GenerationOptions, XinyingApi } from "../src/shared/contracts";

let host: HTMLDivElement;
let root: Root;
let sync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  sync = vi.fn();
  window.xinying = { generationCapabilities: sync } as unknown as XinyingApi;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(value: GenerationOptions & { modelName?: string }, onChange = vi.fn()) {
  act(() => root.render(createElement(AdvancedGenerationControls, { value, onChange })));
  return onChange;
}

function checkbox(label: string): HTMLInputElement {
  const row = [...host.querySelectorAll(".switch-row")].find((element) => element.querySelector("strong")?.textContent === label);
  if (!row) throw new Error(`Missing switch: ${label}`);
  return row.querySelector("input")!;
}

function syncButton(): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find((button) => /同步官网选项|读取中/.test(button.textContent ?? ""))!;
}

describe("official generation controls", () => {
  it("disables unsupported Seedance options without requiring an extra network request", () => {
    render({ modelName: "Seedance 2.0 全能参考" });
    expect(checkbox("自动图片人像审核").checked).toBe(true);
    expect(checkbox("提示词优化").disabled).toBe(true);
    expect(checkbox("样片模式").disabled).toBe(true);
    expect(checkbox("智能均衡模式").disabled).toBe(false);
    expect(sync).not.toHaveBeenCalled();

    render({ modelName: "Seedance 2.5 全能参考" });
    expect(checkbox("样片模式").disabled).toBe(false);
  });

  it("lets live account capability flags override the verified defaults", async () => {
    sync.mockResolvedValue({ models: [{ name: "Seedance 2.5 全能参考", autoPortraitAudit: false,
      promptOptimizer: true, draftMode: false, smartBalance: false, inspiration: false }], inspirations: {} } satisfies GenerationCapabilities);
    const change = render({ modelName: "Seedance 2.5 全能参考" });
    await act(async () => syncButton().click());
    expect(sync).toHaveBeenCalledTimes(1);
    expect(checkbox("提示词优化").disabled).toBe(false);
    expect(checkbox("样片模式").disabled).toBe(true);
    // An unsupported saved option may still be turned off; it is never silently
    // reset, and the submission adapter must independently verify the website.
    expect(checkbox("自动图片人像审核").disabled).toBe(false);
    act(() => checkbox("自动图片人像审核").click());
    expect(change).toHaveBeenCalledWith({ autoPortraitAudit: false });
  });

  it("passes the draft constraints atomically and prevents smart balance in draft mode", () => {
    const change = render({ modelName: "Seedance 2.5 全能参考", smartBalance: true });
    act(() => checkbox("样片模式").click());
    expect(change).toHaveBeenCalledWith({ draftMode: true, resolution: "480p", videoFormat: "mp4", smartBalance: false });
    render({ modelName: "Seedance 2.5 全能参考", draftMode: true, smartBalance: true });
    expect(checkbox("智能均衡模式").disabled).toBe(true);
    expect(checkbox("智能均衡模式").checked).toBe(false);
  });

  it("shows a failed capability query and leaves a retry available", async () => {
    sync.mockRejectedValue(new Error("心影登录已失效"));
    render({ modelName: "Seedance 2.5 全能参考" });
    await act(async () => syncButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("心影登录已失效");
    expect(syncButton().disabled).toBe(false);
  });
});
