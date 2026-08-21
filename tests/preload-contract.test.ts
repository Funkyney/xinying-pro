import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../src/shared/ipc";

describe("sandboxed preload contract", () => {
  it("keeps every main-process IPC channel in the self-contained preload table", () => {
    const preloadSource = fs.readFileSync(path.resolve("src/main/preload.ts"), "utf8");
    expect(preloadSource).not.toMatch(/from\s+["']\.\.\/shared\/ipc["']/);
    for (const channel of Object.values(IPC)) {
      expect(preloadSource).toContain(`"${channel}"`);
    }
  });

  it("does not contain duplicate channel values", () => {
    const values = Object.values(IPC);
    expect(new Set(values).size).toBe(values.length);
  });
});
