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

const PROMPT_MATERIAL_INDEX = "[0-9０-９]+|[零〇一二两三四五六七八九十]+";

function parsePromptMaterialIndex(value: string): number | null {
  const asciiDigits = value.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(asciiDigits)) return Number(asciiDigits);

  const digitValues: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (!asciiDigits.includes("十")) {
    const digits = [...asciiDigits].map((digit) => digitValues[digit]);
    return digits.some((digit) => digit === undefined) ? null : Number(digits.join(""));
  }

  const [tensText, onesText, ...rest] = asciiDigits.split("十");
  if (rest.length || (tensText && digitValues[tensText] === undefined) || (onesText && digitValues[onesText] === undefined)) return null;
  return (tensText ? digitValues[tensText] : 1) * 10 + (onesText ? digitValues[onesText] : 0);
}

/**
 * Converts the ways creators commonly refer to Heart materials into one stable
 * representation before validation and platform-order remapping.
 */
export function canonicalizePromptMaterialReferences(prompt: string): string {
  const explicitReference = new RegExp(`[@＠]\\s*(图|视频|音频)\\s*(${PROMPT_MATERIAL_INDEX})`, "g");
  const canonical = prompt.replace(explicitReference, (original, kind: string, rawIndex: string) => {
    const index = parsePromptMaterialIndex(rawIndex);
    return index === null ? original : `@${kind}${index}`;
  });
  const naturalReference = new RegExp(`参考\\s*(图|视频|音频)\\s*(${PROMPT_MATERIAL_INDEX})`, "g");
  return canonical.replace(naturalReference, (original, kind: string, rawIndex: string) => {
    const index = parsePromptMaterialIndex(rawIndex);
    return index === null ? original : `参考@${kind}${index}`;
  });
}

export function promptMaterialLabels(prompt: string): string[] {
  return [...canonicalizePromptMaterialReferences(prompt).matchAll(/@(图|视频|音频)\d+/g)].map((match) => match[0]);
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
