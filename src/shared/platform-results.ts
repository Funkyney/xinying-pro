const HEART_CDN_HOST_SUFFIX = ".bluemediacdn.com";
const GENERATED_VIDEO_PATH = /\/vlc-toc\/task\/img2video\/.*_(?:360|480|540|720|1080)p\.mp4$/i;
const VIDEO_QUALITY_SUFFIX = /_(?:360|480|540|720|1080)p(?=\.mp4$)/i;
const VIDEO_COVER_SUFFIX = /_cover\.(?:jpg|jpeg|png)$/i;

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

export function isPlatformPreviewOutputUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const canonical = canonicalPlatformOutputUrl(value);
  try {
    return Boolean(canonical && canonical !== new URL(value).toString());
  } catch {
    return false;
  }
}
