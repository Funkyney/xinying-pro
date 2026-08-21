import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { automationPortCandidates, readAutomationPort, reserveAutomationPort } from "../src/shared/automation-port";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-port-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("automation port recovery", () => {
  it("uses the alternate port for the first post-update launch and alternates afterward", () => {
    const dataDir = temporaryDirectory();
    expect(reserveAutomationPort(dataDir, undefined, true)).toBe(9334);
    expect(readAutomationPort(dataDir)).toBe(9334);
    expect(reserveAutomationPort(dataDir)).toBe(9333);
    expect(reserveAutomationPort(dataDir)).toBe(9334);
  });

  it("lets the CLI discover the active marker with fixed-port fallbacks", () => {
    const dataDir = temporaryDirectory();
    expect(reserveAutomationPort(dataDir, "19444")).toBe(19444);
    expect(readAutomationPort(dataDir)).toBeNull();
    expect(automationPortCandidates(dataDir, "19444")).toEqual([19444]);
    reserveAutomationPort(dataDir, undefined, true);
    expect(automationPortCandidates(dataDir)).toEqual([9334, 9333]);
  });
});
