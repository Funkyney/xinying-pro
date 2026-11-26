import type { ConversationHistoryEntry, ConversationHistoryMaterial, ConversationHistoryPage, ConversationHistorySource, ProjectInput } from "./contracts";
import { modelProfile } from "./model-profiles";
import { generationOptions } from "./generation-options";
import { platformPlaybackVideoUrl } from "./platform-results";

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function url(value: unknown): string | null {
  try { const parsed = new URL(text(value)); return parsed.protocol === "https:" ? parsed.toString() : null; } catch { return null; }
}

export function historyResultMediaKind(entry: Pick<ConversationHistoryEntry, "mediaKind" | "outputUrl">): "video" | "image" {
  if (entry.mediaKind) return entry.mediaKind;
  return /\.(png|jpe?g|webp|gif|avif)(?:\?|$)/i.test(entry.outputUrl ?? "") ? "image" : "video";
}

/** Playback only: MOV originals stay unchanged for editing/download. */
export function historyResultPlaybackUrl(entry: ConversationHistoryEntry): string | null {
  const output = url(entry.outputUrl);
  return historyResultMediaKind(entry) === "image" ? output ?? url(entry.previewUrl)
    : output ? platformPlaybackVideoUrl(output, url(entry.previewUrl)) : null;
}

/** Old records can contain a video-frame transform even for PNG references. */
export function historyMaterialPreviewUrls(material: ConversationHistoryMaterial): string[] {
  let preview = url(material.previewUrl);
  const original = material.kind === "image" ? url(material.originalUrl) : null;
  if (preview && material.kind === "image") {
    const parsed = new URL(preview);
    if (/^video\/snapshot(?:,|\/|$)/i.test(parsed.searchParams.get("x-tos-process") ?? "")) {
      parsed.searchParams.delete("x-tos-process");
      preview = original ?? parsed.toString();
    }
  }
  return [...new Set([preview, original].filter((candidate): candidate is string => Boolean(candidate)))];
}

/** Preview metadata added by an app update must not invalidate saved drafts. */
export function historyMaterialsMatch(current: ConversationHistoryMaterial[], saved: ConversationHistoryMaterial[]): boolean {
  return current.length === saved.length && current.every((material, index) => {
    const previous = saved[index];
    return material.key === previous.key && material.kind === previous.kind && material.name === previous.name
      && material.label === previous.label && material.previewUrl === previous.previewUrl
      && (!previous.originalUrl || material.originalUrl === previous.originalUrl);
  });
}

export function historySourceMatches(source: ConversationHistorySource, platformUrl: string): boolean {
  try {
    const target = new URL(platformUrl);
    return target.hostname === "blueaivideo.com" && target.searchParams.get("projectId") === source.remoteProjectId
      && target.searchParams.get("sessionId") === source.sessionId && /^\d+$/.test(source.eventId);
  } catch { return false; }
}

export function parseConversationHistory(payload: unknown, remoteProjectId: string, sessionId: string): ConversationHistoryPage {
  const response = object(payload), data = object(response.data);
  if (response.code !== 0 || data.project_id !== remoteProjectId || data.avp_session_id !== sessionId || !Array.isArray(data.grouped_records)) {
    throw new Error("心影生成记录未返回所选项目和对话的有效数据；已保留草稿，请刷新重试");
  }
  const entries: ConversationHistoryEntry[] = data.grouped_records.map(object).map((record) => {
    const params = object(record.task_create_params ?? record.task_create_parmas);
    const video = object(record.img2video_result), image = object(record.txt2img_result);
    const result = object(video.result ?? image.result), input = object(video.input_params);
    const modelName = text(params.model_name);
    const materials: ConversationHistoryMaterial[] = [];
    const counts = { image: 0, video: 0, audio: 0 };
    for (const slot of ["firstFrame", "tailFrame", "image", "video", "audio"] as const) {
      for (const [index, raw] of (Array.isArray(params[slot]) ? params[slot] : []).entries()) {
        const material = object(raw), kind = slot === "video" ? "video" : slot === "audio" ? "audio" : "image";
        counts[kind] += 1;
        materials.push({ key: `${slot}:${index}`, kind, name: text(material.material_name || material.display_name || material.name) || `参考素材 ${materials.length + 1}`,
          previewUrl: url(material.thumbnail_url || material.post_cdn_url || (kind === "image" ? material.cdn_url : "")),
          ...(kind === "image" ? { originalUrl: url(material.cdn_url) } : {}),
          label: `@${kind === "image" ? "图" : kind === "video" ? "视频" : "音频"}${counts[kind]}` });
      }
    }
    const videos = Array.isArray(result.videos) ? result.videos : [], images = Array.isArray(result.images) ? result.images : [];
    const mediaKind = videos.length ? "video" : images.length || record.txt2img_result && !record.img2video_result ? "image" : "video";
    const outputs = mediaKind === "image" ? images : videos;
    const output = object(outputs[0]);
    const prompt = text(params.text || params.prompt || video.prompt || image.prompt);
    const eventId = String(record.event_id ?? "");
    const mode: ProjectInput["mode"] = /first.*last|first.*tail/.test(text(params.model_variant)) || (params.firstFrame?.length && params.tailFrame?.length)
      ? "first-last-frame" : materials.length ? "reference-to-video" : "text-to-video";
    const inspirations = Object.fromEntries(Object.entries(object(params.promptInspiration_dict)).flatMap(([key, value]) => {
      const selection = Array.isArray(value) ? value[0] : value;
      return typeof selection === "string" ? [[key, selection]] : [];
    }));
    const settings: Partial<ProjectInput> = {
      prompt, modelName, mode, aspectRatio: text(params.aspect) || text(result.ratio), duration: Number(params.duration ?? video.duration ?? result.duration),
      resolution: text(params.resolution || result.resolution), audioEnabled: Boolean(params.generateAudio ?? result.generate_audio),
      videoFormat: (params.output_format || input.output_format || result.output_format) === "mov" ? "mov" : "mp4",
      networkEnabled: Array.isArray(params.tools) && params.tools.some((tool: any) => tool?.type === "web_search"),
      ...generationOptions({ modelName, autoPortraitAudit: params.auto_portrait_audit ?? undefined, promptOptimizer: Boolean(params.prompt_optimizer),
        draftMode: Boolean(params.is_draft), smartBalance: Boolean(params.enhance_video_hd), inspiration: inspirations }),
    };
    const profile = modelProfile(modelName);
    const unsupported = !profile ? `当前工作台暂不支持原模型“${modelName || "未知模型"}”` : !profile.modes.includes(mode) ? "原生成模式暂不支持回填" : "";
    const documentCount = Array.isArray(params.document) ? params.document.length : 0;
    const unavailableMaterial = ["image", "video", "audio", "firstFrame", "tailFrame"].some((slot) => (Array.isArray(params[slot]) ? params[slot] : []).some((item: any) => !item || typeof item !== "object"));
    const invalidParameters = !Number.isFinite(settings.duration) || !settings.aspectRatio || !settings.resolution;
    const status = String(record.task_status ?? "").toUpperCase();
    return { eventId, prompt, mediaKind, status: status === "SUCCESS" ? "completed" : status === "FAIL" ? "failed" : ["TEMP", "NEW", "WAITING", "WAITING_CONSUME", "PROCESSING"].includes(status) ? "running" : "unknown",
      createdAt: text(video.create_time || image.create_time), previewUrl: url(output.post_cdn_url || output.thumbnail_url || (result.images ? output.cdn_url : "")),
      outputUrl: url(output.cdn_url || output.url || object(result.content).video_url), settings,
      source: { remoteProjectId, sessionId, eventId, prompt, materials },
      editUnavailableReason: unsupported || (documentCount ? "此记录包含文档参考，请在原网页重新编辑" : unavailableMaterial ? "旧记录的素材信息不完整，请在原网页重新编辑" : !prompt || invalidParameters || !/^\d+$/.test(eventId) ? "原记录的提示词或参数不完整" : ""),
    } as ConversationHistoryEntry;
  });
  const ids = entries.map((entry) => entry.eventId).filter((id) => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b));
  return { sessionId, entries: entries.sort((a, b) => Number(b.eventId) - Number(a.eventId)), beforeEventId: ids[0] ?? null,
    hasMore: Boolean(data.has_more_before ?? data.has_more) && ids.length > 0 };
}
