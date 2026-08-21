export type PlatformNavigationKind = "authenticated" | "login" | "auth-provider" | "other";

function hostMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

export function classifyPlatformNavigation(
  rawUrl: string,
  authenticatedUrlPatterns: string[],
): PlatformNavigationKind {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return "other";
    if (hostMatches(url.hostname, "feishu.cn") || hostMatches(url.hostname, "larksuite.com")) {
      return "auth-provider";
    }
    if (!hostMatches(url.hostname, "blueaivideo.com")) return "other";
    if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return "login";
    const authenticated = authenticatedUrlPatterns.some((pattern) => (
      url.pathname === pattern || url.pathname.startsWith(`${pattern}/`)
    ));
    return authenticated ? "authenticated" : "other";
  } catch {
    return "other";
  }
}

export function sessionNavigationPriority(kind: PlatformNavigationKind): number {
  if (kind === "authenticated") return 3;
  if (kind === "auth-provider") return 2;
  if (kind === "login") return 1;
  return 0;
}

export function platformHomeUrl(rawUrl: string, baseUrl: string, homePath: string): string {
  const current = new URL(rawUrl);
  const base = new URL(baseUrl);
  if (
    current.protocol !== "https:"
    || base.protocol !== "https:"
    || !hostMatches(current.hostname, "blueaivideo.com")
    || !hostMatches(base.hostname, "blueaivideo.com")
  ) {
    throw new Error("不是有效的心影页面地址");
  }
  const home = new URL(homePath, base);
  const projectId = current.searchParams.get("projectId");
  if (projectId) home.searchParams.set("projectId", projectId);
  return home.toString();
}
