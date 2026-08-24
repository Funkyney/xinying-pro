import { describe, expect, it } from "vitest";
import { buildWindowsUpdateRelaunchScript } from "../src/main/app-updater";

describe("Windows update relaunch guardian", () => {
  it("waits for the old process and target version before reopening the app", () => {
    const script = buildWindowsUpdateRelaunchScript("C:\\Users\\Liam O'Brien\\心影Pro.exe", "0.5.30", 4321);

    expect(script).toContain("$previousPid = 4321");
    expect(script).toContain("Wait-Process -Id $previousPid -Timeout 60");
    expect(script).toContain("$targetVersion = '0.5.30'");
    expect(script).toContain("C:\\Users\\Liam O''Brien\\心影Pro.exe");
    expect(script).toContain("Start-Process -FilePath $executable -ArgumentList '--updated'");
  });
});
