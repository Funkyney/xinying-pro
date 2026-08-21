import { describe, expect, it } from "vitest";
import { adapterInternals } from "../src/main/playwright-adapter";
import type { Job } from "../src/shared/contracts";

describe("Playwright adapter task references", () => {
  it("round-trips a session-scoped conversation index", () => {
    const value = adapterInternals.encodeChatTaskRef({ projectId: "project-1", sessionId: "session-2", userIndex: 7 });
    expect(value).toBe("chat:project-1:session-2:7");
    expect(adapterInternals.decodeChatTaskRef(value)).toEqual({ projectId: "project-1", sessionId: "session-2", userIndex: 7 });
    const pending = adapterInternals.encodePendingTaskRef({ projectId: "project-1", sessionId: "session-2", userIndex: 8 });
    expect(adapterInternals.decodePendingTaskRef(pending)).toEqual({ projectId: "project-1", sessionId: "session-2", userIndex: 8 });
  });

  it("accepts only the visible heart-platform generation route", () => {
    expect(adapterInternals.safeGenerationUrl("https://blueaivideo.com/avpAgent?projectId=a&sessionId=b")?.pathname).toBe("/avpAgent");
    expect(adapterInternals.safeGenerationUrl("https://example.com/avpAgent?projectId=a&sessionId=b")).toBeNull();
    expect(adapterInternals.decodeChatTaskRef("task-from-private-api")).toBeNull();
  });

  it("keeps the current Heart resolution when the project requests auto", () => {
    const auto = { parameters: { resolution: "auto" } } as Job;
    const explicit = { parameters: { resolution: "2K" } } as Job;
    expect(adapterInternals.explicitParameterValue(auto, "resolution")).toBeNull();
    expect(adapterInternals.explicitParameterValue(explicit, "resolution")).toBe("2K");
  });

  it("parses Heart's retained portrait selection and remaps platform labels without swap collisions", () => {
    expect(adapterInternals.parseSelectedPortraitCount("已选 2 项")).toBe(2);
    expect(adapterInternals.parseSelectedPortraitCount("尚未选择")).toBeNull();
    expect(adapterInternals.remapPromptLabels("@图1 先看 @图2，再回到 @图1", new Map([["@图1", "@图2"], ["@图2", "@图1"]])))
      .toBe("@图2 先看 @图1，再回到 @图2");
    expect(adapterInternals.normalizePromptLabels("@图2 先看 @视频3")).toBe("@图# 先看 @视频#");
  });

  it("canonicalizes Chinese material numbers and remaps the creator's order to Heart's order", () => {
    const mapping = new Map([["@图1", "@图1"], ["@图2", "@图3"], ["@图3", "@图4"], ["@图4", "@图2"]]);
    expect(adapterInternals.remapPromptLabels("让@图一的女人和@图四的男人对话，女人参考@图二。男人参考图三。", mapping))
      .toBe("让@图1的女人和@图2的男人对话，女人参考@图3。男人参考@图4。");
    expect(adapterInternals.normalizePromptLabels("＠图十先看参考视频二，再听@音频三"))
      .toBe("@图#先看参考@视频#，再听@音频#");
  });

  it("classifies only the matched portrait card status", () => {
    expect(adapterInternals.classifyPortraitCardText("审核失败 测试人像")).toBe("failed");
    expect(adapterInternals.classifyPortraitCardText("正在审核中... 测试人像")).toBe("running");
    expect(adapterInternals.classifyPortraitCardText("测试人像")).toBe("completed");
  });

  it("does not mistake a loading video placeholder for a completed result", () => {
    expect(adapterInternals.classifyGenerationCard("生成中...", "content-item _isLoading _video", false)).toBe("running");
    expect(adapterInternals.classifyGenerationCard("", "content-item _video", false)).toBe("running");
    expect(adapterInternals.classifyGenerationCard("结果已生成", "content-item _video", true)).toBe("completed");
    expect(adapterInternals.classifyGenerationCard("系统繁忙，请稍后再试", "content-item _video", false)).toBe("failed");
  });

  it("keeps a stable Heart portrait identity when preview processing changes", () => {
    const first = adapterInternals.platformPortraitIdentity("角色A", "https://cdn.bluemediacdn.com/team/asset-1.png?x-tos-process=image/quality,q_40", "team-a");
    const second = adapterInternals.platformPortraitIdentity("角色A", "https://cdn.bluemediacdn.com/team/asset-1.png?x-tos-process=image/quality,q_80", "team-a");
    expect(first).toEqual(second);
    expect(first.platformAssetId).toBe("asset-1");
    expect(adapterInternals.platformPortraitIdentity("角色A", "https://cdn.bluemediacdn.com/team/asset-1.png", "team-b").id).not.toBe(first.id);
  });

  it("uses workspace-scoped stable identities for Heart spaces and projects", () => {
    const personal = adapterInternals.platformWorkspaceIdentity("personal", "个人空间");
    const team = adapterInternals.platformWorkspaceIdentity("team", "个人空间");
    expect(personal).not.toBe(team);
    expect(adapterInternals.platformProjectIdentity(team, "项目A", "000001")).toBe(adapterInternals.platformProjectIdentity(team, "项目A", "000001"));
    expect(adapterInternals.platformProjectIdentity(personal, "项目A", "000001")).not.toBe(adapterInternals.platformProjectIdentity(team, "项目A", "000001"));
  });

  it("selects the default other portrait metadata without asking the user", () => {
    const defaults = {
      gender: "其他",
      ageGroup: "其他",
      ethnicity: "其他",
    } as Parameters<typeof adapterInternals.configurablePortraitOptions>[0];
    expect(adapterInternals.configurablePortraitOptions(defaults)).toEqual([
      { index: 0, value: "其他" },
      { index: 1, value: "其他" },
      { index: 2, value: "其他" },
    ]);
    expect(adapterInternals.configurablePortraitOptions({
      ...defaults,
      gender: "女",
      ageGroup: "青年（19-35）",
    })).toEqual([
      { index: 0, value: "女" },
      { index: 1, value: "青年（19-35）" },
      { index: 2, value: "其他" },
    ]);
  });

});
