const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function safeDownloadBaseName(value: string, fallback = "心影作品"): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const candidate = normalized && !WINDOWS_RESERVED_NAMES.test(normalized) ? normalized : fallback;
  return candidate.slice(0, 80).replace(/[. ]+$/g, "") || fallback;
}

export function downloadTimestamp(value?: string | null): string {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${valueOf("year")}${valueOf("month")}${valueOf("day")}-${valueOf("hour")}${valueOf("minute")}${valueOf("second")}`;
}

export function projectDownloadName(
  projectName: string,
  extension: string,
  options: { createdAt?: string | null; index?: number } = {},
): string {
  const normalizedExtension = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  const sequence = options.index === undefined ? "" : `-${String(options.index).padStart(3, "0")}`;
  return `${safeDownloadBaseName(projectName)}-${downloadTimestamp(options.createdAt)}${sequence}${normalizedExtension}`;
}
