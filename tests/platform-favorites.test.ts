import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { attachPlatformFavorites, platformFavoriteFlag } from "../src/shared/platform-favorites";
import { readPlatformFavoriteVideos } from "../src/main/platform-favorites";
import { adapterInternals } from "../src/main/playwright-adapter";
import { createAppPaths } from "../src/core/paths";
import { XinyingDatabase } from "../src/core/database";
import { XinyingService } from "../src/core/service";
import type { PlatformResult } from "../src/shared/contracts";

const url = (name: string) => `https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/model/${name}`;
const record = (id: string, extra: Partial<PlatformResult> = {}): PlatformResult => ({
  id, projectId: "local", platformProjectId: "remote", platformTaskId: "task", jobId: null, source: "personal", mediaKind: "video",
  name: "clip.mp4", prompt: "", outputUrl: url("one.mp4"), outputPath: null, previewUrl: null, marked: false, available: true,
  createdAt: "2026-11-25", lastSeenAt: "2026-11-25", ...extra,
});

describe("website favorite flags", () => {
  it("distinguishes confirmed unfavorite from unknown without coercing strings", () => {
    expect(platformFavoriteFlag({ tag_list: ["liked"] })).toBe(true);
    for (const raw of [{ tag_list: [] }, { tag_list: null }, { is_liked: false }, { liked_status: 0 }]) expect(platformFavoriteFlag(raw)).toBe(false);
    for (const raw of [{}, { tag_list: "liked" }, { is_liked: "false" }, { liked_status: "1" }]) expect(platformFavoriteFlag(raw)).toBeUndefined();
    expect(platformFavoriteFlag({ is_liked: true })).toBe(true);
    expect(platformFavoriteFlag({ liked_status: 1 })).toBe(true);
  });
  it("matches original/MOV/quality variants, not unrelated clips or image types", () => {
    const rows = attachPlatformFavorites([record("original"), record("mov", { outputUrl: url("one.mov") }), record("preview", { outputUrl: url("one_720p.mp4") }),
      record("other", { outputUrl: url("two.mp4") }), record("image", { mediaKind: "image" }), record("missing", { outputUrl: null })], [url("one.mp4")]);
    expect(rows.map(row => row.platformMarked)).toEqual([true, true, true, false, undefined, undefined]);
    expect(rows.every(row => !row.marked)).toBe(true);
  });
  it("extracts image and video favorites from project material rows", () => {
    for (const kind of ["image", "video"] as const) {
      const result = adapterInternals.platformMaterialResult({ id: "local" } as any, "remote", kind,
        { material_id: "1", material_name: "clip", cdn_url: url("one.mp4"), tag_list: ["liked"] }, "2026-11-25", 0);
      expect(result).toMatchObject({ platformMarked: true, marked: false, mediaKind: kind });
    }
  });
});

describe("read-only website favorite snapshot", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const item = (id: string) => ({ material_id: id, cdn_url: url(`${id}.mp4`), tag_list: ["liked"] });
  const response = (items: unknown[], count = items.length, pages = 1, index = 1) => ({ items, page_info: { total_count: count, total_page: pages, page_index: index } });
  function fixture(responses: unknown[]) {
    const request = vi.fn(async () => { const value = responses.shift(); if (value instanceof Error) throw value; return value; });
    vi.stubGlobal("window", { __: { a: request } });
    vi.stubGlobal("location", { protocol: "https:", hostname: "blueaivideo.com" });
    const evaluate = vi.fn(async (fn, args) => fn(args));
    return { page: { evaluate } as unknown as Page, request, evaluate };
  }
  it("reads all pages with exact project/liked filter and only website's own read client", async () => {
    const { page, request } = fixture([response([item("a")], 2, 2), response([item("b")], 2, 2, 2)]);
    expect(await readPlatformFavoriteVideos(page, "remote-id")).toEqual([url("a.mp4"), url("b.mp4")]);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [key, payload, options] of request.mock.calls as unknown as [string, any, any][]) {
      expect(key).toBe("/materials/list");
      expect(payload).toMatchObject({ project_id: "remote-id", material_type: "video", filter_material_tag_list: ["liked"], page_size: 200 });
      expect(options).toEqual({ needLoading: false });
    }
  });
  it("accepts authoritative empty snapshots including zero total pages", async () => {
    const { page } = fixture([response([], 0, 0)]);
    expect(await readPlatformFavoriteVideos(page, "remote")).toEqual([]);
  });
  it.each([
    [response([item("a")], 2)],
    [response([item("a"), item("a")], 2)],
    [response([{ ...item("a"), tag_list: null }])],
    [{ items: [], page_info: {} }],
    [{ items: [], page_info: { total_count: null, total_page: null, page_index: 1 } }],
    [response([], 1, 501)],
    [response([item("a")], 2, 2), new Error("connection lost")],
    [response([item("a")], 2, 2), response([item("b")], 3, 2, 2)],
    [response([{ ...item("a"), cdn_url: "file:///tmp/a.mp4" }])],
  ])("rejects partial/malformed snapshots instead of silently clearing favorites: %#", async (...responses) => {
    const { page } = fixture(responses);
    await expect(readPlatformFavoriteVideos(page, "remote")).rejects.toThrow(/已保留原有标记/);
  });
  it("times out and rejects invalid origins without calling website APIs", async () => {
    vi.useFakeTimers();
    const { page, request } = fixture([]);
    request.mockImplementation(() => new Promise(() => {}));
    const pending = expect(readPlatformFavoriteVideos(page, "remote")).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(15_000); await pending;
    request.mockClear();
    vi.stubGlobal("location", { protocol: "https:", hostname: "example.com" });
    await expect(readPlatformFavoriteVideos(page, "remote")).rejects.toThrow(/未就绪/);
    expect(request).not.toHaveBeenCalled();
    await expect(readPlatformFavoriteVideos(page, "")).rejects.toThrow(/项目标识/);
  });
});

describe("website favorites persistence independent from local PR annotations", () => {
  let directory: string, database: XinyingDatabase, service: XinyingService, projectId: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-favorites-"));
    const paths = createAppPaths(directory); database = new XinyingDatabase(paths.databasePath); service = new XinyingService(database, paths);
    projectId = service.createProject({ name: "Favorites", platformProjectId: "remote", platformWorkspaceId: "space", platformUrl: "https://blueaivideo.com/agentlab?projectId=remote&sessionId=one" }).id;
  });
  afterEach(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const localRecord = (id: string, projectId: string, extra: Partial<PlatformResult> = {}) => record(id, { projectId, ...extra });
  it("syncs both directions of website state across hidden aliases, never clears local marks or PR points", () => {
    service.syncPlatformResults(projectId, [localRecord("a", projectId, { platformMarked: true }), localRecord("other", projectId, { outputUrl: url("two.mp4") })]);
    expect(service.getResult("a")).toMatchObject({ platformMarked: true, marked: false, clipMarkersMs: [] });
    service.setClipMarker("a", 2080, true);
    service.syncPlatformResults(projectId, [localRecord("new", projectId, { outputUrl: url("one.mov"), platformMarked: false })]);
    expect(service.getResult("new")).toMatchObject({ platformMarked: false, marked: true, clipMarkersMs: [2080] });
    expect(service.getResult("a").platformMarked).toBe(false);
    expect(service.getResult("other").platformMarked).toBeUndefined();
    service.syncPlatformResults(projectId, [localRecord("new", projectId, { outputUrl: url("one.mov") })]);
    expect(service.getResult("new").platformMarked).toBe(false);
  });
  it("shares project library favorites across bindings, preserves unknown and survives reopen", () => {
    const b = service.createProject({ name: "binding2", platformProjectId: "remote", platformWorkspaceId: "space" });
    const c = service.createProject({ name: "different", platformProjectId: "different", platformWorkspaceId: "space" });
    service.syncPlatformResults(projectId, [localRecord("a", projectId)]);
    service.syncPlatformResults(b.id, [localRecord("b", b.id, { source: "project", platformMarked: true })], "project");
    service.syncPlatformResults(c.id, [localRecord("c", c.id, { platformProjectId: "different" })]);
    expect(service.getResult("a").platformMarked).toBe(true);
    expect(service.getResult("c").platformMarked).toBeUndefined();
    service.markResults(["a"], true); service.markResults(["a"], false);
    service.syncPlatformResults(projectId, [localRecord("a", projectId)]);
    const paths = service.paths; database.close(); database = new XinyingDatabase(paths.databasePath); service = new XinyingService(database, paths);
    expect(service.getResult("a")).toMatchObject({ platformMarked: true, marked: false });
    service.syncPlatformResults(b.id, [localRecord("b", b.id, { source: "project", platformMarked: false })], "project");
    expect(service.getResult("a").platformMarked).toBe(false);
  });
});
