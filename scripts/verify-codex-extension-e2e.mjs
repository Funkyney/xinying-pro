import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { CodexExtensionManager } = require("../dist-electron/main/codex-extension.js");
const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xinying-codex-extension-e2e-"));

try {
  const unpacked = path.resolve("release", process.platform === "win32" ? "win-unpacked" : "mac-universal", process.platform === "win32" ? "" : "心影Pro.app", "Contents");
  const appExecutable = process.platform === "win32"
    ? path.resolve("release", "win-unpacked", "心影Pro.exe")
    : path.join(unpacked, "MacOS", "心影Pro");
  const resourcesPath = process.platform === "win32"
    ? path.resolve("release", "win-unpacked", "resources")
    : path.join(unpacked, "Resources");
  const cliEntry = path.join(resourcesPath, "app.asar", "dist-electron", "cli", "index.js");
  const manager = new CodexExtensionManager({
    appVersion: "e2e",
    appExecutable,
    cliEntry,
    bundledSkillPath: path.join(resourcesPath, "codex-skills", "xinying-pro-generate"),
    codexHome: root,
    platform: process.platform,
  });

  const installed = await manager.install();
  if (!fs.existsSync(appExecutable) || !fs.existsSync(path.join(resourcesPath, "app.asar"))) {
    throw new Error(`安装版执行器路径不存在：${JSON.stringify({ appExecutable, resourcesPath })}`);
  }
  let execution;
  if (process.platform === "win32") {
    const captureScript = path.join(root, "capture-launcher-output.ps1");
    const launcherPath = manager.launcherPath.replace(/'/g, "''");
    await fs.promises.writeFile(captureScript, [
      `\uFEFF$output = & '${launcherPath}' doctor`,
      'if (-not $output) { throw "Xinying Pro CLI launcher returned before producing JSON" }',
      "$output",
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"), "utf8");
    const powerShell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execution = await execFileAsync(powerShell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", captureScript], { windowsHide: true });
  } else {
    execution = await execFileAsync(manager.launcherPath, ["doctor"]);
  }
  const envelope = JSON.parse(execution.stdout);
  if (!envelope.ok || envelope.command !== "xinying doctor") throw new Error(`启动器返回异常：${execution.stdout}`);
  process.stdout.write(`${JSON.stringify({ ok: true, installed, command: envelope.command }, null, 2)}\n`);
} finally {
  await fs.promises.rm(root, { recursive: true, force: true });
}
