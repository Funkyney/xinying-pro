import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppPaths } from "../src/core/paths";
import { XinyingDatabase } from "../src/core/database";
import { XinyingService } from "../src/core/service";
import type { PlatformResult } from "../src/shared/contracts";
import { resultAnnotationGroups, normalizedClipMarkers } from "../src/shared/result-annotations";
import { exportMarkedClip } from "../src/core/export-clip-markers";

describe("PR clip markers", () => {
  let temp: string, database: XinyingDatabase, service: XinyingService, projectId: string;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-markers-test-"));
    const paths = createAppPaths(temp);
    database = new XinyingDatabase(paths.databasePath);
    service = new XinyingService(database, paths);
    projectId = service.createProject({ name: "PR", platformProjectId: "remote", platformWorkspaceId: "space", platformUrl: "https://blueaivideo.com/agentlab?projectId=remote&sessionId=one" }).id;
  });
  afterEach(() => { database.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const url = (name: string) => `https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/model/${name}`;
  function record(id: string, extra: Partial<PlatformResult> = {}): PlatformResult {
    return { id, projectId, platformProjectId: "remote", platformTaskId: "same-task", jobId: null, source: "personal", mediaKind: "video", name: "clip.mp4", prompt: "", outputUrl: url("one.mp4"), outputPath: null, previewUrl: null, marked: false, available: true, createdAt: "2026-11-25", lastSeenAt: "2026-11-25", ...extra };
  }
  it("deduplicates/sorts points, auto-favorites and deletes without unfavoriting", () => {
    service.syncPlatformResults(projectId, [record("a")]);
    expect(service.setClipMarker("a", 2080, true)).toEqual([2080]);
    expect(service.setClipMarker("a", 1000, true)).toEqual([1000, 2080]);
    expect(service.setClipMarker("a", 2080, true)).toEqual([1000, 2080]);
    expect(service.setClipMarker("a", 1000, false)).toEqual([2080]);
    expect(service.getResult("a").marked).toBe(true);
    service.markResults(["a"], false);
    expect(service.getResult("a")).toMatchObject({ marked: false, clipMarkersMs: [2080] });
    service.setClipMarker("a", 2080, true);
    expect(service.getResult("a").marked).toBe(true);
  });
  it("shares annotations across libraries and local bindings, not unrelated outputs", () => {
    const b = service.createProject({ name: "other binding", platformProjectId: "remote", platformWorkspaceId: "space", platformUrl: "https://blueaivideo.com/agentlab?projectId=remote&sessionId=two" });
    service.syncPlatformResults(projectId, [record("a"), record("unrelated", { outputUrl: url("two.mp4") })]);
    service.setClipMarker("a", 1800, true);
    service.syncPlatformResults(b.id, [record("b", { projectId: b.id, outputUrl: url("one.mov"), source: "project" })], "project");
    expect(service.getResult("b")).toMatchObject({ marked: true, clipMarkersMs: [1800] });
    service.setClipMarker("b", 1800, false);
    service.markResults(["b"], false);
    service.syncPlatformResults(projectId, [record("a"), record("unrelated", { outputUrl: url("two.mp4") })]);
    expect(service.getResult("a")).toMatchObject({ marked: false, clipMarkersMs: [] });
    expect(service.getResult("unrelated")).toMatchObject({ marked: false, clipMarkersMs: [] });
  });
  it("persists across sync, hidden aliases and database reopen", () => {
    service.syncPlatformResults(projectId, [record("a")]);
    service.setClipMarker("a", 0, true);
    service.syncPlatformResults(projectId, [record("new-id", { outputUrl: url("one_720p.mp4") })]);
    database.close();
    database = new XinyingDatabase(service.paths.databasePath);
    service = new XinyingService(database, service.paths);
    expect(service.listResults()).toHaveLength(1);
    expect(service.getResult("new-id")).toMatchObject({ marked: true, clipMarkersMs: [0] });
    service.setClipMarker("new-id", 0, false);
    expect(service.getResult("a").clipMarkersMs).toEqual([]);
  });
  it("validates marker input and rejects images/missing records", () => {
    service.syncPlatformResults(projectId, [record("a"), record("image", { mediaKind: "image", name: "a.jpg" })]);
    for (const time of [-1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) expect(() => service.setClipMarker("a", time, true)).toThrow(/无效/);
    expect(() => service.setClipMarker("image", 1, true)).toThrow(/视频/);
    expect(() => service.setClipMarker("missing", 1, true)).toThrow(/视频/);
    expect(() => service.setClipMarker("a", 1, 1 as unknown as boolean)).toThrow(/无效/);
  });
  it("doesn't group by name/task, strip external URL queries or cross remote projects", () => {
    const all = [record("a", { jobId: "same-job" }), record("b", { outputUrl: url("two.mp4"), jobId: "same-job" }), record("c", { platformProjectId: "other" }),
      record("d", { outputUrl: "https://example.com/a.mp4?id=one" }), record("e", { outputUrl: "https://example.com/a.mp4?id=two" })];
    const groups = resultAnnotationGroups(all);
    for (const row of all) expect(groups.get(row.id)).toEqual([row]);
    expect(normalizedClipMarkers([2, 1, 2, -1, NaN, 1.1])).toEqual([1, 2]);
  });
  it("refuses source overwrite, extension disguise and invalid times before export", async () => {
    const source = path.join(temp, "original.mp4"); fs.writeFileSync(source, "preserve");
    await expect(exportMarkedClip(source, source, [1])).rejects.toThrow(/新的导出/);
    await expect(exportMarkedClip(source, path.join(temp, "wrong.mov"), [1])).rejects.toThrow(/不转码/);
    await expect(exportMarkedClip(source, path.join(temp, "wrong.mp4"), [-1])).rejects.toThrow(/无效/);
    expect(fs.readFileSync(source, "utf8")).toBe("preserve");
  });
  it("preserves existing destination and removes only staging on metadata failure", async () => {
    const source = path.join(temp, "broken.mp4"), destination = path.join(temp, "keep.mp4");
    fs.writeFileSync(source, "not a video"); fs.writeFileSync(destination, "keep me");
    await expect(exportMarkedClip(source, destination, [1])).rejects.toThrow(/导出失败/);
    expect(fs.readFileSync(source, "utf8")).toBe("not a video");
    expect(fs.readFileSync(destination, "utf8")).toBe("keep me");
    expect(fs.readdirSync(temp).filter(name => name.startsWith(".xinying-markers-"))).toEqual([]);
  });
});
