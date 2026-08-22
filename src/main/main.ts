import path from "node:path";
import { app, BrowserWindow, dialog, net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import { createAppPaths } from "../core/paths";
import { XinyingDatabase } from "../core/database";
import { XinyingService } from "../core/service";
import { loadSelectorPack } from "./selector-pack";
import { PlatformViewManager } from "./platform-view";
import { PlaywrightXinyingAdapter } from "./playwright-adapter";
import { JobWorker } from "./job-worker";
import { registerIpcHandlers } from "./ipc-handlers";
import { registerAppUpdater } from "./app-updater";
import { IPC } from "../shared/ipc";
import { reserveAutomationPort } from "../shared/automation-port";

app.setName("xinying-director");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

const bootstrapPaths = createAppPaths();
const CDP_PORT = singleInstance
  ? reserveAutomationPort(bootstrapPaths.dataDir, process.env.XINYING_CDP_PORT, process.argv.includes("--updated"))
  : Number(process.env.XINYING_CDP_PORT ?? 9333);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));

protocol.registerSchemesAsPrivileged([
  { scheme: "xinying-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;
let platformManager: PlatformViewManager | null = null;
let worker: JobWorker | null = null;
let database: XinyingDatabase | null = null;
let adapter: PlaywrightXinyingAdapter | null = null;

function createWindow(): void {
  const paths = createAppPaths();
  database = new XinyingDatabase(paths.databasePath);
  const service = new XinyingService(database, paths);
  service.recoverInterruptedJobs();
  const selectors = loadSelectorPack();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#090b10",
    title: "心影Pro",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  platformManager = new PlatformViewManager(mainWindow, selectors, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.sessionLoginCompleted);
  });
  adapter = new PlaywrightXinyingAdapter(
    CDP_PORT,
    selectors,
    paths,
    (prefix, timeoutMs) => platformManager!.captureNextDownload(paths.outputsDir, prefix, timeoutMs),
    (prefix, reason) => platformManager!.cancelPendingDownload(prefix, reason),
    (jobId, platformTaskId) => {
      service.updateJob(jobId, { platformTaskId });
      service.addJobEvent(jobId, "info", "SUBMIT_INTENT_RECORDED", "已在点击生成前记录心影对话位置，用于异常恢复和防止重复提交");
    },
    (portraitId, mediaKind) => {
      service.updatePlatformPortraitMediaKind(portraitId, mediaKind);
    },
  );
  worker = new JobWorker(service, adapter, (operation) => platformManager!.withAutomationViewport(operation));
  registerIpcHandlers(mainWindow, service, platformManager, adapter);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "https:" || protocol === "http:") {
        void import("electron").then(({ shell }) => shell.openExternal(url));
      }
    } catch {
      // Invalid and non-web schemes are denied below.
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (!devUrl && url.startsWith("file:")) return;
    event.preventDefault();
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void mainWindow.loadURL(devServer);
  else void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    worker?.start();
  });
  mainWindow.on("closed", () => {
    platformManager?.destroy();
    platformManager = null;
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  protocol.handle("xinying-media", (request) => {
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");
    if (!filePath) return new Response("Missing path", { status: 400 });
    const permitted = database?.db.prepare(`
      SELECT file_path FROM reference_assets WHERE file_path = ?
      UNION ALL SELECT file_path FROM shared_media_assets WHERE file_path = ?
      UNION ALL SELECT file_path FROM portrait_assets WHERE file_path = ?
      UNION ALL SELECT output_path AS file_path FROM jobs WHERE output_path = ?
      UNION ALL SELECT output_path AS file_path FROM platform_results WHERE output_path = ?
      LIMIT 1
    `).get(filePath, filePath, filePath, filePath, filePath);
    if (!permitted) return new Response("Media path is not registered in the local project database", { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  registerAppUpdater(() => mainWindow);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  dialog.showErrorBox("心影Pro启动失败", message);
  app.quit();
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  worker?.stop();
  void adapter?.close();
  database?.close();
});

app.on("window-all-closed", () => app.quit());
