import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexExtensionInstallResult, CodexExtensionStatus } from "../shared/contracts";

const SKILL_NAME = "xinying-pro-generate";
const MARKER_NAME = ".xinying-pro-managed.json";

interface ManagedMarker {
  managedBy: "xinying-pro";
  skillName: typeof SKILL_NAME;
  extensionVersion: string;
  installedAt: string;
  appExecutable: string;
  cliEntry: string;
  launcherPath: string;
}

export interface CodexExtensionRuntime {
  appVersion: string;
  appExecutable: string;
  cliEntry: string;
  bundledSkillPath: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireInside(parent: string, candidate: string): void {
  if (!isInside(parent, candidate)) throw new Error(`拒绝访问 Codex Skill 目录之外的路径：${candidate}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readMarker(target: string): Promise<ManagedMarker | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(target, MARKER_NAME), "utf8")) as Partial<ManagedMarker>;
    if (parsed.managedBy !== "xinying-pro" || parsed.skillName !== SKILL_NAME || typeof parsed.extensionVersion !== "string") return null;
    return parsed as ManagedMarker;
  } catch {
    return null;
  }
}

async function copySafeTree(source: string, destination: string, rootDestination: string): Promise<void> {
  requireInside(rootDestination, destination);
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Codex 扩展包不允许包含符号链接：${source}`);
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destination, { recursive: true });
    for (const entry of await fs.promises.readdir(source)) {
      await copySafeTree(path.join(source, entry), path.join(destination, entry), rootDestination);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Codex 扩展包包含不支持的文件类型：${source}`);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export class CodexExtensionManager {
  readonly runtime: Required<Omit<CodexExtensionRuntime, "codexHome" | "platform">> & { codexHome: string; platform: NodeJS.Platform };

  constructor(runtime: CodexExtensionRuntime) {
    this.runtime = {
      ...runtime,
      codexHome: path.resolve(runtime.codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex")),
      platform: runtime.platform ?? process.platform,
    };
  }

  get skillsRoot(): string {
    return path.join(this.runtime.codexHome, "skills");
  }

  get skillPath(): string {
    return path.join(this.skillsRoot, SKILL_NAME);
  }

  get backupsRoot(): string {
    return path.join(this.runtime.codexHome, "skill-backups");
  }

  get launcherName(): string {
    return this.runtime.platform === "win32" ? "xinying.cmd" : "xinying";
  }

  get launcherPath(): string {
    return path.join(this.skillPath, "scripts", this.launcherName);
  }

  async status(): Promise<CodexExtensionStatus> {
    const sourceAvailable = await pathExists(path.join(this.runtime.bundledSkillPath, "SKILL.md"));
    const targetExists = await pathExists(this.skillPath);
    const marker = targetExists ? await readMarker(this.skillPath) : null;
    const conflict = targetExists && !marker;
    const installed = Boolean(marker);
    const needsUpdate = Boolean(marker && marker.extensionVersion !== this.runtime.appVersion);
    const state: CodexExtensionStatus["state"] = !sourceAvailable
      ? "source-missing"
      : conflict
        ? "conflict"
        : !installed
          ? "not-installed"
          : needsUpdate
            ? "update-available"
            : "installed";
    const message = state === "source-missing" ? "安装包中缺少 Codex 扩展资源"
      : state === "conflict" ? "检测到同名的非心影Pro托管 Skill；安装前会先备份"
        : state === "not-installed" ? "尚未安装到本机 Codex"
          : state === "update-available" ? `Codex 扩展可更新至 ${this.runtime.appVersion}`
            : `Codex 扩展 ${this.runtime.appVersion} 已就绪`;

    return {
      state,
      available: sourceAvailable,
      installed,
      needsUpdate,
      conflict,
      currentVersion: this.runtime.appVersion,
      installedVersion: marker?.extensionVersion ?? null,
      codexHome: this.runtime.codexHome,
      skillPath: this.skillPath,
      launcherPath: installed ? this.launcherPath : null,
      message,
    };
  }

  async install(replaceExisting = false): Promise<CodexExtensionInstallResult> {
    const before = await this.status();
    if (!before.available) throw new Error(before.message);
    if (before.conflict && !replaceExisting) {
      throw new Error("检测到同名的现有 Skill。请确认备份现有 Skill 后再安装。");
    }

    await fs.promises.mkdir(this.skillsRoot, { recursive: true });
    await this.migrateLegacyBackups();
    requireInside(this.skillsRoot, this.skillPath);
    const nonce = randomUUID();
    const staging = path.join(this.skillsRoot, `.${SKILL_NAME}.install-${nonce}`);
    const previous = path.join(this.skillsRoot, `.${SKILL_NAME}.previous-${nonce}`);
    requireInside(this.skillsRoot, staging);
    requireInside(this.skillsRoot, previous);
    let displacedPath: string | null = null;
    let backupPath: string | null = null;

    try {
      await fs.promises.mkdir(staging, { recursive: false });
      await copySafeTree(this.runtime.bundledSkillPath, path.join(staging, "bundle"), staging);

      const bundleRoot = path.join(staging, "bundle");
      for (const entry of await fs.promises.readdir(bundleRoot)) {
        await fs.promises.rename(path.join(bundleRoot, entry), path.join(staging, entry));
      }
      await fs.promises.rmdir(bundleRoot);

      const scriptsDir = path.join(staging, "scripts");
      await fs.promises.mkdir(scriptsDir, { recursive: true });
      const stagedLauncher = path.join(scriptsDir, this.launcherName);
      const launcher = this.runtime.platform === "win32"
        ? `@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0xinying.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(this.runtime.appExecutable)} ${quoteShell(this.runtime.cliEntry)} "$@"\n`;
      await fs.promises.writeFile(stagedLauncher, launcher, "utf8");
      if (this.runtime.platform === "win32") {
        const powerShellLauncher = `\uFEFF$ErrorActionPreference = "Stop"\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n\r\nfunction ConvertTo-WindowsCommandLineArgument {\r\n  param([AllowEmptyString()][string]$Value)\r\n  if ($Value.Length -gt 0 -and $Value -notmatch '[\\s"]') { return $Value }\r\n  $builder = New-Object System.Text.StringBuilder\r\n  [void]$builder.Append([char]34)\r\n  $slashes = 0\r\n  foreach ($character in $Value.ToCharArray()) {\r\n    if ($character -eq [char]92) { $slashes += 1; continue }\r\n    if ($character -eq [char]34) {\r\n      [void]$builder.Append([char]92, ($slashes * 2) + 1)\r\n      [void]$builder.Append([char]34)\r\n      $slashes = 0\r\n      continue\r\n    }\r\n    if ($slashes -gt 0) { [void]$builder.Append([char]92, $slashes); $slashes = 0 }\r\n    [void]$builder.Append($character)\r\n  }\r\n  if ($slashes -gt 0) { [void]$builder.Append([char]92, $slashes * 2) }\r\n  [void]$builder.Append([char]34)\r\n  return $builder.ToString()\r\n}\r\n\r\n$arguments = @(${quotePowerShell(this.runtime.cliEntry)}) + @($args)\r\n$startInfo = New-Object System.Diagnostics.ProcessStartInfo\r\n$startInfo.FileName = ${quotePowerShell(this.runtime.appExecutable)}\r\n$startInfo.Arguments = (($arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join ' ')\r\n$startInfo.UseShellExecute = $false\r\n$startInfo.CreateNoWindow = $true\r\n$startInfo.RedirectStandardOutput = $true\r\n$startInfo.RedirectStandardError = $true\r\n$startInfo.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'\r\n$startInfo.EnvironmentVariables['XINYING_CLI_ASCII_JSON'] = '1'\r\n$process = New-Object System.Diagnostics.Process\r\n$process.StartInfo = $startInfo\r\n[void]$process.Start()\r\n$stdoutTask = $process.StandardOutput.ReadToEndAsync()\r\n$stderrTask = $process.StandardError.ReadToEndAsync()\r\n$process.WaitForExit()\r\n$stdout = $stdoutTask.Result\r\n$stderr = $stderrTask.Result\r\nif ($stdout) { [Console]::Out.Write($stdout) }\r\nif ($stderr) { [Console]::Error.Write($stderr) }\r\nexit $process.ExitCode\r\n`;
        await fs.promises.writeFile(path.join(scriptsDir, "xinying.ps1"), powerShellLauncher, "utf8");
      } else {
        await fs.promises.chmod(stagedLauncher, 0o755);
      }

      const marker: ManagedMarker = {
        managedBy: "xinying-pro",
        skillName: SKILL_NAME,
        extensionVersion: this.runtime.appVersion,
        installedAt: new Date().toISOString(),
        appExecutable: this.runtime.appExecutable,
        cliEntry: this.runtime.cliEntry,
        launcherPath: this.launcherPath,
      };
      await fs.promises.writeFile(path.join(staging, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, "utf8");

      if (await pathExists(this.skillPath)) {
        const managed = await readMarker(this.skillPath);
        if (managed) {
          displacedPath = previous;
        } else {
          await fs.promises.mkdir(this.backupsRoot, { recursive: true });
          const base = path.join(this.backupsRoot, `${SKILL_NAME}.backup-${backupTimestamp(new Date())}`);
          backupPath = base;
          let suffix = 1;
          while (await pathExists(backupPath)) backupPath = `${base}-${suffix++}`;
          displacedPath = backupPath;
        }
        if (displacedPath === previous) requireInside(this.skillsRoot, displacedPath);
        else requireInside(this.backupsRoot, displacedPath);
        await fs.promises.rename(this.skillPath, displacedPath);
      }

      await fs.promises.rename(staging, this.skillPath);
      if (displacedPath === previous) await fs.promises.rm(previous, { recursive: true, force: true }).catch(() => undefined);
      return { ...(await this.status()), backupPath };
    } catch (error) {
      if (!(await pathExists(this.skillPath)) && displacedPath && await pathExists(displacedPath)) {
        await fs.promises.rename(displacedPath, this.skillPath).catch(() => undefined);
      }
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async migrateLegacyBackups(): Promise<void> {
    if (!(await pathExists(this.skillsRoot))) return;
    const entries = await fs.promises.readdir(this.skillsRoot, { withFileTypes: true });
    const legacy = entries.filter((entry) => entry.name.startsWith(`${SKILL_NAME}.backup-`));
    if (!legacy.length) return;
    await fs.promises.mkdir(this.backupsRoot, { recursive: true });
    for (const entry of legacy) {
      const source = path.join(this.skillsRoot, entry.name);
      requireInside(this.skillsRoot, source);
      const base = path.join(this.backupsRoot, entry.name);
      let destination = base;
      let suffix = 1;
      while (await pathExists(destination)) destination = `${base}-${suffix++}`;
      requireInside(this.backupsRoot, destination);
      await fs.promises.rename(source, destination);
    }
  }
}
