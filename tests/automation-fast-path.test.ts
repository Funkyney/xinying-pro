import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AutomationFastPathCache,
  pageShellFingerprint,
  selectorGroupKey,
} from "../src/main/automation-fast-path";

describe("automation fast path cache", () => {
  it("keeps the shell stable across projects and invalidates it when frontend assets change", () => {
    const first = pageShellFingerprint({
      url: "https://blueaivideo.com/avpAgent?projectId=one",
      bodyClass: "theme-light app",
      assets: ["/assets/app-123.js", "/assets/app.css"],
      roots: ["div#app.app-shell"],
    });
    const second = pageShellFingerprint({
      url: "https://blueaivideo.com/avpAgent?projectId=two&sessionId=three",
      bodyClass: "app theme-light",
      assets: ["/assets/app.css", "/assets/app-123.js"],
      roots: ["div#app.app-shell"],
    });
    const updated = pageShellFingerprint({
      url: "https://blueaivideo.com/avpAgent?projectId=two",
      bodyClass: "theme-light app",
      assets: ["/assets/app-456.js", "/assets/app.css"],
      roots: ["div#app.app-shell"],
    });

    expect(second).toBe(first);
    expect(updated).not.toBe(first);
  });

  it("persists only selectors from the declared candidate set", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-fast-path-"));
    const filePath = path.join(directory, "automation-fast-paths.json");
    const selectors = [".old", ".current"];
    const shell = "https://blueaivideo.com/avpAgent|shell";
    const cache = new AutomationFastPathCache(filePath);

    cache.remember(shell, "visible", selectors, ".current");
    cache.remember(shell, "visible", selectors, ".not-allowed");

    const reloaded = new AutomationFastPathCache(filePath);
    expect(reloaded.preferred(shell, "visible", selectors)).toBe(".current");
    expect(Object.keys(reloaded.snapshot())).toEqual([selectorGroupKey(shell, "visible", selectors)]);
  });

  it("expires stale entries and caps the cache", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-fast-path-expiry-"));
    const filePath = path.join(directory, "automation-fast-paths.json");
    let now = Date.parse("2026-09-20T00:00:00.000Z");
    const cache = new AutomationFastPathCache(filePath, () => now, 1_000, 2);

    cache.remember("shell-a", "visible", [".a"], ".a");
    now += 10;
    cache.remember("shell-b", "visible", [".b"], ".b");
    now += 10;
    cache.remember("shell-c", "visible", [".c"], ".c");
    expect(Object.keys(cache.snapshot())).toHaveLength(2);

    now += 2_000;
    expect(cache.preferred("shell-c", "visible", [".c"])).toBeNull();
  });
});
