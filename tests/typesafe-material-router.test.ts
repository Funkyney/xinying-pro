import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppPaths } from "../src/core/paths";
import { XinyingDatabase } from "../src/core/database";
import { XinyingService } from "../src/core/service";
import {
  resolveDirectorMaterialRouting,
  type MaterialRoutingAdvisor,
} from "../src/core/typesafe-material-router";
import type { DirectorManifest } from "../src/shared/contracts";

describe("TypeSafe material routing", () => {
  let tempDir: string;
  let database: XinyingDatabase;
  let service: XinyingService;
  let projectId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-material-routing-"));
    const paths = createAppPaths(tempDir);
    database = new XinyingDatabase(paths.databasePath);
    service = new XinyingService(database, paths);
    projectId = service.createProject({
      name: "素材路由",
      platformWorkspaceId: "workspace-team",
      platformProjectId: "platform-project",
      platformUrl: "https://blueaivideo.com/avpAgent?projectId=platform-project&sessionId=test-session",
    }).id;
  });

  afterEach(() => {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fixture(name: string, content = name): string {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function manifest(materials: DirectorManifest["materials"]): DirectorManifest {
    return {
      version: 1,
      projectId,
      prompt: "测试素材自动路由",
      count: 1,
      replaceMaterials: true,
      materials,
    };
  }

  it("reuses the persistent SHA-256 cache without calling JEV", async () => {
    const personPath = fixture("known-person.png");
    service.prepareDirectorRun(manifest([{
      kind: "file",
      path: personPath,
      containsPerson: true,
      authorizeAsPortrait: true,
    }]));
    const advisor: MaterialRoutingAdvisor = { assess: vi.fn(async () => []) };

    const result = await resolveDirectorMaterialRouting(service, manifest([{
      kind: "file",
      path: personPath,
    }]), advisor);

    expect(advisor.assess).not.toHaveBeenCalled();
    expect(result.manifest.materials[0]).toMatchObject({ containsPerson: true, authorizeAsPortrait: true });
    expect(result.summary).toMatchObject({ cacheHits: 1, typesafe: 0, unresolved: 0 });
  });

  it("batches ambiguous evidence and applies asymmetric safety thresholds", async () => {
    const possiblePerson = fixture("possible-person.png");
    const likelyEmpty = fixture("likely-empty.mp4");
    const uncertainEmpty = fixture("uncertain-empty.png");
    const advisor: MaterialRoutingAdvisor = {
      assess: vi.fn(async (inputs) => inputs.map((input) => ({
        index: input.index,
        choice: input.index === 0 ? "portrait_authorization" : "ordinary_upload",
        confidence: input.index === 0 ? 0.8 : 0.97,
        source: "typesafe",
      }))),
    };

    const result = await resolveDirectorMaterialRouting(service, manifest([
      {
        kind: "file",
        path: possiblePerson,
        personCheck: {
          verdict: "uncertain",
          confidence: 0.65,
          summary: "画面边缘有一个疑似人形轮廓",
          inspectionComplete: true,
        },
      },
      {
        kind: "file",
        path: likelyEmpty,
        personCheck: {
          verdict: "no-person",
          confidence: 0.9,
          summary: "覆盖全片的关键帧只包含空房间和家具",
          inspectedFrames: 18,
          inspectionComplete: true,
        },
      },
      {
        kind: "file",
        path: uncertainEmpty,
        personCheck: {
          verdict: "uncertain",
          confidence: 0.9,
          summary: "主体被遮挡，无法排除人物",
          inspectionComplete: true,
        },
      },
    ]), advisor);

    expect(advisor.assess).toHaveBeenCalledOnce();
    expect(vi.mocked(advisor.assess).mock.calls[0][0]).toHaveLength(3);
    expect(result.manifest.materials[0]).toMatchObject({ containsPerson: true, authorizeAsPortrait: true });
    expect(result.manifest.materials[1]).toMatchObject({ containsPerson: false });
    expect(result.manifest.materials[2]).not.toHaveProperty("containsPerson");
    expect(result.summary).toMatchObject({ typesafe: 2, unresolved: 1 });
  });

  it("routes clear positive evidence locally and never sends it to JEV", async () => {
    const personPath = fixture("clear-person.png");
    const advisor: MaterialRoutingAdvisor = { assess: vi.fn(async () => []) };

    const result = await resolveDirectorMaterialRouting(service, manifest([{
      kind: "file",
      path: personPath,
      personCheck: {
        verdict: "person",
        confidence: 0.51,
        summary: "画面中可见人物",
        inspectionComplete: true,
      },
    }]), advisor);

    expect(advisor.assess).not.toHaveBeenCalled();
    expect(result.manifest.materials[0]).toMatchObject({ containsPerson: true, authorizeAsPortrait: true });
    expect(result.summary).toMatchObject({ deterministic: 1, unresolved: 0 });
  });
});
