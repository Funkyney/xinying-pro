import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC } from "../shared/ipc";
import type { PlatformPortraitDeleteProgress, PlatformProjectCreateInput, PlatformViewBounds, PortraitMetadataInput, ProjectInput, ReferenceRole } from "../shared/contracts";
import type { XinyingService } from "../core/service";
import type { PlatformViewManager } from "./platform-view";
import type { PlaywrightXinyingAdapter } from "./playwright-adapter";
import type { CodexExtensionManager } from "./codex-extension";

export function registerIpcHandlers(
  window: BrowserWindow,
  service: XinyingService,
  platform: PlatformViewManager,
  adapter: PlaywrightXinyingAdapter,
  codexExtension: CodexExtensionManager,
): void {
  const handle = (channel: string, listener: (...args: any[]) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener);
  };

  handle(IPC.dashboard, async () => ({
    projects: service.listProjects(),
    jobs: service.listJobs(),
    portraits: service.listPortraits(),
    platformPortraits: service.listPlatformPortraits(),
    sharedMedia: service.listSharedMedia(),
    results: service.listResults(),
    platformCatalog: service.getPlatformCatalog(),
    platformAutomation: platform.getAutomationState(),
    session: await adapter.sessionState(),
  }));
  handle(IPC.projectsList, () => service.listProjects());
  handle(IPC.projectsCreate, (_event, input: ProjectInput) => service.createProject(input));
  handle(IPC.projectsUpdate, (_event, id: string, input: Partial<ProjectInput>) => service.updateProject(id, input));
  handle(IPC.projectsRemove, (_event, id: string) => service.removeProject(id));
  handle(IPC.platformProjectsCatalog, () => service.getPlatformCatalog());
  handle(IPC.platformProjectsSync, async () => {
    const catalog = await platform.withAutomationViewport(
      () => adapter.syncPlatformCatalog(service.getPlatformCatalog()),
      "正在同步心影空间与项目",
    );
    return service.syncPlatformCatalog(catalog);
  });
  handle(IPC.platformProjectsOpen, async (_event, projectId: string) => {
    const selected = service.getPlatformCatalog().projects.find((project) => project.id === projectId);
    const binding = await platform.withAutomationViewport(
      () => adapter.openPlatformProject(service.getPlatformCatalog(), projectId),
      `正在进入项目${selected?.name ? `「${selected.name}」` : ""}`,
    );
    return service.bindPlatformProject(binding);
  });
  handle(IPC.platformProjectsCreate, async (_event, input: PlatformProjectCreateInput) => {
    const binding = await platform.withAutomationViewport(() => adapter.createPlatformProject(service.getPlatformCatalog(), input), `正在创建项目「${input.name.trim()}」`);
    return service.bindPlatformProject(binding);
  });

  handle(IPC.referencesList, (_event, projectId: string) => service.listReferences(projectId));
  handle(IPC.referencesPickAdd, async (_event, projectId: string) => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择参考图片、视频或音频",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "心影参考素材", extensions: ["png", "jpg", "jpeg", "mp4", "mov", "wav", "mp3"] }],
    });
    return result.canceled ? service.listReferences(projectId) : service.addReferences(projectId, result.filePaths);
  });
  handle(IPC.referencesBatchReplace, async (_event, projectId: string) => {
    const current = service.listReferences(projectId);
    const count = current.length;
    const result = await dialog.showOpenDialog(window, {
      title: `选择 ${count} 个替换素材（随后确认编号映射）`,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "心影参考素材", extensions: ["png", "jpg", "jpeg", "mp4", "mov", "wav", "mp3"] }],
    });
    if (result.canceled) return current;
    if (result.filePaths.length !== count) return service.batchReplaceReferences(projectId, result.filePaths);
    const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
    const orderedPaths = [...result.filePaths].sort((left, right) => collator.compare(path.basename(left), path.basename(right)));
    const mapping = current.map((asset, index) => `${index + 1}.  ${asset.name}  ←  ${path.basename(orderedPaths[index])}`).join("\n");
    const confirmation = await dialog.showMessageBox(window, {
      type: "question",
      title: "确认批量替换映射",
      message: "所选文件已按文件名自然顺序排列",
      detail: `${mapping}\n\n确认后保留卡片位置和用途标记；媒体类型改变时会按心影规则重新计算 @图/@视频/@音频编号。`,
      buttons: ["确认替换", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return confirmation.response === 0 ? service.batchReplaceReferences(projectId, orderedPaths) : current;
  });
  handle(IPC.referencesReorder, (_event, projectId: string, orderedIds: string[]) => service.reorderReferences(projectId, orderedIds));
  handle(IPC.referencesRole, (_event, id: string, role: ReferenceRole) => service.updateReferenceRole(id, role));
  handle(IPC.referencesReplace, async (_event, id: string) => {
    const result = await dialog.showOpenDialog(window, {
      title: "替换参考素材",
      properties: ["openFile"],
      filters: [{ name: "心影参考素材", extensions: ["png", "jpg", "jpeg", "mp4", "mov", "wav", "mp3"] }],
    });
    return result.canceled ? service.database.mapReference(service.database.rows.reference(id)!) : service.replaceReference(id, result.filePaths[0]);
  });
  handle(IPC.referencesRemove, (_event, id: string) => service.removeReference(id));

  handle(IPC.sharedMediaList, () => service.listSharedMedia());
  handle(IPC.sharedMediaPickAdd, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "上传到共享素材库",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片、视频或音频", extensions: ["png", "jpg", "jpeg", "mp4", "mov", "wav", "mp3"] }],
    });
    return result.canceled ? service.listSharedMedia() : service.addSharedMedia(result.filePaths);
  });
  handle(IPC.sharedMediaAddToProject, (_event, projectId: string, id: string) => service.addSharedMediaToProject(projectId, id));
  handle(IPC.sharedMediaRemoveFromProject, (_event, projectId: string, id: string) => service.removeSharedMediaFromProject(projectId, id));
  handle(IPC.sharedMediaRemove, (_event, id: string) => service.removeSharedMedia(id));

  handle(IPC.portraitsList, () => service.listPortraits());
  handle(IPC.portraitsPickAdd, async (_event, consentConfirmed: boolean) => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择虚拟人像素材",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "心影虚拟人像图片或视频", extensions: ["png", "jpg", "jpeg", "webp", "mp4", "mov"] }],
    });
    return result.canceled ? service.listPortraits() : service.addPortraits(result.filePaths, consentConfirmed);
  });
  handle(IPC.portraitsUpdate, (_event, id: string, input: PortraitMetadataInput) => service.updatePortraitMetadata(id, input));
  handle(IPC.portraitsSubmit, (_event, id: string, projectId?: string) => service.submitPortraitReview(id, projectId));
  handle(IPC.portraitsAuthorizeReference, (_event, referenceId: string, projectId: string, consentConfirmed: boolean) => service.authorizeReference(referenceId, projectId, consentConfirmed));
  handle(IPC.portraitsRemove, (_event, id: string) => service.removePortrait(id));
  handle(IPC.portraitsPlatformList, () => service.listPlatformPortraits());
  handle(IPC.portraitsSync, async (_event, projectId?: string) => {
    const targetProject = projectId ? service.getProject(projectId) : service.listProjects().find((project) => project.platformUrl);
    if (!targetProject?.platformUrl) throw new Error("请先选择并进入一个心影项目，再同步该空间的虚拟人像库");
    const portraits = await platform.withAutomationViewport(
      () => adapter.syncPlatformPortraits(targetProject.platformUrl, targetProject.modelName, targetProject.platformWorkspaceId),
      "正在同步当前空间虚拟人像",
    );
    return service.syncPlatformPortraits(portraits, targetProject.platformWorkspaceId, false);
  });
  handle(IPC.portraitsPlatformDelete, async (_event, projectId: string, ids: string[]) => {
    const targetProject = service.getProject(projectId);
    if (!targetProject.platformUrl || !targetProject.platformWorkspaceId) {
      throw new Error("请先选择一个已绑定心影空间与项目的本地项目");
    }
    const portraits = service.validatePlatformPortraitDeletion(ids, targetProject.platformWorkspaceId);
    const requestedIds = portraits.map((portrait) => portrait.id);
    let latestProgress: PlatformPortraitDeleteProgress | null = null;
    const notifyProgress = (progress: PlatformPortraitDeleteProgress) => {
      latestProgress = progress;
      if (!window.isDestroyed()) window.webContents.send(IPC.portraitsPlatformDeleteProgress, progress);
      if (progress.status !== "queued") platform.reportAutomationProgress(progress.message, progress.current, progress.total);
    };
    notifyProgress({
      status: "queued",
      requestedIds,
      deletedIds: [],
      currentId: null,
      currentName: null,
      current: 0,
      total: portraits.length,
      message: `已排队，准备删除 ${portraits.length} 个虚拟人像`,
    });
    let result;
    try {
      result = await platform.withAutomationViewport(() => adapter.deletePlatformPortraits(
        targetProject.platformUrl,
        targetProject.modelName,
        portraits,
        (progress) => {
          if (progress.status === "deleted" && progress.currentId) {
            service.markPlatformPortraitsDeleted([progress.currentId], targetProject.platformWorkspaceId);
          }
          notifyProgress(progress);
        },
      ), `正在删除 ${portraits.length} 个虚拟人像`);
    } catch (error) {
      const previous = latestProgress as PlatformPortraitDeleteProgress | null;
      const message = error instanceof Error ? error.message : String(error);
      notifyProgress({
        status: "failed",
        requestedIds,
        deletedIds: previous?.deletedIds ?? [],
        currentId: previous?.currentId ?? null,
        currentName: previous?.currentName ?? null,
        current: previous?.current ?? 0,
        total: portraits.length,
        message: `删除任务未完成：${message}`,
      });
      throw error;
    }
    service.markPlatformPortraitsDeleted(result.deletedIds, targetProject.platformWorkspaceId);
    if (result.failed) {
      throw new Error(`已永久删除 ${result.deletedIds.length} 项；删除“${result.failed.displayName}”时停止：${result.failed.message}`);
    }
    notifyProgress({
      status: "completed",
      requestedIds,
      deletedIds: result.deletedIds,
      currentId: null,
      currentName: null,
      current: result.deletedIds.length,
      total: portraits.length,
      message: `已删除 ${result.deletedIds.length} / ${portraits.length} 个虚拟人像`,
    });
    return result;
  });

  handle(IPC.jobsList, () => service.listJobs());
  handle(IPC.jobsPreview, (_event, projectId: string) => service.previewSubmission(projectId));
  handle(IPC.jobsSubmit, (_event, projectId: string, count = 1) =>
    count === 1 ? service.submitGeneration(projectId) : service.submitGenerationBatch(projectId, count));
  handle(IPC.jobsStatus, (_event, id: string) => service.getJob(id));
  handle(IPC.jobsEvents, (_event, id: string) => service.listJobEvents(id));
  handle(IPC.jobsResume, (_event, id: string) => service.resumeJob(id));
  handle(IPC.jobsCancel, (_event, id: string) => service.cancelJob(id));
  handle(IPC.jobsDownload, async (_event, id: string) => {
    const job = service.getJob(id);
    const defaultName = `${job.projectId ?? job.id}.mp4`;
    const result = await dialog.showSaveDialog(window, {
      title: "保存生成结果",
      defaultPath: path.join(service.paths.outputsDir, defaultName),
      filters: [{ name: "视频", extensions: ["mp4", "mov", "webm"] }],
    });
    if (result.canceled || !result.filePath) return job;
    if (!job.outputPath) {
      try {
        const captured = await platform.withAutomationViewport(() => adapter.downloadVisibleResult(job), "正在从心影下载视频");
        service.updateJob(id, { outputPath: captured });
      } catch (error) {
        if (!job.outputUrl) throw error;
      }
    }
    return service.downloadJob(id, result.filePath);
  });

  handle(IPC.resultsList, (_event, projectId?: string) => service.listResults(projectId));
  handle(IPC.resultsSync, async (_event, projectId: string) => {
    const project = service.getProject(projectId);
    const remote = await platform.withAutomationViewport(() => adapter.syncProjectResults(project), `正在同步「${project.name}」结果库`);
    return service.syncPlatformResults(projectId, remote);
  });
  handle(IPC.resultsMark, (_event, ids: string[], marked: boolean) => service.markResults(ids, marked));
  const ensureResultDownloadable = async (id: string) => {
    const result = service.getResult(id);
    if (result.jobId && !result.outputPath && !result.outputUrl) {
      const job = service.getJob(result.jobId);
      const captured = await platform.withAutomationViewport(() => adapter.downloadVisibleResult(job), "正在从心影下载视频");
      service.updateJob(job.id, { outputPath: captured });
    }
    return service.getResult(id);
  };
  handle(IPC.resultsDownload, async (_event, id: string) => {
    const result = await ensureResultDownloadable(id);
    const selected = await dialog.showSaveDialog(window, {
      title: "保存心影视频结果",
      defaultPath: path.join(service.paths.outputsDir, `${result.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.mp4`),
      filters: [{ name: "视频", extensions: ["mp4", "mov", "webm"] }],
    });
    return selected.canceled || !selected.filePath ? result : service.exportResult(id, selected.filePath);
  });
  handle(IPC.resultsBatchDownload, async (_event, ids: string[]) => {
    const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!normalized.length) throw new Error("请至少选择一个要下载的视频");
    const selected = await dialog.showOpenDialog(window, { title: `选择 ${normalized.length} 个视频的保存文件夹`, properties: ["openDirectory", "createDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return normalized.map((id) => service.getResult(id));
    const destination = selected.filePaths[0];
    const downloaded = [];
    for (const [index, id] of normalized.entries()) {
      await ensureResultDownloadable(id);
      const filePath = path.join(destination, `${String(index + 1).padStart(3, "0")}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}.mp4`);
      downloaded.push(await service.exportResult(id, filePath));
    }
    return downloaded;
  });

  handle(IPC.sessionStatus, () => adapter.sessionState());
  handle(IPC.sessionOpenLogin, () => platform.openLogin());
  handle(IPC.sessionOpenUrl, (_event, url: string) => platform.openUrl(url));
  handle(IPC.sessionShowPlatform, () => platform.openPlatform());
  handle(IPC.sessionReload, () => platform.reload());
  handle(IPC.platformVisible, (_event, visible: boolean) => {
    if (visible) platform.show();
    else {
      platform.cancelLogin();
      platform.hide();
    }
  });
  handle(IPC.platformVisibleState, () => platform.isVisible());
  handle(IPC.platformBounds, (_event, bounds: PlatformViewBounds) => platform.setBounds(bounds));
  handle(IPC.codexExtensionStatus, () => codexExtension.status());
  handle(IPC.codexExtensionInstall, (_event, replaceExisting: boolean) => codexExtension.install(Boolean(replaceExisting)));
  handle(IPC.codexExtensionOpenFolder, async () => {
    const status = await codexExtension.status();
    const target = status.installed || status.conflict ? status.skillPath : path.dirname(status.skillPath);
    await fs.promises.mkdir(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return target;
  });
}
