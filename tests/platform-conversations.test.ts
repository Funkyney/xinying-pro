import { describe, expect, it, vi } from "vitest";
import { PlaywrightXinyingAdapter } from "../src/main/playwright-adapter";
import type { PlatformCatalogSnapshot } from "../src/shared/contracts";

const catalog: PlatformCatalogSnapshot = {
  workspaces: [{ id: "workspace", name: "个人空间", kind: "personal", description: "", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: "" }],
  projects: [{ id: "catalog-project", workspaceId: "workspace", remoteId: "remote-project", name: "广告", shortId: "remote", homeUrl: "", available: true, isCurrent: true, sortOrder: 0, lastSeenAt: "" }],
  currentWorkspaceId: "workspace", currentProjectId: "catalog-project", customerOptions: [], creationTypeOptions: [], syncedAt: "",
};
function fixture() {
  const page = { url: () => "https://blueaivideo.com/agentlab?projectId=remote-project&sessionId=old-session", goto: vi.fn() };
  // Exercise the real adapter methods with a page/API stub. No account, files,
  // browser profile, credit-consuming endpoint or Electron process is used.
  const adapter: PlaywrightXinyingAdapter = Object.assign(Object.create(PlaywrightXinyingAdapter.prototype), {
    selectors: { baseUrl: "https://blueaivideo.com/", authenticatedUrlPatterns: ["/agentlab"], projects: { homePath: "/home" } },
    page: vi.fn().mockResolvedValue(page),
    retryProjectNavigation: vi.fn(async (_page, operation) => operation()),
    authenticatedGet: vi.fn(), authenticatedRequest: vi.fn(),
  });
  const internal = adapter as unknown as { authenticatedGet: ReturnType<typeof vi.fn>; authenticatedRequest: ReturnType<typeof vi.fn>; retryProjectNavigation: ReturnType<typeof vi.fn> };
  return { adapter, internal, page };
}

describe("project conversation adapter", () => {
  it("reads all pages from the official sidebar API without navigating or clicking conversations", async () => {
    const { adapter, internal, page } = fixture();
    internal.authenticatedGet.mockImplementation(async (_page, path: string) => {
      const query = new URL(path, "https://blueaivideo.com").searchParams;
      const offset = Number(query.get("offset"));
      return { code: 0, data: { total: 41, sessions: Array.from({ length: offset === 0 ? 40 : 1 }, (_, i) => ({ avp_session_id: `session-${offset + i}`, session_title: `对话${offset + i}` })) } };
    });
    const rows = await adapter.listPlatformConversations(catalog, "catalog-project");
    expect(rows).toHaveLength(41);
    expect(internal.authenticatedGet.mock.calls[0][1]).toContain("/api/agentproxy/api/avp_agent/skill/session_list?");
    expect(internal.authenticatedGet.mock.calls[1][1]).toContain("offset=40");
    expect(page.goto).not.toHaveBeenCalled(); expect(internal.authenticatedRequest).not.toHaveBeenCalled();
  });

  it("falls back to the legacy read-only endpoint and reports errors instead of fabricating an empty project", async () => {
    const { adapter, internal, page } = fixture();
    internal.authenticatedGet.mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce({ code: 0, data: { total: 0, sessions: [] } });
    expect(await adapter.listPlatformConversations(catalog, "catalog-project")).toEqual([]);
    expect(internal.authenticatedGet.mock.calls[1][1]).toContain("/api/avp_agent/session/list?");
    internal.authenticatedGet.mockRejectedValue(new Error("登录失效"));
    await expect(adapter.listPlatformConversations(catalog, "catalog-project")).rejects.toThrow(/不会切换或新建对话/);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("rejects a stalled/incomplete paginated list rather than silently hiding older conversations", async () => {
    const { adapter, internal } = fixture();
    internal.authenticatedGet.mockResolvedValue({ code: 0, data: { total: 100, sessions: [{ avp_session_id: "same" }] } });
    await expect(adapter.listPlatformConversations(catalog, "catalog-project")).rejects.toThrow(/分页未返回完整记录/);
    expect(internal.authenticatedGet).toHaveBeenCalledTimes(4);
  });

  it("binds an exact existing session without creating a session or disturbing the official draft", async () => {
    const { adapter, internal, page } = fixture();
    const binding = await adapter.openPlatformProject(catalog, "catalog-project", "chosen-session");
    expect(new URL(binding.generationUrl).searchParams.get("sessionId")).toBe("chosen-session");
    expect(new URL(binding.generationUrl).searchParams.get("tab")).toBe("generation");
    expect(page.goto).not.toHaveBeenCalled(); expect(internal.authenticatedRequest).not.toHaveBeenCalled();
  });

  it("uses the official creation payload, binds the confirmed ID, and does not send a video generation", async () => {
    const { adapter, internal, page } = fixture();
    internal.authenticatedRequest.mockResolvedValue({ code: 0, data: { avp_session_id: "new-confirmed" } });
    const binding = await adapter.openPlatformProject(catalog, "catalog-project");
    expect(internal.authenticatedRequest).toHaveBeenCalledExactlyOnceWith(page, "/api/avp_agent/session/create", { session_type: "creation", project_id: "remote-project" });
    expect(new URL(binding.generationUrl).searchParams.get("sessionId")).toBe("new-confirmed");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous create timeout or accept the old session as new", async () => {
    const { adapter, internal } = fixture();
    internal.authenticatedRequest.mockRejectedValueOnce(new Error("timeout"));
    await expect(adapter.openPlatformProject(catalog, "catalog-project")).rejects.toThrow("timeout");
    expect(internal.authenticatedRequest).toHaveBeenCalledTimes(1);
    internal.authenticatedRequest.mockResolvedValueOnce({ code: 0, data: { avp_session_id: "old-session" } });
    await expect(adapter.openPlatformProject(catalog, "catalog-project")).rejects.toThrow(/不会自动重复创建/);
    expect(internal.authenticatedRequest).toHaveBeenCalledTimes(2);
  });
});
