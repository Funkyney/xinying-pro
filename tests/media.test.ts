import { describe, expect, it } from "vitest";
import { assignMediaLabels, findAddedMediaLabel, portraitMediaKindFromPreviewUrl } from "../src/shared/media";

describe("media helpers", () => {
  it("recognizes Heart video portrait snapshot URLs", () => {
    expect(portraitMediaKindFromPreviewUrl("https://cdn.example/portrait.mp4?x-tos-process=video/snapshot,t_0,f_jpg")).toBe("video");
    expect(portraitMediaKindFromPreviewUrl("https://cdn.example/portrait.jpg")).toBe("unknown");
  });

  it("numbers each media type independently", () => {
    expect(assignMediaLabels(["image", "video", "audio", "video", "image"]))
      .toEqual(["@图1", "@视频1", "@音频1", "@视频2", "@图2"]);
  });

  it("finds the newly assigned label even when Heart regroups media types", () => {
    expect(findAddedMediaLabel(["视频1"], ["图1", "视频1"])).toBe("图1");
    expect(findAddedMediaLabel(["图1", "视频1"], ["图1", "视频1", "视频2"])).toBe("视频2");
  });
});
