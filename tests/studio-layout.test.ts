// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioParameters } from "../src/renderer/components/StudioParameters";
import { SharedMaterialLibrary } from "../src/renderer/components/SharedMaterialLibrary";
import type { Project, SharedMediaAsset, XinyingApi } from "../src/shared/contracts";
import { projectDraft, type ProjectDraft } from "../src/shared/project-draft";

const project: Project = { id: "local", name: "不应显示的项目名", description: "不应显示的项目说明", prompt: "原提示词",
  modelName: "Seedance 2.5 全能参考", platformUrl: "", platformWorkspaceId: "space", platformProjectId: "project",
  mode: "reference-to-video", aspectRatio: "16:9", duration: 5, resolution: "1080p", audioEnabled: true,
  networkEnabled: true, videoFormat: "mov", portraitIds: [], materialOrder: [], status: "draft", createdAt: "", updatedAt: "" };
let host: HTMLDivElement, root: Root, change: ReturnType<typeof vi.fn>, chooseModel: ReturnType<typeof vi.fn>, sync: ReturnType<typeof vi.fn>;
const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === name)!;
const field = (label: string) => [...host.querySelectorAll("label")].find(node => node.firstChild?.textContent === label)!.querySelector<HTMLSelectElement>("select")!;
const checkbox = (label: string) => [...host.querySelectorAll(".switch-row")].find(node => node.querySelector("strong")?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
function Harness() {
  const [value, setValue] = useState<ProjectDraft>(projectDraft(project));
  return createElement(StudioParameters, { value, project, onModelChange: chooseModel, onChange: patch => { change(patch); setValue(current => ({ ...current, ...patch })); } });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  change = vi.fn(); chooseModel = vi.fn(); sync = vi.fn();
  window.xinying = { generationCapabilities: sync, references: { mediaUrl: (file: string) => `https://fixture.invalid/${file}` } } as unknown as XinyingApi;
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("groups the model and five menu parameters in one tab without project metadata or inspiration", () => {
  act(() => root.render(createElement(Harness)));
  expect(tab("模型").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelectorAll(".studio-model-options select")).toHaveLength(5);
  expect(field("时长").options).toHaveLength(27); expect(field("时长").value).toBe("5");
  expect(field("视频格式").value).toBe("mov");
  expect(host.textContent).not.toContain("不应显示"); expect(host.textContent).not.toContain("灵感镜头");
  expect(host.querySelector<HTMLElement>(".studio-advanced-panel")!.hidden).toBe(true);
  expect(sync).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});

it("updates just the selected parameter and retains the choice across tab switches", () => {
  act(() => root.render(createElement(Harness)));
  const select = field("时长");
  act(() => { select.value = "12"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(change).toHaveBeenCalledExactlyOnceWith({ duration: 12 });
  act(() => tab("高级选项").click()); act(() => tab("模型").click());
  expect(field("时长").value).toBe("12");
  act(() => host.querySelectorAll<HTMLButtonElement>(".model-choice")[1].click());
  expect(chooseModel).toHaveBeenCalledExactlyOnceWith("Seedance 2.0 全能参考");
});

it("places all six advanced switches together and preserves draft-mode constraints", () => {
  act(() => root.render(createElement(Harness)));
  act(() => tab("高级选项").click());
  expect(host.querySelector<HTMLElement>(".studio-advanced-panel")!.hidden).toBe(false);
  expect(host.querySelectorAll(".studio-advanced-panel input[type=checkbox]")).toHaveLength(6);
  expect(checkbox("自动图片人像审核").checked).toBe(true);
  act(() => checkbox("样片模式").click());
  expect(change).toHaveBeenLastCalledWith({ draftMode: true, resolution: "480p", videoFormat: "mp4", smartBalance: false });
  expect(checkbox("智能均衡模式").disabled).toBe(true);
  act(() => tab("模型").click());
  expect(field("分辨率").disabled).toBe(true); expect(field("分辨率").value).toBe("480p");
  expect(field("视频格式").disabled).toBe(true); expect(field("视频格式").value).toBe("mp4");
});

it("supports arrow, Home and End navigation with one tab stop", () => {
  act(() => root.render(createElement(Harness)));
  act(() => { tab("模型").focus(); tab("模型").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(document.activeElement).toBe(tab("高级选项")); expect(tab("高级选项").tabIndex).toBe(0); expect(tab("模型").tabIndex).toBe(-1);
  act(() => tab("高级选项").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(tab("模型"));
  act(() => tab("模型").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(tab("高级选项")); expect(change).not.toHaveBeenCalled();
});

it("uses a single disabled MP4 menu and caps duration for Seedance 2.0", () => {
  const value = projectDraft({ ...project, modelName: "Seedance 2.0 全能参考", videoFormat: "mp4" });
  act(() => root.render(createElement(StudioParameters, { value, project, onChange: change, onModelChange: chooseModel })));
  expect(field("时长").options).toHaveLength(12);
  expect(field("视频格式").disabled).toBe(true); expect(field("视频格式").value).toBe("mp4");
  expect(checkbox("样片模式").disabled).toBe(true);
});

it("does not mount shared media until expanded and remembers the user's disclosure preference", () => {
  const asset = { id: "asset", name: "共享图片.png", filePath: "image.png", mediaKind: "image" } as SharedMediaAsset;
  const toggleAsset = vi.fn();
  const render = () => act(() => root.render(createElement(SharedMaterialLibrary, { assets: [asset], portraits: [], references: [], materialOrder: [], materialLabels: [], onUpload: vi.fn(), onSyncPortraits: vi.fn(), onToggleAsset: toggleAsset, onDeleteAsset: vi.fn(), onTogglePortrait: vi.fn() })));
  render();
  expect(host.querySelector("img, video, audio, .shared-library-card")).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>(".studio-disclosure-toggle")!.click());
  expect(host.querySelector("img")).not.toBeNull();
  act(() => host.querySelector<HTMLElement>(".shared-library-card")!.click()); expect(toggleAsset).toHaveBeenCalledExactlyOnceWith(asset);
  act(() => root.unmount()); root = createRoot(host); render();
  expect(host.querySelector(".studio-disclosure-toggle")?.getAttribute("aria-expanded")).toBe("true");
  act(() => host.querySelector<HTMLButtonElement>(".studio-disclosure-toggle")!.click());
  expect(host.querySelector("img, audio, video")).toBeNull();
});
