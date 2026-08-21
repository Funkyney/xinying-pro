import type { PlatformPortrait, PlatformPortraitMediaKind, ReferenceAsset, ReferenceMediaKind } from "./contracts";

export function mediaKindFromMime(mimeType: string): ReferenceMediaKind {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "image";
}

export function portraitMediaKindFromPreviewUrl(previewUrl: string): PlatformPortraitMediaKind {
  return /\.mp4(?:$|[?#])/i.test(previewUrl) || /video\/snapshot/i.test(previewUrl) ? "video" : "unknown";
}

export function materialMediaKind(item: ReferenceAsset | PlatformPortrait): ReferenceMediaKind | "unknown" {
  return "mimeType" in item ? mediaKindFromMime(item.mimeType) : item.mediaKind;
}

export function mediaKindLabel(kind: ReferenceMediaKind | "unknown"): string {
  if (kind === "video") return "视频";
  if (kind === "audio") return "音频";
  if (kind === "unknown") return "待校验";
  return "图";
}

export function mediaKindEnglishLabel(kind: ReferenceMediaKind | "unknown"): string {
  if (kind === "video") return "Video";
  if (kind === "audio") return "Audio";
  if (kind === "unknown") return "Media";
  return "Image";
}

export function assignMediaLabels(kinds: Array<ReferenceMediaKind | "unknown">): string[] {
  const counters: Record<ReferenceMediaKind, number> = { image: 0, video: 0, audio: 0 };
  return kinds.map((kind) => {
    if (kind === "unknown") return "@待心影校验";
    counters[kind] += 1;
    return `@${mediaKindLabel(kind)}${counters[kind]}`;
  });
}

export function findAddedMediaLabel(before: string[], after: string[]): string | undefined {
  const remaining = new Map<string, number>();
  for (const label of before) remaining.set(label, (remaining.get(label) ?? 0) + 1);
  for (const label of after) {
    const count = remaining.get(label) ?? 0;
    if (count === 0) return label;
    remaining.set(label, count - 1);
  }
  return undefined;
}
