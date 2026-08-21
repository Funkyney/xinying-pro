import { app, type BrowserWindow, ipcMain } from "electron";
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

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => publish({ status: "checking", message: "正在检查 GitHub Releases…" }));
  autoUpdater.on("update-available", (info) => publish({ status: "available", availableVersion: info.version, progress: 0, message: `发现心影Pro ${info.version}` }));
  autoUpdater.on("update-not-available", () => publish({ status: "not-available", availableVersion: undefined, progress: undefined, message: "当前已经是最新版本" }));
  autoUpdater.on("download-progress", (progress) => publish({ status: "downloading", progress: Math.max(0, Math.min(100, progress.percent)), message: `正在下载 ${Math.round(progress.percent)}%` }));
  autoUpdater.on("update-downloaded", (info) => publish({ status: "downloaded", availableVersion: info.version, progress: 100, message: "新版已下载，点击即可重启安装" }));
  autoUpdater.on("error", (error) => publish({ status: "error", progress: undefined, message: `更新失败：${errorMessage(error)}` }));

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
    const next = publish({ message: "正在重启并安装新版…" });
    // 一次点击后静默替换当前安装并自动重启；false 会再次弹出 NSIS 安装向导，
    // 让同事误以为 APP 卡在“正在安装”。
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return next;
  });

  if (app.isPackaged && process.env.XINYING_DISABLE_AUTO_UPDATE !== "1") {
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 12_000);
  }
}
