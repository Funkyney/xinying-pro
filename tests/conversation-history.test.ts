import { describe, expect, it, vi } from "vitest";
import { parseConversationHistory, historySourceMatches, historyMaterialPreviewUrls, historyMaterialsMatch, historyResultMediaKind, historyResultPlaybackUrl } from "../src/shared/conversation-history";
import { PlaywrightXinyingAdapter } from "../src/main/playwright-adapter";
import type { Project } from "../src/shared/contracts";

const params = { text: "@图1 中的车向前行驶", model_name: "Seedance 2.5 全能参考", aspect: "9:16", duration: 10, resolution: "1080p", generateAudio: true,
  image: [{ material_name: "场景", cdn_url: "https://example.com/ref.png" }, { display_name: "人物", thumbnail_url: "https://example.com/person.png", portrait_id: "portrait-1" }],
  video: [{ material_name: "运动" }], audio: [{ material_name: "节奏" }], output_format: "mov", tools: [{ type: "web_search" }], enhance_video_hd: true,
  prompt_optimizer: true, auto_portrait_audit: true, promptInspiration_dict: { 风格: ["写实"] } };
function payload(overrides = {}) { return { code: 0, data: { project_id: "remote", avp_session_id: "session", has_more: true,
  grouped_records: [{ event_id: 123, task_status: "SUCCESS", task_create_parmas: params, img2video_result: { create_time: "2026-11-24T03:00:00Z", result: { videos: [{ post_cdn_url: "https://example.com/cover.jpg", cdn_url: "https://example.com/output.mp4" }] } } }], ...overrides } }; }

describe("official generation history", () => {
  it("maps original parameters, mixed references, portrait position and stable identity", () => {
    const history = parseConversationHistory(payload(), "remote", "session");
    expect(history).toMatchObject({ sessionId: "session", hasMore: true, beforeEventId: "123" });
    const entry = history.entries[0];
    expect(entry.settings).toMatchObject({ prompt: params.text, modelName: params.model_name, mode: "reference-to-video", aspectRatio: "9:16", duration: 10, resolution: "1080p", audioEnabled: true, videoFormat: "mov", networkEnabled: true, smartBalance: true, autoPortraitAudit: true, inspiration: { 风格: "写实" } });
    expect(entry.source.materials.map((item) => [item.name, item.label])).toEqual([["场景", "@图1"], ["人物", "@图2"], ["运动", "@视频1"], ["节奏", "@音频1"]]);
    expect(entry.editUnavailableReason).toBe("");
    expect(entry.previewUrl).toBe("https://example.com/cover.jpg");
    expect(entry.mediaKind).toBe("video");
    expect(entry.source).not.toHaveProperty("token");
  });
  it("rejects another project/session, malformed/error responses, and does not fabricate empty history", () => {
    for (const raw of [{ code: 500 }, payload({ project_id: "other" }), payload({ avp_session_id: "other" }), payload({ grouped_records: null })]) expect(() => parseConversationHistory(raw, "remote", "session")).toThrow(/所选项目和对话/);
    expect(parseConversationHistory(payload({ grouped_records: [], has_more: false }), "remote", "session").entries).toEqual([]);
  });
  it("distinguishes generated images and uses MOV-compatible playback without changing original records", () => {
    const image = parseConversationHistory(payload({ grouped_records: [{ event_id: 2, task_status: "SUCCESS", task_create_parmas: params,
      txt2img_result: { result: { images: [{ cdn_url: "https://example.com/generated?id=1", post_cdn_url: "https://example.com/thumb.jpg" }] } } }] }), "remote", "session").entries[0];
    expect(image.mediaKind).toBe("image");
    expect(historyResultPlaybackUrl(image)).toBe("https://example.com/generated?id=1");
    const video = { ...parseConversationHistory(payload(), "remote", "session").entries[0],
      outputUrl: "https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/model/clip.mov", previewUrl: null };
    expect(historyResultPlaybackUrl(video)).toContain("clip_720p.mp4");
    expect(video.outputUrl).toContain("clip.mov");
    expect(historyResultPlaybackUrl({ ...video, outputUrl: null })).toBeNull();
    expect(historyResultPlaybackUrl({ ...video, outputUrl: "javascript:alert(1)" })).toBeNull();
    expect(historyResultMediaKind({ outputUrl: "https://example.com/legacy.png?q=1" })).toBe("image");
  });
  it("uses the original image instead of an invalid video snapshot, including already-saved drafts", () => {
    const original = "https://example.com/ref.png?signature=keep-me";
    const thumbnail = `${original}&x-tos-process=video/snapshot,t_0,f_jpg`;
    const raw = payload({ grouped_records: [{ event_id: 1, task_create_parmas: { ...params, image: [{ material_name: "人物", cdn_url: original, thumbnail_url: thumbnail }] } }] });
    const material = parseConversationHistory(raw, "remote", "session").entries[0].source.materials[0];
    expect(material).toMatchObject({ kind: "image", previewUrl: thumbnail, originalUrl: original, label: "@图1" });
    expect(historyMaterialPreviewUrls(material)).toEqual([original]);
    const { originalUrl, ...legacy } = material;
    expect(historyMaterialPreviewUrls(legacy)).toEqual([original]);
    expect(historyMaterialsMatch([material], [legacy])).toBe(true);
    expect(historyMaterialsMatch([material], [{ ...material, originalUrl: "https://example.com/changed.png" }])).toBe(false);
    expect(historyMaterialsMatch([material], [{ ...legacy, name: "其他素材" }])).toBe(false);
    expect(historyMaterialsMatch([material], [])).toBe(false);
  });
  it("keeps image thumbnail/original fallbacks safe and preserves video snapshot transforms", () => {
    const material = { key: "image:0", name: "场景", kind: "image" as const, label: "@图1", previewUrl: "https://example.com/thumb.jpg", originalUrl: "https://example.com/ref.png" };
    expect(historyMaterialPreviewUrls(material)).toEqual([material.previewUrl, material.originalUrl]);
    expect(historyMaterialPreviewUrls({ ...material, previewUrl: material.originalUrl })).toEqual([material.originalUrl]);
    expect(historyMaterialPreviewUrls({ ...material, previewUrl: "javascript:alert(1)" })).toEqual([material.originalUrl]);
    expect(historyMaterialPreviewUrls({ ...material, previewUrl: "http://example.com/unsafe", originalUrl: "file:///private.png" })).toEqual([]);
    const videoPreview = "https://example.com/motion.mp4?x-tos-process=video/snapshot,t_0,f_jpg";
    expect(historyMaterialPreviewUrls({ ...material, kind: "video", previewUrl: videoPreview })).toEqual([videoPreview]);
    expect(historyMaterialPreviewUrls({ ...material, kind: "audio", previewUrl: null })).toEqual([]);
  });
  it("keeps unsupported/image-only history visible but never silently substitutes a different model", () => {
    const raw = payload({ grouped_records: [{ event_id: 1, task_status: "FAIL", task_create_parmas: { ...params, model_name: "图片新模型" } }] });
    const entry = parseConversationHistory(raw, "remote", "session").entries[0];
    expect(entry.status).toBe("failed"); expect(entry.editUnavailableReason).toContain("暂不支持原模型");
    expect(entry.settings.modelName).toBe("图片新模型");
  });
  it("requires exact session binding and accepts only HTTPS previews", () => {
    const raw = payload({ grouped_records: [{ event_id: 1, task_create_parmas: params, img2video_result: { result: { videos: [{ post_cdn_url: "javascript:alert(1)" }] } } }] });
    const entry = parseConversationHistory(raw, "remote", "session").entries[0];
    expect(entry.previewUrl).toBeNull();
    expect(historySourceMatches(entry.source, "https://blueaivideo.com/agentlab?projectId=remote&sessionId=session")).toBe(true);
    expect(historySourceMatches(entry.source, "https://blueaivideo.com/agentlab?projectId=remote&sessionId=other")).toBe(false);
  });
  it("reads history by API without navigation, editing, uploading or submitting; follows official event_id pagination", async () => {
    const get = vi.fn().mockResolvedValue(payload()), page = { goto: vi.fn() };
    const adapter = Object.assign(Object.create(PlaywrightXinyingAdapter.prototype), { page: vi.fn().mockResolvedValue(page), authenticatedGet: get }) as PlaywrightXinyingAdapter;
    const project = { platformUrl: "https://blueaivideo.com/agentlab?projectId=remote&sessionId=session" } as Project;
    await adapter.conversationHistory(project, "session");
    await adapter.conversationHistory(project, "session", "124");
    expect(get.mock.calls[1][1]).toContain("event_id=124"); expect(page.goto).not.toHaveBeenCalled();
    await expect(adapter.conversationHistory(project, "another")).rejects.toThrow(/请先选择/);
    await expect(adapter.conversationHistory(project, "session", "123")).rejects.toThrow(/未返回更早/);
    await expect(adapter.conversationHistory(project, "session", "invalid")).rejects.toThrow(/分页标识/);
    expect(get).toHaveBeenCalledTimes(3);
  });
});
