import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PageControlRecoveryCache } from "../src/main/page-control-recovery";

describe("page control recovery cache", () => {
  it("persists a recovered locator under the page shell and intent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-control-recovery-"));
    const filePath = path.join(directory, "recovery.json");
    const locator = { strategy: "role" as const, role: "button", value: "生成" };
    const cache = new PageControlRecoveryCache(filePath);

    cache.remember("shell-a", "提交生成", "click", locator);

    const reloaded = new PageControlRecoveryCache(filePath);
    expect(reloaded.preferred("shell-a", "提交生成", "click")).toEqual(locator);
    expect(reloaded.preferred("shell-a", "提交授权", "click")).toBeNull();
  });

  it("expires and forgets stale or invalid paths without affecting other intents", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-control-expiry-"));
    const filePath = path.join(directory, "recovery.json");
    let now = Date.parse("2026-09-21T00:00:00.000Z");
    const cache = new PageControlRecoveryCache(filePath, () => now, 1_000, 10);

    cache.remember("shell-a", "打开模型", "click", { strategy: "selector", value: "#model" });
    cache.remember("shell-a", "提交生成", "click", { strategy: "selector", value: "#submit" });
    cache.forget("shell-a", "打开模型", "click");
    expect(cache.preferred("shell-a", "打开模型", "click")).toBeNull();
    expect(cache.preferred("shell-a", "提交生成", "click")).toEqual({ strategy: "selector", value: "#submit" });

    now += 2_000;
    expect(cache.preferred("shell-a", "提交生成", "click")).toBeNull();
  });
});
