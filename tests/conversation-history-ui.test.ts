// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationHistory, HistoryMaterialTray } from "../src/renderer/components/ConversationHistory";
import type { ConversationHistoryEntry, ConversationHistoryPage, ConversationHistorySource, XinyingApi } from "../src/shared/contracts";

let host: HTMLDivElement, root: Root, history: ReturnType<typeof vi.fn>, edit: ReturnType<typeof vi.fn>;
const entry = (id: string): ConversationHistoryEntry => ({ eventId: id, prompt: `提示词 ${id}`, status: "completed", createdAt: "", previewUrl: null, outputUrl: null,
  settings: { modelName: "Seedance 2.5 全能参考", duration: 10, aspectRatio: "9:16" },
  source: { remoteProjectId: "remote", sessionId: "a", eventId: id, prompt: `提示词 ${id}`, materials: [] }, editUnavailableReason: "" });
const page = (sessionId = "a", ids = ["123"]): ConversationHistoryPage => ({ sessionId, entries: ids.map(entry), hasMore: true, beforeEventId: ids.at(-1)! });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
const render = (sessionId = "a") => act(() => root.render(createElement(ConversationHistory, { projectId: "local", sessionId, onEdit: edit })));
const settle = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("xinying:studio-disclosure:v1:history", "open");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  history = vi.fn().mockResolvedValue(page()); edit = vi.fn();
  window.xinying = { platformProjects: { history } } as unknown as XinyingApi;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("starts collapsed without history/media requests, loads on demand and releases playback on collapse", async () => {
  localStorage.clear();
  history.mockResolvedValue({ ...page(), entries: [{ ...entry("123"), outputUrl: "https://example.com/123.mp4" }] });
  render(); await settle();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(history).not.toHaveBeenCalled(); expect(host.querySelector("article, img, video")).toBeNull();
  await act(async () => toggle.click());
  expect(history).toHaveBeenCalledTimes(1);
  act(() => host.querySelector("article")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(host.querySelector("video")).not.toBeNull();
  act(() => toggle.click());
  expect(host.querySelector("video")).toBeNull();
  expect(localStorage.getItem("xinying:studio-disclosure:v1:history")).toBe("closed");
  await act(async () => toggle.click());
  expect(history).toHaveBeenCalledTimes(1); expect(host.querySelector("video")).toBeNull();
  expect(edit).not.toHaveBeenCalled();
});

it("loads the exact conversation without editing or submitting, then explicitly fills the selected record", async () => {
  render(); await settle(); expect(history).toHaveBeenCalledExactlyOnceWith("local", "a", undefined); expect(edit).not.toHaveBeenCalled();
  act(() => button("重新编辑").click()); expect(edit).toHaveBeenCalledExactlyOnceWith(entry("123"));
});
it("loads earlier records, de-duplicates IDs, and leaves draft unchanged on refresh errors", async () => {
  render(); await settle(); history.mockResolvedValueOnce(page("a", ["123", "100"]));
  await act(async () => button("加载更早记录").click()); expect(history).toHaveBeenLastCalledWith("local", "a", "123");
  expect(host.querySelectorAll("article")).toHaveLength(2);
  history.mockRejectedValueOnce(Error("连接失败")); await act(async () => button("刷新记录").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("连接失败"); expect(host.querySelectorAll("article")).toHaveLength(2); expect(edit).not.toHaveBeenCalled();
});
it("ignores stale responses after switching conversations and never displays an old session's entries", async () => {
  let complete!: (value: ConversationHistoryPage) => void;
  history.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; })).mockResolvedValueOnce(page("b", ["456"]));
  render(); render("b"); await settle();
  await act(async () => complete(page("a", ["999"])));
  expect(host.textContent).toContain("提示词 456"); expect(host.textContent).not.toContain("提示词 999");
});
it("reports a scope mismatch instead of presenting someone else's generation history", async () => {
  history.mockResolvedValueOnce(page("wrong")); render(); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("其他对话"); expect(host.querySelectorAll("article")).toHaveLength(0);
});

it("loads only the hovered video, pauses/releases on leave and never edits the draft", async () => {
  const rows = page("a", ["123", "122"]);
  rows.entries.forEach(row => { row.outputUrl = `https://example.com/${row.eventId}.mp4`; });
  history.mockResolvedValue(rows); render(); await settle();
  expect(host.querySelector("video")).toBeNull();
  const cards = host.querySelectorAll("article");
  act(() => cards[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(host.querySelectorAll("video")).toHaveLength(1);
  const video = host.querySelector("video")!;
  expect(video.muted).toBe(true); expect(video.loop).toBe(true); expect(video.src).toBe("https://example.com/123.mp4");
  act(() => cards[0].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  expect(host.querySelector("video")).toBeNull(); expect(video.getAttribute("src")).toBeNull();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
});

it("opens an accessible portal viewer without editing, closes on Escape and restores focus", async () => {
  const row = { ...entry("123"), outputUrl: "https://example.com/123.mp4" };
  history.mockResolvedValue({ ...page(), entries: [row] }); render(); await settle();
  const cover = host.querySelector<HTMLButtonElement>(".conversation-history-cover")!;
  act(() => { cover.focus(); cover.click(); });
  const dialog = document.querySelector<HTMLDialogElement>(".history-result-viewer")!;
  expect(dialog.open).toBe(true); expect(host.contains(dialog)).toBe(false);
  const video = dialog.querySelector("video")!;
  expect(video.controls).toBe(true); expect(video.playsInline).toBe(true);
  expect(host.querySelector("video")).toBeNull(); expect(edit).not.toHaveBeenCalled();
  act(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(document.querySelector(".history-result-viewer")).toBeNull(); expect(document.activeElement).toBe(cover);
});

it("supports image viewing, playback errors, and explicit edit from preview without submitting", async () => {
  const row = { ...entry("123"), outputUrl: "https://example.com/123.mp4" };
  history.mockResolvedValue({ ...page(), entries: [row] }); render(); await settle();
  act(() => host.querySelector<HTMLButtonElement>(".conversation-history-cover")!.click());
  let dialog = document.querySelector<HTMLDialogElement>(".history-result-viewer")!;
  act(() => dialog.querySelector("video")!.dispatchEvent(new Event("error")));
  expect(dialog.textContent).toContain("暂时无法播放");
  act(() => [...dialog.querySelectorAll("button")].find(button => button.textContent === "重新编辑")!.click());
  expect(edit).toHaveBeenCalledExactlyOnceWith(row); expect(document.querySelector(".history-result-viewer")).toBeNull();
  history.mockResolvedValue({ ...page("b"), entries: [{ ...entry("456"), mediaKind: "image", outputUrl: "https://example.com/image.png" }] });
  render("b"); await settle();
  act(() => host.querySelector<HTMLButtonElement>(".conversation-history-cover")!.click());
  dialog = document.querySelector<HTMLDialogElement>(".history-result-viewer")!;
  expect(dialog.querySelector("img")?.src).toBe("https://example.com/image.png"); expect(dialog.querySelector("video")).toBeNull();
  history.mockResolvedValue(page("c")); render("c"); await settle();
  expect(document.querySelector(".history-result-viewer")).toBeNull();
});

it("renders legacy PNG references without the invalid video-frame transform and preserves numbering", () => {
  const source = { ...entry("123").source, materials: [
    { key: "image:0", kind: "image", name: "人物.png", previewUrl: "https://example.com/person.png?x-tos-process=video/snapshot,t_0,f_jpg", label: "@图1" },
    { key: "image:1", kind: "image", name: "场景.png", previewUrl: "https://example.com/scene.png", label: "@图2" },
  ] } as ConversationHistorySource;
  act(() => root.render(createElement(HistoryMaterialTray, { source, onExit: vi.fn() })));
  expect([...host.querySelectorAll("img")].map((img) => img.src)).toEqual(["https://example.com/person.png", "https://example.com/scene.png"]);
  expect([...host.querySelectorAll("figcaption strong")].map((label) => label.textContent)).toEqual(["@图1", "@图2"]);
  expect(source.materials[0].previewUrl).toContain("video/snapshot");
  expect(history).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
});

it("falls back to the original once, then shows a clean placeholder without broken filename text or retry loops", () => {
  const source: ConversationHistorySource = { ...entry("123").source, materials: [
    { key: "image:0", kind: "image", name: "人物.png", previewUrl: "https://example.com/thumb.jpg", originalUrl: "https://example.com/original.png", label: "@图1" },
  ] };
  const show = (value = source) => act(() => root.render(createElement(HistoryMaterialTray, { source: value, onExit: vi.fn() })));
  show(); expect(host.querySelector("img")?.src).toBe("https://example.com/thumb.jpg");
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")?.src).toBe("https://example.com/original.png");
  act(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("预览暂不可用");
  expect(host.querySelector("figcaption")?.textContent).toContain("@图1");
  show(); expect(host.querySelector("img")).toBeNull();
  show({ ...source, materials: [{ ...source.materials[0], previewUrl: "https://example.com/new-thumb.jpg" }] });
  expect(host.querySelector("img")?.src).toBe("https://example.com/new-thumb.jpg");
  expect(history).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
});
