import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDirectorManifest, parseDirectorManifest } from "../src/core/director-manifest";

describe("director manifest", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    tempDirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  });

  it("resolves relative material paths from the manifest directory and applies safe defaults", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-director-manifest-"));
    tempDirs.push(directory);
    const manifestPath = path.join(directory, "shot.json");
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      projectId: "project-1",
      prompt: "@图1 缓慢转身",
      materials: [{ kind: "file", path: "assets/face.png", containsPerson: true, authorizeAsPortrait: true }],
    }));

    const manifest = loadDirectorManifest(manifestPath);
    expect(manifest.count).toBe(1);
    expect(manifest.replaceMaterials).toBe(true);
    expect(manifest.materials[0]).toMatchObject({
      path: path.join(directory, "assets", "face.png"),
      containsPerson: true,
      authorizeAsPortrait: true,
    });
  });

  it("rejects excessive batch counts and unknown fields", () => {
    expect(() => parseDirectorManifest({
      version: 1,
      projectId: "project-1",
      prompt: "测试",
      count: 21,
      materials: [],
    })).toThrow(/格式无效/);
    expect(() => parseDirectorManifest({
      version: 1,
      projectId: "project-1",
      prompt: "测试",
      materials: [],
      unsafe: true,
    })).toThrow(/格式无效/);
  });

  it("accepts up to 50 Seedance 2.5 materials at the schema boundary", () => {
    const materials = Array.from({ length: 50 }, (_, index) => ({ kind: "file" as const, path: `asset-${index}.png` }));
    expect(parseDirectorManifest({
      version: 1,
      projectId: "project-1",
      prompt: "五十项参考",
      materials,
    }).materials).toHaveLength(50);
    expect(() => parseDirectorManifest({
      version: 1,
      projectId: "project-1",
      prompt: "五十一项参考",
      materials: [...materials, { kind: "file", path: "overflow.png" }],
    })).toThrow(/格式无效/);
  });
});
