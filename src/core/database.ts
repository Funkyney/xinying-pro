import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  Job,
  JobEvent,
  JobKind,
  JobStatus,
  PortraitAsset,
  PlatformPortrait,
  PlatformResult,
  Project,
  ReferenceAsset,
  SharedMediaAsset,
} from "../shared/contracts";

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model_name: string;
  platform_url: string;
  platform_workspace_id: string;
  platform_project_id: string;
  mode: Project["mode"];
  aspect_ratio: string;
  duration: number;
  resolution: string;
  audio_enabled: number;
  portrait_ids_json: string;
  material_order_json: string;
  status: Project["status"];
  created_at: string;
  updated_at: string;
}

interface ReferenceRow {
  id: string;
  project_id: string;
  source_shared_media_id: string | null;
  name: string;
  file_path: string;
  mime_type: string;
  file_size: number;
  position: number;
  role: ReferenceAsset["role"];
  sha256: string;
  created_at: string;
}

interface SharedMediaRow {
  id: string;
  name: string;
  file_path: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  created_at: string;
  updated_at: string;
}

interface PortraitRow {
  id: string;
  name: string;
  display_name: string;
  file_path: string;
  mime_type: string;
  consent_confirmed: number;
  gender: PortraitAsset["gender"];
  age_group: PortraitAsset["ageGroup"];
  ethnicity: PortraitAsset["ethnicity"];
  application_scope: PortraitAsset["applicationScope"];
  platform_status: PortraitAsset["platformStatus"];
  review_note: string;
  platform_asset_id: string | null;
  source_reference_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PlatformPortraitRow {
  id: string;
  display_name: string;
  preview_url: string;
  platform_asset_id: string;
  workspace_id: string;
  media_kind: PlatformPortrait["mediaKind"];
  sort_order: number;
  delete_sort_order: number | null;
  can_delete: number;
  available: number;
  last_seen_at: string;
}

interface PlatformResultRow {
  id: string;
  project_id: string;
  platform_project_id: string;
  platform_task_id: string;
  job_id: string | null;
  source: PlatformResult["source"];
  media_kind: PlatformResult["mediaKind"];
  name: string;
  prompt: string;
  output_url: string | null;
  preview_url: string | null;
  output_path: string | null;
  marked: number;
  available: number;
  created_at: string;
  last_seen_at: string;
}

interface JobRow {
  id: string;
  kind: JobKind;
  project_id: string | null;
  portrait_id: string | null;
  status: JobStatus;
  platform_task_id: string | null;
  platform_execution_id: string | null;
  progress: number | null;
  progress_label: string;
  last_checked_at: string | null;
  prompt_snapshot: string;
  parameters_json: string;
  references_json: string;
  output_path: string | null;
  output_url: string | null;
  error_code: string | null;
  error_message: string | null;
  requires_human_reason: string | null;
  retry_count: number;
  created_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface EventRow {
  id: number;
  job_id: string;
  level: JobEvent["level"];
  code: string;
  message: string;
  metadata_json: string;
  created_at: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class XinyingDatabase {
  readonly db: DatabaseType;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT 'Seedance 2.5 全能参考',
        platform_url TEXT NOT NULL DEFAULT '',
        platform_workspace_id TEXT NOT NULL DEFAULT '',
        platform_project_id TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'reference-to-video',
        aspect_ratio TEXT NOT NULL DEFAULT '16:9',
        duration INTEGER NOT NULL DEFAULT 5,
        resolution TEXT NOT NULL DEFAULT 'auto',
        audio_enabled INTEGER NOT NULL DEFAULT 1,
        portrait_ids_json TEXT NOT NULL DEFAULT '[]',
        material_order_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shared_media_assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_media_sha256
        ON shared_media_assets(sha256);
      CREATE INDEX IF NOT EXISTS idx_shared_media_created
        ON shared_media_assets(created_at DESC);

      CREATE TABLE IF NOT EXISTS reference_assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_shared_media_id TEXT REFERENCES shared_media_assets(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'other',
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_position
        ON reference_assets(project_id, position);

      CREATE TABLE IF NOT EXISTS portrait_assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        consent_confirmed INTEGER NOT NULL DEFAULT 0,
        gender TEXT NOT NULL DEFAULT '其他',
        age_group TEXT NOT NULL DEFAULT '其他',
        ethnicity TEXT NOT NULL DEFAULT '其他',
        application_scope TEXT NOT NULL DEFAULT 'domestic',
        platform_status TEXT NOT NULL DEFAULT 'local',
        review_note TEXT NOT NULL DEFAULT '',
        platform_asset_id TEXT,
        source_reference_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_portraits (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        preview_url TEXT NOT NULL,
        platform_asset_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        media_kind TEXT NOT NULL DEFAULT 'unknown',
        sort_order INTEGER NOT NULL DEFAULT 0,
        delete_sort_order INTEGER,
        can_delete INTEGER NOT NULL DEFAULT 0,
        available INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_platform_portraits_available
        ON platform_portraits(available, display_name);

      CREATE TABLE IF NOT EXISTS platform_results (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        platform_project_id TEXT NOT NULL DEFAULT '',
        platform_task_id TEXT NOT NULL DEFAULT '',
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'personal',
        media_kind TEXT NOT NULL DEFAULT 'video',
        name TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        output_url TEXT,
        preview_url TEXT,
        output_path TEXT,
        marked INTEGER NOT NULL DEFAULT 0,
        available INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_platform_results_project
        ON platform_results(project_id, available, created_at DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        portrait_id TEXT REFERENCES portrait_assets(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        platform_task_id TEXT,
        platform_execution_id TEXT,
        progress INTEGER,
        progress_label TEXT NOT NULL DEFAULT '',
        last_checked_at TEXT,
        prompt_snapshot TEXT NOT NULL DEFAULT '',
        parameters_json TEXT NOT NULL DEFAULT '{}',
        references_json TEXT NOT NULL DEFAULT '[]',
        output_path TEXT,
        output_url TEXT,
        error_code TEXT,
        error_message TEXT,
        requires_human_reason TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        submitted_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const projectColumns = new Set(
      (this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!projectColumns.has("model_name")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN model_name TEXT NOT NULL DEFAULT 'Seedance 2.5 全能参考'");
    }
    if (!projectColumns.has("platform_url")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN platform_url TEXT NOT NULL DEFAULT ''");
    }
    if (!projectColumns.has("portrait_ids_json")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN portrait_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!projectColumns.has("material_order_json")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN material_order_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!projectColumns.has("platform_workspace_id")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN platform_workspace_id TEXT NOT NULL DEFAULT ''");
    }
    if (!projectColumns.has("platform_project_id")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN platform_project_id TEXT NOT NULL DEFAULT ''");
    }

    const referenceColumns = new Set(
      (this.db.prepare("PRAGMA table_info(reference_assets)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!referenceColumns.has("source_shared_media_id")) {
      this.db.exec("ALTER TABLE reference_assets ADD COLUMN source_shared_media_id TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_reference_shared_media ON reference_assets(source_shared_media_id)");

    const platformPortraitColumns = new Set(
      (this.db.prepare("PRAGMA table_info(platform_portraits)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!platformPortraitColumns.has("workspace_id")) {
      this.db.exec("ALTER TABLE platform_portraits ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''");
    }
    if (!platformPortraitColumns.has("sort_order")) {
      this.db.exec("ALTER TABLE platform_portraits ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    }
    if (!platformPortraitColumns.has("can_delete")) {
      this.db.exec("ALTER TABLE platform_portraits ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 0");
    }
    if (!platformPortraitColumns.has("delete_sort_order")) {
      this.db.exec("ALTER TABLE platform_portraits ADD COLUMN delete_sort_order INTEGER");
    }
    if (!platformPortraitColumns.has("media_kind")) {
      this.db.exec("ALTER TABLE platform_portraits ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'unknown'");
    }

    const portraitColumns = new Set(
      (this.db.prepare("PRAGMA table_info(portrait_assets)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!portraitColumns.has("display_name")) this.db.exec("ALTER TABLE portrait_assets ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    if (!portraitColumns.has("gender")) this.db.exec("ALTER TABLE portrait_assets ADD COLUMN gender TEXT NOT NULL DEFAULT '其他'");
    if (!portraitColumns.has("age_group")) this.db.exec("ALTER TABLE portrait_assets ADD COLUMN age_group TEXT NOT NULL DEFAULT '其他'");
    if (!portraitColumns.has("ethnicity")) this.db.exec("ALTER TABLE portrait_assets ADD COLUMN ethnicity TEXT NOT NULL DEFAULT '其他'");
    if (!portraitColumns.has("application_scope")) this.db.exec("ALTER TABLE portrait_assets ADD COLUMN application_scope TEXT NOT NULL DEFAULT 'domestic'");
    if (!portraitColumns.has("source_reference_id")) this.db.exec("ALTER TABLE portrait_assets ADD COLUMN source_reference_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_portrait_source_reference ON portrait_assets(source_reference_id)");
    this.db.exec("UPDATE portrait_assets SET display_name = name WHERE display_name = ''");
    this.db.exec("UPDATE portrait_assets SET gender = '其他' WHERE gender = ''");
    this.db.exec("UPDATE portrait_assets SET age_group = '其他' WHERE age_group = ''");
    this.db.exec("UPDATE portrait_assets SET ethnicity = '其他' WHERE ethnicity = ''");

    const platformResultColumns = new Set(
      (this.db.prepare("PRAGMA table_info(platform_results)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!platformResultColumns.has("source")) {
      this.db.exec("ALTER TABLE platform_results ADD COLUMN source TEXT NOT NULL DEFAULT 'personal'");
    }
    if (!platformResultColumns.has("media_kind")) {
      this.db.exec("ALTER TABLE platform_results ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'video'");
    }
    if (!platformResultColumns.has("name")) {
      this.db.exec("ALTER TABLE platform_results ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_platform_results_source ON platform_results(project_id, source, available, created_at DESC)");

    const jobColumns = new Set(
      (this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!jobColumns.has("platform_execution_id")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN platform_execution_id TEXT");
    }
    if (!jobColumns.has("progress")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN progress INTEGER");
    }
    if (!jobColumns.has("progress_label")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN progress_label TEXT NOT NULL DEFAULT ''");
    }
    if (!jobColumns.has("last_checked_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN last_checked_at TEXT");
    }
  }

  mapProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      modelName: row.model_name,
      platformUrl: row.platform_url,
      platformWorkspaceId: row.platform_workspace_id || (row.platform_url ? "legacy" : ""),
      platformProjectId: row.platform_project_id || this.remoteProjectIdFromUrl(row.platform_url),
      mode: row.mode,
      aspectRatio: row.aspect_ratio,
      duration: row.duration,
      resolution: row.resolution,
      audioEnabled: Boolean(row.audio_enabled),
      portraitIds: parseJson(row.portrait_ids_json, []),
      materialOrder: parseJson(row.material_order_json, []),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  mapReference(row: ReferenceRow): ReferenceAsset {
    return {
      id: row.id,
      projectId: row.project_id,
      sourceSharedMediaId: row.source_shared_media_id,
      name: row.name,
      filePath: row.file_path,
      mimeType: row.mime_type,
      fileSize: row.file_size,
      position: row.position,
      role: row.role,
      sha256: row.sha256,
      createdAt: row.created_at,
    };
  }

  mapSharedMedia(row: SharedMediaRow): SharedMediaAsset {
    const mimeType = row.mime_type;
    return {
      id: row.id,
      name: row.name,
      filePath: row.file_path,
      mimeType,
      mediaKind: mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "image",
      fileSize: row.file_size,
      sha256: row.sha256,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  mapPortrait(row: PortraitRow): PortraitAsset {
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      filePath: row.file_path,
      mimeType: row.mime_type,
      consentConfirmed: Boolean(row.consent_confirmed),
      gender: row.gender,
      ageGroup: row.age_group,
      ethnicity: row.ethnicity,
      applicationScope: row.application_scope,
      platformStatus: row.platform_status,
      reviewNote: row.review_note,
      platformAssetId: row.platform_asset_id,
      sourceReferenceId: row.source_reference_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  mapPlatformPortrait(row: PlatformPortraitRow): PlatformPortrait {
    return {
      id: row.id,
      displayName: row.display_name,
      previewUrl: row.preview_url,
      platformAssetId: row.platform_asset_id,
      workspaceId: row.workspace_id,
      mediaKind: row.media_kind,
      sortOrder: row.sort_order,
      deleteSortOrder: row.delete_sort_order,
      canDelete: Boolean(row.can_delete),
      available: Boolean(row.available),
      lastSeenAt: row.last_seen_at,
    };
  }

  mapPlatformResult(row: PlatformResultRow): PlatformResult {
    return {
      id: row.id,
      projectId: row.project_id,
      platformProjectId: row.platform_project_id,
      platformTaskId: row.platform_task_id,
      jobId: row.job_id,
      source: row.source,
      mediaKind: row.media_kind,
      name: row.name,
      prompt: row.prompt,
      outputUrl: row.output_url,
      previewUrl: row.preview_url,
      outputPath: row.output_path,
      marked: Boolean(row.marked),
      available: Boolean(row.available),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  mapJob(row: JobRow): Job {
    return {
      id: row.id,
      kind: row.kind,
      projectId: row.project_id,
      portraitId: row.portrait_id,
      status: row.status,
      platformTaskId: row.platform_task_id,
      platformExecutionId: row.platform_execution_id,
      progress: row.progress,
      progressLabel: row.progress_label,
      lastCheckedAt: row.last_checked_at,
      promptSnapshot: row.prompt_snapshot,
      parameters: parseJson(row.parameters_json, {}),
      references: parseJson(row.references_json, []),
      outputPath: row.output_path,
      outputUrl: row.output_url,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      requiresHumanReason: row.requires_human_reason,
      retryCount: row.retry_count,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    };
  }

  mapEvent(row: EventRow): JobEvent {
    return {
      id: row.id,
      jobId: row.job_id,
      level: row.level,
      code: row.code,
      message: row.message,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
    };
  }

  rows = {
    projects: () => this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as ProjectRow[],
    project: (id: string) => this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined,
    references: (projectId: string) =>
      this.db.prepare("SELECT * FROM reference_assets WHERE project_id = ? ORDER BY position ASC").all(projectId) as ReferenceRow[],
    reference: (id: string) => this.db.prepare("SELECT * FROM reference_assets WHERE id = ?").get(id) as ReferenceRow | undefined,
    sharedMedia: () => this.db.prepare("SELECT * FROM shared_media_assets ORDER BY created_at DESC, id DESC").all() as SharedMediaRow[],
    sharedMediaAsset: (id: string) => this.db.prepare("SELECT * FROM shared_media_assets WHERE id = ?").get(id) as SharedMediaRow | undefined,
    sharedMediaByHash: (sha256: string) => this.db.prepare("SELECT * FROM shared_media_assets WHERE sha256 = ?").get(sha256) as SharedMediaRow | undefined,
    portraits: () => this.db.prepare("SELECT * FROM portrait_assets ORDER BY updated_at DESC").all() as PortraitRow[],
    platformPortraitCount: () => (this.db.prepare("SELECT COUNT(*) AS count FROM platform_portraits WHERE available = 1").get() as { count: number }).count,
    platformPortraits: (workspaceId?: string) => (workspaceId === undefined
      ? this.db.prepare("SELECT * FROM platform_portraits ORDER BY available DESC, sort_order ASC, display_name COLLATE NOCASE ASC").all()
      : this.db.prepare("SELECT * FROM platform_portraits WHERE workspace_id = ? ORDER BY available DESC, sort_order ASC, display_name COLLATE NOCASE ASC").all(workspaceId)) as PlatformPortraitRow[],
    platformResults: (projectId?: string) => (projectId
      ? this.db.prepare("SELECT * FROM platform_results WHERE project_id = ? ORDER BY created_at DESC, id DESC").all(projectId)
      : this.db.prepare("SELECT * FROM platform_results ORDER BY created_at DESC, id DESC").all()) as PlatformResultRow[],
    platformResult: (id: string) => this.db.prepare("SELECT * FROM platform_results WHERE id = ?").get(id) as PlatformResultRow | undefined,
    portrait: (id: string) => this.db.prepare("SELECT * FROM portrait_assets WHERE id = ?").get(id) as PortraitRow | undefined,
    jobs: () => this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as JobRow[],
    queuedJobs: () =>
      this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC").all() as JobRow[],
    job: (id: string) => this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined,
    events: (jobId: string) =>
      this.db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC").all(jobId) as EventRow[],
  };

  private remoteProjectIdFromUrl(rawUrl: string): string {
    try {
      return new URL(rawUrl).searchParams.get("projectId") ?? "";
    } catch {
      return "";
    }
  }
}
