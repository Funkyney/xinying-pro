import { contextBridge, ipcRenderer } from "electron";
import type { PlatformAutomationState, PlatformPortraitDeleteProgress, PlatformProjectCreateInput, PlatformViewBounds, PortraitMetadataInput, ProjectInput, ReferenceRole, XinyingApi } from "../shared/contracts";

// Sandboxed Electron preload scripts cannot require arbitrary local modules.
// Keep this runtime channel table self-contained; src/shared/ipc.ts is the
// corresponding main-process contract and the values are checked in tests.
const IPC = {
  dashboard: "dashboard:get",
  projectsList: "projects:list",
  projectsCreate: "projects:create",
  projectsUpdate: "projects:update",
  projectsRemove: "projects:remove",
  platformProjectsCatalog: "platform-projects:catalog",
  platformProjectsSync: "platform-projects:sync",
  platformProjectsOpen: "platform-projects:open",
  platformProjectsCreate: "platform-projects:create",
  referencesList: "references:list",
  referencesPickAdd: "references:pick-add",
  referencesBatchReplace: "references:batch-replace",
  referencesReorder: "references:reorder",
  referencesRole: "references:role",
  referencesReplace: "references:replace",
  referencesRemove: "references:remove",
  sharedMediaList: "shared-media:list",
  sharedMediaPickAdd: "shared-media:pick-add",
  sharedMediaAddToProject: "shared-media:add-to-project",
  sharedMediaRemoveFromProject: "shared-media:remove-from-project",
  sharedMediaRemove: "shared-media:remove",
  portraitsList: "portraits:list",
  portraitsPickAdd: "portraits:pick-add",
  portraitsUpdate: "portraits:update",
  portraitsSubmit: "portraits:submit",
  portraitsAuthorizeReference: "portraits:authorize-reference",
  portraitsRemove: "portraits:remove",
  portraitsPlatformList: "portraits:platform-list",
  portraitsSync: "portraits:sync",
  portraitsPlatformDelete: "portraits:platform-delete",
  portraitsPlatformDeleteProgress: "portraits:platform-delete-progress",
  jobsList: "jobs:list",
  jobsPreview: "jobs:preview",
  jobsSubmit: "jobs:submit",
  jobsStatus: "jobs:status",
  jobsEvents: "jobs:events",
  jobsResume: "jobs:resume",
  jobsCancel: "jobs:cancel",
  jobsDownload: "jobs:download",
  resultsList: "results:list",
  resultsSync: "results:sync",
  resultsMark: "results:mark",
  resultsDownload: "results:download",
  resultsBatchDownload: "results:batch-download",
  sessionStatus: "session:status",
  sessionOpenLogin: "session:open-login",
  sessionLoginCompleted: "session:login-completed",
  sessionOpenUrl: "session:open-url",
  sessionShowPlatform: "session:show-platform",
  sessionReload: "session:reload",
  platformVisible: "platform-view:visible",
  platformVisibleState: "platform-view:visible-state",
  platformBounds: "platform-view:bounds",
  platformAutomationChanged: "platform-view:automation-changed",
  updateState: "update:state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateStateChanged: "update:state-changed",
  codexExtensionStatus: "codex-extension:status",
  codexExtensionInstall: "codex-extension:install",
  codexExtensionOpenFolder: "codex-extension:open-folder",
} as const;

const api: XinyingApi = {
  dashboard: () => ipcRenderer.invoke(IPC.dashboard),
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    create: (input: ProjectInput) => ipcRenderer.invoke(IPC.projectsCreate, input),
    update: (id: string, input: Partial<ProjectInput>) => ipcRenderer.invoke(IPC.projectsUpdate, id, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.projectsRemove, id),
  },
  platformProjects: {
    catalog: () => ipcRenderer.invoke(IPC.platformProjectsCatalog),
    sync: () => ipcRenderer.invoke(IPC.platformProjectsSync),
    open: (projectId: string) => ipcRenderer.invoke(IPC.platformProjectsOpen, projectId),
    create: (input: PlatformProjectCreateInput) => ipcRenderer.invoke(IPC.platformProjectsCreate, input),
  },
  references: {
    list: (projectId: string) => ipcRenderer.invoke(IPC.referencesList, projectId),
    pickAndAdd: (projectId: string) => ipcRenderer.invoke(IPC.referencesPickAdd, projectId),
    batchReplace: (projectId: string) => ipcRenderer.invoke(IPC.referencesBatchReplace, projectId),
    reorder: (projectId: string, orderedIds: string[]) => ipcRenderer.invoke(IPC.referencesReorder, projectId, orderedIds),
    updateRole: (id: string, role: ReferenceRole) => ipcRenderer.invoke(IPC.referencesRole, id, role),
    replace: (id: string) => ipcRenderer.invoke(IPC.referencesReplace, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.referencesRemove, id),
    mediaUrl: (filePath: string) => `xinying-media://asset?path=${encodeURIComponent(filePath)}`,
  },
  sharedMedia: {
    list: () => ipcRenderer.invoke(IPC.sharedMediaList),
    pickAndAdd: () => ipcRenderer.invoke(IPC.sharedMediaPickAdd),
    addToProject: (projectId: string, id: string) => ipcRenderer.invoke(IPC.sharedMediaAddToProject, projectId, id),
    removeFromProject: (projectId: string, id: string) => ipcRenderer.invoke(IPC.sharedMediaRemoveFromProject, projectId, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.sharedMediaRemove, id),
  },
  portraits: {
    list: () => ipcRenderer.invoke(IPC.portraitsList),
    pickAndAdd: (consentConfirmed: boolean) => ipcRenderer.invoke(IPC.portraitsPickAdd, consentConfirmed),
    update: (id: string, input: PortraitMetadataInput) => ipcRenderer.invoke(IPC.portraitsUpdate, id, input),
    submitReview: (id: string, projectId?: string) => ipcRenderer.invoke(IPC.portraitsSubmit, id, projectId),
    authorizeReference: (referenceId: string, projectId: string, consentConfirmed: boolean) => ipcRenderer.invoke(IPC.portraitsAuthorizeReference, referenceId, projectId, consentConfirmed),
    remove: (id: string) => ipcRenderer.invoke(IPC.portraitsRemove, id),
    platformList: () => ipcRenderer.invoke(IPC.portraitsPlatformList),
    sync: (projectId?: string) => ipcRenderer.invoke(IPC.portraitsSync, projectId),
    deletePlatform: (projectId: string, ids: string[]) => ipcRenderer.invoke(IPC.portraitsPlatformDelete, projectId, ids),
    onDeleteProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: PlatformPortraitDeleteProgress) => listener(progress);
      ipcRenderer.on(IPC.portraitsPlatformDeleteProgress, handler);
      return () => ipcRenderer.removeListener(IPC.portraitsPlatformDeleteProgress, handler);
    },
  },
  jobs: {
    list: () => ipcRenderer.invoke(IPC.jobsList),
    preview: (projectId: string) => ipcRenderer.invoke(IPC.jobsPreview, projectId),
    submit: (projectId: string, count = 1) => ipcRenderer.invoke(IPC.jobsSubmit, projectId, count),
    status: (id: string) => ipcRenderer.invoke(IPC.jobsStatus, id),
    events: (id: string) => ipcRenderer.invoke(IPC.jobsEvents, id),
    resume: (id: string) => ipcRenderer.invoke(IPC.jobsResume, id),
    cancel: (id: string) => ipcRenderer.invoke(IPC.jobsCancel, id),
    download: (id: string) => ipcRenderer.invoke(IPC.jobsDownload, id),
  },
  results: {
    list: (projectId?: string) => ipcRenderer.invoke(IPC.resultsList, projectId),
    sync: (projectId: string) => ipcRenderer.invoke(IPC.resultsSync, projectId),
    mark: (ids: string[], marked: boolean) => ipcRenderer.invoke(IPC.resultsMark, ids, marked),
    download: (id: string) => ipcRenderer.invoke(IPC.resultsDownload, id),
    batchDownload: (ids: string[]) => ipcRenderer.invoke(IPC.resultsBatchDownload, ids),
  },
  session: {
    status: () => ipcRenderer.invoke(IPC.sessionStatus),
    openLogin: () => ipcRenderer.invoke(IPC.sessionOpenLogin),
    onLoginCompleted: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.sessionLoginCompleted, handler);
      return () => ipcRenderer.removeListener(IPC.sessionLoginCompleted, handler);
    },
    openUrl: (url: string) => ipcRenderer.invoke(IPC.sessionOpenUrl, url),
    showPlatform: () => ipcRenderer.invoke(IPC.sessionShowPlatform),
    reloadPlatform: () => ipcRenderer.invoke(IPC.sessionReload),
  },
  platformView: {
    setVisible: (visible: boolean) => ipcRenderer.invoke(IPC.platformVisible, visible),
    isVisible: () => ipcRenderer.invoke(IPC.platformVisibleState),
    setBounds: (bounds: PlatformViewBounds) => ipcRenderer.invoke(IPC.platformBounds, bounds),
    onAutomationStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: PlatformAutomationState) => listener(state);
      ipcRenderer.on(IPC.platformAutomationChanged, handler);
      return () => ipcRenderer.removeListener(IPC.platformAutomationChanged, handler);
    },
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.updateState),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    onStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on(IPC.updateStateChanged, handler);
      return () => ipcRenderer.removeListener(IPC.updateStateChanged, handler);
    },
  },
  codexExtension: {
    status: () => ipcRenderer.invoke(IPC.codexExtensionStatus),
    install: (replaceExisting = false) => ipcRenderer.invoke(IPC.codexExtensionInstall, replaceExisting),
    openFolder: () => ipcRenderer.invoke(IPC.codexExtensionOpenFolder),
  },
};

contextBridge.exposeInMainWorld("xinying", api);
