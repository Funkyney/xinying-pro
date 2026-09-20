import { describe, expect, it } from "vitest";
import { parseDirectorManifest } from "../src/core/director-manifest";

describe("director manifest personCheck", () => {
  it("accepts bounded person-inspection evidence for confidence routing", () => {
    const manifest = parseDirectorManifest({
      version: 1,
      projectId: "project-1",
      prompt: "人物从远处经过",
      materials: [{
        kind: "file",
        path: "ambiguous.mp4",
        personCheck: {
          verdict: "uncertain",
          confidence: 0.74,
          summary: "远景中有一个可能为人物的移动轮廓",
          inspectedFrames: 12,
          inspectionComplete: true,
        },
      }],
    });
    expect(manifest.materials[0]).toMatchObject({
      personCheck: { verdict: "uncertain", inspectedFrames: 12, inspectionComplete: true },
    });
    expect(() => parseDirectorManifest({
      version: 1,
      projectId: "project-1",
      prompt: "非法置信度",
      materials: [{
        kind: "file",
        path: "ambiguous.mp4",
        personCheck: { verdict: "uncertain", confidence: 1.2, summary: "不确定" },
      }],
    })).toThrow();
  });
});
