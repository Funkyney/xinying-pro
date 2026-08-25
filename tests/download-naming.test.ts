import { describe, expect, it } from "vitest";
import { downloadTimestamp, projectDownloadName, safeDownloadBaseName } from "../src/shared/download-naming";

describe("download naming", () => {
  it("keeps the project name while removing characters illegal on Windows", () => {
    expect(safeDownloadBaseName('汽车广告: A/B * 终版. ')).toBe("汽车广告- A-B - 终版");
    expect(safeDownloadBaseName("CON")).toBe("心影作品");
  });

  it("uses a stable Shanghai timestamp", () => {
    expect(downloadTimestamp("2026-08-25T18:03:04.000Z")).toBe("20260826-020304");
  });

  it("builds single and batch names from the project name", () => {
    expect(projectDownloadName("新品宣传片", ".MP4", { createdAt: "2026-08-25T18:03:04.000Z" }))
      .toBe("新品宣传片-20260826-020304.mp4");
    expect(projectDownloadName("新品宣传片", "jpg", { createdAt: "2026-08-25T18:03:04.000Z", index: 2 }))
      .toBe("新品宣传片-20260826-020304-002.jpg");
  });
});
