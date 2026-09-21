import { describe, expect, it } from "vitest";
import {
  buildWindowsUpdateRelaunchScript,
  macCodeSignatureSupportsAutomaticUpdates,
} from "../src/main/app-updater";

describe("Windows update relaunch guardian", () => {
  it("waits for the old process and target version before reopening the app", () => {
    const script = buildWindowsUpdateRelaunchScript("C:\\Users\\Liam O'Brien\\心影Pro.exe", "0.5.30", 4321);

    expect(script).toContain("$previousPid = 4321");
    expect(script).toContain("Wait-Process -Id $previousPid -Timeout 60");
    expect(script).toContain("$targetVersion = '0.5.30'");
    expect(script).toContain("C:\\Users\\Liam O''Brien\\心影Pro.exe");
    expect(script).toContain('$installedVersion.StartsWith("$targetVersion.")');
    expect(script).toContain("Start-Process -FilePath $executable -ArgumentList '--updated'");
  });

  it("accepts the four-part Windows product version emitted by electron-builder", () => {
    const script = buildWindowsUpdateRelaunchScript("C:\\心影Pro.exe", "0.5.65", 100);

    expect(script).toContain('$installedVersion -eq $targetVersion -or $installedVersion.StartsWith("$targetVersion.")');
  });
});

describe("macOS update signing", () => {
  it("allows a valid certificate-backed signature", () => {
    expect(macCodeSignatureSupportsAutomaticUpdates(0, [
      "Executable=/Applications/心影Pro.app/Contents/MacOS/心影Pro",
      "Authority=Developer ID Application: Example Company (TEAMID1234)",
      "TeamIdentifier=TEAMID1234",
    ].join("\n"))).toBe(true);
  });

  it("rejects unsigned and ad-hoc signed packages", () => {
    expect(macCodeSignatureSupportsAutomaticUpdates(1, "code object is not signed at all")).toBe(false);
    expect(macCodeSignatureSupportsAutomaticUpdates(0, "Signature=adhoc\nTeamIdentifier=not set")).toBe(false);
    expect(macCodeSignatureSupportsAutomaticUpdates(0, "Identifier=com.liambao.xinyingdirector")).toBe(false);
  });
});
