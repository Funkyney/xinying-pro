import { spawn } from "node:child_process";
import { app, autoUpdater as nativeAutoUpdater, type BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdateState } from "../shared/contracts";
import { IPC } from "../shared/ipc";

let registered = false;
let state: AppUpdateState = {
  status: "idle",
  currentVersion: "0.0.0",
};

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
    "    if ($installedVersion -eq $targetVersion) { break }",
    "  }",
    "  Start-Sleep -Milliseconds 750",
    "}",
    "Start-Sleep -Seconds 2",
    "if (Test-Path -LiteralPath $executable) {",
    "  Start-Process -FilePath $executable -ArgumentList '--updated'",
    "}",
  ].join("\n");
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
  state = {
    status: app.isPackaged ? "idle" : "unsupported",
    currentVersion: app.getVersion(),
    message: app.isPackaged ? "点击检查 GitHub Releases 中的新版本" : "开发模式不执行自动更新",
  };

  const publish = (patch: Partial<AppUpdateState>) => {
    state = { ...state, ...patch, currentVersion: app.getVersion() };
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.updateStateChanged, state);
    return state;
  };

  let forcedExitTimer: NodeJS.Timeout | null = null;
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
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => publish({ status: "checking", message: "正在检查 GitHub Releases…" }));
  autoUpdater.on("update-available", (info) => publish({ status: "available", availableVersion: info.version, progress: 0, message: `发现心影Pro ${info.version}` }));
  autoUpdater.on("update-not-available", () => publish({ status: "not-available", availableVersion: undefined, progress: undefined, message: "当前已经是最新版本" }));
  autoUpdater.on("download-progress", (progress) => publish({ status: "downloading", progress: Math.max(0, Math.min(100, progress.percent)), message: `正在下载 ${Math.round(progress.percent)}%` }));
  autoUpdater.on("update-downloaded", (info) => publish({ status: "downloaded", availableVersion: info.version, progress: 100, message: "新版已下载，点击即可重启安装" }));
  autoUpdater.on("error", (error) => {
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
      publish({ status: "downloading", progress: 0, message: "开始下载新版…" });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      publish({ status: "error", message: `下载失败：${errorMessage(error)}` });
    }
    return state;
  });
  handle(IPC.updateInstall, () => {
    if (state.status !== "downloaded") return state;
    const targetVersion = state.availableVersion ?? app.getVersion();
    const next = publish({ status: "installing", message: "正在关闭旧版、安装更新并重新打开…" });
    // electron-updater normally relaunches after a silent NSIS install. Keep a
    // detached Windows guardian as a second path because the embedded Heart
    // page or the single-instance hand-off can make that relaunch disappear.
    startWindowsRelaunchGuardian(targetVersion);
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 150);
    return next;
  });

  if (app.isPackaged && process.env.XINYING_DISABLE_AUTO_UPDATE !== "1") {
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 12_000);
  }
}
