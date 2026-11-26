import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localVideoResponse } from "../src/main/local-video-response";

describe("seekable local video response", () => {
  let directory: string, file: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-ranges-test-")); file = path.join(directory, "clip.mp4"); fs.writeFileSync(file, "0123456789"); });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const request = (range?: string, method = "GET") => new Request("https://local.invalid/clip", { method, headers: range ? { Range: range } : {} });
  it("serves the full file, HEAD and empty files", async () => {
    const full = await localVideoResponse(file, "video/mp4", request());
    expect(full.status).toBe(200); expect(full.headers.get("accept-ranges")).toBe("bytes"); expect(await full.text()).toBe("0123456789");
    const head = await localVideoResponse(file, "video/mp4", request(undefined, "HEAD"));
    expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe("");
    fs.writeFileSync(file, "");
    const empty = await localVideoResponse(file, "video/mp4", request());
    expect(empty.headers.get("content-length")).toBe("0"); expect(await empty.text()).toBe("");
  });
  it.each([["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=8-99", "89", "bytes 8-9/10"]])("serves %s", async (range, text, contentRange) => {
    const response = await localVideoResponse(file, "video/mp4", request(range));
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(contentRange); expect(await response.text()).toBe(text);
  });
  it.each(["bytes=10-", "bytes=6-2", "bytes=-0", "bytes=", "bytes=1-2,4-5", "bytes=999999999999999999999-", "other=1-2"])("rejects invalid range %s", async range => {
    const response = await localVideoResponse(file, "video/mp4", request(range));
    expect(response.status).toBe(416); expect(response.headers.get("content-range")).toBe("bytes */10");
  });
});
