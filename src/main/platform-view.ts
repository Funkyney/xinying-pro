import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, WebContentsView, app, session, shell, type WebContents } from "electron";
import type { PlatformViewBounds } from "../shared/contracts";
import type { SelectorPack } from "./selector-pack";
import { classifyPlatformNavigation } from "./platform-navigation";
import { AsyncOperationQueue } from "./async-operation-queue";
import { backgroundAutomationBounds } from "./platform-layout";

const ALLOWED_HOSTS = [
  "blueaivideo.com",
  "feishu.cn",
  "larksuite.com",
  "byteimg.com",
  "bytedance.com",
];

function isAllowedUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    return ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export class PlatformViewManager {
  readonly view: WebContentsView;
  private visible = false;
  private automationDepth = 0;
  private readonly automationQueue = new AsyncOperationQueue();
  private loginFlowActive = false;
  private loginChallengeObserved = false;
  private completingLogin = false;
  private readonly loginWindows = new Set<BrowserWindow>();
  private bounds: PlatformViewBounds = { x: 272, y: 84, width: 900, height: 650 };
  private pendingDownload: {
    outputDirectory: string;
    prefix: string;
    resolve: (filePath: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly selectors: SelectorPack,
    private readonly onLoginCompleted?: () => void,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        partition: "persist:xinying-platform",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.contentView.addChildView(this.view);
    this.view.setVisible(false);
    this.configureSecurity();
    this.observeLoginNavigation(this.view.webContents);
    void this.view.webContents.loadURL(selectors.baseUrl);
  }

  private configureSecurity(): void {
    const platformSession = session.fromPartition("persist:xinying-platform");
    platformSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    platformSession.on("will-download", (_event, item) => {
      const safeName = path.basename(item.getFilename()).replace(/[<>:"/\\|?*]+/g, "-");
      const pending = this.pendingDownload;
      if (!pending) {
        item.setSavePath(path.join(app.getPath("downloads"), safeName));
        return;
      }
      this.pendingDownload = null;
      const safePrefix = path.basename(pending.prefix).replace(/[<>:"/\\|?*]+/g, "-");
      const target = path.join(pending.outputDirectory, `${safePrefix}-${safeName}`);
      fs.mkdirSync(pending.outputDirectory, { recursive: true });
      item.setSavePath(target);
      item.once("done", (_doneEvent, state) => {
        clearTimeout(pending.timer);
        if (state === "completed") pending.resolve(target);
        else pending.reject(new Error(`心影下载未完成：${state}`));
      });
    });

    this.view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 1080,
            height: 760,
            autoHideMenuBar: true,
            title: "飞书登录 · 心影Pro",
            webPreferences: {
              partition: "persist:xinying-platform",
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        };
      }
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });

    this.view.webContents.on("did-create-window", (childWindow, details) => {
      const kind = classifyPlatformNavigation(details.url, this.selectors.authenticatedUrlPatterns);
      if (!this.loginFlowActive && kind !== "login" && kind !== "auth-provider") return;
      this.loginWindows.add(childWindow);
      childWindow.on("closed", () => this.loginWindows.delete(childWindow));
      childWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
        return { action: "deny" };
      });
      childWindow.webContents.on("will-navigate", (event, url) => {
        if (isAllowedUrl(url)) return;
        event.preventDefault();
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
      });
      this.observeLoginNavigation(childWindow.webContents);
    });

    this.view.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedUrl(url)) event.preventDefault();
    });
  }

  private observeLoginNavigation(contents: WebContents): void {
    const inspect = (url: string) => {
      if (!this.loginFlowActive) return;
      const kind = classifyPlatformNavigation(url, this.selectors.authenticatedUrlPatterns);
      if (kind === "login" || kind === "auth-provider") this.loginChallengeObserved = true;
      if (kind === "authenticated" && this.loginChallengeObserved) {
        void this.completeLogin(contents);
      }
    };
    contents.on("did-navigate", (_event, url) => inspect(url));
    contents.on("did-redirect-navigation", (_event, url) => inspect(url));
    contents.on("did-navigate-in-page", (_event, url) => inspect(url));
    contents.on("did-finish-load", () => inspect(contents.getURL()));
  }

  private closeLoginWindows(): void {
    for (const loginWindow of this.loginWindows) {
      if (!loginWindow.isDestroyed()) loginWindow.close();
    }
    this.loginWindows.clear();
  }

  private async completeLogin(source: WebContents): Promise<void> {
    if (!this.loginFlowActive || this.completingLogin) return;
    this.loginFlowActive = false;
    this.completingLogin = true;
    this.hide();
    try {
      if (source !== this.view.webContents && !this.view.webContents.isDestroyed()) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await this.view.webContents.loadURL(this.selectors.baseUrl);
      }
    } catch {
      // The authenticated popup is already authoritative; a background home refresh can be retried later.
    } finally {
      this.closeLoginWindows();
      if (!this.window.isDestroyed()) {
        this.window.show();
        this.window.focus();
      }
      this.onLoginCompleted?.();
      this.completingLogin = false;
    }
  }

  cancelLogin(): void {
    this.loginFlowActive = false;
    this.loginChallengeObserved = false;
    this.completingLogin = false;
    this.closeLoginWindows();
  }

  show(): void {
    this.visible = true;
    this.syncVisibility();
  }

  isVisible(): boolean {
    return this.visible;
  }

  hide(): void {
    this.visible = false;
    this.syncVisibility();
  }

  setBounds(bounds: PlatformViewBounds): void {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(320, Math.round(bounds.width)),
      height: Math.max(240, Math.round(bounds.height)),
    };
    if (this.visible && this.automationDepth === 0) this.view.setBounds(this.bounds);
  }

  async withAutomationViewport<T>(operation: () => Promise<T>): Promise<T> {
    return this.automationQueue.run(async () => {
      this.automationDepth += 1;
      this.syncVisibility();
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        return await operation();
      } finally {
        this.automationDepth = Math.max(0, this.automationDepth - 1);
        this.syncVisibility();
      }
    });
  }

  private syncVisibility(): void {
    if (this.visible) {
      this.view.setBounds(this.bounds);
      this.view.setVisible(true);
      return;
    }
    if (this.automationDepth > 0) {
      // Electron collapses a WebContentsView's page viewport to 0×0 when the
      // native view is completely outside its parent. Keep one clipped pixel
      // intersecting the window so responsive platform content still renders.
      this.view.setBounds(backgroundAutomationBounds(this.bounds));
      this.view.setVisible(true);
      return;
    }
    this.view.setVisible(false);
  }

  async openLogin(): Promise<void> {
    this.cancelLogin();
    this.loginFlowActive = true;
    this.loginChallengeObserved = false;
    try {
      await this.view.webContents.loadURL(this.selectors.loginUrl);
      if (this.loginFlowActive) this.show();
    } catch (error) {
      this.loginFlowActive = false;
      throw error;
    }
  }

  async openUrl(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.hostname !== "blueaivideo.com" || url.pathname !== "/avpAgent" || !isAllowedUrl(url.toString())) {
      throw new Error("只能在兼容模式中打开心影 avpAgent 会话链接");
    }
    this.cancelLogin();
    await this.view.webContents.loadURL(url.toString());
    this.show();
  }

  async openPlatform(): Promise<void> {
    const url = this.view.webContents.getURL();
    if (!url || url === "about:blank") await this.view.webContents.loadURL(this.selectors.baseUrl);
    this.show();
  }

  async reload(): Promise<void> {
    this.view.webContents.reload();
  }

  currentUrl(): string {
    return this.view.webContents.getURL();
  }

  captureNextDownload(outputDirectory: string, prefix: string, timeoutMs = 120_000): Promise<string> {
    if (this.pendingDownload) return Promise.reject(new Error("已有一个心影下载正在等待开始"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingDownload?.prefix === prefix) this.pendingDownload = null;
        reject(new Error("等待心影下载开始超时"));
      }, timeoutMs);
      this.pendingDownload = { outputDirectory, prefix, resolve, reject, timer };
    });
  }

  cancelPendingDownload(prefix: string, reason = "下载操作已取消"): boolean {
    if (!this.pendingDownload || this.pendingDownload.prefix !== prefix) return false;
    const pending = this.pendingDownload;
    this.pendingDownload = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    return true;
  }

  destroy(): void {
    this.cancelLogin();
    if (this.pendingDownload) {
      clearTimeout(this.pendingDownload.timer);
      this.pendingDownload.reject(new Error("心影页面已关闭，下载已取消"));
      this.pendingDownload = null;
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }
}
