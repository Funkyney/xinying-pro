// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectConversations } from "../src/renderer/components/ProjectConversations";
import type { PlatformConversation, Project, XinyingApi } from "../src/shared/contracts";

const rows: PlatformConversation[] = [
  { id: "first", projectId: "p", title: "官网置顶对话", isPinned: true, updatedAt: "2026-11-20T00:00:00Z", isCurrent: false },
  { id: "second", projectId: "p", title: "分镜草稿", updatedAt: "2026-11-24T00:00:00Z", isCurrent: true },
];
let host: HTMLDivElement;
let root: Root;
let list: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
let opened: ReturnType<typeof vi.fn>;
const project = (id: string) => ({ id: "local", platformUrl: `https://blueaivideo.com/agentlab?tab=generation&projectId=remote&sessionId=${id}` }) as Project;
function render(overrides: Partial<Parameters<typeof ProjectConversations>[0]> = {}) {
  act(() => root.render(createElement(ProjectConversations, { projectId: "p", projectName: "广告项目", selectedId: "second", onOpened: opened, ...overrides })));
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const item = (title: string) => [...host.querySelectorAll<HTMLButtonElement>(".project-conversation-item")].find((b) => b.textContent?.includes(title))!;
async function settle() { await act(async () => { await Promise.resolve(); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  list = vi.fn().mockResolvedValue(rows); open = vi.fn().mockResolvedValue(project("first")); opened = vi.fn();
  window.xinying = { platformProjects: { conversations: list, open } } as unknown as XinyingApi;
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("official project conversations", () => {
  it("keeps the official order, highlights the APP binding, and saves the draft before selecting an exact ID", async () => {
    const before = vi.fn().mockResolvedValue(undefined);
    render({ beforeOpen: before }); await settle();
    expect(list).toHaveBeenCalledWith("p");
    expect(host.querySelector(".project-conversation-item")?.textContent).toContain("官网置顶对话");
    expect(item("分镜草稿").getAttribute("aria-current")).toBe("true");
    expect(open).not.toHaveBeenCalled();
    await act(async () => item("官网置顶对话").click());
    expect(open).toHaveBeenCalledWith("p", "first");
    expect(before.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
    expect(opened).toHaveBeenCalledWith(project("first"));
  });

  it("filters locally without another network request and supports collapsing the list", async () => {
    render(); await settle();
    act(() => {
      const input = host.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "分镜");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll(".project-conversation-item")).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
    act(() => host.querySelector<HTMLButtonElement>(".conversation-category-toggle")!.click());
    expect(host.querySelector<HTMLElement>(".project-conversation-rows")!.hidden).toBe(true);
  });

  it("creates once on an explicit click, waits for confirmation, and never submits a generation", async () => {
    const pending = deferred<Project>(); open.mockReturnValue(pending.promise);
    const busy = vi.fn(); render({ onBusyChange: busy }); await settle();
    act(() => { button("新建会话").click(); button("新建会话").click(); });
    await settle();
    expect(open).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledWith("p", undefined);
    expect(button("新建会话").disabled).toBe(true); expect(opened).not.toHaveBeenCalled();
    await act(async () => pending.resolve(project("new-confirmed")));
    expect(opened).toHaveBeenCalledWith(project("new-confirmed"));
    expect(host.textContent).toContain("已新建空白会话，未提交生成");
    expect(host.querySelectorAll(".project-conversation-item")).toHaveLength(3);
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });

  it("does not pretend a restored historical conversation is newly created", async () => {
    open.mockResolvedValue(project("second")); render(); await settle();
    await act(async () => button("新建会话").click());
    expect(opened).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("未确认所选对话编号");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("shows load errors distinctly from an empty project and retries without creating anything", async () => {
    list.mockRejectedValueOnce(new Error("心影登录已失效")); render(); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("心影登录已失效");
    expect(host.textContent).not.toContain("暂无对话"); expect(open).not.toHaveBeenCalled();
    await act(async () => button("刷新对话").click());
    expect(host.querySelectorAll(".project-conversation-item")).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores a late response from a previously selected project", async () => {
    const old = deferred<PlatformConversation[]>(); list.mockReturnValueOnce(old.promise);
    render(); render({ projectId: "another", selectedId: "" }); await settle();
    await act(async () => old.resolve([{ ...rows[0], title: "旧项目内容" }]));
    expect(host.textContent).not.toContain("旧项目内容");
    expect(host.querySelectorAll(".project-conversation-item")).toHaveLength(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not switch if saving the local draft failed", async () => {
    render({ beforeOpen: vi.fn().mockRejectedValue(new Error("草稿保存失败")) }); await settle();
    await act(async () => item("官网置顶对话").click());
    expect(open).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("草稿保存失败");
  });
});
