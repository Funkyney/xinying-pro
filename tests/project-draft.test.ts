import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/contracts";
import { mergeProjectDraft, projectDraft, projectDraftPatch, recoverProjectDraft } from "../src/shared/project-draft";

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "one", name: "测试项目", description: "", prompt: "旧提示词", modelName: "Seedance 2.5 全能参考",
  platformUrl: "https://blueaivideo.com/agentlab?projectId=p&sessionId=a", platformWorkspaceId: "space", platformProjectId: "p",
  mode: "reference-to-video", aspectRatio: "16:9", duration: 5, resolution: "480p", audioEnabled: true,
  videoFormat: "mp4", networkEnabled: true, portraitIds: [], materialOrder: [], status: "draft",
  createdAt: "2026-11-26T01:00:00Z", updatedAt: "2026-11-26T01:00:00Z", ...overrides,
});

describe("project draft conflict protection", () => {
  it("keeps unsaved prompt and settings while accepting unrelated remote material edits", () => {
    const base = projectDraft(project());
    const local = { ...base, prompt: "刚输入的提示词", duration: 8 };
    const remote = projectDraft(project({ materialOrder: ["reference:new"] }));
    const merged = mergeProjectDraft(base, local, remote);
    expect(merged).toMatchObject({ prompt: local.prompt, duration: 8, materialOrder: ["reference:new"] });
    expect(projectDraftPatch(remote, merged)).toEqual({ prompt: local.prompt, duration: 8 });
  });

  it("adopts a prompt updated externally when the editor has no local prompt change", () => {
    const base = projectDraft(project());
    expect(mergeProjectDraft(base, base, { ...base, prompt: "导演任务更新" }).prompt).toBe("导演任务更新");
  });

  it("keeps keystrokes entered while an earlier save was in flight", () => {
    const sent = projectDraft(project({ prompt: "第一段" }));
    const typed = { ...sent, prompt: "第一段 + 新输入" };
    const acknowledged = { ...sent, materialOrder: ["reference:new"] };
    expect(mergeProjectDraft(sent, typed, acknowledged)).toMatchObject({ prompt: typed.prompt, materialOrder: acknowledged.materialOrder });
  });

  it("does not treat empty prompts or false switches as missing edits", () => {
    expect(projectDraftPatch({ prompt: "旧", audioEnabled: true }, { prompt: "", audioEnabled: false })).toEqual({ prompt: "", audioEnabled: false });
  });

  it("recognizes acknowledged arrays and objects without producing another save", () => {
    const base = projectDraft(project({ materialOrder: ["reference:one"], inspiration: { camera: "test" } }));
    expect(projectDraftPatch(base, JSON.parse(JSON.stringify(base)))).toEqual({});
  });

  it("restores per-project unsaved edits without reviving stale references", () => {
    const old = project(), base = projectDraft(old);
    const stored = { version: 1, projectId: old.id, base, value: { ...base, prompt: "立即恢复" } };
    expect(recoverProjectDraft(project({ materialOrder: ["reference:new"] }), stored)).toMatchObject({ prompt: "立即恢复", materialOrder: ["reference:new"] });
    expect(recoverProjectDraft(project({ id: "other" }), stored).prompt).toBe("旧提示词");
  });

  it("never restores a previous session's binding or history into a new conversation", () => {
    const old = project(), base = projectDraft(old);
    const stored = { version: 1, projectId: old.id, base, value: { ...base, prompt: "保留文本", historySource: { sessionId: "a" }, platformUrl: base.platformUrl } };
    const remote = project({ platformUrl: "https://blueaivideo.com/agentlab?projectId=p&sessionId=b" });
    expect(recoverProjectDraft(remote, stored)).toMatchObject({ prompt: "保留文本", platformUrl: remote.platformUrl, historySource: null });
  });

  it("ignores malformed recovery records", () => {
    for (const stored of [null, [], { version: 9 }, { version: 1, projectId: "one", base: [], value: [] }]) {
      expect(recoverProjectDraft(project(), stored)).toEqual(projectDraft(project()));
    }
  });
});
