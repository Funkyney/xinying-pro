import type { PlatformResult } from "./contracts";
import { canonicalPlatformOutputUrl, platformVideoIdentity } from "./platform-results";

/** These fields are emitted by Heart's material library. Absence is not false. */
export function platformFavoriteFlag(raw: Record<string, unknown>): boolean | undefined {
  const flags = [raw.is_liked, raw.liked_status].filter(value => typeof value === "boolean" || value === 0 || value === 1);
  if (Array.isArray(raw.tag_list)) flags.push(raw.tag_list.includes("liked"));
  else if (raw.tag_list === null) flags.push(false);
  return flags.length ? flags.some(value => value === true || value === 1) : undefined;
}

export function favoriteMediaKey(kind: PlatformResult["mediaKind"], outputUrl: string | null): string | null {
  if (!outputUrl) return null;
  return `${kind}:${(kind === "video" ? platformVideoIdentity(outputUrl) : null) ?? canonicalPlatformOutputUrl(outputUrl)}`;
}

/** Call only with a complete project/kind snapshot, never a partially read page. */
export function attachPlatformFavorites(results: PlatformResult[], favoriteUrls: readonly string[]): PlatformResult[] {
  const keys = new Set(favoriteUrls.map(url => favoriteMediaKey("video", url)));
  return results.map(result => {
    const key = favoriteMediaKey(result.mediaKind, result.outputUrl);
    return result.mediaKind === "video" && key ? { ...result, platformMarked: keys.has(key) } : result;
  });
}
