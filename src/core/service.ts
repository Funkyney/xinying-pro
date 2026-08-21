import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Job,
  JobEvent,
  PlatformCatalogSnapshot,
  PlatformProjectBinding,
  PlatformPortrait,
  PlatformResult,
  PortraitAsset,
  PortraitMetadataInput,
  Project,
  ProjectInput,
  ReferenceAsset,
  ReferenceRole,
  SubmissionPreview,
} from "../shared/contracts";
import { assignMediaLabels, mediaKindEnglishLabel, mediaKindFromMime } from "../shared/media";
import { DEFAULT_XINYING_MODEL, modelProfile } from "../shared/model-profiles";
import {
  parseMaterialKey,
  portraitMaterialKey,
  reconcileMaterialOrder,
  referenceMaterialKey,
} from "../shared/material-order";
import type { AppPaths } from "./paths";
import { AppError } from "./errors";
import { XinyingDatabase } from "./database";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3"]);
const REFERENCE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);
const PORTRAIT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov"]);
const PROJECT_MODES = new Set(["text-to-video", "image-to-video", "reference-to-video", "first-last-frame"]);
const REFERENCE_ROLES = new Set(["first-frame", "last-frame", "character", "scene", "product", "style", "motion", "other"]);
const ASPECT_RATIOS = new Set(["9:16", "16:9", "4:3", "1:1", "3:4", "21:9", "自适应"]);
const RESOLUTIONS = new Set(["auto", "480p", "720p", "1080p", "1K", "2K", "4k"]);
const PORTRAIT_GENDERS = new Set(["男", "女", "其他"]);
const PORTRAIT_AGE_GROUPS = new Set(["儿童（0-12）", "少年（13-18）", "青年（19-35）", "中年（36-55）", "老年（55+）", "其他"]);
const PORTRAIT_ETHNICITIES = new Set(["东亚裔", "东南亚裔", "南亚裔", "中亚裔", "中东/北非", "白人/西欧", "白人/东欧", "黑人/非洲", "西语/拉丁裔", "太平洋岛民", "其他"]);
const PORTRAIT_SCOPES = new Set(["domestic", "overseas", "both"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

const EMPTY_PLATFORM_CATALOG: PlatformCatalogSnapshot = {
  workspaces: [],
  projects: [],
  currentWorkspaceId: "",
  currentProjectId: "",
  customerOptions: [],
  creationTypeOptions: [],
  syncedAt: "",
};

interface PreparedReferenceReplacement {
  asset: ReferenceAsset;
  sourcePath: string;
  targetPath: string;
  stagingPath: string;
  backupPath: string | null;
  hadOriginal: boolean;
  name: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
}

function now(): string {
  return new Date().toISOString();
}

function mimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
    }[ext] ?? "application/octet-stream"
  );
}

function ensureFile(filePath: string, allowed: Set<string>): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new AppError("FILE_NOT_FOUND", `找不到文件：${filePath}`);
  }
  if (!allowed.has(path.extname(filePath).toLowerCase())) {
    throw new AppError("UNSUPPORTED_FILE", `不支持的文件格式：${path.extname(filePath)}`);
  }
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function safeOutputName(value: string): string {
  const sanitized = path.basename(value).replace(/[<>:"/\\|?*]+/g, "-").trim();
  return sanitized || "result.mp4";
}

function normalizePlatformUrl(rawUrl: string | undefined): string {
  const value = rawUrl?.trim() ?? "";
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("INVALID_PLATFORM_URL", "心影生成链接不是有效网址");
  }
  if (url.protocol !== "https:" || url.hostname !== "blueaivideo.com" || url.pathname !== "/avpAgent") {
    throw new AppError("INVALID_PLATFORM_URL", "心影生成链接必须是 https://blueaivideo.com/avpAgent 页面");
  }
  if (!url.searchParams.get("projectId")) {
    throw new AppError("INVALID_PLATFORM_URL", "心影项目链接缺少 projectId");
  }
  return url.toString();
}

function remoteProjectIdFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).searchParams.get("projectId") ?? "";
  } catch {
    return "";
  }
}

function validateProjectSettings(input: Pick<Project, "modelName" | "mode" | "aspectRatio" | "duration" | "resolution">): void {
  if (!PROJECT_MODES.has(input.mode)) throw new AppError("INVALID_MODE", `不支持的生成模式：${input.mode}`);
  if (!ASPECT_RATIOS.has(input.aspectRatio)) throw new AppError("INVALID_ASPECT_RATIO", `不支持的画面比例：${input.aspectRatio}`);
  if (!Number.isInteger(input.duration) || input.duration < 4 || input.duration > 30) {
    throw new AppError("INVALID_DURATION", "心影当前视频时长必须是 4 到 30 秒的整数");
  }
  if (!RESOLUTIONS.has(input.resolution)) throw new AppError("INVALID_RESOLUTION", `不支持的分辨率：${input.resolution}`);
  const profile = modelProfile(input.modelName);
  if (!profile) return;
  if (!profile.modes.includes(input.mode)) {
    throw new AppError("MODEL_MODE_MISMATCH", `${profile.shortName} 当前不支持该生成模式`);
  }
  if (!profile.aspectRatios.includes(input.aspectRatio)) {
    throw new AppError("MODEL_ASPECT_RATIO_MISMATCH", `${profile.shortName} 不支持画面比例：${input.aspectRatio}`);
  }
  if (input.resolution !== "auto" && !profile.resolutions.includes(input.resolution)) {
    throw new AppError("MODEL_RESOLUTION_MISMATCH", `${profile.shortName} 不支持分辨率：${input.resolution}`);
  }
  if (input.duration < profile.minDuration || input.duration > profile.maxDuration) {
    throw new AppError("MODEL_DURATION_MISMATCH", `${profile.shortName} 当前时长范围为 ${profile.minDuration} 到 ${profile.maxDuration} 秒`);
  }
}

function normalizePortraitIds(value: string[] | undefined): string[] {
  if (!value) return [];
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  if (normalized.length !== new Set(normalized).size) throw new AppError("DUPLICATE_PLATFORM_PORTRAIT", "虚拟人像不能重复选择");
  return normalized;
}

function validateRemotePortraitUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("INVALID_PORTRAIT_PREVIEW", "心影虚拟人像预览地址无效");
  }
  const allowed = url.protocol === "https:" && (url.hostname === "blueaivideo.com" || url.hostname.endsWith(".blueaivideo.com") || url.hostname === "bluemediacdn.com" || url.hostname.endsWith(".bluemediacdn.com"));
  if (!allowed) throw new AppError("INVALID_PORTRAIT_PREVIEW", "心影虚拟人像预览地址不在允许域名内");
  return url.toString();
}

function validatePortraitMetadata(portrait: Pick<PortraitAsset, "displayName" | "gender" | "ageGroup" | "ethnicity" | "applicationScope">): void {
  if (!portrait.displayName.trim() || portrait.displayName.trim().length > 50) {
    throw new AppError("INVALID_PORTRAIT_NAME", "虚拟人像名称必须是 1 到 50 个字符");
  }
  if (!PORTRAIT_GENDERS.has(portrait.gender)) throw new AppError("INVALID_PORTRAIT_GENDER", "请选择虚拟人像性别");
  if (!PORTRAIT_AGE_GROUPS.has(portrait.ageGroup)) throw new AppError("INVALID_PORTRAIT_AGE", "请选择虚拟人像年龄段");
  if (!PORTRAIT_ETHNICITIES.has(portrait.ethnicity)) throw new AppError("INVALID_PORTRAIT_ETHNICITY", "请选择虚拟人像人种");
  if (!PORTRAIT_SCOPES.has(portrait.applicationScope)) throw new AppError("INVALID_PORTRAIT_SCOPE", "请选择有效的虚拟人像应用范围");
}

export class XinyingService {
  constructor(
    readonly database: XinyingDatabase,
    readonly paths: AppPaths,
  ) {
    this.backfillPortraitSourceReferences();
  }

  private backfillPortraitSourceReferences(): void {
    const candidates = this.database.db.prepare(
      "SELECT id, name FROM portrait_assets WHERE source_reference_id IS NULL",
    ).all() as Array<{ id: string; name: string }>;
    const update = this.database.db.prepare("UPDATE portrait_assets SET source_reference_id = ? WHERE id = ?");
    for (const candidate of candidates) {
      const referenceId = path.parse(candidate.name).name;
      if (this.database.rows.reference(referenceId)) update.run(referenceId, candidate.id);
    }
  }

  listProjects(): Project[] {
    return this.database.rows.projects().map((row) => this.database.mapProject(row));
  }

  getProject(id: string): Project {
    const row = this.database.rows.project(id);
    if (!row) throw new AppError("PROJECT_NOT_FOUND", `项目不存在：${id}`);
    return this.database.mapProject(row);
  }

  getPlatformCatalog(): PlatformCatalogSnapshot {
    const row = this.database.db.prepare("SELECT value_json FROM settings WHERE key = 'platform_catalog'").get() as { value_json: string } | undefined;
    if (!row) return EMPTY_PLATFORM_CATALOG;
    try {
      const parsed = JSON.parse(row.value_json) as PlatformCatalogSnapshot;
      return {
        ...EMPTY_PLATFORM_CATALOG,
        ...parsed,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        customerOptions: Array.isArray(parsed.customerOptions) ? parsed.customerOptions : [],
        creationTypeOptions: Array.isArray(parsed.creationTypeOptions) ? parsed.creationTypeOptions : [],
      };
    } catch {
      return EMPTY_PLATFORM_CATALOG;
    }
  }

  syncPlatformCatalog(catalog: PlatformCatalogSnapshot): PlatformCatalogSnapshot {
    const workspaceIds = new Set<string>();
    for (const workspace of catalog.workspaces) {
      if (!workspace.id.trim() || !workspace.name.trim() || workspaceIds.has(workspace.id)) {
        throw new AppError("INVALID_PLATFORM_CATALOG", "心影空间目录包含无效或重复空间");
      }
      workspaceIds.add(workspace.id);
    }
    const projectIds = new Set<string>();
    for (const project of catalog.projects) {
      if (!project.id.trim() || !project.name.trim() || !workspaceIds.has(project.workspaceId) || projectIds.has(project.id)) {
        throw new AppError("INVALID_PLATFORM_CATALOG", "心影项目目录包含无效、重复或无归属的项目");
      }
      projectIds.add(project.id);
    }
    const normalized: PlatformCatalogSnapshot = {
      ...catalog,
      workspaces: [...catalog.workspaces].sort((a, b) => a.sortOrder - b.sortOrder),
      projects: [...catalog.projects].sort((a, b) => a.sortOrder - b.sortOrder),
      customerOptions: [...new Set(catalog.customerOptions.map((item) => item.trim()).filter(Boolean))],
      creationTypeOptions: [...new Set(catalog.creationTypeOptions.map((item) => item.trim()).filter(Boolean))],
      syncedAt: catalog.syncedAt || now(),
    };
    this.database.db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('platform_catalog', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(normalized), now());
    return normalized;
  }

  bindPlatformProject(binding: PlatformProjectBinding): Project {
    const catalog = this.getPlatformCatalog();
    const workspaces = catalog.workspaces.map((item) => item.id === binding.workspace.id ? binding.workspace : item);
    if (!workspaces.some((item) => item.id === binding.workspace.id)) workspaces.push(binding.workspace);
    const projects = catalog.projects.map((item) => item.id === binding.project.id ? binding.project : item);
    if (!projects.some((item) => item.id === binding.project.id)) projects.push(binding.project);
    this.syncPlatformCatalog({
      ...catalog,
      workspaces: workspaces.map((item) => ({ ...item, isCurrent: item.id === binding.workspace.id })),
      projects: projects.map((item) => ({ ...item, isCurrent: item.id === binding.project.id })),
      currentWorkspaceId: binding.workspace.id,
      currentProjectId: binding.project.id,
      syncedAt: now(),
    });
    const existing = this.listProjects().find((item) => item.platformProjectId === binding.project.id
      || (binding.project.remoteId && remoteProjectIdFromUrl(item.platformUrl) === binding.project.remoteId));
    if (existing) {
      return this.updateProject(existing.id, {
        platformUrl: binding.generationUrl,
        platformWorkspaceId: binding.workspace.id,
        platformProjectId: binding.project.id,
      });
    }
    return this.createProject({
      name: binding.project.name,
      platformUrl: binding.generationUrl,
      platformWorkspaceId: binding.workspace.id,
      platformProjectId: binding.project.id,
    });
  }

  createProject(input: ProjectInput): Project {
    const name = input.name?.trim();
    if (!name) throw new AppError("INVALID_PROJECT", "项目名称不能为空");
    const timestamp = now();
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      description: input.description?.trim() ?? "",
      prompt: input.prompt ?? "",
      modelName: input.modelName?.trim() ?? DEFAULT_XINYING_MODEL,
      platformUrl: normalizePlatformUrl(input.platformUrl),
      platformWorkspaceId: input.platformWorkspaceId?.trim() ?? (input.platformUrl ? "legacy" : ""),
      platformProjectId: input.platformProjectId?.trim() ?? (input.platformUrl ? remoteProjectIdFromUrl(input.platformUrl) : ""),
      mode: input.mode ?? "reference-to-video",
      aspectRatio: input.aspectRatio ?? "16:9",
      duration: input.duration ?? 5,
      resolution: input.resolution ?? "auto",
      audioEnabled: input.audioEnabled ?? true,
      portraitIds: normalizePortraitIds(input.portraitIds),
      materialOrder: [],
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    project.materialOrder = reconcileMaterialOrder(input.materialOrder, project.portraitIds, []);
    validateProjectSettings(project);
    this.validatePlatformPortraitSelection(project.portraitIds);
    this.database.db
      .prepare(`INSERT INTO projects
        (id, name, description, prompt, model_name, platform_url, platform_workspace_id, platform_project_id, mode, aspect_ratio, duration, resolution, audio_enabled, portrait_ids_json, material_order_json, status, created_at, updated_at)
        VALUES (@id, @name, @description, @prompt, @modelName, @platformUrl, @platformWorkspaceId, @platformProjectId, @mode, @aspectRatio, @duration, @resolution, @audioEnabled, @portraitIdsJson, @materialOrderJson, @status, @createdAt, @updatedAt)`)
      .run({ ...project, audioEnabled: project.audioEnabled ? 1 : 0, portraitIdsJson: JSON.stringify(project.portraitIds), materialOrderJson: JSON.stringify(project.materialOrder) });
    return project;
  }

  updateProject(id: string, input: Partial<ProjectInput>): Project {
    const current = this.getProject(id);
    const next: Project = {
      ...current,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.modelName !== undefined ? { modelName: input.modelName.trim() } : {}),
      ...(input.platformUrl !== undefined ? { platformUrl: normalizePlatformUrl(input.platformUrl) } : {}),
      ...(input.platformWorkspaceId !== undefined ? { platformWorkspaceId: input.platformWorkspaceId.trim() } : {}),
      ...(input.platformProjectId !== undefined ? { platformProjectId: input.platformProjectId.trim() } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(input.audioEnabled !== undefined ? { audioEnabled: input.audioEnabled } : {}),
      ...(input.portraitIds !== undefined ? { portraitIds: normalizePortraitIds(input.portraitIds) } : {}),
      updatedAt: now(),
    };
    const references = this.listReferences(id);
    next.materialOrder = reconcileMaterialOrder(
      input.materialOrder ?? current.materialOrder,
      next.portraitIds,
      references.map((reference) => reference.id),
    );
    if (!next.name) throw new AppError("INVALID_PROJECT", "项目名称不能为空");
    validateProjectSettings(next);
    if (input.portraitIds !== undefined) this.validatePlatformPortraitSelection(next.portraitIds);

    this.database.db.prepare(`UPDATE projects SET
      name = @name, description = @description, prompt = @prompt, model_name = @modelName,
      platform_url = @platformUrl, platform_workspace_id = @platformWorkspaceId, platform_project_id = @platformProjectId, mode = @mode,
      aspect_ratio = @aspectRatio, duration = @duration, resolution = @resolution,
      audio_enabled = @audioEnabled, portrait_ids_json = @portraitIdsJson, material_order_json = @materialOrderJson,
      status = @status, updated_at = @updatedAt
      WHERE id = @id`).run({ ...next, audioEnabled: next.audioEnabled ? 1 : 0, portraitIdsJson: JSON.stringify(next.portraitIds), materialOrderJson: JSON.stringify(next.materialOrder) });
    if (input.materialOrder !== undefined) this.persistReferencePositions(id, next.materialOrder);
    return next;
  }

  private persistReferencePositions(projectId: string, materialOrder: readonly string[]): void {
    const referenceIds = materialOrder
      .map(parseMaterialKey)
      .filter((item): item is { kind: "reference"; id: string } => item?.kind === "reference")
      .map((item) => item.id);
    if (!referenceIds.length) return;
    const offset = referenceIds.length + 1000;
    this.database.db.prepare("UPDATE reference_assets SET position = position + ? WHERE project_id = ?").run(offset, projectId);
    const statement = this.database.db.prepare("UPDATE reference_assets SET position = ? WHERE id = ? AND project_id = ?");
    referenceIds.forEach((id, index) => statement.run(index, id, projectId));
  }

  removeProject(id: string): void {
    this.getProject(id);
    const active = this.listJobs().filter((job) => job.projectId === id && !TERMINAL_JOB_STATUSES.has(job.status));
    if (active.length) throw new AppError("PROJECT_HAS_ACTIVE_JOBS", "项目仍有关联的活动任务，请先在任务队列完成或取消这些任务");
    const assets = this.listReferences(id);
    this.database.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    for (const asset of assets) fs.rmSync(asset.filePath, { force: true });
  }

  listReferences(projectId: string): ReferenceAsset[] {
    this.getProject(projectId);
    return this.database.rows.references(projectId).map((row) => this.database.mapReference(row));
  }

  addReferences(projectId: string, filePaths: string[]): ReferenceAsset[] {
    const project = this.getProject(projectId);
    if (!filePaths.length) return this.listReferences(projectId);
    filePaths.forEach((sourcePath) => ensureFile(sourcePath, REFERENCE_EXTENSIONS));
    const existing = this.listReferences(projectId);
    const projectDir = path.join(this.paths.assetsDir, projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const addedIds: string[] = [];
    let hasFirstImage = existing.some((reference) => mediaKindFromMime(reference.mimeType) === "image");
    this.database.transaction(() => {
      filePaths.forEach((sourcePath, index) => {
        const id = crypto.randomUUID();
        addedIds.push(id);
        const extension = path.extname(sourcePath).toLowerCase();
        const targetPath = path.join(projectDir, `${id}${extension}`);
        fs.copyFileSync(sourcePath, targetPath);
        const stats = fs.statSync(targetPath);
        const mimeType = mimeFromExtension(targetPath);
        const mediaKind = mediaKindFromMime(mimeType);
        const role: ReferenceRole = mediaKind === "image" && !hasFirstImage ? "first-frame"
          : mediaKind === "video" ? "motion"
            : "other";
        if (mediaKind === "image") hasFirstImage = true;
        const asset: ReferenceAsset = {
          id,
          projectId,
          name: path.basename(sourcePath),
          filePath: targetPath,
          mimeType,
          fileSize: stats.size,
          position: existing.length + index,
          role,
          sha256: hashFile(targetPath),
          createdAt: now(),
        };
        this.database.db.prepare(`INSERT INTO reference_assets
          (id, project_id, name, file_path, mime_type, file_size, position, role, sha256, created_at)
          VALUES (@id, @projectId, @name, @filePath, @mimeType, @fileSize, @position, @role, @sha256, @createdAt)`)
          .run(asset);
      });
      const materialOrder = reconcileMaterialOrder(
        project.materialOrder,
        project.portraitIds,
        [...existing.map((reference) => reference.id), ...addedIds],
      );
      this.database.db.prepare("UPDATE projects SET material_order_json = ? WHERE id = ?")
        .run(JSON.stringify(materialOrder), projectId);
    });
    return this.listReferences(projectId);
  }

  reorderReferences(projectId: string, orderedIds: string[]): ReferenceAsset[] {
    const current = this.listReferences(projectId);
    const expected = new Set(current.map((item) => item.id));
    const received = new Set(orderedIds);
    if (orderedIds.length !== current.length || received.size !== current.length || orderedIds.some((id) => !expected.has(id))) {
      throw new AppError("INVALID_REFERENCE_ORDER", "排序列表必须完整包含项目中的全部参考素材");
    }

    this.database.transaction(() => {
      const offset = orderedIds.length + 1000;
      this.database.db.prepare("UPDATE reference_assets SET position = position + ? WHERE project_id = ?").run(offset, projectId);
      const statement = this.database.db.prepare("UPDATE reference_assets SET position = ? WHERE id = ? AND project_id = ?");
      orderedIds.forEach((id, index) => statement.run(index, id, projectId));
      const project = this.getProject(projectId);
      const currentOrder = reconcileMaterialOrder(project.materialOrder, project.portraitIds, current.map((item) => item.id));
      let referenceIndex = 0;
      const materialOrder = currentOrder.map((key) => parseMaterialKey(key)?.kind === "reference"
        ? referenceMaterialKey(orderedIds[referenceIndex++])
        : key);
      this.database.db.prepare("UPDATE projects SET material_order_json = ? WHERE id = ?")
        .run(JSON.stringify(materialOrder), projectId);
    });
    return this.listReferences(projectId);
  }

  updateReferenceRole(id: string, role: ReferenceRole): ReferenceAsset {
    const row = this.database.rows.reference(id);
    if (!row) throw new AppError("REFERENCE_NOT_FOUND", `参考素材不存在：${id}`);
    if (!REFERENCE_ROLES.has(role)) throw new AppError("INVALID_REFERENCE_ROLE", `不支持的素材用途：${role}`);
    this.database.db.prepare("UPDATE reference_assets SET role = ? WHERE id = ?").run(role, id);
    return this.database.mapReference({ ...row, role });
  }

  private commitReferenceReplacements(replacements: Array<{ asset: ReferenceAsset; sourcePath: string }>): void {
    const prepared: PreparedReferenceReplacement[] = [];
    const temporaryFiles: string[] = [];
    let filesApplied = false;
    try {
      for (const { asset, sourcePath } of replacements) {
        ensureFile(sourcePath, REFERENCE_EXTENSIONS);
        const extension = path.extname(sourcePath).toLowerCase();
        const targetPath = path.join(path.dirname(asset.filePath), `${asset.id}${extension}`);
        const stagingPath = path.join(path.dirname(asset.filePath), `.replace-${asset.id}-${crypto.randomUUID()}${extension}`);
        temporaryFiles.push(stagingPath);
        fs.copyFileSync(sourcePath, stagingPath);
        const stats = fs.statSync(stagingPath);
        const hadOriginal = fs.existsSync(asset.filePath);
        let backupPath: string | null = null;
        if (hadOriginal) {
          backupPath = path.join(path.dirname(asset.filePath), `.backup-${asset.id}-${crypto.randomUUID()}${path.extname(asset.filePath)}`);
          temporaryFiles.push(backupPath);
          fs.copyFileSync(asset.filePath, backupPath);
        }
        prepared.push({
          asset,
          sourcePath,
          targetPath,
          stagingPath,
          backupPath,
          hadOriginal,
          name: path.basename(sourcePath),
          mimeType: mimeFromExtension(targetPath),
          fileSize: stats.size,
          sha256: hashFile(stagingPath),
        });
      }

      for (const item of prepared) fs.copyFileSync(item.stagingPath, item.targetPath);
      filesApplied = true;
      this.database.transaction(() => {
        const statement = this.database.db.prepare(`UPDATE reference_assets SET
          name = ?, file_path = ?, mime_type = ?, file_size = ?, sha256 = ? WHERE id = ?`);
        for (const item of prepared) {
          statement.run(item.name, item.targetPath, item.mimeType, item.fileSize, item.sha256, item.asset.id);
        }
      });

      filesApplied = false;
      for (const item of prepared) {
        if (!samePath(item.targetPath, item.asset.filePath)) {
          try {
            fs.rmSync(item.asset.filePath, { force: true });
          } catch {
            // The database already points at the verified replacement. A stale
            // old-extension copy is harmless and can be cleaned on a later run.
          }
        }
      }
    } catch (error) {
      if (filesApplied) {
        for (const item of prepared) {
          if (item.backupPath && fs.existsSync(item.backupPath)) {
            fs.copyFileSync(item.backupPath, item.asset.filePath);
          } else if (!item.hadOriginal) {
            fs.rmSync(item.asset.filePath, { force: true });
          }
          if (!samePath(item.targetPath, item.asset.filePath)) fs.rmSync(item.targetPath, { force: true });
        }
      }
      throw error;
    } finally {
      for (const filePath of temporaryFiles) fs.rmSync(filePath, { force: true });
    }
  }

  replaceReference(id: string, sourcePath: string): ReferenceAsset {
    const row = this.database.rows.reference(id);
    if (!row) throw new AppError("REFERENCE_NOT_FOUND", `参考素材不存在：${id}`);
    const old = this.database.mapReference(row);
    this.commitReferenceReplacements([{ asset: old, sourcePath }]);
    return this.database.mapReference(this.database.rows.reference(id)!);
  }

  batchReplaceReferences(projectId: string, sourcePaths: string[]): ReferenceAsset[] {
    const current = this.listReferences(projectId);
    if (!current.length) throw new AppError("NO_REFERENCES", "当前项目没有可批量替换的参考素材");
    if (sourcePaths.length !== current.length) {
      throw new AppError(
        "BATCH_REPLACE_COUNT_MISMATCH",
        `请选择 ${current.length} 个文件；当前选择了 ${sourcePaths.length} 个`,
      );
    }
    sourcePaths.forEach((sourcePath) => ensureFile(sourcePath, REFERENCE_EXTENSIONS));
    this.commitReferenceReplacements(current.map((asset, index) => ({ asset, sourcePath: sourcePaths[index] })));
    return this.listReferences(projectId);
  }

  removeReference(id: string): void {
    const row = this.database.rows.reference(id);
    if (!row) throw new AppError("REFERENCE_NOT_FOUND", `参考素材不存在：${id}`);
    const asset = this.database.mapReference(row);
    this.database.transaction(() => {
      this.database.db.prepare("DELETE FROM reference_assets WHERE id = ?").run(id);
      const remaining = this.database.rows.references(asset.projectId);
      const offset = remaining.length + 1000;
      this.database.db.prepare("UPDATE reference_assets SET position = position + ? WHERE project_id = ?").run(offset, asset.projectId);
      const statement = this.database.db.prepare("UPDATE reference_assets SET position = ? WHERE id = ?");
      remaining.forEach((item, index) => statement.run(index, item.id));
      const project = this.getProject(asset.projectId);
      const materialOrder = reconcileMaterialOrder(
        project.materialOrder.filter((key) => key !== referenceMaterialKey(id)),
        project.portraitIds,
        remaining.map((item) => item.id),
      );
      this.database.db.prepare("UPDATE projects SET material_order_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(materialOrder), now(), asset.projectId);
    });
    fs.rmSync(asset.filePath, { force: true });
  }

  listPlatformPortraits(workspaceId?: string): PlatformPortrait[] {
    const all = this.database.rows.platformPortraits().map((row) => this.database.mapPlatformPortrait(row));
    return workspaceId ? all.filter((portrait) => portrait.workspaceId === workspaceId) : all;
  }

  private validatePlatformPortraitSelection(ids: string[]): void {
    const available = new Map(this.listPlatformPortraits().map((portrait) => [portrait.id, portrait]));
    const missing = ids.filter((id) => !available.get(id)?.available);
    if (missing.length) throw new AppError("PLATFORM_PORTRAIT_NOT_AVAILABLE", `所选心影虚拟人像不可用：${missing.join(", ")}`);
  }

  syncPlatformPortraits(portraits: PlatformPortrait[], workspaceId = portraits[0]?.workspaceId ?? ""): PlatformPortrait[] {
    const existingById = new Map(this.listPlatformPortraits().map((portrait) => [portrait.id, portrait]));
    const approvedLocalByName = new Map(this.listPortraits()
      .filter((portrait) => portrait.platformStatus === "approved")
      .map((portrait) => [portrait.displayName, portrait]));
    const seen = new Set<string>();
    const normalized = portraits.map((portrait, index) => {
      const id = portrait.id.trim();
      const displayName = portrait.displayName.trim();
      const platformAssetId = portrait.platformAssetId.trim();
      if (!id || !displayName || !platformAssetId) throw new AppError("INVALID_PLATFORM_PORTRAIT", "心影虚拟人像数据不完整");
      if (seen.has(id)) throw new AppError("DUPLICATE_PLATFORM_PORTRAIT", `心影虚拟人像重复：${displayName}`);
      seen.add(id);
      return {
        ...portrait,
        id,
        displayName,
        platformAssetId,
        workspaceId: portrait.workspaceId || workspaceId,
        mediaKind: portrait.mediaKind && portrait.mediaKind !== "unknown"
          ? portrait.mediaKind
          : existingById.get(id)?.mediaKind && existingById.get(id)?.mediaKind !== "unknown"
            ? existingById.get(id)!.mediaKind
            : approvedLocalByName.get(displayName)?.mimeType.startsWith("video/") ? "video" : "unknown",
        sortOrder: Number.isInteger(portrait.sortOrder) ? portrait.sortOrder : index,
        deleteSortOrder: Number.isInteger(portrait.deleteSortOrder) ? portrait.deleteSortOrder : null,
        canDelete: Boolean(portrait.canDelete),
        previewUrl: validateRemotePortraitUrl(portrait.previewUrl),
        available: true,
        lastSeenAt: portrait.lastSeenAt || now(),
      };
    });
    if (normalized.some((portrait) => portrait.workspaceId !== workspaceId)) {
      throw new AppError("MIXED_PLATFORM_PORTRAIT_WORKSPACES", "一次同步只能写入同一个心影空间的人像库");
    }
    this.database.transaction(() => {
      if (workspaceId) this.database.db.prepare("UPDATE platform_portraits SET available = 0 WHERE workspace_id = ''").run();
      this.database.db.prepare("UPDATE platform_portraits SET available = 0 WHERE workspace_id = ?").run(workspaceId);
      const upsert = this.database.db.prepare(`INSERT INTO platform_portraits
        (id, display_name, preview_url, platform_asset_id, workspace_id, media_kind, sort_order, delete_sort_order, can_delete, available, last_seen_at)
        VALUES (@id, @displayName, @previewUrl, @platformAssetId, @workspaceId, @mediaKind, @sortOrder, @deleteSortOrder, @canDelete, 1, @lastSeenAt)
        ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, preview_url = excluded.preview_url,
          platform_asset_id = excluded.platform_asset_id, workspace_id = excluded.workspace_id, media_kind = excluded.media_kind,
          sort_order = excluded.sort_order, delete_sort_order = excluded.delete_sort_order, can_delete = excluded.can_delete,
          available = 1, last_seen_at = excluded.last_seen_at`);
      for (const portrait of normalized) upsert.run({ ...portrait, canDelete: portrait.canDelete ? 1 : 0 });
    });
    return this.listPlatformPortraits(workspaceId);
  }

  validatePlatformPortraitDeletion(ids: string[], workspaceId: string): PlatformPortrait[] {
    const normalized = ids.map((id) => id.trim()).filter(Boolean);
    if (!normalized.length) throw new AppError("PLATFORM_PORTRAIT_DELETE_EMPTY", "请至少选择一个要删除的心影虚拟人像");
    if (normalized.length > 120) throw new AppError("PLATFORM_PORTRAIT_DELETE_LIMIT", "一次最多删除 120 个心影虚拟人像");
    if (new Set(normalized).size !== normalized.length) {
      throw new AppError("DUPLICATE_PLATFORM_PORTRAIT", "待删除的虚拟人像不能重复");
    }
    const available = new Map(this.listPlatformPortraits().map((portrait) => [portrait.id, portrait]));
    return normalized.map((id) => {
      const portrait = available.get(id);
      if (!portrait?.available) throw new AppError("PLATFORM_PORTRAIT_NOT_AVAILABLE", `待删除的心影虚拟人像已不可用：${id}`);
      if (portrait.workspaceId !== workspaceId) {
        throw new AppError("PLATFORM_PORTRAIT_WORKSPACE_MISMATCH", `虚拟人像不属于当前心影空间：${portrait.displayName}`);
      }
      if (!portrait.canDelete) {
        throw new AppError("PLATFORM_PORTRAIT_DELETE_FORBIDDEN", `你没有删除该虚拟人像的权限：${portrait.displayName}`);
      }
      return portrait;
    });
  }

  markPlatformPortraitsDeleted(ids: string[], workspaceId: string): void {
    if (!ids.length) return;
    const deleted = new Set(ids);
    const timestamp = now();
    this.database.transaction(() => {
      const markDeleted = this.database.db.prepare(
        "UPDATE platform_portraits SET available = 0, can_delete = 0, last_seen_at = ? WHERE id = ? AND workspace_id = ?",
      );
      for (const id of deleted) markDeleted.run(timestamp, id, workspaceId);

      const updateProject = this.database.db.prepare(
        "UPDATE projects SET portrait_ids_json = ?, material_order_json = ?, updated_at = ? WHERE id = ?",
      );
      for (const project of this.listProjects().filter((item) => item.platformWorkspaceId === workspaceId)) {
        const portraitIds = project.portraitIds.filter((id) => !deleted.has(id));
        const referenceIds = this.database.rows.references(project.id).map((row) => this.database.mapReference(row).id);
        const materialOrder = reconcileMaterialOrder(project.materialOrder, portraitIds, referenceIds);
        updateProject.run(JSON.stringify(portraitIds), JSON.stringify(materialOrder), timestamp, project.id);
      }
    });
  }

  updatePlatformPortraitMediaKind(id: string, mediaKind: PlatformPortrait["mediaKind"]): PlatformPortrait {
    if (mediaKind === "unknown") throw new AppError("INVALID_MEDIA_KIND", "不能把已识别的虚拟人像恢复为未知媒体类型");
    const row = this.database.rows.platformPortraits().find((item) => item.id === id);
    if (!row) throw new AppError("PLATFORM_PORTRAIT_NOT_FOUND", `心影虚拟人像不存在：${id}`);
    this.database.db.prepare("UPDATE platform_portraits SET media_kind = ?, last_seen_at = ? WHERE id = ?")
      .run(mediaKind, now(), id);
    return this.database.mapPlatformPortrait(this.database.rows.platformPortraits().find((item) => item.id === id)!);
  }

  private upsertCompletedJobResults(): void {
    const upsert = this.database.db.prepare(`INSERT INTO platform_results
      (id, project_id, platform_project_id, platform_task_id, job_id, prompt, output_url, preview_url, output_path, marked, available, created_at, last_seen_at)
      VALUES (@id, @projectId, @platformProjectId, @platformTaskId, @jobId, @prompt, @outputUrl, @previewUrl, @outputPath, 0, 1, @createdAt, @lastSeenAt)
      ON CONFLICT(id) DO UPDATE SET output_url = COALESCE(excluded.output_url, platform_results.output_url),
        output_path = COALESCE(excluded.output_path, platform_results.output_path), available = 1, last_seen_at = excluded.last_seen_at`);
    for (const job of this.listJobs().filter((item) => item.kind === "generation" && item.status === "completed" && item.projectId)) {
      const project = this.getProject(job.projectId!);
      upsert.run({
        id: `job:${job.id}`,
        projectId: job.projectId,
        platformProjectId: project.platformProjectId,
        platformTaskId: job.platformTaskId ?? "",
        jobId: job.id,
        prompt: job.promptSnapshot,
        outputUrl: job.outputUrl,
        previewUrl: job.outputUrl,
        outputPath: job.outputPath,
        createdAt: job.completedAt ?? job.createdAt,
        lastSeenAt: now(),
      });
    }
  }

  listResults(projectId?: string): PlatformResult[] {
    this.upsertCompletedJobResults();
    return this.database.rows.platformResults(projectId)
      .map((row) => this.database.mapPlatformResult(row))
      .filter((result) => result.available);
  }

  getResult(id: string): PlatformResult {
    this.upsertCompletedJobResults();
    const row = this.database.rows.platformResult(id);
    if (!row) throw new AppError("RESULT_NOT_FOUND", `结果不存在：${id}`);
    return this.database.mapPlatformResult(row);
  }

  syncPlatformResults(projectId: string, results: PlatformResult[]): PlatformResult[] {
    const project = this.getProject(projectId);
    this.upsertCompletedJobResults();
    const localJobsByTask = new Map(this.listJobs()
      .filter((job) => job.kind === "generation" && job.status === "completed" && job.projectId === projectId && job.platformTaskId)
      .map((job) => [job.platformTaskId!, job]));
    const seen = new Set<string>();
    const syncedAt = now();
    const normalized = results.map((result) => {
      if (result.projectId !== projectId || result.platformProjectId !== project.platformProjectId) {
        throw new AppError("RESULT_PROJECT_MISMATCH", "心影结果不属于当前项目");
      }
      const localJob = localJobsByTask.get(result.platformTaskId);
      const id = localJob ? `job:${localJob.id}` : result.id;
      if (!id || seen.has(id)) throw new AppError("DUPLICATE_RESULT", "心影返回了重复结果");
      seen.add(id);
      return { ...result, id, jobId: localJob?.id ?? result.jobId, outputPath: localJob?.outputPath ?? result.outputPath, available: true, lastSeenAt: result.lastSeenAt || syncedAt };
    });
    this.database.transaction(() => {
      this.database.db.prepare("UPDATE platform_results SET available = 0 WHERE project_id = ? AND job_id IS NULL").run(projectId);
      const upsert = this.database.db.prepare(`INSERT INTO platform_results
        (id, project_id, platform_project_id, platform_task_id, job_id, prompt, output_url, preview_url, output_path, marked, available, created_at, last_seen_at)
        VALUES (@id, @projectId, @platformProjectId, @platformTaskId, @jobId, @prompt, @outputUrl, @previewUrl, @outputPath, @marked, 1, @createdAt, @lastSeenAt)
        ON CONFLICT(id) DO UPDATE SET platform_task_id = excluded.platform_task_id, prompt = excluded.prompt,
          output_url = COALESCE(excluded.output_url, platform_results.output_url), preview_url = COALESCE(excluded.preview_url, platform_results.preview_url),
          output_path = COALESCE(platform_results.output_path, excluded.output_path), available = 1, last_seen_at = excluded.last_seen_at`);
      for (const result of normalized) upsert.run({ ...result, marked: result.marked ? 1 : 0 });
    });
    return this.listResults(projectId);
  }

  markResults(ids: string[], marked: boolean): PlatformResult[] {
    const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!normalized.length) throw new AppError("RESULT_SELECTION_EMPTY", "请至少选择一个结果");
    const update = this.database.db.prepare("UPDATE platform_results SET marked = ? WHERE id = ?");
    this.database.transaction(() => normalized.forEach((id) => {
      if (!this.database.rows.platformResult(id)) throw new AppError("RESULT_NOT_FOUND", `结果不存在：${id}`);
      update.run(marked ? 1 : 0, id);
    }));
    return normalized.map((id) => this.getResult(id));
  }

  async exportResult(id: string, destination: string): Promise<PlatformResult> {
    let result = this.getResult(id);
    const exportPath = path.resolve(destination);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    if (result.jobId) {
      const job = await this.downloadJob(result.jobId, exportPath);
      this.database.db.prepare("UPDATE platform_results SET output_path = ?, last_seen_at = ? WHERE id = ?")
        .run(job.outputPath, now(), id);
      return this.getResult(id);
    }
    let sourcePath = result.outputPath && fs.existsSync(result.outputPath) ? result.outputPath : null;
    if (!sourcePath && result.outputUrl) {
      const remote = new URL(result.outputUrl);
      if (remote.protocol !== "https:") throw new AppError("DOWNLOAD_FAILED", "结果地址必须使用 HTTPS");
      const response = await fetch(remote);
      if (!response.ok) throw new AppError("DOWNLOAD_FAILED", `下载失败：HTTP ${response.status}`);
      sourcePath = path.join(this.paths.outputsDir, `${result.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.mp4`);
      fs.writeFileSync(sourcePath, Buffer.from(await response.arrayBuffer()));
      this.database.db.prepare("UPDATE platform_results SET output_path = ?, last_seen_at = ? WHERE id = ?")
        .run(sourcePath, now(), id);
      result = this.getResult(id);
    }
    if (!sourcePath) throw new AppError("OUTPUT_NOT_FOUND", "该心影结果暂时没有可直接下载的地址，请先重新同步");
    if (!samePath(sourcePath, exportPath)) fs.copyFileSync(sourcePath, exportPath);
    return result;
  }

  listPortraits(): PortraitAsset[] {
    return this.database.rows.portraits().map((row) => this.database.mapPortrait(row));
  }

  addPortraits(filePaths: string[], consentConfirmed: boolean): PortraitAsset[] {
    if (!filePaths.length) return this.listPortraits();
    filePaths.forEach((sourcePath) => ensureFile(sourcePath, PORTRAIT_EXTENSIONS));
    this.database.transaction(() => {
      for (const sourcePath of filePaths) {
        const id = crypto.randomUUID();
        const targetPath = path.join(this.paths.portraitsDir, `${id}${path.extname(sourcePath).toLowerCase()}`);
        fs.copyFileSync(sourcePath, targetPath);
        const timestamp = now();
        this.database.db.prepare(`INSERT INTO portrait_assets
          (id, name, display_name, file_path, mime_type, consent_confirmed, gender, age_group, ethnicity, application_scope,
           platform_status, review_note, platform_asset_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, '其他', '其他', '其他', 'domestic', 'local', '', NULL, ?, ?)`)
          .run(id, path.basename(sourcePath), path.parse(sourcePath).name, targetPath, mimeFromExtension(targetPath), consentConfirmed ? 1 : 0, timestamp, timestamp);
      }
    });
    return this.listPortraits();
  }

  authorizeReference(referenceId: string, projectId: string, consentConfirmed: boolean): Job {
    if (!consentConfirmed) throw new AppError("CONSENT_REQUIRED", "请先确认虚拟人像素材合规承诺");
    const project = this.getProject(projectId);
    if (!project.platformProjectId || !project.platformUrl) {
      throw new AppError("PLATFORM_PROJECT_REQUIRED", "请先选择心影空间和项目，再授权虚拟人像");
    }
    const row = this.database.rows.reference(referenceId);
    if (!row) throw new AppError("REFERENCE_NOT_FOUND", `参考素材不存在：${referenceId}`);
    const reference = this.database.mapReference(row);
    if (mediaKindFromMime(reference.mimeType) === "audio") {
      throw new AppError("AUDIO_PORTRAIT_UNSUPPORTED", "音频参考不能授权为虚拟人像；只有图片或视频可以授权");
    }
    if (reference.projectId !== projectId) throw new AppError("REFERENCE_PROJECT_MISMATCH", "参考素材不属于当前项目");
    const linkedPortraits = this.listPortraits().filter((portrait) => portrait.sourceReferenceId === referenceId);
    const linkedIds = new Set(linkedPortraits.map((portrait) => portrait.id));
    const linkedJobs = this.listJobs().filter((job) => job.kind === "portrait-review" && Boolean(job.portraitId && linkedIds.has(job.portraitId)));
    const activeJob = linkedJobs.find((job) => !TERMINAL_JOB_STATUSES.has(job.status));
    if (activeJob) return activeJob;
    const approvedPortrait = linkedPortraits.find((portrait) => portrait.platformStatus === "approved");
    const completedJob = approvedPortrait && linkedJobs.find((job) => job.portraitId === approvedPortrait.id && job.status === "completed");
    if (completedJob) return completedJob;
    const reusablePortrait = linkedPortraits[0];
    if (reusablePortrait) return this.submitPortraitReview(reusablePortrait.id, projectId);
    const before = new Set(this.listPortraits().map((portrait) => portrait.id));
    const imported = this.addPortraits([reference.filePath], true).find((portrait) => !before.has(portrait.id));
    if (!imported) throw new AppError("PORTRAIT_IMPORT_FAILED", "未能把参考图加入虚拟人像授权队列");
    this.database.db.prepare("UPDATE portrait_assets SET source_reference_id = ?, updated_at = ? WHERE id = ?")
      .run(referenceId, now(), imported.id);
    this.updatePortraitMetadata(imported.id, { displayName: path.parse(reference.name).name });
    return this.submitPortraitReview(imported.id, projectId);
  }

  getPortrait(id: string): PortraitAsset {
    const row = this.database.rows.portrait(id);
    if (!row) throw new AppError("PORTRAIT_NOT_FOUND", `虚拟人像素材不存在：${id}`);
    return this.database.mapPortrait(row);
  }

  updatePortraitMetadata(id: string, input: PortraitMetadataInput): PortraitAsset {
    const current = this.getPortrait(id);
    const active = this.listJobs().find((job) => job.portraitId === id && ["queued", "submitting", "running"].includes(job.status));
    if (active) throw new AppError("PORTRAIT_METADATA_LOCKED", "虚拟人像正在上传或审核，暂时不能修改资料");
    const next: PortraitAsset = {
      ...current,
      ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.ageGroup !== undefined ? { ageGroup: input.ageGroup } : {}),
      ...(input.ethnicity !== undefined ? { ethnicity: input.ethnicity } : {}),
      ...(input.applicationScope !== undefined ? { applicationScope: input.applicationScope } : {}),
      updatedAt: now(),
    };
    validatePortraitMetadata(next);
    this.database.db.prepare(`UPDATE portrait_assets SET
      display_name = ?, gender = ?, age_group = ?, ethnicity = ?, application_scope = ?, updated_at = ? WHERE id = ?`)
      .run(next.displayName, next.gender, next.ageGroup, next.ethnicity, next.applicationScope, next.updatedAt, id);
    return this.getPortrait(id);
  }

  removePortrait(id: string): void {
    const portrait = this.getPortrait(id);
    const active = this.listJobs().filter((job) => job.portraitId === id && !TERMINAL_JOB_STATUSES.has(job.status));
    if (active.length) throw new AppError("PORTRAIT_HAS_ACTIVE_JOB", "虚拟人像仍有关联的审核任务，请先完成或取消该任务");
    this.database.db.prepare("DELETE FROM portrait_assets WHERE id = ?").run(id);
    fs.rmSync(portrait.filePath, { force: true });
  }

  previewSubmission(projectId: string): SubmissionPreview {
    const storedProject = this.getProject(projectId);
    const references = this.listReferences(projectId);
    const platformPortraits = new Map(this.listPlatformPortraits().map((portrait) => [portrait.id, portrait]));
    const materialOrder = reconcileMaterialOrder(storedProject.materialOrder, storedProject.portraitIds, references.map((reference) => reference.id));
    const project = { ...storedProject, materialOrder };
    const selectedPortraits = materialOrder
      .map(parseMaterialKey)
      .filter((item): item is { kind: "portrait"; id: string } => item?.kind === "portrait")
      .map((item) => platformPortraits.get(item.id))
      .filter((portrait): portrait is PlatformPortrait => Boolean(portrait));
    const referencesById = new Map(references.map((reference) => [reference.id, reference]));
    const portraitsById = new Map(selectedPortraits.map((portrait) => [portrait.id, portrait]));
    const orderedKinds = materialOrder.map((key) => {
      const item = parseMaterialKey(key);
      if (item?.kind === "portrait") return portraitsById.get(item.id)?.mediaKind ?? "unknown";
      const reference = item?.kind === "reference" ? referencesById.get(item.id) : undefined;
      return reference ? mediaKindFromMime(reference.mimeType) : "unknown";
    });
    const mediaLabels = assignMediaLabels(orderedKinds);
    const warnings: string[] = [];
    if (!project.prompt.trim()) warnings.push("提示词为空");
    if (!project.platformWorkspaceId || !project.platformProjectId) warnings.push("请先从心影空间与项目列表选择一个项目");
    if (!project.platformUrl) warnings.push("当前心影项目尚未建立内容生成会话，请重新进入该项目");
    if (project.portraitIds.length !== selectedPortraits.length || selectedPortraits.some((portrait) => !portrait.available)) warnings.push("至少一个已选心影虚拟人像当前不可用，请重新同步并选择");
    if (project.mode !== "text-to-video" && references.length + selectedPortraits.length === 0) warnings.push("当前模式需要至少一项参考素材或心影虚拟人像");
    if (project.mode === "text-to-video" && (references.length > 0 || selectedPortraits.length > 0)) warnings.push("文生视频模式不能包含参考图或虚拟人像，请移除素材或切换生成模式");
    if (project.mode === "first-last-frame" && (references.length !== 2 || references.some((reference) => mediaKindFromMime(reference.mimeType) !== "image"))) warnings.push("首尾帧模式必须正好包含两张图片");
    if (project.mode === "first-last-frame" && selectedPortraits.length > 0) warnings.push("首尾帧模式不能同时使用心影虚拟人像");
    if (project.mode === "first-last-frame" && !project.modelName.includes("首尾帧")) warnings.push("首尾帧模式必须选择名称包含“首尾帧”的心影模型");
    if (project.mode !== "first-last-frame" && project.modelName.includes("首尾帧")) warnings.push("当前生成模式与首尾帧模型不匹配");
    if (project.mode === "first-last-frame" && references.length === 2 && (references[0].role !== "first-frame" || references[1].role !== "last-frame")) {
      warnings.push("首尾帧模式请将 @图1 标为首帧、@图2 标为尾帧");
    }
    if (references.length + selectedPortraits.length > 9) warnings.push("参考图片、视频、音频与虚拟人像合计超过 9 项，请在心影当前页面确认实际限制");
    references.forEach((item) => {
      if (!fs.existsSync(item.filePath)) warnings.push(`素材文件已丢失：${item.name}`);
    });
    if (!orderedKinds.includes("unknown")) {
      const availableLabels = new Set(mediaLabels);
      const promptLabels = [...project.prompt.matchAll(/@(图|视频|音频)\d+/g)].map((match) => match[0]);
      const invalid = [...new Set(promptLabels.filter((label) => !availableLabels.has(label)))];
      if (invalid.length) warnings.push(`提示词引用了不存在的编号：${invalid.join("、")}`);
    }
    return {
      project,
      references,
      selectedPortraits,
      orderedLabels: materialOrder.map((key, index) => {
        const item = parseMaterialKey(key);
        if (item?.kind === "portrait") {
          const portrait = portraitsById.get(item.id);
          const kind = portrait?.mediaKind ?? "unknown";
          return `${mediaLabels[index]} / @${mediaKindEnglishLabel(kind)}${mediaLabels[index].match(/\d+$/)?.[0] ?? "?"} · 心影虚拟人像 · ${portrait?.displayName ?? item.id}`;
        }
        const reference = item?.kind === "reference" ? referencesById.get(item.id) : undefined;
        const kind = reference ? mediaKindFromMime(reference.mimeType) : "unknown";
        return `${mediaLabels[index]} / @${mediaKindEnglishLabel(kind)}${mediaLabels[index].match(/\d+$/)?.[0] ?? "?"} · ${reference?.role ?? "other"} · ${reference?.name ?? item?.id ?? key}`;
      }),
      warnings,
      ready: warnings.length === 0,
    };
  }

  submitGeneration(projectId: string): Job {
    const preview = this.previewSubmission(projectId);
    if (!preview.ready) {
      throw new AppError("PROJECT_NOT_READY", "项目尚未达到提交条件", preview.warnings);
    }
    const timestamp = now();
    const id = crypto.randomUUID();
    const snapshotDir = path.join(this.paths.jobSnapshotsDir, id);
    let snapshotReferences: ReferenceAsset[] = [];
    try {
      if (preview.references.length) fs.mkdirSync(snapshotDir, { recursive: true });
      snapshotReferences = preview.references.map((reference, index) => {
        const extension = path.extname(reference.filePath).toLowerCase();
        const snapshotPath = path.join(snapshotDir, `${String(index + 1).padStart(3, "0")}-${reference.id}${extension}`);
        fs.copyFileSync(reference.filePath, snapshotPath);
        const snapshotHash = hashFile(snapshotPath);
        if (snapshotHash !== reference.sha256) {
          throw new AppError("REFERENCE_CHANGED", `素材在提交快照期间发生变化：${reference.name}`);
        }
        return { ...reference, filePath: snapshotPath, sha256: snapshotHash };
      });
      this.database.db.prepare(`INSERT INTO jobs
        (id, kind, project_id, portrait_id, status, platform_task_id, prompt_snapshot,
         parameters_json, references_json, output_path, output_url, error_code, error_message,
         requires_human_reason, retry_count, created_at, submitted_at, completed_at, updated_at)
        VALUES (?, 'generation', ?, NULL, 'queued', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, ?)`)
        .run(
          id,
          projectId,
          preview.project.prompt,
          JSON.stringify({
            mode: preview.project.mode,
            modelName: preview.project.modelName,
            platformUrl: preview.project.platformUrl,
            platformWorkspaceId: preview.project.platformWorkspaceId,
            platformProjectId: preview.project.platformProjectId,
            aspectRatio: preview.project.aspectRatio,
            duration: preview.project.duration,
            resolution: preview.project.resolution,
            audioEnabled: preview.project.audioEnabled,
            portraitIds: preview.project.portraitIds,
            materialOrder: preview.project.materialOrder,
            platformPortraits: preview.selectedPortraits,
          }),
          JSON.stringify(snapshotReferences),
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (snapshotDir.startsWith(`${this.paths.jobSnapshotsDir}${path.sep}`)) {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      }
      throw error;
    }
    this.addJobEvent(id, "info", "JOB_QUEUED", "生成任务已加入本地队列");
    return this.getJob(id);
  }

  submitPortraitReview(portraitId: string, projectId?: string): Job {
    const portrait = this.getPortrait(portraitId);
    if (!portrait.consentConfirmed) {
      throw new AppError("CONSENT_REQUIRED", "提交虚拟人像审核前必须确认已获得素材授权");
    }
    validatePortraitMetadata(portrait);
    const active = this.listJobs().find((job) => job.portraitId === portraitId && !TERMINAL_JOB_STATUSES.has(job.status));
    if (active) throw new AppError("PORTRAIT_REVIEW_ACTIVE", `该素材已有活动审核任务：${active.id}`);
    const timestamp = now();
    const id = crypto.randomUUID();
    const project = projectId ? this.getProject(projectId) : undefined;
    if (projectId && (!project?.platformProjectId || !project.platformUrl)) {
      throw new AppError("PLATFORM_PROJECT_REQUIRED", "请先选择心影空间和项目，再上传授权虚拟人像");
    }
    const parameters = project ? {
      platformUrl: project.platformUrl,
      platformWorkspaceId: project.platformWorkspaceId,
      platformProjectId: project.platformProjectId,
      modelName: project.modelName,
    } : {};
    this.database.transaction(() => {
      this.database.db.prepare(`INSERT INTO jobs
        (id, kind, project_id, portrait_id, status, platform_task_id, prompt_snapshot,
         parameters_json, references_json, output_path, output_url, error_code, error_message,
         requires_human_reason, retry_count, created_at, submitted_at, completed_at, updated_at)
        VALUES (?, 'portrait-review', ?, ?, 'queued', NULL, '', ?, '[]', NULL, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, ?)`)
        .run(id, projectId ?? null, portraitId, JSON.stringify(parameters), timestamp, timestamp);
      this.database.db.prepare("UPDATE portrait_assets SET platform_status = 'queued', updated_at = ? WHERE id = ?")
        .run(timestamp, portraitId);
    });
    this.addJobEvent(id, "info", "PORTRAIT_REVIEW_QUEUED", "虚拟人像审核任务已加入本地队列");
    return this.getJob(id);
  }

  listJobs(): Job[] {
    return this.database.rows.jobs().map((row) => this.database.mapJob(row));
  }

  listQueuedJobs(): Job[] {
    return this.database.rows.queuedJobs().map((row) => this.database.mapJob(row));
  }

  recoverInterruptedJobs(): Job[] {
    const interrupted = this.listJobs().filter((job) => job.status === "submitting");
    for (const job of interrupted) {
      this.updateJob(job.id, {
        status: "needs-human",
        errorCode: "APP_RESTART_DURING_SUBMIT",
        errorMessage: "APP 在提交阶段退出，无法安全判断心影是否已经收到任务",
        requiresHumanReason: "请在原网页模式检查是否出现了对应的新对话；确认后再恢复任务，避免重复提交",
      });
      this.addJobEvent(
        job.id,
        "warning",
        "APP_RESTART_DURING_SUBMIT",
        "检测到上次运行在提交阶段中断，已暂停并等待人工确认，防止重复提交",
      );
    }
    return interrupted.map((job) => this.getJob(job.id));
  }

  getJob(id: string): Job {
    const row = this.database.rows.job(id);
    if (!row) throw new AppError("JOB_NOT_FOUND", `任务不存在：${id}`);
    return this.database.mapJob(row);
  }

  listJobEvents(id: string): JobEvent[] {
    this.getJob(id);
    return this.database.rows.events(id).map((row) => this.database.mapEvent(row));
  }

  addJobEvent(
    jobId: string,
    level: JobEvent["level"],
    code: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): void {
    this.database.db.prepare(`INSERT INTO job_events
      (job_id, level, code, message, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(jobId, level, code, message, JSON.stringify(metadata), now());
  }

  updateJob(id: string, patch: Partial<Job>): Job {
    const current = this.getJob(id);
    const next = { ...current, ...patch, updatedAt: now() };
    this.database.db.prepare(`UPDATE jobs SET
      status = @status, platform_task_id = @platformTaskId, output_path = @outputPath,
      output_url = @outputUrl, error_code = @errorCode, error_message = @errorMessage,
      requires_human_reason = @requiresHumanReason, retry_count = @retryCount,
      submitted_at = @submittedAt, completed_at = @completedAt, updated_at = @updatedAt
      WHERE id = @id`).run(next);
    return this.getJob(id);
  }

  cancelJob(id: string): Job {
    const job = this.getJob(id);
    if (["completed", "failed"].includes(job.status)) return job;
    if (job.status === "cancelled") {
      return job.requiresHumanReason || job.errorCode || job.errorMessage
        ? this.updateJob(id, { requiresHumanReason: null, errorCode: null, errorMessage: null })
        : job;
    }
    if (!["draft", "queued", "needs-human", "needs-login"].includes(job.status)) {
      throw new AppError("CANCEL_NEEDS_PLATFORM", "运行中的任务必须在心影页面确认取消");
    }
    const updated = this.updateJob(id, {
      status: "cancelled",
      completedAt: now(),
      errorCode: null,
      errorMessage: null,
      requiresHumanReason: null,
    });
    if (job.kind === "portrait-review" && job.portraitId) {
      this.updatePortraitReviewState(job.portraitId, "local", "本地审核任务已取消；如心影表单仍打开，请人工关闭");
    }
    this.addJobEvent(id, "warning", "JOB_CANCELLED", "任务已在本地取消");
    return updated;
  }

  resumeJob(id: string): Job {
    const job = this.getJob(id);
    if (!["needs-human", "needs-login", "failed"].includes(job.status)) {
      throw new AppError("JOB_NOT_RESUMABLE", `任务当前状态不可恢复：${job.status}`);
    }
    const updated = this.updateJob(id, {
      status: "queued",
      errorCode: null,
      errorMessage: null,
      requiresHumanReason: null,
      retryCount: job.retryCount + 1,
    });
    this.addJobEvent(id, "info", "JOB_RESUMED", "人工处理完成，任务已重新加入队列");
    return updated;
  }

  updatePortraitReviewState(id: string, platformStatus: PortraitAsset["platformStatus"], reviewNote: string): PortraitAsset {
    this.getPortrait(id);
    this.database.db.prepare("UPDATE portrait_assets SET platform_status = ?, review_note = ?, updated_at = ? WHERE id = ?")
      .run(platformStatus, reviewNote, now(), id);
    return this.getPortrait(id);
  }

  async downloadJob(id: string, destination: string): Promise<Job> {
    const job = this.getJob(id);
    if (job.status !== "completed") throw new AppError("JOB_NOT_COMPLETE", "任务尚未完成");
    const exportPath = path.resolve(destination);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    let current = job;
    let sourcePath = job.outputPath && fs.existsSync(job.outputPath) ? job.outputPath : null;
    if (!sourcePath && job.outputUrl) {
      let resultUrl: URL;
      try {
        resultUrl = new URL(job.outputUrl);
      } catch {
        throw new AppError("DOWNLOAD_FAILED", "结果地址无效");
      }
      if (resultUrl.protocol !== "https:") throw new AppError("DOWNLOAD_FAILED", "结果地址必须使用 HTTPS");
      const response = await fetch(resultUrl);
      if (!response.ok) throw new AppError("DOWNLOAD_FAILED", `下载失败：HTTP ${response.status}`);
      const managedPath = path.join(this.paths.outputsDir, `${job.id}-${safeOutputName(exportPath)}`);
      const stagingPath = `${managedPath}.${crypto.randomUUID()}.part`;
      try {
        fs.writeFileSync(stagingPath, Buffer.from(await response.arrayBuffer()));
        fs.copyFileSync(stagingPath, managedPath);
      } finally {
        fs.rmSync(stagingPath, { force: true });
      }
      current = this.updateJob(id, { outputPath: managedPath });
      sourcePath = managedPath;
    }
    if (!sourcePath) {
      throw new AppError("OUTPUT_NOT_FOUND", "任务没有可下载的输出");
    }
    if (!samePath(sourcePath, exportPath)) fs.copyFileSync(sourcePath, exportPath);
    this.addJobEvent(id, "info", "OUTPUT_DOWNLOADED", "结果已导出，结果库主文件保持不变", {
      destination: exportPath,
      libraryPath: current.outputPath,
    });
    return current;
  }

  filePathFromMediaUrl(url: string): string {
    return fileURLToPath(url);
  }
}
