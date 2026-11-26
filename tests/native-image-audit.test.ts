import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppPaths } from "../src/core/paths";
import { XinyingDatabase } from "../src/core/database";
import { XinyingService } from "../src/core/service";
import { resolveDirectorMaterialRouting } from "../src/core/typesafe-material-router";
import { runDirectorManifest } from "../src/cli/director-run";
import { parseDirectorManifest } from "../src/core/director-manifest";
import { parseGenerationCapabilities } from "../src/shared/generation-capabilities";
import type { DirectorManifest } from "../src/shared/contracts";
import { generationOptions, nativeImageAuditEnabled } from "../src/shared/generation-options";
import { modelProfile } from "../src/shared/model-profiles";

describe("official automatic image portrait review", () => {
  let dir: string;
  let db: XinyingDatabase;
  let service: XinyingService;
  let projectId: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-native-review-"));
    const paths = createAppPaths(dir);
    db = new XinyingDatabase(paths.databasePath); service = new XinyingService(db, paths);
    projectId = service.createProject({ name: "官方审核", platformWorkspaceId: "w", platformProjectId: "p",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=p&sessionId=s" }).id;
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const manifest = (materials: DirectorManifest["materials"]): DirectorManifest => ({ version: 1, projectId,
    prompt: "@图1 人物走动", count: 1, replaceMaterials: true, materials });
  const file = (name: string) => { const target = path.join(dir, name); fs.writeFileSync(target, name); return target; };

  it("migrates existing project defaults and preserves explicit opt-out", () => {
    expect(service.getProject(projectId).autoPortraitAudit).toBe(true);
    db.db.prepare("UPDATE projects SET generation_options_json = '{}' WHERE id = ?").run(projectId);
    expect(service.getProject(projectId).autoPortraitAudit).toBe(true);
    service.updateProject(projectId, { autoPortraitAudit: false });
    expect(service.getProject(projectId).autoPortraitAudit).toBe(false);
    expect(new URL(service.getProject(projectId).platformUrl).searchParams.get("sessionId")).toBe("s");
    expect(new URL(service.getProject(projectId).platformUrl).pathname).toBe("/agentlab");
    expect(new URL(service.getProject(projectId).platformUrl).searchParams.get("tab")).toBe("generation");
  });

  it("keeps person images as ordered references without redundant portrait jobs or JEV", async () => {
    const input = manifest([
      { kind: "file", path: file("person.png"), role: "character", containsPerson: true, authorizeAsPortrait: true },
      { kind: "file", path: file("scene.png") },
      { kind: "file", path: file("voice.mp3") },
    ]);
    const advisor = { assess: vi.fn(async () => []) };
    const routed = await resolveDirectorMaterialRouting(service, input, advisor);
    expect(advisor.assess).not.toHaveBeenCalled();
    expect(routed.summary.unresolved).toBe(0);
    const prepared = service.prepareDirectorRun(routed.manifest);
    expect(prepared.authorizationCount).toBe(0);
    expect(prepared.authorizationReferenceIds).toEqual([]);
    expect(prepared.materials.every((item) => item.authorizationState === "not-needed")).toBe(true);
    expect(prepared.preview.ready).toBe(true);
    expect(prepared.preview.orderedLabels.map((item) => item.split(" / ")[0])).toEqual(["@图1", "@图2", "@音频1"]);
    expect(service.listPortraits()).toEqual([]);
    expect(service.submitGeneration(projectId).parameters.autoPortraitAudit).toBe(true);
  });

  it("retains independent authorization and mandatory inspection for person-containing video", () => {
    const image = { kind: "file" as const, path: file("actor.png"), role: "character" as const };
    const video = { kind: "file" as const, path: file("actor.mp4"), role: "motion" as const };
    expect(() => service.validateDirectorRun(manifest([image, video]))).toThrow(/containsPerson/);
    const prepared = service.prepareDirectorRun(manifest([image, { ...video, containsPerson: true }]));
    expect(prepared.authorizationCount).toBe(1);
    expect(prepared.materials.map((item) => item.authorizationState)).toEqual(["not-needed", "required"]);
    expect(prepared.authorizationReferenceIds).toEqual([prepared.materials[1].referenceId]);
    expect(prepared.preview.ready).toBe(false);
  });

  it("keeps legacy image review when the switch is disabled", () => {
    const input = manifest([{ kind: "file", path: file("legacy.png"), containsPerson: true }]);
    input.settings = { autoPortraitAudit: false };
    const prepared = service.prepareDirectorRun(input);
    expect(prepared.authorizationCount).toBe(1);
    expect(prepared.preview.ready).toBe(false);
  });

  it("routes Seedance 2.0 images through official review and preserves an explicit opt-out", () => {
    const seedance20 = service.createProject({ name: "2.0 官网审核", modelName: "Seedance 2.0 全能参考" });
    const input = { ...manifest([{ kind: "file", path: file("seedance20.png"), containsPerson: true }]), projectId: seedance20.id };
    expect(seedance20.autoPortraitAudit).toBe(true);
    expect(service.prepareDirectorRun(input).authorizationCount).toBe(0);
    service.updateProject(seedance20.id, { autoPortraitAudit: false });
    expect(service.prepareDirectorRun(input).authorizationCount).toBe(1);
  });

  it("persists advanced settings through reload and immutable generation snapshots", () => {
    const saved = service.updateProject(projectId, { prompt: "测试", mode: "text-to-video", autoPortraitAudit: true,
      promptOptimizer: true, draftMode: true, smartBalance: true, resolution: "1080p", videoFormat: "mov", inspiration: { 相机: "测试镜头" } });
    expect(saved).toMatchObject({ resolution: "480p", videoFormat: "mp4" });
    expect(service.getProject(projectId)).toMatchObject(saved);
    const job = service.submitGeneration(projectId);
    service.updateProject(projectId, { promptOptimizer: false, inspiration: {} });
    expect(service.getJob(job.id).parameters).toMatchObject({ promptOptimizer: true, smartBalance: false,
      draftMode: true, resolution: "480p", videoFormat: "mp4", inspiration: { 相机: "测试镜头" } });
  });

  it("completes the native image path at generating without any authorization loop", async () => {
    const authorize = vi.spyOn(service, "authorizeReference");
    const result = await runDirectorManifest(service, manifest([{ kind: "file", path: file("auto.png") }]), {
      timeoutMs: 2_000, ensureAppReady: async () => ({ ready: true }), materialRoutingAdvisor: null,
      sleep: async () => { service.listJobsByKind("generation").forEach((job) => service.updateJob(job.id, { status: "running", platformTaskId: "chat:p:s:0" })); },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(result.successBoundary).toBe("heart-generating");
    expect(result.authorization.required).toBe(0);
  });
});

describe("new website capability contracts", () => {
  it.each(["Seedance 2.0 全能参考", "Seedance 2.5 全能参考", "Seedance 2.0 首尾帧(海外版)", "Seedance 2.5 首尾帧"])("defaults official image review only for verified Seedance families: %s", (modelName) => {
    expect(nativeImageAuditEnabled({ modelName })).toBe(true);
    expect(nativeImageAuditEnabled({ modelName, autoPortraitAudit: false })).toBe(false);
  });

  it("keeps other models on independent review and reflects live Seedance 4K/network support", () => {
    expect(nativeImageAuditEnabled({ modelName: "MiniMax H3 全能参考" })).toBe(false);
    expect(nativeImageAuditEnabled({ modelName: "Seedance 3.0 全能参考" })).toBe(false);
    expect(generationOptions({ modelName: "Seedance 2.0 全能参考" }).autoPortraitAudit).toBe(true);
    for (const name of ["Seedance 2.0 全能参考", "Seedance 2.5 全能参考"]) {
      expect(modelProfile(name)?.resolutions).toContain("4k");
      expect(modelProfile(name)?.networkSearchSupported).toBe(true);
    }
  });

  it("parses strict manifest options without inventing inspiration identifiers", () => {
    expect(parseDirectorManifest({ version: 1, projectId: "p", prompt: "test", materials: [], settings: {
      autoPortraitAudit: true, promptOptimizer: true, draftMode: true, smartBalance: false, inspiration: { 相机: "官网名称" },
    } }).settings).toMatchObject({ autoPortraitAudit: true, draftMode: true, inspiration: { 相机: "官网名称" } });
    expect(() => parseDirectorManifest({ version: 1, projectId: "p", prompt: "test", materials: [], settings: { autoPortraitAudit: "true" } })).toThrow();
  });

  it("honors per-model supported flags and exposes display names only", () => {
    const result = parseGenerationCapabilities({ code: 0, data: { model_config_list: { img2video_config_list: [
      { model_name: "Seedance 2.5 全能参考", function_list: [{ outputConfig: { auto_portrait_audit: { supported: true },
        prompt_optimizer: { supported: false }, is_draft: { supported: true }, enhance_video_hd: { supported: true }, promptInspiration_dict: { supported: true } } }] },
    ] }, promptInspiration_dict: { 相机: [{ display_name: "测试相机", unique_id: "private-id" }] } } });
    expect(result.models[0]).toMatchObject({ autoPortraitAudit: true, promptOptimizer: false, draftMode: true, smartBalance: true });
    expect(result.inspirations).toEqual({ 相机: ["测试相机"] });
    expect(JSON.stringify(result)).not.toContain("private-id");
    expect(() => parseGenerationCapabilities({ code: 401, message: "请登录" })).toThrow("请登录");
  });
});
