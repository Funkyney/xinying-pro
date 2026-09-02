const HEART_CDN_HOST_SUFFIX = ".bluemediacdn.com";
const GENERATED_VIDEO_PATH = /\/vlc-toc\/task\/img2video\/.*_(?:360|480|540|720|1080)p\.mp4$/i;
const VIDEO_QUALITY_SUFFIX = /_(?:360|480|540|720|1080)p(?=\.mp4$)/i;
const VIDEO_COVER_SUFFIX = /_cover\.(?:jpg|jpeg|png)$/i;
const MOV_SUFFIX = /\.mov$/i;

function parsedHeartCdnUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(HEART_CDN_HOST_SUFFIX)) return null;
    return url;
  } catch {
    return null;
  }
}

export function canonicalPlatformOutputUrl(value: string | null | undefined): string | null {
  const url = parsedHeartCdnUrl(value);
  if (!url) return value ?? null;
  url.searchParams.delete("x-tos-process");
  if (GENERATED_VIDEO_PATH.test(url.pathname)) {
    url.pathname = url.pathname.replace(VIDEO_QUALITY_SUFFIX, "");
  }
  return url.toString();
}

export function originalPlatformVideoUrlFromPoster(value: string | null | undefined): string | null {
  const url = parsedHeartCdnUrl(value);
  if (!url || !VIDEO_COVER_SUFFIX.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(VIDEO_COVER_SUFFIX, ".mp4");
  url.searchParams.delete("x-tos-process");
  return url.toString();
}

export function platformPlaybackVideoUrl(
  outputUrl: string | null | undefined,
  posterUrl: string | null | undefined,
): string | null {
  const output = parsedHeartCdnUrl(outputUrl);
  if (!output || !MOV_SUFFIX.test(output.pathname)) return outputUrl ?? null;

  // Heart 的 MOV 原片不一定能被 Electron/Chromium 解码；网页本身也使用
  // 同名 _720p.mp4 作播放预览。详情展示用 MP4，下载仍保留 outputUrl 的 MOV 原片。
  const poster = parsedHeartCdnUrl(posterUrl);
  const playback = poster && VIDEO_COVER_SUFFIX.test(poster.pathname) ? poster : output;
  playback.pathname = poster && VIDEO_COVER_SUFFIX.test(playback.pathname)
    ? playback.pathname.replace(VIDEO_COVER_SUFFIX, "_720p.mp4")
    : playback.pathname.replace(MOV_SUFFIX, "_720p.mp4");
  playback.searchParams.delete("x-tos-process");
  return playback.toString();
}

export function isPlatformPreviewOutputUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const canonical = canonicalPlatformOutputUrl(value);
  try {
    return Boolean(canonical && canonical !== new URL(value).toString());
  } catch {
    return false;
  }
}
