// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../src/shared/contracts";
import { useProjectDraft } from "../src/renderer/hooks/use-project-draft";

const original = (): Project => ({ id: "one", name: "测试项目", description: "", prompt: "旧提示词", modelName: "Seedance 2.5 全能参考",
  platformUrl: "https://blueaivideo.com/agentlab?projectId=p&sessionId=a", platformWorkspaceId: "space", platformProjectId: "p",
  mode: "reference-to-video", aspectRatio: "16:9", duration: 5, resolution: "480p", audioEnabled: true,
  videoFormat: "mp4", networkEnabled: true, portraitIds: [], materialOrder: [], status: "draft",
  createdAt: "2026-11-26T01:00:00.000Z", updatedAt: "2026-11-26T01:00:00.000Z" });
let host: HTMLDivElement, root: Root, current: ReturnType<typeof useProjectDraft>, remote: Project;
let update: ReturnType<typeof vi.fn>;
function Harness({ project }: { project: Project }) { current = useProjectDraft(project); return null; }
const mount = (project = remote) => act(() => root.render(createElement(Harness, { project, key: project.id })));
const type = (prompt: string) => act(() => current.setDraft(draft => ({ ...draft, prompt })));

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); remote = original();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  update = vi.fn(async (_id, patch) => remote = { ...remote, ...patch, updatedAt: "2026-11-26T01:01:00.000Z" });
  Object.defineProperty(window, "xinying", { configurable: true, value: { projects: { update } } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("draft autosave lifecycle", () => {
  it("backs up each keystroke synchronously and recovers before the debounce fires", () => {
    mount(); type("最后一个字");
    expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("xinying:studio-draft:v1:one")!).value.prompt).toBe("最后一个字");
    act(() => root.unmount()); root = createRoot(host); mount();
    expect(current.draft.prompt).toBe("最后一个字");
  });

  it("only patches the prompt and accepts a simultaneous server material update", async () => {
    mount(); type("新文本");
    remote = { ...remote, materialOrder: ["reference:new"], updatedAt: "2026-11-26T01:00:30.000Z" }; mount();
    expect(current.draft).toMatchObject({ prompt: "新文本", materialOrder: ["reference:new"] });
    await act(async () => { vi.advanceTimersByTime(601); });
    expect(update).toHaveBeenCalledExactlyOnceWith("one", { prompt: "新文本" });
    expect(localStorage.getItem("xinying:studio-draft:v1:one")).toBeNull();
    mount(original()); // A stale dashboard response must not undo the save.
    expect(current.draft.prompt).toBe("新文本");
  });

  it("serializes writes and keeps text entered during an in-flight save", async () => {
    const resolve: Array<() => void> = [];
    update.mockImplementation((_id, patch) => new Promise(done => resolve.push(() => done(remote = { ...remote, ...patch, updatedAt: "2026-11-26T01:01:00.000Z" }))));
    mount(); type("第一段");
    await act(async () => { vi.advanceTimersByTime(601); });
    type("第一段 + 第二段");
    await act(async () => { vi.advanceTimersByTime(601); });
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => resolve.shift()!());
    expect(update).toHaveBeenCalledTimes(2);
    expect(current.draft.prompt).toBe("第一段 + 第二段");
    await act(async () => resolve.shift()!());
    expect(remote.prompt).toBe("第一段 + 第二段");
    expect(current.saveError).toBe("");
  });

  it("retains recovery data and reports a failed database save", async () => {
    update.mockRejectedValue(new Error("数据库暂忙")); mount(); type("不可丢失");
    await act(async () => { vi.advanceTimersByTime(601); });
    expect(current.saveError).toContain("数据库暂忙");
    expect(current.draft.prompt).toBe("不可丢失");
    expect(JSON.parse(localStorage.getItem("xinying:studio-draft:v1:one")!).value.prompt).toBe("不可丢失");
  });

  it("an unmounted editor's save cannot erase a newer editor's recovery", async () => {
    let finish!: (project: Project) => void;
    update.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount(); type("先前文本"); await act(async () => { vi.advanceTimersByTime(601); });
    type("旧窗口尚未发出的第二段");
    act(() => root.unmount()); root = createRoot(host); mount(); type("新窗口文本");
    await act(async () => finish({ ...remote, prompt: "先前文本", updatedAt: "2026-11-26T01:01:00.000Z" }));
    expect(current.draft.prompt).toBe("新窗口文本");
    expect(JSON.parse(localStorage.getItem("xinying:studio-draft:v1:one")!).value.prompt).toBe("新窗口文本");
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(601); });
    expect(remote.prompt).toBe("新窗口文本");
  });
});
