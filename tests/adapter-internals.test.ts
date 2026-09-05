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
    expect(adapterInternals.normalizeReusablePrompt("让 @图1 转身\n\n固定机位"))
      .toBe(adapterInternals.normalizeReusablePrompt("让 @图3 转身 固定机位"));
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

  it("binds Heart's numeric generation id and reads task-manager progress records", () => {
    expect(adapterInternals.extractBaseTaskId({ code: 0, data: { task_data: { base_task_id: 1687009 } } })).toBe("1687009");
    expect(adapterInternals.taskListRecords({
      code: 0,
      data: { tasks_list: [{ task_id: 1687009, status: "PROCESS", progress: 63 }] },
    })).toEqual([{ task_id: 1687009, status: "PROCESS", progress: 63 }]);
  });

  it("keeps a stable Heart portrait identity when preview processing changes", () => {
    const first = adapterInternals.platformPortraitIdentity("角色A", "https://cdn.bluemediacdn.com/team/asset-1.png?x-tos-process=image/quality,q_40", "team-a");
    const second = adapterInternals.platformPortraitIdentity("角色A", "https://cdn.bluemediacdn.com/team/asset-1.png?x-tos-process=image/quality,q_80", "team-a");
    expect(first).toEqual(second);
    expect(first.platformAssetId).toBe("asset-1");
    expect(adapterInternals.platformPortraitIdentity("角色A", "https://cdn.bluemediacdn.com/team/asset-1.png", "team-b").id).not.toBe(first.id);
  });

  it("matches a Heart portrait card by its stable asset id after a rename or CDN transform", () => {
    const portrait = {
      displayName: "伴舞11",
      previewUrl: "https://cdn.bluemediacdn.com/team/asset-11.png?x-tos-process=image/quality,q_40",
      platformAssetId: "asset-11",
    };
    expect(adapterInternals.platformPortraitCardMatches(portrait, {
      displayName: "伴舞11-已改名",
      previewUrl: "https://cdn.bluemediacdn.com/team/asset-11.webp?x-tos-process=image/quality,q_80",
    })).toBe(true);
    expect(adapterInternals.platformPortraitCardMatches(portrait, {
      displayName: "伴舞11",
      previewUrl: "https://cdn.bluemediacdn.com/team/another-asset.png",
    })).toBe(false);
  });

  it("matches renamed Heart portrait approvals by the uploaded file fingerprint", () => {
    const records = adapterInternals.platformPortraitApiRecords({
      code: 0,
      data: {
        portraits: [{
          display_name: "WechatIMG-renamed-by-heart",
          thumbnail_url: "https://cdn.bluemediacdn.com/team/approved.png",
          asset_type: "Image",
          source_info: { SourceInfo: { Md5: "ABC123", Size: 12_345 } },
        }],
      },
    });

    expect(records).toEqual([expect.objectContaining({
      displayName: "WechatIMG-renamed-by-heart",
      md5: "abc123",
      size: 12_345,
      mediaKind: "image",
    })]);
    expect(adapterInternals.matchPlatformPortraitApiRecord(records, {
      md5: "abc123",
      size: 12_345,
      mediaKind: "image",
    })?.displayName).toBe("WechatIMG-renamed-by-heart");
  });

  it("falls back to exact byte size for renamed Heart video approvals", () => {
    const records = adapterInternals.platformPortraitApiRecords({
      data: {
        portraits: [{
          display_name: "renamed-video",
          thumbnail_url: "https://cdn.bluemediacdn.com/team/approved.mp4",
          asset_type: "Video",
          source_info: { SourceInfo: { Size: 98_765 } },
        }],
      },
    });
    expect(adapterInternals.matchPlatformPortraitApiRecord(records, {
      md5: "",
      size: 98_765,
      mediaKind: "video",
    })?.displayName).toBe("renamed-video");
    expect(adapterInternals.matchPlatformPortraitApiRecord(records, {
      md5: "",
      size: 98_765,
      mediaKind: "image",
    })).toBeNull();
    expect(adapterInternals.platformPortraitPendingTotal({ data: { total: 0, list: [] } })).toBe(0);
    expect(adapterInternals.platformPortraitPendingTotal({ data: {} })).toBeNull();
  });

  it("uses workspace-scoped stable identities for Heart spaces and projects", () => {
    const personal = adapterInternals.platformWorkspaceIdentity("personal", "个人空间");
    const team = adapterInternals.platformWorkspaceIdentity("team", "个人空间");
    expect(personal).not.toBe(team);
    expect(adapterInternals.platformProjectIdentity(team, "项目A", "000001")).toBe(adapterInternals.platformProjectIdentity(team, "项目A", "000001"));
    expect(adapterInternals.platformProjectIdentity(personal, "项目A", "000001")).not.toBe(adapterInternals.platformProjectIdentity(team, "项目A", "000001"));
  });

  it("maps and sorts Heart project conversations for exact session reuse", () => {
    const conversations = adapterInternals.platformConversationsFromApi({
      code: 0,
      data: {
        sessions: [
          { avp_session_id: "session-old", session_title: "旧版分镜", updated_at: "2026-08-20T10:00:00+08:00" },
          { avp_session_id: "session-current", session_title: "最终广告片", update_time: 1787536800 },
          { avp_session_id: "session-current", session_title: "重复行" },
        ],
      },
    }, "catalog-project", "session-current");

    expect(conversations).toHaveLength(2);
    expect(conversations[0]).toMatchObject({
      id: "session-current",
      projectId: "catalog-project",
      title: "最终广告片",
      isCurrent: true,
    });
    expect(conversations[1]).toMatchObject({ id: "session-old", title: "旧版分镜", isCurrent: false });
  });

  it("builds a complete directly-openable catalog from Heart's read-only directory responses", () => {
    const catalog = adapterInternals.platformCatalogFromApi({
      currentRemoteId: "remote-team",
      currentWorkspaceKey: "team:team-1",
      workspaces: [
        { key: "personal:group-1", kind: "personal", name: "个人空间" },
        { key: "team:team-1", kind: "team", name: "设计团队" },
      ],
      projects: [
        { workspaceKey: "personal:group-1", remoteId: "remote-personal", name: "个人项目", shortId: "000001" },
        { workspaceKey: "team:team-1", remoteId: "remote-team", name: "团队项目", shortId: "000002" },
      ],
      customerOptions: ["客户A", "客户A", "客户B"],
      creationTypeOptions: ["其他", "汽车"],
    }, "2026-08-24T00:00:00.000Z", "https://blueaivideo.com/", "/home");

    expect(catalog.workspaces).toHaveLength(2);
    expect(catalog.projects).toHaveLength(2);
    expect(catalog.customerOptions).toEqual(["客户A", "客户B"]);
    expect(catalog.currentProjectId).toBe(catalog.projects[1].id);
    expect(catalog.currentWorkspaceId).toBe(catalog.workspaces[1].id);
    expect(catalog.workspaces[1].isCurrent).toBe(true);
    expect(catalog.projects[1]).toMatchObject({
      remoteId: "remote-team",
      homeUrl: "https://blueaivideo.com/home?projectId=remote-team",
      isCurrent: true,
    });
  });

  it("maps Heart project-library image and video rows into project-wide results", () => {
    const project = {
      id: "local-project",
      platformProjectId: "remote-project",
    } as Parameters<typeof adapterInternals.platformMaterialResult>[0];
    const video = adapterInternals.platformMaterialResult(project, "remote-project", "video", {
      material_id: 91,
      material_name: "团队成片.mp4",
      cdn_url: "https://media.example/team.mp4",
      post_cdn_url: "https://media.example/team.jpg",
      material_type: "ai_video",
      task_create_parmas: { prompt: "所有成员可见的提示词" },
      show_updated_time: "2026-08-24T12:00:00+08:00",
    }, "2026-08-24T05:00:00.000Z", 0);
    const image = adapterInternals.platformMaterialResult(project, "remote-project", "image", {
      material_id: 92,
      material_name: "竖屏图片.png",
      cdn_url: "https://media.example/portrait.png",
      post_cdn_url: "",
      material_type: "image",
    }, "2026-08-24T05:00:00.000Z", 1);

    expect(video).toMatchObject({ source: "project", mediaKind: "video", name: "团队成片.mp4", prompt: "所有成员可见的提示词", previewUrl: "https://media.example/team.jpg" });
    expect(image).toMatchObject({ source: "project", mediaKind: "image", name: "竖屏图片.png", outputUrl: "https://media.example/portrait.png", previewUrl: "https://media.example/portrait.png" });
    expect(image?.id).not.toBe(video?.id);
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

  it("falls back to a platform option when the unattended default other value is unavailable", () => {
    const candidates = [
      { value: "男", disabled: false },
      { value: "女", disabled: false },
      { value: "不可选", disabled: true },
    ];
    expect(adapterInternals.resolvePortraitOptionValue(candidates, "其他")).toBe("男");
    expect(adapterInternals.resolvePortraitOptionValue([
      ...candidates,
      { value: "其他", disabled: false },
    ], "其他")).toBe("其他");
    expect(adapterInternals.resolvePortraitOptionValue(candidates, "女")).toBe("女");
    expect(adapterInternals.resolvePortraitOptionValue(candidates, "青年（19-35）")).toBeNull();
    expect(adapterInternals.resolvePortraitOptionValue([{ value: "男", disabled: true }], "其他")).toBeNull();
  });

  it("trusts successful Heart mutation envelopes and captures the submitted portrait id", () => {
    expect(adapterInternals.platformMutationResult({ code: 0, data: { portrait_ids: ["portrait-9"] } }, true)).toEqual({ ok: true, message: "" });
    expect(adapterInternals.submittedPortraitId({ code: 0, data: { portrait_ids: ["portrait-9"] } })).toBe("portrait-9");
    expect(adapterInternals.submittedPortraitId({ data: { items: [{ portrait_id: 88 }] } })).toBe("88");
    expect(adapterInternals.platformMutationResult({ code: 500, message: "任务进行中" }, true)).toEqual({ ok: false, message: "任务进行中" });
    expect(adapterInternals.platformMutationResult({ code: 0 }, false).ok).toBe(false);
  });

});
