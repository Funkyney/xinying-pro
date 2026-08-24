import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Sqlite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppPaths } from "../src/core/paths";
import { XinyingDatabase } from "../src/core/database";
import { XinyingService } from "../src/core/service";
import { referenceMaterialKey } from "../src/shared/material-order";
import type { DirectorManifest } from "../src/shared/contracts";

describe("XinyingService", () => {
  let tempDir: string;
  let database: XinyingDatabase;
  let service: XinyingService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-director-test-"));
    const paths = createAppPaths(tempDir);
    database = new XinyingDatabase(paths.databasePath);
    service = new XinyingService(database, paths);
    const createProject = service.createProject.bind(service);
    service.createProject = (input) => createProject({
      platformWorkspaceId: "workspace-team",
      platformProjectId: "platform-project",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project&sessionId=test-session",
      ...input,
    });
  });

  afterEach(() => {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fixture(name: string, content: string): string {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("creates and updates a project", () => {
    const project = service.createProject({ name: "产品广告" });
    expect(project.mode).toBe("reference-to-video");
    expect(project.modelName).toBe("Seedance 2.5 全能参考");
    expect(project.resolution).toBe("auto");
    const platformUrl = "https://blueaivideo.com/avpAgent?projectId=test-project&sessionId=test-session";
    const updated = service.updateProject(project.id, { prompt: "镜头缓慢推近", aspectRatio: "9:16", platformUrl });
    expect(updated.prompt).toBe("镜头缓慢推近");
    expect(updated.aspectRatio).toBe("9:16");
    expect(updated.platformUrl).toContain("sessionId=test-session");
  });

  it("builds a deduplicated shared image, video, and audio library", () => {
    const image = fixture("library-image.png", "image-bytes");
    const duplicateImage = fixture("same-image.png", "image-bytes");
    const video = fixture("library-video.mp4", "video-bytes");
    const audio = fixture("library-audio.mp3", "audio-bytes");

    const library = service.addSharedMedia([image, duplicateImage, video, audio]);
    expect(library).toHaveLength(3);
    expect(library.map((asset) => asset.mediaKind).sort()).toEqual(["audio", "image", "video"]);
    expect(library.every((asset) => asset.filePath.startsWith(service.paths.sharedMediaDir))).toBe(true);
    expect(library.every((asset) => fs.existsSync(asset.filePath))).toBe(true);
  });

  it("reuses shared media across projects without coupling project copies to the library master", () => {
    const source = fixture("shared-product.png", "shared-product-image");
    const [shared] = service.addSharedMedia([source]);
    const firstProject = service.createProject({ name: "共享素材项目一" });
    const secondProject = service.createProject({ name: "共享素材项目二" });

    const firstReferences = service.addSharedMediaToProject(firstProject.id, shared.id);
    const secondReferences = service.addSharedMediaToProject(secondProject.id, shared.id);
    expect(firstReferences[0].sourceSharedMediaId).toBe(shared.id);
    expect(secondReferences[0].sourceSharedMediaId).toBe(shared.id);
    expect(firstReferences[0].filePath).not.toBe(secondReferences[0].filePath);
    expect(firstReferences[0].filePath).not.toBe(shared.filePath);
    expect(service.addSharedMediaToProject(firstProject.id, shared.id)).toHaveLength(1);

    service.removeSharedMedia(shared.id);
    expect(service.listSharedMedia()).toEqual([]);
    expect(fs.existsSync(firstReferences[0].filePath)).toBe(true);
    expect(fs.existsSync(secondReferences[0].filePath)).toBe(true);
    expect(service.listReferences(firstProject.id)[0].sourceSharedMediaId).toBeNull();
    expect(service.listReferences(secondProject.id)[0].sourceSharedMediaId).toBeNull();
  });

  it("automatically publishes direct project uploads and removes only the selected project copy", () => {
    const source = fixture("direct-audio.wav", "audio-reference");
    const project = service.createProject({ name: "直接上传同步共享库" });
    const [reference] = service.addReferences(project.id, [source]);
    const [shared] = service.listSharedMedia();
    expect(shared.name).toBe("direct-audio.wav");
    expect(reference.sourceSharedMediaId).toBe(shared.id);

    expect(service.removeSharedMediaFromProject(project.id, shared.id)).toEqual([]);
    expect(service.listSharedMedia()).toHaveLength(1);
    expect(fs.existsSync(shared.filePath)).toBe(true);
  });

  it("backfills existing unlinked project references into the shared library on startup", () => {
    const project = service.createProject({ name: "旧素材回填" });
    const [reference] = service.addReferences(project.id, [fixture("legacy-scene.png", "legacy-scene")]);
    const [oldShared] = service.listSharedMedia();
    service.removeSharedMedia(oldShared.id);
    expect(service.listReferences(project.id)[0].sourceSharedMediaId).toBeNull();
    database.db.prepare("DELETE FROM settings WHERE key = 'shared_media_library_migration_v1'").run();

    database.close();
    const paths = createAppPaths(tempDir);
    database = new XinyingDatabase(paths.databasePath);
    service = new XinyingService(database, paths);
    const [backfilled] = service.listSharedMedia();
    expect(backfilled.name).toBe("legacy-scene.png");
    expect(service.listReferences(project.id)[0]).toMatchObject({ id: reference.id, sourceSharedMediaId: backfilled.id });

    service.removeSharedMedia(backfilled.id);
    database.close();
    database = new XinyingDatabase(paths.databasePath);
    service = new XinyingService(database, paths);
    expect(service.listSharedMedia()).toEqual([]);
    expect(service.listReferences(project.id)[0].sourceSharedMediaId).toBeNull();
  });

  it("blocks generation until a Heart workspace and project are selected", () => {
    const project = service.createProject({
      name: "未绑定项目",
      prompt: "固定机位",
      mode: "text-to-video",
      platformWorkspaceId: "",
      platformProjectId: "",
      platformUrl: "",
    });
    const preview = service.previewSubmission(project.id);
    expect(preview.ready).toBe(false);
    expect(preview.warnings.some((warning) => warning.includes("空间") && warning.includes("项目"))).toBe(true);
    expect(() => service.submitGeneration(project.id)).toThrow(/提交条件/);
  });

  it("persists personal and team workspaces and binds a selected Heart project", () => {
    const catalog = service.syncPlatformCatalog({
      workspaces: [
        { id: "team", name: "团队空间", kind: "team", sortOrder: 1, isCurrent: true },
        { id: "personal", name: "个人空间", kind: "personal", sortOrder: 0, isCurrent: false },
      ],
      projects: [
        { id: "team:remote-1", workspaceId: "team", remoteId: "remote-1", name: "共享项目", shortId: "000001", sortOrder: 0, isCurrent: true },
      ],
      currentWorkspaceId: "team",
      currentProjectId: "team:remote-1",
      customerOptions: ["客户A", "客户A", "客户B"],
      creationTypeOptions: ["类型A"],
      syncedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(catalog.workspaces.map((workspace) => workspace.kind)).toEqual(["personal", "team"]);
    expect(catalog.customerOptions).toEqual(["客户A", "客户B"]);

    const bound = service.bindPlatformProject({
      workspace: catalog.workspaces[1],
      project: catalog.projects[0],
      generationUrl: "https://blueaivideo.com/avpAgent?projectId=remote-1&sessionId=session-1",
    });
    expect(bound.platformWorkspaceId).toBe("team");
    expect(bound.platformProjectId).toBe("team:remote-1");
    expect(service.getPlatformCatalog().currentProjectId).toBe("team:remote-1");
  });

  it("keeps a discovered full Heart project id across later catalog refreshes", () => {
    const initial = service.syncPlatformCatalog({
      workspaces: [{ id: "team", name: "团队空间", kind: "team", sortOrder: 0, isCurrent: true }],
      projects: [{
        id: "team:project-a", workspaceId: "team", remoteId: "full-remote-project-id", name: "项目A",
        shortId: "000001", homeUrl: "https://blueaivideo.com/home?projectId=full-remote-project-id", sortOrder: 0, isCurrent: true,
      }],
      currentWorkspaceId: "team",
      currentProjectId: "team:project-a",
      customerOptions: [],
      creationTypeOptions: [],
      syncedAt: "2026-08-21T00:00:00.000Z",
    });
    expect(initial.projects[0].remoteId).toBe("full-remote-project-id");

    const refreshed = service.syncPlatformCatalog({
      ...initial,
      projects: [{ ...initial.projects[0], remoteId: "", homeUrl: "", isCurrent: false }],
      currentProjectId: "",
      syncedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(refreshed.projects[0].remoteId).toBe("full-remote-project-id");
    expect(refreshed.projects[0].homeUrl).toContain("full-remote-project-id");
  });

  it("migrates an existing project database without losing rows", () => {
    database.close();
    const databasePath = path.join(tempDir, "xinying.sqlite3");
    fs.rmSync(databasePath, { force: true });
    const legacy = new Sqlite(databasePath);
    legacy.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'reference-to-video', aspect_ratio TEXT NOT NULL DEFAULT '16:9', duration INTEGER NOT NULL DEFAULT 5,
      resolution TEXT NOT NULL DEFAULT '720p', audio_enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    legacy.prepare("INSERT INTO projects VALUES (?, ?, '', '', 'reference-to-video', '16:9', 5, '720p', 1, 'draft', ?, ?)")
      .run("legacy", "旧项目", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.close();

    database = new XinyingDatabase(databasePath);
    service = new XinyingService(database, createAppPaths(tempDir));
    const migrated = service.getProject("legacy");
    expect(migrated.name).toBe("旧项目");
    expect(migrated.modelName).toBe("Seedance 2.5 全能参考");
    expect(migrated.platformUrl).toBe("");
  });

  it("rejects unsafe platform URLs and out-of-range durations", () => {
    expect(() => service.createProject({ name: "错误链接", platformUrl: "https://example.com/avpAgent?projectId=a&sessionId=b" })).toThrow(/心影/);
    expect(() => service.createProject({ name: "错误时长", duration: 2 })).toThrow(/4 到 30/);
    expect(() => service.createProject({ name: "错误分辨率", resolution: "8K" })).toThrow(/分辨率/);
  });

  it("allows a newly created Heart project before its first session id exists", () => {
    const project = service.createProject({
      name: "新心影项目",
      platformWorkspaceId: "personal",
      platformProjectId: "catalog-project",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=remote-project",
    });
    expect(project.platformUrl).toContain("projectId=remote-project");
    expect(project.platformUrl).not.toContain("sessionId=");
    expect(() => service.createProject({ name: "缺项目编号", platformUrl: "https://blueaivideo.com/avpAgent?sessionId=session" })).toThrow(/projectId/);
  });

  it("matches the live Heart capabilities for Seedance 2.0 and 2.5", () => {
    const fourK = service.createProject({
      name: "2.0 4K",
      modelName: "Seedance 2.0 全能参考",
      mode: "reference-to-video",
      resolution: "4k",
      duration: 15,
    });
    expect(fourK.resolution).toBe("4k");
    expect(() => service.createProject({ name: "2.0 超时", modelName: "Seedance 2.0 全能参考", duration: 16 })).toThrow(/4 到 15/);
    expect(() => service.createProject({ name: "2.0 文生", modelName: "Seedance 2.0 全能参考", mode: "text-to-video" })).toThrow(/不支持该生成模式/);
    expect(() => service.createProject({ name: "2.5 伪4K", modelName: "Seedance 2.5 全能参考", resolution: "4k" })).toThrow(/不支持分辨率/);
    expect(service.createProject({ name: "2.5 30秒", modelName: "Seedance 2.5 全能参考", duration: 30 }).duration).toBe(30);
  });

  it("preserves explicit reference order and roles", () => {
    const project = service.createProject({ name: "排序测试" });
    const first = fixture("first.png", "first");
    const second = fixture("second.png", "second");
    const added = service.addReferences(project.id, [first, second]);
    expect(added.map((item) => item.position)).toEqual([0, 1]);
    expect(added[0].role).toBe("first-frame");

    const reordered = service.reorderReferences(project.id, [added[1].id, added[0].id]);
    expect(reordered.map((item) => item.name)).toEqual(["second.png", "first.png"]);
    const role = service.updateReferenceRole(reordered[0].id, "product");
    expect(role.role).toBe("product");
    expect(() => service.reorderReferences(project.id, [added[0].id, added[0].id])).toThrow(/完整包含/);
    expect(() => service.updateReferenceRole(reordered[0].id, "invalid" as never)).toThrow(/素材用途/);
  });

  it("validates every imported reference before copying any project asset", () => {
    const project = service.createProject({ name: "导入预检" });
    expect(() => service.addReferences(project.id, [fixture("valid.png", "valid"), path.join(tempDir, "missing.png")])).toThrow(/找不到文件/);
    expect(service.listReferences(project.id)).toEqual([]);
    const projectDir = path.join(service.paths.assetsDir, project.id);
    expect(fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : []).toEqual([]);
  });

  it("requires exactly two ordered roles for first/last-frame mode", () => {
    const project = service.createProject({ name: "首尾帧", prompt: "人物从远处走近", mode: "first-last-frame", modelName: "Seedance 2.5 首尾帧" });
    const one = service.addReferences(project.id, [fixture("start.png", "start")]);
    expect(service.previewSubmission(project.id).ready).toBe(false);
    const two = service.addReferences(project.id, [fixture("end.png", "end")]);
    service.updateReferenceRole(one[0].id, "first-frame");
    service.updateReferenceRole(two[1].id, "last-frame");
    expect(service.previewSubmission(project.id).ready).toBe(true);

    const mismatch = service.createProject({ name: "模型不匹配", prompt: "固定机位", mode: "text-to-video", modelName: "Seedance 2.5 首尾帧" });
    expect(service.previewSubmission(mismatch.id).warnings).toContain("当前生成模式与首尾帧模型不匹配");
  });

  it("accepts image, video, and Heart-supported wav/mp3 audio references with independent numbering", () => {
    const project = service.createProject({ name: "多模态素材", prompt: "@图1、@视频1、@音频1、@图2依次参考" });
    const references = service.addReferences(project.id, [
      fixture("image-a.png", "image-a"),
      fixture("motion.mov", "video"),
      fixture("voice.wav", "audio"),
      fixture("image-b.jpg", "image-b"),
    ]);
    expect(references.map((item) => item.mimeType)).toEqual(["image/png", "video/quicktime", "audio/wav", "image/jpeg"]);
    expect(references.map((item) => item.role)).toEqual(["first-frame", "motion", "other", "other"]);
    expect(service.previewSubmission(project.id).orderedLabels.map((label) => label.split(" / ")[0])).toEqual(["@图1", "@视频1", "@音频1", "@图2"]);
    expect(service.previewSubmission(project.id).ready).toBe(true);
    expect(() => service.authorizeReference(references[2].id, project.id, true)).toThrow(/音频参考不能授权/);
    expect(() => service.addReferences(project.id, [fixture("unsupported.m4a", "audio")])).toThrow(/不支持/);
  });

  it("batch replaces files without changing reference ids or positions", () => {
    const project = service.createProject({ name: "批量替换" });
    const original = service.addReferences(project.id, [fixture("a.png", "a"), fixture("b.png", "b")]);
    const replaced = service.batchReplaceReferences(project.id, [fixture("c.png", "c"), fixture("d.png", "d")]);
    expect(replaced.map((item) => item.id)).toEqual(original.map((item) => item.id));
    expect(replaced.map((item) => item.name)).toEqual(["c.png", "d.png"]);
    expect(replaced.map((item) => item.position)).toEqual([0, 1]);
    expect(fs.readdirSync(path.dirname(replaced[0].filePath)).some((name) => name.startsWith(".replace-") || name.startsWith(".backup-"))).toBe(false);
  });

  it("validates every batch replacement before changing the first slot", () => {
    const project = service.createProject({ name: "批量替换预检" });
    const original = service.addReferences(project.id, [fixture("old-1.png", "old-1"), fixture("old-2.png", "old-2")]);
    expect(() => service.batchReplaceReferences(project.id, [fixture("new-1.png", "new-1"), path.join(tempDir, "missing.png")])).toThrow(/找不到文件/);
    const unchanged = service.listReferences(project.id);
    expect(unchanged.map((item) => item.name)).toEqual(original.map((item) => item.name));
    expect(unchanged.map((item) => item.sha256)).toEqual(original.map((item) => item.sha256));
  });

  it("deletes a middle reference and closes the numbering gap", () => {
    const project = service.createProject({ name: "删除中间参考图" });
    const references = service.addReferences(project.id, [
      fixture("one.png", "one"),
      fixture("two.png", "two"),
      fixture("three.png", "three"),
    ]);
    const removedPath = references[1].filePath;

    service.removeReference(references[1].id);

    const remaining = service.listReferences(project.id);
    expect(remaining.map((item) => item.id)).toEqual([references[0].id, references[2].id]);
    expect(remaining.map((item) => item.position)).toEqual([0, 1]);
    expect(service.getProject(project.id).materialOrder).toEqual([
      referenceMaterialKey(references[0].id),
      referenceMaterialKey(references[2].id),
    ]);
    expect(fs.existsSync(removedPath)).toBe(false);
  });

  it("creates a reproducible queued generation snapshot", () => {
    const project = service.createProject({ name: "任务", prompt: "固定机位，产品旋转", mode: "text-to-video" });
    const preview = service.previewSubmission(project.id);
    expect(preview.ready).toBe(true);
    const job = service.submitGeneration(project.id);
    expect(job.status).toBe("queued");
    expect(job.promptSnapshot).toBe("固定机位，产品旋转");
    expect(job.parameters.modelName).toBe("Seedance 2.5 全能参考");
    expect(job.parameters.resolution).toBe("auto");
    expect(service.listJobEvents(job.id)[0].code).toBe("JOB_QUEUED");
  });

  it("keeps immutable per-job reference files after project assets change", () => {
    const project = service.createProject({ name: "素材快照", prompt: "产品缓慢旋转" });
    const asset = service.addReferences(project.id, [fixture("original.png", "original-bytes")])[0];
    service.updateReferenceRole(asset.id, "product");
    const job = service.submitGeneration(project.id);
    const snapshot = job.references[0];

    expect(snapshot.filePath).not.toBe(asset.filePath);
    expect(snapshot.filePath.startsWith(path.join(service.paths.jobSnapshotsDir, job.id))).toBe(true);
    expect(fs.readFileSync(snapshot.filePath, "utf8")).toBe("original-bytes");
    service.replaceReference(asset.id, fixture("replacement.jpg", "replacement-bytes"));
    expect(fs.readFileSync(snapshot.filePath, "utf8")).toBe("original-bytes");
    service.removeReference(asset.id);
    expect(fs.readFileSync(snapshot.filePath, "utf8")).toBe("original-bytes");
  });

  it("resumes a failed or human-paused job without losing its snapshot", () => {
    const project = service.createProject({ name: "恢复任务", prompt: "固定机位", mode: "text-to-video" });
    const job = service.submitGeneration(project.id);
    service.updateJob(job.id, { status: "needs-login", requiresHumanReason: "请登录" });
    const resumed = service.resumeJob(job.id);
    expect(resumed.status).toBe("queued");
    expect(resumed.retryCount).toBe(1);
    expect(resumed.promptSnapshot).toBe("固定机位");
    expect(service.listJobEvents(job.id).at(-1)?.code).toBe("JOB_RESUMED");
  });

  it("pauses an interrupted submitting job instead of risking a duplicate submit", () => {
    const project = service.createProject({ name: "中断恢复", prompt: "固定机位", mode: "text-to-video" });
    const job = service.submitGeneration(project.id);
    service.updateJob(job.id, {
      status: "submitting",
      submittedAt: new Date().toISOString(),
      platformTaskId: "pending-chat:project:session:3",
    });
    const recovered = service.recoverInterruptedJobs();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe("needs-human");
    expect(recovered[0].errorCode).toBe("APP_RESTART_DURING_SUBMIT");
    expect(recovered[0].platformTaskId).toBe("pending-chat:project:session:3");
    expect(service.listJobEvents(job.id).at(-1)?.code).toBe("APP_RESTART_DURING_SUBMIT");
  });

  it("exports a completed result without replacing the result-library source", async () => {
    const project = service.createProject({ name: "结果导出", prompt: "固定机位", mode: "text-to-video" });
    const job = service.submitGeneration(project.id);
    const libraryPath = path.join(service.paths.outputsDir, `${job.id}-library.mp4`);
    const destination = path.join(tempDir, "exports", "copy.mp4");
    fs.writeFileSync(libraryPath, "managed-result");
    service.updateJob(job.id, { status: "completed", outputPath: libraryPath, completedAt: new Date().toISOString() });

    const exported = await service.downloadJob(job.id, destination);
    expect(fs.readFileSync(destination, "utf8")).toBe("managed-result");
    expect(exported.outputPath).toBe(libraryPath);
    expect(service.getJob(job.id).outputPath).toBe(libraryPath);
    expect(service.listJobEvents(job.id).at(-1)?.metadata).toMatchObject({ destination, libraryPath });
    await expect(service.downloadJob(job.id, libraryPath)).resolves.toMatchObject({ outputPath: libraryPath });
  });

  it("requires explicit portrait authorization before review", () => {
    const portrait = service.addPortraits([fixture("portrait.png", "portrait")], false)[0];
    expect(portrait.displayName).toBe("portrait");
    expect([portrait.gender, portrait.ageGroup, portrait.ethnicity]).toEqual(["其他", "其他", "其他"]);
    expect(portrait.applicationScope).toBe("domestic");
    expect(() => service.submitPortraitReview(portrait.id)).toThrow(/授权/);
  });

  it("caches Heart portraits and snapshots selected roles before local references", () => {
    const synced = service.syncPlatformPortraits([{
      id: "portrait-platform-1",
      displayName: "已授权角色",
      previewUrl: "https://blueai-video-global.bluemediacdn.com/vlc-toc/team/asset.png?x-tos-process=image/quality,q_40",
      platformAssetId: "asset",
      mediaKind: "image",
      available: true,
      lastSeenAt: "2026-08-21T00:00:00.000Z",
    }]);
    expect(synced).toHaveLength(1);
    const project = service.createProject({ name: "角色调用", prompt: "@图1走入画面", portraitIds: [synced[0].id] });
    service.addReferences(project.id, [fixture("scene.png", "scene")]);
    const preview = service.previewSubmission(project.id);
    expect(preview.ready).toBe(true);
    expect(preview.orderedLabels[0]).toContain("@图1 / @Image1 · 心影虚拟人像 · 已授权角色");
    expect(preview.orderedLabels[1]).toContain("@图2 / @Image2");
    const job = service.submitGeneration(project.id);
    expect(job.parameters.portraitIds).toEqual([synced[0].id]);
    expect(job.parameters.platformPortraits).toEqual([synced[0]]);
  });

  it("persists one unified draggable order for local references and Heart portraits", () => {
    const portraits = service.syncPlatformPortraits([
      {
        id: "portrait-a",
        displayName: "角色 A",
        previewUrl: "https://blueai-video-global.bluemediacdn.com/portrait-a.png",
        platformAssetId: "portrait-a",
        mediaKind: "image",
        available: true,
        lastSeenAt: "2026-08-21T00:00:00.000Z",
      },
      {
        id: "portrait-b",
        displayName: "角色 B",
        previewUrl: "https://blueai-video-global.bluemediacdn.com/portrait-b.png",
        platformAssetId: "portrait-b",
        mediaKind: "image",
        available: true,
        lastSeenAt: "2026-08-21T00:00:00.000Z",
      },
    ]);
    const project = service.createProject({ name: "混合排序", prompt: "按编号出场" });
    const references = service.addReferences(project.id, [fixture("scene-a.png", "a"), fixture("scene-b.png", "b")]);
    const materialOrder = [
      `reference:${references[0].id}`,
      `portrait:${portraits[1].id}`,
      `portrait:${portraits[0].id}`,
      `reference:${references[1].id}`,
    ];
    service.updateProject(project.id, { portraitIds: [portraits[1].id, portraits[0].id], materialOrder });

    const preview = service.previewSubmission(project.id);
    expect(preview.ready).toBe(true);
    expect(preview.project.materialOrder).toEqual(materialOrder);
    expect(preview.orderedLabels[0]).toContain("scene-a.png");
    expect(preview.orderedLabels[1]).toContain("角色 B");
    expect(preview.orderedLabels[2]).toContain("角色 A");
    expect(preview.orderedLabels[3]).toContain("scene-b.png");
    const job = service.submitGeneration(project.id);
    expect(job.parameters.materialOrder).toEqual(materialOrder);
    expect((job.parameters.platformPortraits as Array<{ id: string }>).map((portrait) => portrait.id)).toEqual([portraits[1].id, portraits[0].id]);

    const freelyInterleaved = [materialOrder[1], materialOrder[0], materialOrder[2], materialOrder[3]];
    service.updateProject(project.id, { materialOrder: freelyInterleaved });
    const interleavedPreview = service.previewSubmission(project.id);
    expect(interleavedPreview.ready).toBe(true);
    expect(interleavedPreview.project.materialOrder).toEqual(freelyInterleaved);
    expect(interleavedPreview.warnings.some((warning) => warning.includes("自由顺序已保存"))).toBe(false);
    expect(interleavedPreview.orderedLabels.map((label) => label.match(/角色 B|scene-a\.png|角色 A|scene-b\.png/)?.[0])).toEqual([
      "角色 B",
      "scene-a.png",
      "角色 A",
      "scene-b.png",
    ]);
  });

  it("marks missing Heart portraits unavailable after the next sync", () => {
    service.syncPlatformPortraits([{
      id: "old-role",
      displayName: "旧角色",
      previewUrl: "https://blueai-video-global.bluemediacdn.com/old.png",
      platformAssetId: "old",
      available: true,
      lastSeenAt: "2026-08-21T00:00:00.000Z",
    }]);
    service.syncPlatformPortraits([]);
    expect(service.listPlatformPortraits()[0].available).toBe(false);
    expect(() => service.createProject({ name: "不可用角色", portraitIds: ["old-role"] })).toThrow(/不可用/);
  });

  it("stores, marks, and exports synchronized Heart project results", async () => {
    const project = service.createProject({ name: "远端结果", prompt: "固定机位" });
    const libraryPath = path.join(service.paths.outputsDir, "remote-result.mp4");
    fs.writeFileSync(libraryPath, "remote-video");
    const synced = service.syncPlatformResults(project.id, [{
      id: "remote-result-1",
      projectId: project.id,
      platformProjectId: project.platformProjectId,
      platformTaskId: "chat:platform-project:session-1:0",
      jobId: null,
      prompt: "远端历史提示词",
      outputUrl: null,
      previewUrl: null,
      outputPath: libraryPath,
      marked: false,
      available: true,
      createdAt: "2026-08-21T08:00:00.000Z",
      lastSeenAt: "2026-08-21T08:00:00.000Z",
    }]);
    expect(synced).toHaveLength(1);
    expect(service.markResults([synced[0].id], true)[0].marked).toBe(true);
    const destination = path.join(tempDir, "exports", "remote-copy.mp4");
    await service.exportResult(synced[0].id, destination);
    expect(fs.readFileSync(destination, "utf8")).toBe("remote-video");
  });

  it("completes a submitted generation only when result sync finds its Heart video", () => {
    const project = service.createProject({ name: "人工查看结果", prompt: "固定机位", mode: "text-to-video" });
    const job = service.submitGeneration(project.id);
    service.updateJob(job.id, { status: "running", platformTaskId: "chat:platform-project:session-2:0" });

    const [result] = service.syncPlatformResults(project.id, [{
      id: "remote-result-2",
      projectId: project.id,
      platformProjectId: project.platformProjectId,
      platformTaskId: "chat:platform-project:session-2:0",
      jobId: null,
      prompt: "固定机位",
      outputUrl: "https://media.example/result-2.mp4",
      previewUrl: "https://media.example/result-2.jpg",
      outputPath: null,
      marked: false,
      available: true,
      createdAt: "2026-08-24T08:00:00.000Z",
      lastSeenAt: "2026-08-24T08:00:00.000Z",
    }]);

    expect(result.jobId).toBe(job.id);
    expect(service.getJob(job.id).status).toBe("completed");
    expect(service.getJob(job.id).outputUrl).toBe("https://media.example/result-2.mp4");
    expect(service.listJobEvents(job.id).at(-1)?.code).toBe("COMPLETED_ON_RESULT_SYNC");
  });

  it("keeps Heart portraits newest-first and invalidates only the synced workspace", () => {
    service.syncPlatformPortraits([
      {
        id: "team-new",
        displayName: "团队最新人像",
        previewUrl: "https://blueai-video-global.bluemediacdn.com/team/new.png",
        platformAssetId: "team-new",
        workspaceId: "team",
        sortOrder: 0,
        available: true,
        lastSeenAt: "2026-08-21T02:00:00.000Z",
      },
      {
        id: "team-old",
        displayName: "团队较早人像",
        previewUrl: "https://blueai-video-global.bluemediacdn.com/team/old.png",
        platformAssetId: "team-old",
        workspaceId: "team",
        sortOrder: 1,
        available: true,
        lastSeenAt: "2026-08-21T01:00:00.000Z",
      },
    ], "team");
    service.syncPlatformPortraits([{
      id: "personal-role",
      displayName: "个人空间人像",
      previewUrl: "https://blueai-video-global.bluemediacdn.com/personal/role.png",
      platformAssetId: "personal-role",
      workspaceId: "personal",
      sortOrder: 0,
      available: true,
      lastSeenAt: "2026-08-21T03:00:00.000Z",
    }], "personal");

    expect(service.listPlatformPortraits("team").map((portrait) => portrait.id)).toEqual(["team-new", "team-old"]);
    service.syncPlatformPortraits([{
      id: "team-new",
      displayName: "团队最新人像",
      previewUrl: "https://blueai-video-global.bluemediacdn.com/team/new.png",
      platformAssetId: "team-new",
      workspaceId: "team",
      sortOrder: 0,
      available: true,
      lastSeenAt: "2026-08-21T04:00:00.000Z",
    }], "team");
    expect(service.listPlatformPortraits("team").find((portrait) => portrait.id === "team-old")?.available).toBe(false);
    expect(service.listPlatformPortraits("personal")[0].available).toBe(true);
  });

  it("does not invalidate cached portraits when Heart returns a non-authoritative lazy-loaded window", () => {
    const workspaceId = "workspace-large";
    const portraits = Array.from({ length: 120 }, (_, index) => ({
      id: `portrait-${index}`,
      displayName: `角色 ${index}`,
      previewUrl: `https://blueai-video-global.bluemediacdn.com/portrait-${index}.png`,
      platformAssetId: `asset-${index}`,
      workspaceId,
      mediaKind: "image" as const,
      sortOrder: index,
      deleteSortOrder: null,
      canDelete: false,
      available: true,
      lastSeenAt: new Date().toISOString(),
    }));
    service.syncPlatformPortraits(portraits, workspaceId);
    service.syncPlatformPortraits(portraits.slice(0, 60), workspaceId, false);

    expect(service.listPlatformPortraits(workspaceId).filter((portrait) => portrait.available)).toHaveLength(120);
  });

  it("validates remote deletion permissions and removes deleted portraits from live projects only", () => {
    const synced = service.syncPlatformPortraits([
      {
        id: "owned-role",
        displayName: "我上传的角色",
        previewUrl: "https://blueai-video-global.bluemediacdn.com/team/owned.png",
        platformAssetId: "owned",
        workspaceId: "workspace-team",
        sortOrder: 0,
        canDelete: true,
        available: true,
        lastSeenAt: "2026-08-21T04:00:00.000Z",
      },
      {
        id: "shared-role",
        displayName: "同事共享的角色",
        previewUrl: "https://blueai-video-global.bluemediacdn.com/team/shared.png",
        platformAssetId: "shared",
        workspaceId: "workspace-team",
        sortOrder: 1,
        canDelete: false,
        available: true,
        lastSeenAt: "2026-08-21T03:00:00.000Z",
      },
    ], "workspace-team");
    expect(synced.map((portrait) => portrait.canDelete)).toEqual([true, false]);
    expect(service.validatePlatformPortraitDeletion(["owned-role"], "workspace-team")[0].displayName).toBe("我上传的角色");
    expect(() => service.validatePlatformPortraitDeletion(["shared-role"], "workspace-team")).toThrow(/没有删除|权限/);
    expect(() => service.validatePlatformPortraitDeletion(["owned-role"], "other-workspace")).toThrow(/不属于当前/);

    const project = service.createProject({ name: "删除角色引用", prompt: "角色离开画面", portraitIds: ["owned-role"] });
    const reference = service.addReferences(project.id, [fixture("delete-scene.png", "scene")])[0];
    const queued = service.submitGeneration(project.id);
    expect(queued.parameters.portraitIds).toEqual(["owned-role"]);

    service.markPlatformPortraitsDeleted(["owned-role"], "workspace-team");
    expect(service.listPlatformPortraits("workspace-team").find((portrait) => portrait.id === "owned-role")?.available).toBe(false);
    expect(service.getProject(project.id).portraitIds).toEqual([]);
    expect(service.getProject(project.id).materialOrder).toEqual([`reference:${reference.id}`]);
    expect(service.getJob(queued.id).parameters.portraitIds).toEqual(["owned-role"]);
  });

  it("authorizes a face reference and queues its review in the selected Heart project", () => {
    const project = service.createProject({ name: "人像授权项目" });
    const reference = service.addReferences(project.id, [fixture("face.png", "synthetic-face")])[0];
    expect(() => service.authorizeReference(reference.id, project.id, false)).toThrow(/承诺|授权/);

    const job = service.authorizeReference(reference.id, project.id, true);
    expect(job.kind).toBe("portrait-review");
    expect(job.projectId).toBe(project.id);
    expect(job.parameters.platformProjectId).toBe("platform-project");
    expect(service.getPortrait(job.portraitId!).consentConfirmed).toBe(true);
    expect(service.getPortrait(job.portraitId!).sourceReferenceId).toBe(reference.id);
    const repeated = service.authorizeReference(reference.id, project.id, true);
    expect(repeated.id).toBe(job.id);
    expect(service.listPortraits().filter((portrait) => portrait.sourceReferenceId === reference.id)).toHaveLength(1);
  });

  it("prepares an ordered director manifest and replaces an approved face in place", () => {
    const face = fixture("director-face.png", "director-face");
    const audio = fixture("director-voice.mp3", "director-audio");
    const scene = fixture("director-scene.png", "director-scene");
    const stale = fixture("stale.png", "stale");
    const project = service.createProject({ name: "导演自动化" });
    service.addReferences(project.id, [stale]);
    const manifest: DirectorManifest = {
      version: 1,
      projectId: project.id,
      prompt: "@图1 说话，参考 @音频1；场景参考 @图2。",
      count: 3,
      replaceMaterials: true,
      settings: { mode: "reference-to-video", duration: 8, aspectRatio: "16:9", audioEnabled: true },
      materials: [
        // The APP must enforce portrait authorization for character-role media
        // even if a caller forgets the explicit flag.
        { kind: "file", path: face, role: "character" },
        { kind: "file", path: audio, role: "other" },
        { kind: "file", path: scene, role: "scene" },
      ],
    };

    const prepared = service.prepareDirectorRun(manifest);
    expect(prepared.authorizationReferenceIds).toHaveLength(1);
    expect(prepared.materials.map((material) => material.authorizationState)).toEqual(["required", "not-needed", "not-needed"]);
    expect(prepared.preview.orderedLabels.map((label) => label.split(" / ")[0])).toEqual(["@图1", "@音频1", "@图2"]);
    expect(service.listReferences(project.id).some((reference) => reference.name === "stale.png")).toBe(false);

    const review = service.authorizeReference(prepared.authorizationReferenceIds[0], project.id, true);
    service.updateJob(review.id, { status: "completed", completedAt: new Date().toISOString() });
    const localPortrait = service.updatePortraitReviewState(review.portraitId!, "approved", "审核通过");
    service.syncPlatformPortraits([{
      id: "director-platform-face",
      displayName: localPortrait.displayName,
      previewUrl: "https://blueaivideo.com/director-face.png",
      platformAssetId: "director-face-asset",
      workspaceId: "workspace-team",
      mediaKind: "image",
      sortOrder: 0,
      deleteSortOrder: 0,
      canDelete: true,
      available: true,
      lastSeenAt: new Date().toISOString(),
    }], "workspace-team", false);

    const resolved = service.prepareDirectorRun(manifest);
    expect(resolved.authorizationReferenceIds).toEqual([]);
    expect(resolved.materials[0]).toMatchObject({
      referenceId: null,
      platformPortraitId: "director-platform-face",
      authorizationState: "approved",
    });
    expect(resolved.project.materialOrder[0]).toBe("portrait:director-platform-face");
    expect(resolved.preview.orderedLabels.map((label) => label.split(" / ")[0])).toEqual(["@图1", "@音频1", "@图2"]);
    expect(service.getPortrait(localPortrait.id).platformAssetId).toBe("director-face-asset");
  });

  it("creates an atomic multi-take generation batch", () => {
    const project = service.createProject({ name: "三条成片", prompt: "固定机位", mode: "text-to-video" });
    const batch = service.submitGenerationBatch(project.id, 3);
    expect(batch.count).toBe(3);
    expect(batch.jobs).toHaveLength(3);
    expect(new Set(batch.jobs.map((job) => job.id)).size).toBe(3);
    expect(batch.jobs.map((job) => job.parameters.takeNumber)).toEqual([1, 2, 3]);
    expect(batch.jobs.every((job) => job.parameters.batchId === batch.batchId && job.status === "queued")).toBe(true);
    expect(() => service.submitGenerationBatch(project.id, 0)).toThrow(/1 到 20/);
  });

  it("prevents duplicate portrait reviews and deletion while work is active", () => {
    const portrait = service.addPortraits([fixture("authorized.png", "portrait")], true)[0];
    const renamed = service.updatePortraitMetadata(portrait.id, { displayName: "自动角色", applicationScope: "both" });
    expect(renamed.displayName).toBe("自动角色");
    expect(renamed.applicationScope).toBe("both");
    const job = service.submitPortraitReview(portrait.id);
    expect(() => service.submitPortraitReview(portrait.id)).toThrow(/活动审核任务/);
    expect(() => service.removePortrait(portrait.id)).toThrow(/关联的审核任务/);
    service.cancelJob(job.id);
    expect(service.getPortrait(portrait.id).platformStatus).toBe("local");
    expect(() => service.removePortrait(portrait.id)).not.toThrow();
  });

  it("prevents deleting a project that still has an active job", () => {
    const project = service.createProject({ name: "活动项目", prompt: "固定机位", mode: "text-to-video" });
    const job = service.submitGeneration(project.id);
    expect(() => service.removeProject(project.id)).toThrow(/活动任务/);
    service.updateJob(job.id, { status: "needs-human", requiresHumanReason: "参数不兼容" });
    const cancelled = service.cancelJob(job.id);
    expect(cancelled.requiresHumanReason).toBeNull();
    expect(() => service.removeProject(project.id)).not.toThrow();
  });
});
