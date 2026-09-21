import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, autoUpdater as nativeAutoUpdater, type BrowserWindow, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdateState } from "../shared/contracts";
import { IPC } from "../shared/ipc";

let registered = false;
let state: AppUpdateState = {
  status: "idle",
  currentVersion: "0.0.0",
  installMode: "automatic",
};

const RELEASES_URL = "https://github.com/Funkyney/xinying-pro/releases/latest";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsUpdateRelaunchScript(executablePath: string, targetVersion: string, previousPid: number): string {
  const executable = powershellLiteral(executablePath);
  const version = powershellLiteral(targetVersion);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$previousPid = ${previousPid}`,
    `$executable = ${executable}`,
    `$targetVersion = ${version}`,
    "Wait-Process -Id $previousPid -Timeout 60",
    "$deadline = (Get-Date).AddMinutes(3)",
    "while ((Get-Date) -lt $deadline) {",
    "  if (Test-Path -LiteralPath $executable) {",
    "    $installedVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion",
    "    if ($installedVersion -eq $targetVersion -or $installedVersion.StartsWith(\"$targetVersion.\")) { break }",
    "  }",
    "  Start-Sleep -Milliseconds 750",
    "}",
    "Start-Sleep -Seconds 2",
    "if (Test-Path -LiteralPath $executable) {",
    "  Start-Process -FilePath $executable -ArgumentList '--updated'",
    "}",
  ].join("\n");
}

export function macCodeSignatureSupportsAutomaticUpdates(exitCode: number | null, output: string): boolean {
  if (exitCode !== 0 || /Signature=adhoc/i.test(output)) return false;
  return /^Authority=.+$/m.test(output);
}

function macAppBundlePath(executablePath: string): string | null {
  const match = executablePath.match(/^(.+?\.app)(?:\/|$)/i);
  return match?.[1] ?? null;
}

function supportsAutomaticMacUpdates(): boolean {
  if (process.platform !== "darwin" || !app.isPackaged) return true;
  const bundlePath = macAppBundlePath(process.execPath);
  if (!bundlePath) return false;
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", bundlePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  return macCodeSignatureSupportsAutomaticUpdates(result.status, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function configureUpdaterLog(): void {
  try {
    const directory = path.join(app.getPath("userData"), "logs");
    const filePath = path.join(directory, "updater.log");
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1_000_000) {
      const previous = path.join(directory, "updater.previous.log");
      fs.rmSync(previous, { force: true });
      fs.renameSync(filePath, previous);
    }
    const write = (level: string, values: unknown[]) => {
      const message = values.map((value) => value instanceof Error ? value.stack ?? value.message : String(value)).join(" ");
      fs.appendFileSync(filePath, `${new Date().toISOString()} [${level}] ${message}\n`, "utf8");
    };
    autoUpdater.logger = {
      info: (...values: unknown[]) => write("info", values),
      warn: (...values: unknown[]) => write("warn", values),
      error: (...values: unknown[]) => write("error", values),
      debug: (...values: unknown[]) => write("debug", values),
    };
  } catch {
    // Update logging must never prevent the application from starting.
  }
}

function startWindowsRelaunchGuardian(targetVersion: string): void {
  if (process.platform !== "win32") return;
  const script = buildWindowsUpdateRelaunchScript(process.execPath, targetVersion, process.pid);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const guardian = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  guardian.unref();
}

export function registerAppUpdater(getWindow: () => BrowserWindow | null): void {
  if (registered) return;
  registered = true;
  configureUpdaterLog();
  const automaticMacUpdates = supportsAutomaticMacUpdates();
  const manualMacUpdate = app.isPackaged && process.platform === "darwin" && !automaticMacUpdates;
  state = {
    status: app.isPackaged ? "idle" : "unsupported",
    currentVersion: app.getVersion(),
    installMode: manualMacUpdate ? "manual" : "automatic",
    releaseUrl: RELEASES_URL,
    message: app.isPackaged
      ? manualMacUpdate
        ? "当前 macOS 安装包没有 Apple 代码签名；可检查版本并打开官方安装包页面"
        : "点击检查 GitHub Releases 中的新版本"
      : "开发模式不执行自动更新",
  };

  const publish = (patch: Partial<AppUpdateState>) => {
    state = { ...state, ...patch, currentVersion: app.getVersion() };
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.updateStateChanged, state);
    return state;
  };

  let forcedExitTimer: NodeJS.Timeout | null = null;
  let installAfterDownload = false;
  let installTriggered = false;
  const installDownloadedUpdate = (): AppUpdateState => {
    if (state.status !== "downloaded" || installTriggered) return state;
    if (manualMacUpdate) {
      void shell.openExternal(RELEASES_URL);
      return publish({ status: "available", message: "已打开 macOS 安装包页面；配置 Apple 代码签名后即可恢复一键自动安装" });
    }
    installTriggered = true;
    installAfterDownload = false;
    const targetVersion = state.availableVersion ?? app.getVersion();
    const next = publish({ status: "installing", message: "正在关闭旧版、安装更新并重新打开…" });
    // electron-updater normally relaunches after a silent NSIS install. Keep a
    // detached Windows guardian as a second path because the embedded Heart
    // page or the single-instance hand-off can make that relaunch disappear.
    startWindowsRelaunchGuardian(targetVersion);
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 150);
    return next;
  };
  nativeAutoUpdater.on("before-quit-for-update", () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.hide();
    if (forcedExitTimer) clearTimeout(forcedExitTimer);
    // A loaded Heart page can keep an embedded webContents alive during a
    // normal app.quit(). The installer is already detached at this point, so
    // force the old process down if it has not exited by itself.
    forcedExitTimer = setTimeout(() => app.exit(0), 5_000);
    forcedExitTimer.unref();
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = !manualMacUpdate;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => publish({ status: "checking", message: "正在检查 GitHub Releases…" }));
  autoUpdater.on("update-available", (info) => {
    installTriggered = false;
    publish({
      status: "available",
      availableVersion: info.version,
      progress: 0,
      message: manualMacUpdate
        ? `发现心影Pro ${info.version}；当前 macOS 包未签名，请打开下载页安装`
        : `发现心影Pro ${info.version}`,
    });
  });
  autoUpdater.on("update-not-available", () => publish({ status: "not-available", availableVersion: undefined, progress: undefined, message: "当前已经是最新版本" }));
  autoUpdater.on("download-progress", (progress) => publish({ status: "downloading", progress: Math.max(0, Math.min(100, progress.percent)), message: `正在下载 ${Math.round(progress.percent)}%` }));
  autoUpdater.on("update-downloaded", (info) => {
    publish({
      status: "downloaded",
      availableVersion: info.version,
      progress: 100,
      message: installAfterDownload ? "新版已下载，正在自动重启安装…" : "新版已下载，点击即可重启安装",
    });
    if (installAfterDownload) setTimeout(() => installDownloadedUpdate(), 200);
  });
  autoUpdater.on("error", (error) => {
    installAfterDownload = false;
    installTriggered = false;
    if (forcedExitTimer) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.isVisible()) window.show();
    publish({ status: "error", progress: undefined, message: `更新失败：${errorMessage(error)}` });
  });

  const handle = (channel: string, listener: () => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener);
  };
  handle(IPC.updateState, () => state);
  handle(IPC.updateCheck, async () => {
    if (!app.isPackaged) return state;
    try {
      publish({ status: "checking", message: "正在检查 GitHub Releases…" });
      await autoUpdater.checkForUpdates();
    } catch (error) {
      publish({ status: "error", message: `更新失败：${errorMessage(error)}` });
    }
    return state;
  });
  handle(IPC.updateDownload, async () => {
    if (!app.isPackaged) return state;
    try {
      if (state.status !== "available") {
        await autoUpdater.checkForUpdates();
        if ((state as AppUpdateState).status !== "available") return state;
      }
      if (manualMacUpdate) {
        await shell.openExternal(RELEASES_URL);
        return publish({ status: "available", message: `已打开心影Pro ${state.availableVersion ?? "新版"} 的 macOS 安装包页面` });
      }
      installAfterDownload = true;
      publish({ status: "downloading", progress: 0, message: "开始下载新版，完成后将自动重启安装…" });
      await autoUpdater.downloadUpdate();
      if (state.status === "downloaded") return installDownloadedUpdate();
    } catch (error) {
      installAfterDownload = false;
      publish({ status: "error", message: `下载失败：${errorMessage(error)}` });
    }
    return state;
  });
  handle(IPC.updateInstall, () => {
    return installDownloadedUpdate();
  });

  if (app.isPackaged && process.env.XINYING_DISABLE_AUTO_UPDATE !== "1") {
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 12_000);
  }
}
