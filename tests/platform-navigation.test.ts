import { describe, expect, it } from "vitest";
import { classifyPlatformNavigation, platformHomeUrl, sessionNavigationPriority } from "../src/main/platform-navigation";

const authenticatedPatterns = ["/home", "/avpAgent", "/aiCharacter"];

describe("platform login navigation", () => {
  it("recognizes authenticated Heart pages", () => {
    expect(classifyPlatformNavigation("https://blueaivideo.com/home", authenticatedPatterns)).toBe("authenticated");
    expect(classifyPlatformNavigation("https://blueaivideo.com/avpAgent?projectId=1", authenticatedPatterns)).toBe("authenticated");
    expect(classifyPlatformNavigation("https://blueaivideo.com/aiCharacter", authenticatedPatterns)).toBe("authenticated");
  });

  it("distinguishes Heart login and Feishu authorization pages", () => {
    expect(classifyPlatformNavigation("https://blueaivideo.com/login?from=%2Fhome", authenticatedPatterns)).toBe("login");
    expect(classifyPlatformNavigation("https://passport.feishu.cn/suite/passport/oauth/authorize", authenticatedPatterns)).toBe("auth-provider");
    expect(classifyPlatformNavigation("https://accounts.larksuite.com/open-apis/authen/v1/index", authenticatedPatterns)).toBe("auth-provider");
  });

  it("rejects lookalike hosts and partial route matches", () => {
    expect(classifyPlatformNavigation("https://evilblueaivideo.com/home", authenticatedPatterns)).toBe("other");
    expect(classifyPlatformNavigation("https://blueaivideo.com/home-preview", authenticatedPatterns)).toBe("other");
    expect(classifyPlatformNavigation("http://blueaivideo.com/home", authenticatedPatterns)).toBe("other");
  });

  it("prefers authenticated pages over QR and login pages", () => {
    const ordered = ["login", "authenticated", "auth-provider", "other"] as const;
    expect([...ordered].sort((left, right) => sessionNavigationPriority(right) - sessionNavigationPriority(left))).toEqual([
      "authenticated",
      "auth-provider",
      "login",
      "other",
    ]);
  });

  it("opens the home catalog even when a fresh login has no project id", () => {
    expect(platformHomeUrl("https://blueaivideo.com/home", "https://blueaivideo.com/", "/home"))
      .toBe("https://blueaivideo.com/home");
    expect(platformHomeUrl("https://blueaivideo.com/avpAgent?projectId=project-1&sessionId=session-1", "https://blueaivideo.com/", "/home"))
      .toBe("https://blueaivideo.com/home?projectId=project-1");
  });

  it("refuses non-platform home targets", () => {
    expect(() => platformHomeUrl("https://blueaivideo.example/home", "https://blueaivideo.com/", "/home"))
      .toThrow("不是有效的心影页面地址");
  });
});
