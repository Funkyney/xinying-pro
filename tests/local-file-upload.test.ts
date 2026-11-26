import fs from "node:fs/promises";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocalInputFiles } from "../src/main/local-file-upload";

function fixture(failAt?: string) {
  const send = vi.fn(async (method: string, _params?: unknown) => {
    if (method === failAt) throw new Error("fixture protocol disconnect");
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 2 };
    return {};
  });
  const detach = vi.fn(async () => {});
  const native = vi.fn(async () => {});
  const evaluate = vi.fn(async () => {});
  return { page: { context: () => ({ newCDPSession: async () => ({ send, detach }) }) } as unknown as Page,
    input: { evaluate, setInputFiles: native } as unknown as Locator, send, detach, native, evaluate };
}

afterEach(() => vi.restoreAllMocks());
describe("local file handoff", () => {
  it("passes ordered local paths without buffering or changing originals", async () => {
    vi.spyOn(fs, "stat").mockResolvedValue({ size: 90 * 1024 * 1024, isFile: () => true } as never);
    const f = fixture();
    await setLocalInputFiles(f.page, f.input, ["b.png", "a.png"]);
    const command = f.send.mock.calls.find(([method]) => method === "DOM.setFileInputFiles");
    expect(command?.[1]).toMatchObject({ nodeId: 2, files: [expect.stringMatching(/b\.png$/), expect.stringMatching(/a\.png$/)] });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.evaluate).toHaveBeenCalledTimes(2);
  });

  it("only falls back to payload transfer for a small batch before any selection", async () => {
    vi.spyOn(fs, "stat").mockResolvedValue({ size: 1024, isFile: () => true } as never);
    const f = fixture("DOM.querySelector");
    await setLocalInputFiles(f.page, f.input, "a.png");
    expect(f.native).toHaveBeenCalledOnce();
  });

  it("never transfers a batch at or over 50 MiB through the fallback", async () => {
    vi.spyOn(fs, "stat").mockResolvedValue({ size: 25 * 1024 * 1024, isFile: () => true } as never);
    const f = fixture("DOM.querySelector");
    await expect(setLocalInputFiles(f.page, f.input, ["a.png", "b.png"])).rejects.toMatchObject({ code: "LOCAL_FILE_HANDOFF_UNAVAILABLE" });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it("does not replay an ambiguous selection after a lost protocol response", async () => {
    vi.spyOn(fs, "stat").mockResolvedValue({ size: 1024, isFile: () => true } as never);
    const f = fixture("DOM.setFileInputFiles");
    await expect(setLocalInputFiles(f.page, f.input, "a.png")).rejects.toMatchObject({ code: "LOCAL_FILE_HANDOFF_FAILED" });
    expect(f.native).not.toHaveBeenCalled();
  });

  it("checks existence before mutating the input", async () => {
    vi.spyOn(fs, "stat").mockRejectedValue(new Error("ENOENT"));
    const f = fixture();
    await expect(setLocalInputFiles(f.page, f.input, "missing.png")).rejects.toMatchObject({ code: "REFERENCE_FILE_MISSING" });
    expect(f.send).not.toHaveBeenCalled();
  });
});
