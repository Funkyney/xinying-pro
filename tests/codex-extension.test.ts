import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexExtensionManager } from "../src/main/codex-extension";

const temporaryRoots: string[] = [];

async function fixture(version = "0.5.12", platform: NodeJS.Platform = "win32") {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinying-codex-extension-"));
  temporaryRoots.push(root);
  const source = path.join(root, "bundled", "xinying-pro-generate");
  const codexHome = path.join(root, "codex-home");
  await fs.promises.mkdir(path.join(source, "agents"), { recursive: true });
  await fs.promises.writeFile(path.join(source, "SKILL.md"), "---\nname: xinying-pro-generate\ndescription: test fixture\n---\n", "utf8");
  await fs.promises.writeFile(path.join(source, "agents", "openai.yaml"), "interface: {}\n", "utf8");
  const manager = new CodexExtensionManager({
    appVersion: version,
    appExecutable: platform === "win32" ? "C:\\Program Files\\心影Pro\\心影Pro.exe" : "/Applications/心影Pro.app/Contents/MacOS/心影Pro",
    cliEntry: platform === "win32" ? "C:\\Program Files\\心影Pro\\resources\\app.asar\\dist-electron\\cli\\index.js" : "/Applications/心影Pro.app/Contents/Resources/app.asar/dist-electron/cli/index.js",
    bundledSkillPath: source,
    codexHome,
    platform,
  });
  return { root, source, codexHome, manager };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("CodexExtensionManager", () => {
  it("installs a managed Skill and a packaged-app Windows launcher", async () => {
    const { manager } = await fixture();
    expect((await manager.status()).state).toBe("not-installed");

    const installed = await manager.install();
    expect(installed.state).toBe("installed");
    expect(installed.installedVersion).toBe("0.5.12");
    expect(installed.backupPath).toBeNull();
    expect(await fs.promises.readFile(path.join(manager.skillPath, "SKILL.md"), "utf8")).toContain("xinying-pro-generate");
    const launcher = await fs.promises.readFile(manager.launcherPath, "utf8");
    expect(launcher).toContain("WindowsPowerShell");
    expect(launcher).toContain('"%~dp0xinying.ps1"');
    expect(launcher).toContain("%*");
    const powerShellLauncher = await fs.promises.readFile(path.join(path.dirname(manager.launcherPath), "xinying.ps1"), "utf8");
    expect(powerShellLauncher.charCodeAt(0)).toBe(0xfeff);
    expect(powerShellLauncher).toContain("'C:\\Program Files\\心影Pro\\心影Pro.exe'");
  });

  it("detects and replaces an older managed version", async () => {
    const initial = await fixture("0.5.12");
    await initial.manager.install();
    const updated = new CodexExtensionManager({ ...initial.manager.runtime, appVersion: "0.5.13" });
    expect((await updated.status()).state).toBe("update-available");
    const result = await updated.install();
    expect(result.state).toBe("installed");
    expect(result.installedVersion).toBe("0.5.13");
    expect(result.backupPath).toBeNull();
  });

  it("preserves an unmanaged same-name Skill before confirmed replacement", async () => {
    const { manager } = await fixture();
    await fs.promises.mkdir(manager.skillPath, { recursive: true });
    await fs.promises.writeFile(path.join(manager.skillPath, "personal-note.txt"), "keep me", "utf8");
    expect((await manager.status()).state).toBe("conflict");
    await expect(manager.install()).rejects.toThrow("请确认备份");

    const result = await manager.install(true);
    expect(result.state).toBe("installed");
    expect(result.backupPath).toMatch(/xinying-pro-generate\.backup-/);
    expect(await fs.promises.readFile(path.join(result.backupPath!, "personal-note.txt"), "utf8")).toBe("keep me");
  });

  it("creates an executable macOS launcher", async () => {
    const { manager } = await fixture("0.5.12", "darwin");
    await manager.install();
    const launcher = await fs.promises.readFile(manager.launcherPath, "utf8");
    const mode = (await fs.promises.stat(manager.launcherPath)).mode & 0o777;
    expect(launcher).toContain("ELECTRON_RUN_AS_NODE=1 exec");
    expect(launcher).toContain('"$@"');
    if (process.platform !== "win32") expect(mode).toBe(0o755);
  });
});
