import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { Project } from "../../shared/contracts";
import { mergeProjectDraft, projectDraft, projectDraftPatch, recoverProjectDraft, type DraftRecovery, type ProjectDraft } from "../../shared/project-draft";

const storageKey = (id: string) => `xinying:studio-draft:v1:${id}`;
const readRecovery = (id: string): DraftRecovery | null => {
  try { return JSON.parse(localStorage.getItem(storageKey(id)) ?? "null"); } catch { return null; }
};

/** Mount per project. Write-ahead recovery protects the last keystroke;
 * serialized PATCH saves cannot overwrite unrelated material changes.
 */
export function useProjectDraft(project: Project | null) {
  const [initial] = useState(() => {
    const base = project ? projectDraft(project) : {};
    const recovery = project ? readRecovery(project.id) : null;
    return { version: 1 as const, projectId: project?.id ?? "", editId: recovery?.editId ?? crypto.randomUUID(), base,
      value: project ? recoverProjectDraft(project, recovery) : {} };
  });
  const state = useRef(initial);
  const remoteVersion = useRef(project?.updatedAt ?? "");
  const alive = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  const [draft, render] = useState(initial.value);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const commit = useCallback((next: DraftRecovery, userEdit = false) => {
    const previous = state.current;
    state.current = next;
    try {
      const cached = readRecovery(next.projectId);
      // A request from an unmounted editor cannot clear a newer editor's cache.
      if (next.projectId && (userEdit || !cached || cached.editId === previous.editId)) {
        if (Object.keys(projectDraftPatch(next.base, next.value)).length) localStorage.setItem(storageKey(next.projectId), JSON.stringify(next));
        else localStorage.removeItem(storageKey(next.projectId));
      }
    } catch {
      if (alive.current) setSaveError("本机恢复缓存写入失败，请使用“保存草稿”确认保存");
    }
    if (alive.current) render(next.value);
  }, []);

  const setDraft = useCallback((action: SetStateAction<ProjectDraft>) => {
    const current = state.current;
    const value = typeof action === "function" ? action(current.value) : action;
    commit({ ...current, value, editId: crypto.randomUUID() }, true);
  }, [commit]);

  const saveDraft = useCallback(async (): Promise<void> => {
    if (pending.current) return pending.current;
    const operation = (async () => {
      if (alive.current) { setSaving(true); setSaveError(""); }
      try {
        while (state.current.projectId) {
          const snapshot = state.current;
          const patch = projectDraftPatch(snapshot.base, snapshot.value);
          if (!Object.keys(patch).length) break;
          const saved = await window.xinying.projects.update(snapshot.projectId, patch);
          const base = projectDraft(saved);
          remoteVersion.current = saved.updatedAt;
          const current = state.current;
          commit({ ...current, base, value: mergeProjectDraft(snapshot.value, current.value, base) });
          // A remounted editor owns newer edits now. Do not drain this old
          // editor's pending patch after it has left the screen.
          if (!alive.current) break;
        }
      } catch (error) {
        if (alive.current) {
          const backedUp = readRecovery(state.current.projectId)?.editId === state.current.editId;
          setSaveError(`自动保存未完成，${backedUp ? "输入已即时备份到本机" : "请勿关闭窗口，请先复制提示词备份"}：${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      } finally { if (alive.current) setSaving(false); }
    })();
    pending.current = operation;
    try { await operation; } finally { if (pending.current === operation) pending.current = null; }
  }, [commit]);

  useEffect(() => {
    if (!project || project.id !== state.current.projectId || project.updatedAt < remoteVersion.current) return;
    const base = projectDraft(project), current = state.current;
    remoteVersion.current = project.updatedAt;
    commit({ ...current, base, value: mergeProjectDraft(current.base, current.value, base) });
  }, [project?.id, project?.updatedAt, commit]);

  useEffect(() => {
    if (!Object.keys(projectDraftPatch(state.current.base, state.current.value)).length) return;
    const timer = window.setTimeout(() => { void saveDraft().catch(() => undefined); }, 600);
    return () => window.clearTimeout(timer);
  }, [draft, saveDraft]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  return { draft, setDraft, saveDraft, saving, saveError };
}
