import type { Project, ProjectInput } from "./contracts";
import { generationOptions } from "./generation-options";

export type ProjectDraft = Partial<ProjectInput>;

export function projectDraft(project: Project): ProjectDraft {
  return {
    name: project.name, description: project.description, prompt: project.prompt,
    modelName: project.modelName, platformUrl: project.platformUrl,
    platformWorkspaceId: project.platformWorkspaceId, platformProjectId: project.platformProjectId,
    mode: project.mode, aspectRatio: project.aspectRatio, duration: project.duration,
    resolution: project.resolution, audioEnabled: project.audioEnabled,
    videoFormat: project.videoFormat, networkEnabled: project.networkEnabled,
    portraitIds: project.portraitIds, materialOrder: project.materialOrder,
    historySource: project.historySource ?? null, ...generationOptions(project),
  };
}

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Only local changes win; unrelated remote/material changes are retained. */
export function mergeProjectDraft(base: ProjectDraft, local: ProjectDraft, remote: ProjectDraft): ProjectDraft {
  const merged = { ...remote };
  for (const key of Object.keys(remote) as Array<keyof ProjectInput>) {
    if (local[key] !== undefined && !equal(local[key], base[key])) Object.assign(merged, { [key]: local[key] });
  }
  if (remote.platformUrl !== base.platformUrl && local.platformUrl === base.platformUrl) merged.historySource = remote.historySource;
  return merged;
}

export function projectDraftPatch(base: ProjectDraft, local: ProjectDraft): ProjectDraft {
  return Object.fromEntries(Object.entries(local).filter(([key, value]) => value !== undefined && !equal(value, base[key as keyof ProjectInput])));
}

export interface DraftRecovery {
  version: 1;
  projectId: string;
  editId: string;
  base: ProjectDraft;
  value: ProjectDraft;
}

export function recoverProjectDraft(project: Project, stored: unknown): ProjectDraft {
  const remote = projectDraft(project);
  if (!stored || typeof stored !== "object") return remote;
  const record = stored as Partial<DraftRecovery>;
  if (record.version !== 1 || record.projectId !== project.id || !record.base || !record.value
    || typeof record.base !== "object" || typeof record.value !== "object"
    || Array.isArray(record.base) || Array.isArray(record.value)) return remote;
  const recovered = mergeProjectDraft(record.base, record.value, remote);
  recovered.platformUrl = remote.platformUrl;
  recovered.platformWorkspaceId = remote.platformWorkspaceId;
  recovered.platformProjectId = remote.platformProjectId;
  if (record.base.platformUrl !== remote.platformUrl) recovered.historySource = remote.historySource;
  return recovered;
}
