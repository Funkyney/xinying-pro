import path from "node:path";
import type {
  DirectorRunPreparation,
  DirectorRunValidation,
  GenerationBatch,
  Job,
  PlatformCatalogSnapshot,
  PlatformPortrait,
  Project,
  ReferenceAsset,
} from "../shared/contracts";

export function compactProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    modelName: project.modelName,
    platformWorkspaceId: project.platformWorkspaceId,
    platformProjectId: project.platformProjectId,
    platformUrl: project.platformUrl,
    mode: project.mode,
    aspectRatio: project.aspectRatio,
    duration: project.duration,
    resolution: project.resolution,
    audioEnabled: project.audioEnabled,
    videoFormat: project.videoFormat,
    networkEnabled: project.networkEnabled,
    status: project.status,
    materialCount: project.materialOrder.length,
    updatedAt: project.updatedAt,
  };
}

export function compactReference(reference: ReferenceAsset) {
  return {
    id: reference.id,
    name: reference.name,
    mediaKind: reference.mimeType.split("/")[0],
    role: reference.role,
    position: reference.position,
    sha256: reference.sha256,
  };
}

export function compactPortrait(portrait: PlatformPortrait) {
  return {
    id: portrait.id,
    displayName: portrait.displayName,
    platformAssetId: portrait.platformAssetId,
    workspaceId: portrait.workspaceId,
    mediaKind: portrait.mediaKind,
    available: portrait.available,
  };
}

export function compactCatalog(catalog: PlatformCatalogSnapshot) {
  return {
    currentWorkspaceId: catalog.currentWorkspaceId,
    currentProjectId: catalog.currentProjectId,
    syncedAt: catalog.syncedAt,
    workspaces: catalog.workspaces.filter((workspace) => workspace.available).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      isCurrent: workspace.isCurrent,
    })),
    projects: catalog.projects.filter((project) => project.available).map((project) => ({
      id: project.id,
      workspaceId: project.workspaceId,
      name: project.name,
      shortId: project.shortId,
      isCurrent: project.isCurrent,
    })),
  };
}

export function compactJob(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    projectId: job.projectId,
    status: job.status,
    platformTaskId: job.platformTaskId,
    platformExecutionId: job.platformExecutionId,
    progress: job.progress,
    progressLabel: job.progressLabel,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    requiresHumanReason: job.requiresHumanReason,
    retryCount: job.retryCount,
    createdAt: job.createdAt,
    submittedAt: job.submittedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

export function compactBatch(batch: GenerationBatch) {
  return {
    batchId: batch.batchId,
    count: batch.count,
    jobs: batch.jobs.map(compactJob),
  };
}

export function compactDirectorState(value: DirectorRunValidation | DirectorRunPreparation) {
  const preparation = "materials" in value ? value : null;
  return {
    project: compactProject(value.project),
    materialCount: value.materialCount,
    authorizationCount: value.authorizationCount,
    estimatedGenerationTasks: value.estimatedGenerationTasks,
    ...(preparation ? {
      materials: preparation.materials.map((material) => ({
        index: material.index,
        kind: material.kind,
        sourceName: material.sourcePath ? path.basename(material.sourcePath) : null,
        referenceId: material.referenceId,
        platformPortraitId: material.platformPortraitId,
        role: material.role,
        containsPerson: material.containsPerson,
        authorizationState: material.authorizationState,
        authorizationJobId: material.authorizationJobId,
      })),
      authorizationReferenceIds: preparation.authorizationReferenceIds,
      preview: {
        ready: preparation.preview.ready,
        warnings: preparation.preview.warnings,
        orderedLabels: preparation.preview.orderedLabels,
      },
    } : {}),
  };
}
