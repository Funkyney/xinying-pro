export type ProjectMode = "text-to-video" | "image-to-video" | "reference-to-video" | "first-last-frame";
export type ReferenceRole = "first-frame" | "last-frame" | "character" | "scene" | "product" | "style" | "motion" | "other";
export type ProjectStatus = "draft" | "ready" | "archived";
export type JobKind = "generation" | "portrait-review";
export type JobStatus =
  | "draft"
  | "queued"
  | "submitting"
  | "running"
  | "completed"
  | "failed"
  | "needs-login"
  | "needs-human"
  | "cancelled";
export type PortraitStatus = "local" | "queued" | "reviewing" | "approved" | "rejected" | "needs-human";
export type PortraitGender = "" | "男" | "女" | "其他";
export type PortraitAgeGroup = "" | "儿童（0-12）" | "少年（13-18）" | "青年（19-35）" | "中年（36-55）" | "老年（55+）" | "其他";
export type PortraitEthnicity = "" | "东亚裔" | "东南亚裔" | "南亚裔" | "中亚裔" | "中东/北非" | "白人/西欧" | "白人/东欧" | "黑人/非洲" | "西语/拉丁裔" | "太平洋岛民" | "其他";
export type PortraitApplicationScope = "domestic" | "overseas" | "both";
export type SessionStatus = "unknown" | "logged-out" | "logged-in" | "needs-human";
export type PlatformWorkspaceKind = "personal" | "team";
export type ReferenceMediaKind = "image" | "video" | "audio";
export type PlatformPortraitMediaKind = "image" | "video" | "unknown";

export interface PlatformWorkspace {
  id: string;
  name: string;
  kind: PlatformWorkspaceKind;
  description: string;
  available: boolean;
  isCurrent: boolean;
  sortOrder: number;
  lastSeenAt: string;
}

export interface PlatformProject {
  id: string;
  workspaceId: string;
  name: string;
  shortId: string;
  remoteId: string;
  homeUrl: string;
  available: boolean;
  isCurrent: boolean;
  sortOrder: number;
  lastSeenAt: string;
}

export interface PlatformCatalogSnapshot {
  workspaces: PlatformWorkspace[];
  projects: PlatformProject[];
  currentWorkspaceId: string;
  currentProjectId: string;
  customerOptions: string[];
  creationTypeOptions: string[];
  syncedAt: string;
}

export interface PlatformProjectCreateInput {
  workspaceId: string;
  name: string;
  customer: string;
  creationType: string;
}

export interface PlatformProjectBinding {
  workspace: PlatformWorkspace;
  project: PlatformProject;
  generationUrl: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  prompt: string;
  modelName: string;
  platformUrl: string;
  platformWorkspaceId: string;
  platformProjectId: string;
  mode: ProjectMode;
  aspectRatio: string;
  duration: number;
  resolution: string;
  audioEnabled: boolean;
  portraitIds: string[];
  materialOrder: string[];
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
  description?: string;
  prompt?: string;
  modelName?: string;
  platformUrl?: string;
  platformWorkspaceId?: string;
  platformProjectId?: string;
  mode?: ProjectMode;
  aspectRatio?: string;
  duration?: number;
  resolution?: string;
  audioEnabled?: boolean;
  portraitIds?: string[];
  materialOrder?: string[];
}

export interface DirectorFileMaterialInput {
  kind: "file";
  path: string;
  role?: ReferenceRole;
  authorizeAsPortrait?: boolean;
}

export interface DirectorPlatformPortraitMaterialInput {
  kind: "platform-portrait";
  portraitId: string;
}

export type DirectorMaterialInput = DirectorFileMaterialInput | DirectorPlatformPortraitMaterialInput;

export interface DirectorManifest {
  version: 1;
  projectId: string;
  prompt: string;
  count: number;
  replaceMaterials: boolean;
  settings?: {
    name?: string;
    description?: string;
    modelName?: string;
    mode?: ProjectMode;
    aspectRatio?: string;
    duration?: number;
    resolution?: string;
    audioEnabled?: boolean;
  };
  materials: DirectorMaterialInput[];
}

export type DirectorAuthorizationState = "not-needed" | "required" | "queued" | "reviewing" | "approved" | "needs-human" | "rejected";

export interface DirectorPreparedMaterial {
  index: number;
  kind: DirectorMaterialInput["kind"];
  sourcePath: string | null;
  referenceId: string | null;
  platformPortraitId: string | null;
  role: ReferenceRole | null;
  authorizationState: DirectorAuthorizationState;
  authorizationJobId: string | null;
}

export interface DirectorRunValidation {
  manifest: DirectorManifest;
  project: Project;
  materialCount: number;
  authorizationCount: number;
  estimatedGenerationTasks: number;
}

export interface DirectorRunPreparation extends DirectorRunValidation {
  materials: DirectorPreparedMaterial[];
  authorizationReferenceIds: string[];
  preview: SubmissionPreview;
}

export interface GenerationBatch {
  batchId: string;
  count: number;
  jobs: Job[];
}

export interface ReferenceAsset {
  id: string;
  projectId: string;
  sourceSharedMediaId: string | null;
  name: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  position: number;
  role: ReferenceRole;
  sha256: string;
  createdAt: string;
}

export interface SharedMediaAsset {
  id: string;
  name: string;
  filePath: string;
  mimeType: string;
  mediaKind: ReferenceMediaKind;
  fileSize: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortraitAsset {
  id: string;
  name: string;
  displayName: string;
  filePath: string;
  mimeType: string;
  consentConfirmed: boolean;
  gender: PortraitGender;
  ageGroup: PortraitAgeGroup;
  ethnicity: PortraitEthnicity;
  applicationScope: PortraitApplicationScope;
  platformStatus: PortraitStatus;
  reviewNote: string;
  platformAssetId: string | null;
  sourceReferenceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformPortrait {
  id: string;
  displayName: string;
  previewUrl: string;
  platformAssetId: string;
  workspaceId: string;
  mediaKind: PlatformPortraitMediaKind;
  sortOrder: number;
  deleteSortOrder: number | null;
  canDelete: boolean;
  available: boolean;
  lastSeenAt: string;
}

export interface PlatformResult {
  id: string;
  projectId: string;
  platformProjectId: string;
  platformTaskId: string;
  jobId: string | null;
  prompt: string;
  outputUrl: string | null;
  previewUrl: string | null;
  outputPath: string | null;
  marked: boolean;
  available: boolean;
  createdAt: string;
  lastSeenAt: string;
}

export interface PlatformPortraitDeleteResult {
  requestedIds: string[];
  deletedIds: string[];
  failed?: {
    id: string;
    displayName: string;
    message: string;
  };
}

export type PlatformAutomationPhase = "idle" | "queued" | "running";

export interface PlatformAutomationState {
  phase: PlatformAutomationPhase;
  label: string;
  detail: string;
  pendingCount: number;
  current: number | null;
  total: number | null;
  startedAt: string | null;
}

export interface PlatformPortraitDeleteProgress {
  status: "queued" | "deleting" | "deleted" | "failed" | "completed";
  requestedIds: string[];
  deletedIds: string[];
  currentId: string | null;
  currentName: string | null;
  current: number;
  total: number;
  message: string;
}

export interface PortraitMetadataInput {
  displayName?: string;
  gender?: PortraitGender;
  ageGroup?: PortraitAgeGroup;
  ethnicity?: PortraitEthnicity;
  applicationScope?: PortraitApplicationScope;
}

export interface Job {
  id: string;
  kind: JobKind;
  projectId: string | null;
  portraitId: string | null;
  status: JobStatus;
  platformTaskId: string | null;
  promptSnapshot: string;
  parameters: Record<string, unknown>;
  references: ReferenceAsset[];
  outputPath: string | null;
  outputUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requiresHumanReason: string | null;
  retryCount: number;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SessionState {
  status: SessionStatus;
  url: string;
  accountLabel?: string;
  reason?: string;
  checkedAt: string;
}

export interface DashboardSnapshot {
  projects: Project[];
  jobs: Job[];
  portraits: PortraitAsset[];
  platformPortraits: PlatformPortrait[];
  sharedMedia: SharedMediaAsset[];
  results: PlatformResult[];
  platformCatalog: PlatformCatalogSnapshot;
  platformAutomation: PlatformAutomationState;
  session: SessionState;
}

export interface SubmissionPreview {
  project: Project;
  references: ReferenceAsset[];
  orderedLabels: string[];
  selectedPortraits: PlatformPortrait[];
  warnings: string[];
  ready: boolean;
}

export interface PlatformViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HumanCheckpoint {
  reason: "login" | "captcha" | "identity" | "payment" | "approval" | "page-changed" | "unknown";
  message: string;
}

export interface CliEnvelope<T = unknown> {
  ok: boolean;
  command: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}

export type AppUpdateStatus = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unsupported";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}

export type CodexExtensionInstallState = "not-installed" | "installed" | "update-available" | "conflict" | "source-missing";

export interface CodexExtensionStatus {
  state: CodexExtensionInstallState;
  available: boolean;
  installed: boolean;
  needsUpdate: boolean;
  conflict: boolean;
  currentVersion: string;
  installedVersion: string | null;
  codexHome: string;
  skillPath: string;
  launcherPath: string | null;
  message: string;
}

export interface CodexExtensionInstallResult extends CodexExtensionStatus {
  backupPath: string | null;
}

export interface XinyingApi {
  dashboard(): Promise<DashboardSnapshot>;
  projects: {
    list(): Promise<Project[]>;
    create(input: ProjectInput): Promise<Project>;
    update(id: string, input: Partial<ProjectInput>): Promise<Project>;
    remove(id: string): Promise<void>;
  };
  platformProjects: {
    catalog(): Promise<PlatformCatalogSnapshot>;
    sync(): Promise<PlatformCatalogSnapshot>;
    open(projectId: string): Promise<Project>;
    create(input: PlatformProjectCreateInput): Promise<Project>;
  };
  references: {
    list(projectId: string): Promise<ReferenceAsset[]>;
    pickAndAdd(projectId: string): Promise<ReferenceAsset[]>;
    batchReplace(projectId: string): Promise<ReferenceAsset[]>;
    reorder(projectId: string, orderedIds: string[]): Promise<ReferenceAsset[]>;
    updateRole(id: string, role: ReferenceRole): Promise<ReferenceAsset>;
    replace(id: string): Promise<ReferenceAsset>;
    remove(id: string): Promise<void>;
    mediaUrl(filePath: string): string;
  };
  sharedMedia: {
    list(): Promise<SharedMediaAsset[]>;
    pickAndAdd(): Promise<SharedMediaAsset[]>;
    addToProject(projectId: string, id: string): Promise<ReferenceAsset[]>;
    removeFromProject(projectId: string, id: string): Promise<ReferenceAsset[]>;
    remove(id: string): Promise<void>;
  };
  portraits: {
    list(): Promise<PortraitAsset[]>;
    pickAndAdd(consentConfirmed: boolean): Promise<PortraitAsset[]>;
    update(id: string, input: PortraitMetadataInput): Promise<PortraitAsset>;
    submitReview(id: string, projectId?: string): Promise<Job>;
    authorizeReference(referenceId: string, projectId: string, consentConfirmed: boolean): Promise<Job>;
    remove(id: string): Promise<void>;
    platformList(): Promise<PlatformPortrait[]>;
    sync(projectId?: string): Promise<PlatformPortrait[]>;
    deletePlatform(projectId: string, ids: string[]): Promise<PlatformPortraitDeleteResult>;
    onDeleteProgress(listener: (progress: PlatformPortraitDeleteProgress) => void): () => void;
  };
  jobs: {
    list(): Promise<Job[]>;
    preview(projectId: string): Promise<SubmissionPreview>;
    submit(projectId: string, count?: number): Promise<Job | GenerationBatch>;
    status(id: string): Promise<Job>;
    events(id: string): Promise<JobEvent[]>;
    resume(id: string): Promise<Job>;
    cancel(id: string): Promise<Job>;
    download(id: string): Promise<Job>;
  };
  results: {
    list(projectId?: string): Promise<PlatformResult[]>;
    sync(projectId: string): Promise<PlatformResult[]>;
    mark(ids: string[], marked: boolean): Promise<PlatformResult[]>;
    download(id: string): Promise<PlatformResult>;
    batchDownload(ids: string[]): Promise<PlatformResult[]>;
  };
  session: {
    status(): Promise<SessionState>;
    openLogin(): Promise<void>;
    onLoginCompleted(listener: () => void): () => void;
    openUrl(url: string): Promise<void>;
    showPlatform(): Promise<void>;
    reloadPlatform(): Promise<void>;
  };
  platformView: {
    setVisible(visible: boolean): Promise<void>;
    isVisible(): Promise<boolean>;
    setBounds(bounds: PlatformViewBounds): Promise<void>;
    onAutomationStateChange(listener: (state: PlatformAutomationState) => void): () => void;
  };
  updates: {
    state(): Promise<AppUpdateState>;
    check(): Promise<AppUpdateState>;
    download(): Promise<AppUpdateState>;
    install(): Promise<AppUpdateState>;
    onStateChange(listener: (state: AppUpdateState) => void): () => void;
  };
  codexExtension: {
    status(): Promise<CodexExtensionStatus>;
    install(replaceExisting?: boolean): Promise<CodexExtensionInstallResult>;
    openFolder(): Promise<string>;
  };
}

declare global {
  interface Window {
    xinying: XinyingApi;
  }
}
