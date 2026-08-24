import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page, type Response, type Route } from "playwright-core";
import type {
  HumanCheckpoint,
  Job,
  PlatformCatalogSnapshot,
  PlatformConversation,
  PlatformProject,
  PlatformProjectBinding,
  PlatformProjectCreateInput,
  PlatformPortrait,
  PlatformPortraitDeleteResult,
  PlatformPortraitDeleteProgress,
  PlatformResult,
  PlatformResultMediaKind,
  Project,
  PlatformWorkspace,
  PortraitAsset,
  SessionState,
} from "../shared/contracts";
import type { AppPaths } from "../core/paths";
import { AppError } from "../core/errors";
import type { SelectorPack } from "./selector-pack";
import { classifyPlatformNavigation, platformHomeUrl, sessionNavigationPriority } from "./platform-navigation";
import { parseMaterialKey, portraitMaterialKey, referenceMaterialKey } from "../shared/material-order";
import {
  assignMediaLabels,
  canonicalizePromptMaterialReferences,
  findAddedMediaLabel,
  mediaKindFromMime,
  portraitMediaKindFromPreviewUrl,
  promptMaterialLabels,
} from "../shared/media";

export type AdapterOutcome =
  | { status: "running"; platformTaskId?: string; message: string }
  | { status: "completed"; platformTaskId?: string; outputUrl?: string; outputPath?: string; message: string }
  | { status: "failed"; platformTaskId?: string; code: string; message: string }
  | { status: "needs-human"; platformTaskId?: string; checkpoint: HumanCheckpoint }
  | { status: "needs-login"; message: string };

interface ChatTaskRef {
  projectId: string;
  sessionId: string;
  userIndex: number;
}

interface MatchedChatResponse {
  response: Locator;
  userIndex: number;
}

interface UploadedMaterialSnapshot {
  label: string;
  previewText: string;
}

interface PlatformCatalogApiData {
  currentRemoteId: string;
  currentWorkspaceKey: string;
  workspaces: Array<{
    key: string;
    kind: PlatformWorkspace["kind"];
    name: string;
  }>;
  projects: Array<{
    workspaceKey: string;
    remoteId: string;
    name: string;
    shortId: string;
  }>;
  customerOptions: string[];
  creationTypeOptions: string[];
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true }).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

async function firstExisting(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

async function firstCollection(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true });
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

async function firstVisibleWithin(scope: Locator, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).filter({ visible: true }).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

async function firstCollectionWithin(scope: Locator, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = scope.locator(selector).filter({ visible: true });
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

async function waitForCollectionWithin(scope: Locator, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const collection = await firstCollectionWithin(scope, selectors);
    if (collection) return collection;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function clickDom(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("目标节点不是可点击的 HTML 元素");
    element.click();
  });
}

function stringParameter(job: Job, key: string): string {
  const value = job.parameters[key];
  return typeof value === "string" ? value.trim() : "";
}

function explicitParameterValue(job: Job, key: string): string | null {
  const value = stringParameter(job, key);
  return !value || value.toLowerCase() === "auto" ? null : value;
}

function parseSelectedPortraitCount(text: string): number | null {
  const match = text.match(/已选\s*(\d+)\s*项/);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isInteger(count) ? count : null;
}

function remapPromptLabels(prompt: string, mapping: ReadonlyMap<string, string>): string {
  return canonicalizePromptMaterialReferences(prompt).replace(/@(图|视频|音频)\d+/g, (label) => mapping.get(label) ?? label);
}

function normalizePromptLabels(prompt: string): string {
  return canonicalizePromptMaterialReferences(prompt).replace(/@(图|视频|音频)\d+/g, "@$1#");
}

function normalizeReusablePrompt(prompt: string): string {
  return normalizePromptLabels(prompt).replace(/\s+/g, " ").trim();
}

function platformPortraitsParameter(job: Job): PlatformPortrait[] {
  const value = job.parameters.platformPortraits;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PlatformPortrait => Boolean(
    item && typeof item === "object" && typeof (item as PlatformPortrait).id === "string"
      && typeof (item as PlatformPortrait).displayName === "string" && typeof (item as PlatformPortrait).previewUrl === "string",
  ));
}

function materialOrderParameter(job: Job): string[] {
  const value = job.parameters.materialOrder;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && parseMaterialKey(item) !== null);
}

function configurablePortraitOptions(portrait: PortraitAsset): Array<{ index: number; value: string }> {
  return [portrait.gender, portrait.ageGroup, portrait.ethnicity]
    .map((value, index) => ({ index, value }))
    .filter((item) => item.value !== "");
}

function platformPortraitIdentity(displayName: string, previewUrl: string, workspaceId = ""): { id: string; platformAssetId: string } {
  let platformAssetId = "";
  try {
    platformAssetId = path.basename(new URL(previewUrl).pathname, path.extname(new URL(previewUrl).pathname));
  } catch {
    platformAssetId = "unknown";
  }
  return {
    id: crypto.createHash("sha256").update(`${workspaceId}\n${displayName}\n${previewUrl.split("?")[0]}`).digest("hex"),
    platformAssetId,
  };
}

function platformWorkspaceIdentity(kind: PlatformWorkspace["kind"], name: string): string {
  return crypto.createHash("sha256").update(`workspace\n${kind}\n${name.trim()}`).digest("hex");
}

function platformProjectIdentity(workspaceId: string, name: string, shortId: string): string {
  return crypto.createHash("sha256").update(`project\n${workspaceId}\n${shortId.trim()}\n${name.trim()}`).digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() ?? "";
}

function normalizedConversationTimestamp(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
      const parsed = new Date(milliseconds);
      if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
        const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
        const parsed = new Date(milliseconds);
        if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
      }
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
    }
  }
  return "";
}

function platformConversationsFromApi(
  body: unknown,
  projectId: string,
  currentSessionId = "",
): PlatformConversation[] {
  const envelope = recordValue(body);
  if (Number(envelope.code) !== 0) return [];
  const data = recordValue(envelope.data);
  const rows = Array.isArray(data.sessions) ? data.sessions : Array.isArray(data.list) ? data.list : [];
  const conversations = new Map<string, PlatformConversation>();
  for (const value of rows) {
    const row = recordValue(value);
    const id = nonEmptyString(row.avp_session_id, row.session_id, row.id);
    if (!id || conversations.has(id)) continue;
    conversations.set(id, {
      id,
      projectId,
      title: nonEmptyString(row.session_title, row.title, row.name) || "未命名对话",
      updatedAt: normalizedConversationTimestamp(row.updated_at, row.update_time, row.updatedAt, row.created_at, row.create_time),
      isCurrent: id === currentSessionId,
    });
  }
  return [...conversations.values()].sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function safeHttpsUrl(...values: unknown[]): string | null {
  const value = nonEmptyString(...values);
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizedMaterialTimestamp(value: unknown, fallback: string, order: number): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(Date.parse(fallback) - order).toISOString();
}

function platformMaterialResult(
  project: Project,
  remoteProjectId: string,
  mediaKind: PlatformResultMediaKind,
  raw: Record<string, unknown>,
  syncedAt: string,
  order: number,
): PlatformResult | null {
  const outputUrl = safeHttpsUrl(raw.cdn_url);
  if (!outputUrl) return null;
  const materialId = nonEmptyString(raw.material_id === undefined || raw.material_id === null ? "" : String(raw.material_id), raw.vlc_id, outputUrl);
  if (!materialId) return null;
  const parameters = recordValue(raw.task_create_parmas);
  const name = nonEmptyString(raw.material_name, path.basename(new URL(outputUrl).pathname), `${mediaKind}-${materialId}`);
  const prompt = nonEmptyString(parameters.prompt, parameters.text, parameters.rich_text);
  const previewUrl = mediaKind === "image" ? safeHttpsUrl(raw.post_cdn_url, outputUrl) : safeHttpsUrl(raw.post_cdn_url);
  const createdAt = normalizedMaterialTimestamp(raw.show_updated_time, syncedAt, order);
  return {
    id: crypto.createHash("sha256").update(`project-material\n${remoteProjectId}\n${mediaKind}\n${materialId}`).digest("hex"),
    projectId: project.id,
    platformProjectId: project.platformProjectId || remoteProjectId,
    platformTaskId: `material:${remoteProjectId}:${materialId}`,
    jobId: null,
    source: "project",
    mediaKind,
    name,
    prompt,
    outputUrl,
    previewUrl,
    outputPath: null,
    marked: false,
    available: true,
    createdAt,
    lastSeenAt: syncedAt,
  };
}

function platformCatalogFromApi(
  data: PlatformCatalogApiData,
  syncedAt: string,
  baseUrl: string,
  homePath: string,
): PlatformCatalogSnapshot {
  const seenWorkspaceKeys = new Set<string>();
  const workspaces = data.workspaces.filter((workspace) => {
    if (!workspace.key.trim() || !workspace.name.trim() || seenWorkspaceKeys.has(workspace.key)) return false;
    seenWorkspaceKeys.add(workspace.key);
    return true;
  }).map((workspace, sortOrder): PlatformWorkspace => ({
    id: platformWorkspaceIdentity(workspace.kind, workspace.name),
    name: workspace.name.trim(),
    kind: workspace.kind,
    description: workspace.kind === "personal" ? "数据仅自己可见" : "项目与虚拟人像对团队成员共享",
    available: true,
    isCurrent: false,
    sortOrder,
    lastSeenAt: syncedAt,
  }));
  const workspaceByKey = new Map<string, PlatformWorkspace>();
  for (const workspace of data.workspaces) {
    const matched = workspaces.find((item) => item.id === platformWorkspaceIdentity(workspace.kind, workspace.name));
    if (matched && !workspaceByKey.has(workspace.key)) workspaceByKey.set(workspace.key, matched);
  }

  const origin = baseUrl.replace(/\/$/, "");
  const projects = data.projects.flatMap((project, sortOrder): PlatformProject[] => {
    const workspace = workspaceByKey.get(project.workspaceKey);
    const name = project.name.trim();
    const shortId = project.shortId.trim();
    const remoteId = project.remoteId.trim();
    if (!workspace || !name || !shortId || !remoteId) return [];
    return [{
      id: platformProjectIdentity(workspace.id, name, shortId),
      workspaceId: workspace.id,
      name,
      shortId,
      remoteId,
      homeUrl: `${origin}${homePath}?projectId=${encodeURIComponent(remoteId)}`,
      available: true,
      isCurrent: remoteId === data.currentRemoteId,
      sortOrder,
      lastSeenAt: syncedAt,
    }];
  });
  const currentProject = projects.find((project) => project.isCurrent);
  const currentWorkspace = currentProject
    ? workspaces.find((workspace) => workspace.id === currentProject.workspaceId)
    : workspaceByKey.get(data.currentWorkspaceKey);
  for (const workspace of workspaces) workspace.isCurrent = workspace.id === currentWorkspace?.id;

  return {
    workspaces,
    projects,
    currentWorkspaceId: currentWorkspace?.id ?? "",
    currentProjectId: currentProject?.id ?? "",
    customerOptions: [...new Set(data.customerOptions.map((item) => item.trim()).filter(Boolean))],
    creationTypeOptions: [...new Set(data.creationTypeOptions.map((item) => item.trim()).filter(Boolean))],
    syncedAt,
  };
}

function classifyPortraitCardText(text: string): "failed" | "running" | "completed" {
  if (/审核不通过|审核失败|已拒绝|上传失败/.test(text)) return "failed";
  if (/正在审核|审核中|待审核/.test(text)) return "running";
  return "completed";
}

function classifyGenerationCard(text: string, className: string, hasOutputControl: boolean): "failed" | "running" | "completed" {
  if (/生成失败|审核不通过|任务失败|任务创建失败|限流状态|限流|操作频繁|系统繁忙|稍后再试|已超额打工|余额不足|积分不足|算力不足/.test(text)) return "failed";
  if (className.includes("_isLoading") || /生成中|排队中|处理中|等待生成/.test(text) || !hasOutputControl) return "running";
  return "completed";
}

function encodeChatTaskRef(ref: ChatTaskRef): string {
  return `chat:${ref.projectId}:${ref.sessionId}:${ref.userIndex}`;
}

function encodePendingTaskRef(ref: ChatTaskRef): string {
  return `pending-chat:${ref.projectId}:${ref.sessionId}:${ref.userIndex}`;
}

function decodeChatTaskRef(value: string | null): ChatTaskRef | null {
  if (!value?.startsWith("chat:")) return null;
  const parts = value.split(":");
  const userIndex = Number(parts[3]);
  if (parts.length !== 4 || !parts[1] || !parts[2] || !Number.isInteger(userIndex) || userIndex < 0) return null;
  return { projectId: parts[1], sessionId: parts[2], userIndex };
}

function decodePendingTaskRef(value: string | null): ChatTaskRef | null {
  if (!value?.startsWith("pending-chat:")) return null;
  const parts = value.split(":");
  const userIndex = Number(parts[3]);
  if (parts.length !== 4 || !parts[1] || !parts[2] || !Number.isInteger(userIndex) || userIndex < 0) return null;
  return { projectId: parts[1], sessionId: parts[2], userIndex };
}

function safeGenerationUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "blueaivideo.com" && url.pathname === "/avpAgent"
      ? url
      : null;
  } catch {
    return null;
  }
}

function hostMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

export class PlaywrightXinyingAdapter {
  private browser: Browser | null = null;

  constructor(
    private readonly cdpPort: number,
    private readonly selectors: SelectorPack,
    private readonly paths: AppPaths,
    private readonly captureDownload?: (prefix: string, timeoutMs: number) => Promise<string>,
    private readonly cancelDownloadCapture?: (prefix: string, reason?: string) => boolean,
    private readonly persistPendingTaskRef?: (jobId: string, platformTaskId: string) => void,
    private readonly persistPlatformPortraitMediaKind?: (portraitId: string, mediaKind: PlatformPortrait["mediaKind"]) => void,
  ) {}

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`, { timeout: 8_000 });
    return this.browser;
  }

  async page(): Promise<Page> {
    const browser = await this.connect().catch((error: unknown) => {
      throw new AppError("PLAYWRIGHT_NOT_CONNECTED", "无法连接心影页面自动化通道", error);
    });
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((candidate) => {
      try {
        return hostMatches(new URL(candidate.url()).hostname, "blueaivideo.com");
      } catch {
        return false;
      }
    });
    const preferred = [...pages].reverse().find((candidate) => /\/(avpAgent|aiCharacter)/.test(new URL(candidate.url()).pathname));
    const page = preferred ?? pages.at(-1);
    if (!page) throw new AppError("PLATFORM_PAGE_NOT_FOUND", "尚未打开心影官方页面");
    return page;
  }

  async sessionState(): Promise<SessionState> {
    const checkedAt = new Date().toISOString();
    try {
      const browser = await this.connect();
      const pages = browser.contexts().flatMap((context) => context.pages());
      const candidates = [...pages].reverse().map((candidate) => ({
        page: candidate,
        kind: classifyPlatformNavigation(candidate.url(), this.selectors.authenticatedUrlPatterns),
      })).filter(({ page }) => {
        try {
          const host = new URL(page.url()).hostname;
          return hostMatches(host, "blueaivideo.com") || hostMatches(host, "feishu.cn") || hostMatches(host, "larksuite.com");
        } catch {
          return false;
        }
      });
      candidates.sort((left, right) => sessionNavigationPriority(right.kind) - sessionNavigationPriority(left.kind));
      const selected = candidates[0];
      if (!selected) throw new AppError("PLATFORM_PAGE_NOT_FOUND", "尚未打开心影或飞书登录页面");
      const { page, kind } = selected;
      const url = page.url();
      if (kind === "auth-provider") {
        return { status: "needs-human", url, reason: "请使用飞书/豆包移动端扫码并在手机上确认登录", checkedAt };
      }
      if (kind === "login") return { status: "logged-out", url, checkedAt };
      if (kind === "authenticated") {
        const greeting = page.getByText(/^Hi[，,]/).filter({ visible: true }).first();
        const accountLabel = (await greeting.count()) ? (await greeting.innerText()).trim() : undefined;
        return { status: "logged-in", url, ...(accountLabel ? { accountLabel } : {}), checkedAt };
      }
      return { status: "unknown", url, reason: "无法从当前地址确认登录状态", checkedAt };
    } catch (error) {
      return {
        status: "unknown",
        url: "",
        reason: error instanceof Error ? error.message : "无法检查登录状态",
        checkedAt,
      };
    }
  }

  private requireAuthenticatedPage(page: Page): void {
    const kind = classifyPlatformNavigation(page.url(), this.selectors.authenticatedUrlPatterns);
    if (kind === "login" || kind === "auth-provider") {
      throw new AppError("PLATFORM_LOGIN_REQUIRED", "心影登录已失效，请先完成飞书扫码登录");
    }
    if (kind !== "authenticated") {
      throw new AppError("PLATFORM_PAGE_NOT_READY", "心影页面尚未进入工作台，请先完成登录");
    }
  }

  private async ensureHomePage(page: Page): Promise<Page> {
    let current: URL;
    try {
      current = new URL(page.url());
    } catch {
      throw new AppError("PLATFORM_PAGE_NOT_FOUND", "当前心影页面地址无效");
    }
    this.requireAuthenticatedPage(page);
    if (current.pathname !== this.selectors.projects.homePath) {
      await page.goto(platformHomeUrl(current.toString(), this.selectors.baseUrl, this.selectors.projects.homePath), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    this.requireAuthenticatedPage(page);
    const trigger = await this.waitForVisible(page, this.selectors.projects.selectorTrigger, 20_000);
    if (!trigger) throw new AppError("PROJECT_SELECTOR_NOT_FOUND", "心影空间与项目选择器未加载");
    return page;
  }

  private isTransientProjectNavigationError(error: unknown): boolean {
    if (error instanceof AppError) {
      return new Set([
        "PLATFORM_PAGE_NOT_READY",
        "PROJECT_SELECTOR_NOT_FOUND",
        "WORKSPACE_LIST_NOT_FOUND",
        "PROJECT_LIST_NOT_FOUND",
        "PLATFORM_PROJECT_NOT_FOUND",
        "PLATFORM_PROJECT_SWITCH_FAILED",
        "GENERATION_SESSION_CREATE_FAILED",
      ]).has(error.code);
    }
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|detached|execution context was destroyed|target page/i.test(message);
  }

  private async recoverProjectNavigation(page: Page, attempt: number): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    const current = page.url();
    await page.goto(platformHomeUrl(current, this.selectors.baseUrl, this.selectors.projects.homePath), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => undefined);
    await page.waitForTimeout(350 * attempt);
  }

  private async retryProjectNavigation<T>(page: Page, operation: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !this.isTransientProjectNavigationError(error)) throw error;
        await this.recoverProjectNavigation(page, attempt);
      }
    }
    throw lastError;
  }

  private async openProjectSelector(page: Page): Promise<Locator> {
    const existing = await firstVisible(page, this.selectors.projects.selectorPanel);
    if (existing) return existing;
    const trigger = await this.waitForVisible(page, this.selectors.projects.selectorTrigger, 20_000);
    if (!trigger) throw new AppError("PROJECT_SELECTOR_NOT_FOUND", "找不到心影空间与项目选择器");
    await clickDom(trigger);
    const panel = await this.waitForVisible(page, this.selectors.projects.selectorPanel, 8_000);
    if (!panel) throw new AppError("PROJECT_SELECTOR_NOT_FOUND", "心影空间与项目列表未展开");
    return panel;
  }

  private async showWorkspaceLayer(page: Page, panel: Locator): Promise<Locator> {
    if ((await panel.getByText("项目列表", { exact: true }).filter({ visible: true }).count()) > 0) {
      const back = panel.getByText("返回", { exact: true }).filter({ visible: true }).first();
      if ((await back.count()) > 0) {
        await clickDom(back);
      }
    }
    const workspaces = await waitForCollectionWithin(panel, this.selectors.projects.workspaceItems, 8_000);
    if (!workspaces) throw new AppError("WORKSPACE_LIST_NOT_FOUND", "心影没有显示个人或团队空间列表");
    return workspaces;
  }

  private async readWorkspaceList(items: Locator, syncedAt: string, currentName: string): Promise<PlatformWorkspace[]> {
    const rows = await items.evaluateAll((elements) => elements.map((element, index) => ({
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      active: element.classList.contains("is-active"),
      sortOrder: index,
    })).filter((item) => item.text));
    return rows.map((row) => {
      const personal = row.text.includes("个人空间") || row.text.includes("数据不与他人互通");
      const name = personal ? "个人空间" : row.text.replace(/数据不与他人互通/g, "").trim();
      const kind: PlatformWorkspace["kind"] = personal ? "personal" : "team";
      return {
        id: platformWorkspaceIdentity(kind, name),
        name,
        kind,
        description: personal ? "数据仅自己可见" : "项目与虚拟人像对团队成员共享",
        available: true,
        isCurrent: row.active || name === currentName,
        sortOrder: row.sortOrder,
        lastSeenAt: syncedAt,
      };
    });
  }

  private async chooseWorkspace(page: Page, panel: Locator, workspace: PlatformWorkspace): Promise<void> {
    let currentPanel = panel;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      currentPanel = await this.openProjectSelector(page);
      const items = await this.showWorkspaceLayer(page, currentPanel);
      const clicked = await items.evaluateAll((elements, target) => {
        const match = elements.find((element) => {
          const text = ((element as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
          return target.kind === "personal" ? text.includes("个人空间") : text === target.name;
        });
        if (!(match instanceof HTMLElement)) return false;
        match.click();
        return true;
      }, { name: workspace.name, kind: workspace.kind }).catch(() => false);
      if (!clicked) throw new AppError("WORKSPACE_NOT_FOUND", `找不到心影空间：${workspace.name}`);
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const heading = currentPanel.locator(".selector-back .elp1").filter({ visible: true }).first();
        const headingText = (await heading.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const hasProjectLayer = (await currentPanel.getByText("项目列表", { exact: true }).filter({ visible: true }).count()) > 0;
        if (hasProjectLayer && headingText === workspace.name) return;
        await page.waitForTimeout(150);
      }
    }
    throw new AppError("PROJECT_LIST_NOT_FOUND", `未能打开“${workspace.name}”的项目列表`);
  }

  private async readProjectList(
    panel: Locator,
    workspace: PlatformWorkspace,
    syncedAt: string,
    currentName: string,
    currentRemoteId: string,
  ): Promise<PlatformProject[]> {
    const primarySelector = this.selectors.projects.projectItems[0] ?? ".selector-project-item";
    const projectCards = panel.locator(primarySelector).filter({ visible: true });
    await projectCards.first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
    const rows = await ((await projectCards.count()) > 0 ? projectCards : panel.locator("div").filter({ visible: true })).evaluateAll((elements) => {
      const records: Array<{ name: string; shortId: string; active: boolean; top: number }> = [];
      for (const element of elements) {
        const text = (element as HTMLElement).innerText?.trim() ?? "";
        const matches = text.match(/ID[：:]\s*([^\s]+)/g) ?? [];
        if (matches.length !== 1) continue;
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const idIndex = lines.findIndex((line) => /^ID[：:]/.test(line));
        if (idIndex <= 0) continue;
        const name = lines[idIndex - 1];
        const shortId = lines[idIndex].replace(/^ID[：:]\s*/, "").trim();
        if (!name || !shortId || ["全部项目", "项目列表", "返回"].includes(name)) continue;
        const rect = element.getBoundingClientRect();
        records.push({ name, shortId, active: element.classList.contains("is-active"), top: rect.top });
      }
      const unique = new Map<string, { name: string; shortId: string; active: boolean; top: number }>();
      for (const row of records.sort((a, b) => a.top - b.top)) {
        const key = `${row.name}\n${row.shortId}`;
        if (!unique.has(key)) unique.set(key, row);
      }
      return [...unique.values()];
    });
    return rows.map((row, index) => {
      const current = row.active || row.name === currentName;
      const remoteId = current ? currentRemoteId : "";
      return {
        id: platformProjectIdentity(workspace.id, row.name, row.shortId),
        workspaceId: workspace.id,
        name: row.name,
        shortId: row.shortId,
        remoteId,
        homeUrl: remoteId ? `${this.selectors.baseUrl.replace(/\/$/, "")}${this.selectors.projects.homePath}?projectId=${encodeURIComponent(remoteId)}` : "",
        available: true,
        isCurrent: current,
        sortOrder: index,
        lastSeenAt: syncedAt,
      };
    });
  }

  private async chooseProject(page: Page, panel: Locator, project: PlatformProject): Promise<string> {
    const previousRemoteId = new URL(page.url()).searchParams.get("projectId") ?? "";
    const primarySelector = this.selectors.projects.projectItems[0] ?? ".selector-project-item";
    const cards = panel.locator(primarySelector).filter({ visible: true });
    const loaded = await cards.first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
    if (!loaded) throw new AppError("PLATFORM_PROJECT_NOT_FOUND", `找不到心影项目：${project.name}`);
    const clicked = await cards.evaluateAll((elements, target) => {
      const match = elements.find((element) => {
        const name = element.querySelector(".project-item-name")?.textContent?.trim()
          ?? (element as HTMLElement).innerText.split(/\r?\n/)[0]?.trim()
          ?? "";
        const text = ((element as HTMLElement).innerText ?? "").replace(/\s+/g, " ");
        return name === target.name && (!target.shortId || text.includes(target.shortId));
      });
      if (!(match instanceof HTMLElement)) return false;
      match.click();
      return true;
    }, { name: project.name, shortId: project.shortId }).catch(() => false);
    if (!clicked) throw new AppError("PLATFORM_PROJECT_NOT_FOUND", `找不到心影项目：${project.name}`);
    const deadline = Date.now() + 12_000;
    let stableRemoteId = "";
    let stableRounds = 0;
    while (Date.now() < deadline) {
      const remoteId = new URL(page.url()).searchParams.get("projectId") ?? "";
      const trigger = await firstVisible(page, this.selectors.projects.selectorTrigger);
      const triggerText = (await trigger?.innerText().catch(() => "")) ?? "";
      if (remoteId && triggerText.includes(project.name)) return remoteId;
      if (remoteId && remoteId === stableRemoteId) stableRounds += 1;
      else {
        stableRemoteId = remoteId;
        stableRounds = remoteId ? 1 : 0;
      }
      // The projectId is the authoritative switch result. Heart sometimes
      // updates the selector caption noticeably later than the URL.
      if (remoteId && remoteId !== previousRemoteId && stableRounds >= 3) return remoteId;
      await page.waitForTimeout(200);
    }
    throw new AppError("PLATFORM_PROJECT_SWITCH_FAILED", `心影未能切换到项目：${project.name}`);
  }

  private async openGenerationSession(page: Page, remoteProjectId: string, conversationId?: string): Promise<string> {
    const targetUrl = new URL(`${this.selectors.baseUrl.replace(/\/$/, "")}/avpAgent`);
    targetUrl.searchParams.set("projectId", remoteProjectId);
    if (conversationId?.trim()) targetUrl.searchParams.set("sessionId", conversationId.trim());
    const target = targetUrl.toString();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    let deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = safeGenerationUrl(page.url());
      const expectedSession = conversationId?.trim() ?? "";
      const sessionMatches = !expectedSession || current?.searchParams.get("sessionId") === expectedSession;
      if (current?.searchParams.get("projectId") === remoteProjectId && sessionMatches && await firstVisible(page, this.selectors.generation.composer)) return current.toString();
      await page.waitForTimeout(250);
    }
    if (conversationId?.trim()) throw new AppError("GENERATION_SESSION_NOT_FOUND", "已进入心影项目，但所选历史对话未能加载");
    const createSession = page.getByText("新建会话", { exact: true }).filter({ visible: true }).first();
    if ((await createSession.count()) > 0) await clickDom(createSession);
    deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = safeGenerationUrl(page.url());
      if (current?.searchParams.get("projectId") === remoteProjectId && await firstVisible(page, this.selectors.generation.composer)) return current.toString();
      await page.waitForTimeout(250);
    }
    throw new AppError("GENERATION_SESSION_CREATE_FAILED", "已选择心影项目，但未能建立内容生成会话");
  }

  private async readPlatformCatalogApi(
    page: Page,
    syncedAt: string,
    previous?: PlatformCatalogSnapshot,
  ): Promise<PlatformCatalogSnapshot> {
    this.requireAuthenticatedPage(page);
    const currentRemoteId = new URL(page.url()).searchParams.get("projectId") ?? "";
    let currentContext: Record<string, unknown> = {};
    let teamRows: Array<Record<string, unknown>> = [];
    let skuRows: Array<Record<string, unknown>> = [];
    let clientRows: Array<Record<string, unknown>> = [];
    const selectorCaption = await firstVisible(page, this.selectors.projects.selectorTrigger);
    const currentWorkspaceName = ((await selectorCaption?.innerText().catch(() => "")) ?? "")
      .split(/[｜|]/)[0]?.trim() ?? "";
    const projectLists = new Map<string, Array<Record<string, unknown>>>();
    const pending = new Set<Promise<void>>();
    const rowsFromEnvelope = (value: unknown): Array<Record<string, unknown>> => {
      if (!value || typeof value !== "object") return [];
      const envelope = value as { code?: unknown; data?: unknown };
      if (Number(envelope.code) !== 0 || !Array.isArray(envelope.data)) return [];
      return envelope.data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    };
    const onResponse = (response: Response): void => {
      let url: URL;
      try {
        url = new URL(response.url());
      } catch {
        return;
      }
      if (!hostMatches(url.hostname, "blueaivideo.com") || response.request().method() !== "GET") return;
      if (!["/api/user/info/", "/api/team/list/", "/api/project/list", "/api/project/sku_type", "/api/client/list"].includes(url.pathname)) return;
      const task = response.json().then((body: unknown) => {
        if (url.pathname === "/api/user/info/") {
          const envelope = body && typeof body === "object" ? body as { code?: unknown; data?: unknown } : {};
          const data = Number(envelope.code) === 0 && envelope.data && typeof envelope.data === "object"
            ? envelope.data as Record<string, unknown>
            : {};
          currentContext = data.cur_group_team_info && typeof data.cur_group_team_info === "object"
            ? data.cur_group_team_info as Record<string, unknown>
            : {};
          return;
        }
        const rows = rowsFromEnvelope(body);
        if (url.pathname === "/api/team/list/") teamRows = rows;
        else if (url.pathname === "/api/project/sku_type") skuRows = rows;
        else if (url.pathname === "/api/client/list") clientRows = rows;
        else {
          const projectType = url.searchParams.get("project_type") ?? "";
          const teamId = url.searchParams.get("team_id") ?? "";
          projectLists.set(projectType === "PERSONAL_PROJECT" ? "personal" : `team:${teamId}`, rows);
        }
      }).catch(() => undefined).finally(() => pending.delete(task));
      pending.add(task);
    };

    page.on("response", onResponse);
    try {
      const homeUrl = platformHomeUrl(page.url(), this.selectors.baseUrl, this.selectors.projects.homePath);
      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const panel = await this.openProjectSelector(page);
      await this.showWorkspaceLayer(page, panel);
      const metadataDeadline = Date.now() + 3_000;
      while (Date.now() < metadataDeadline && !teamRows.length) {
        if (pending.size) await Promise.allSettled([...pending]);
        await page.waitForTimeout(50);
      }
      if (!teamRows.length) throw new Error("心影页面没有返回空间目录响应");
      const currentTeamId = typeof currentContext.team_id === "string" ? currentContext.team_id.trim() : "";
      const targets = teamRows.flatMap((row, sortOrder): Array<PlatformWorkspace & { listKey: string; teamId: string }> => {
        const personal = row.space_type === "PRIVATE";
        const teamId = typeof row.team_id === "string" ? row.team_id.trim() : "";
        const name = personal ? "个人空间" : typeof row.team_name === "string" ? row.team_name.trim() : "";
        if (!personal && (!teamId || !name)) return [];
        const kind: PlatformWorkspace["kind"] = personal ? "personal" : "team";
        return [{
          id: platformWorkspaceIdentity(kind, name),
          name,
          kind,
          description: personal ? "数据仅自己可见" : "项目与虚拟人像对团队成员共享",
          available: true,
          isCurrent: currentTeamId ? teamId === currentTeamId : name === currentWorkspaceName,
          sortOrder,
          lastSeenAt: syncedAt,
          listKey: personal ? "personal" : `team:${teamId}`,
          teamId,
        }];
      }).sort((left, right) => Number(left.isCurrent) - Number(right.isCurrent));
      let changedWorkspace = false;
      for (const target of targets) {
        if (target.isCurrent && !changedWorkspace && projectLists.has(target.listKey)) continue;
        const panel = await this.openProjectSelector(page);
        const items = await this.showWorkspaceLayer(page, panel);
        const responsePromise = page.waitForResponse((response) => {
          try {
            const url = new URL(response.url());
            if (url.pathname !== "/api/project/list" || response.request().method() !== "GET") return false;
            const personal = url.searchParams.get("project_type") === "PERSONAL_PROJECT";
            const teamId = url.searchParams.get("team_id") ?? "";
            return target.kind === "personal" ? personal : !personal && teamId === target.teamId;
          } catch {
            return false;
          }
        }, { timeout: 5_000 });
        let clicked = false;
        try {
          clicked = await items.evaluateAll((elements, requested) => {
            const match = elements.find((element) => {
              const text = ((element as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
              return requested.kind === "personal" ? text.includes("个人空间") : text === requested.name;
            });
            if (!(match instanceof HTMLElement)) return false;
            match.click();
            return true;
          }, { name: target.name, kind: target.kind });
        } catch (error) {
          void responsePromise.catch(() => undefined);
          throw error;
        }
        if (!clicked) {
          void responsePromise.catch(() => undefined);
          throw new Error(`心影找不到空间“${target.name}”`);
        }
        await responsePromise;
        if (!target.isCurrent) changedWorkspace = true;
        if (pending.size) await Promise.allSettled([...pending]);
        if (!projectLists.has(target.listKey)) throw new Error(`心影没有返回“${target.name}”的项目目录响应`);
      }
      if (pending.size) await Promise.allSettled([...pending]);
      await page.keyboard.press("Escape").catch(() => undefined);
    } finally {
      page.off("response", onResponse);
    }
    const expectedProjectLists = teamRows.filter((row) => row.space_type === "PRIVATE"
      || (typeof row.team_id === "string" && row.team_id.trim())).length;
    if (!teamRows.length || !expectedProjectLists || projectLists.size < expectedProjectLists) {
      throw new Error(`心影页面没有返回完整的空间或项目目录响应（应有 ${expectedProjectLists}，实际 ${projectLists.size}）`);
    }

    const groupId = typeof currentContext.group_id === "string" && currentContext.group_id
      ? currentContext.group_id
      : teamRows.find((row) => typeof row.group_id === "string" && row.group_id)?.group_id as string | undefined ?? "current";
    const workspaces = teamRows.flatMap((row) => {
      const personal = row.space_type === "PRIVATE";
      const teamId = typeof row.team_id === "string" ? row.team_id.trim() : "";
      const name = personal ? "个人空间" : typeof row.team_name === "string" ? row.team_name.trim() : "";
      if (!personal && (!teamId || !name)) return [];
      return [{
        key: personal ? `personal:${groupId}` : `team:${teamId}`,
        kind: personal ? "personal" as const : "team" as const,
        name,
        projectListKey: personal ? "personal" : `team:${teamId}`,
      }];
    });
    const projects = workspaces.flatMap((workspace) => (projectLists.get(workspace.projectListKey) ?? []).flatMap((row) => {
      const remoteId = typeof row.project_id === "string" ? row.project_id.trim() : "";
      const name = typeof row.project_name === "string" ? row.project_name.trim() : "";
      const shortId = typeof row.project_short_id === "string" ? row.project_short_id.trim() : "";
      return remoteId && name && shortId ? [{ workspaceKey: workspace.key, remoteId, name, shortId }] : [];
    }));
    const currentTeamId = typeof currentContext.team_id === "string" ? currentContext.team_id.trim() : "";
    const currentWorkspaceKey = currentTeamId
      ? `team:${currentTeamId}`
      : workspaces.find((workspace) => workspace.name === currentWorkspaceName)?.key ?? `personal:${groupId}`;
    let customerOptions = clientRows.flatMap((row) => typeof row.client_name === "string" ? [row.client_name] : []);
    let creationTypeOptions = skuRows.flatMap((row) => typeof row.merchant_name === "string" ? [row.merchant_name] : []);
    if (!customerOptions.length) customerOptions = previous?.customerOptions ?? [];
    if (!creationTypeOptions.length) creationTypeOptions = previous?.creationTypeOptions ?? [];
    if (!customerOptions.length && workspaces.some((workspace) => workspace.kind === "team")) {
      customerOptions = await this.readProjectCustomerOptions(page).catch(() => []);
    }
    if (!creationTypeOptions.length) {
      const options = await this.readProjectFormOptions(page);
      if (!customerOptions.length) customerOptions = options.customerOptions;
      creationTypeOptions = options.creationTypeOptions;
    }
    return platformCatalogFromApi({
      currentRemoteId,
      currentWorkspaceKey,
      workspaces: workspaces.map(({ key, kind, name }) => ({ key, kind, name })),
      projects,
      customerOptions,
      creationTypeOptions,
    }, syncedAt, this.selectors.baseUrl, this.selectors.projects.homePath);
  }

  private async readProjectCustomerOptions(page: Page): Promise<string[]> {
    let dialog = await firstVisible(page, this.selectors.projects.newProjectDialog);
    if (dialog) {
      const existingCancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
      if ((await existingCancel.count()) > 0) await clickDom(existingCancel).catch(() => undefined);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    const button = await firstVisible(page, this.selectors.projects.newProjectButtons);
    if (!button) return [];
    const responsePromise = page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        return hostMatches(url.hostname, "blueaivideo.com")
          && url.pathname === "/api/client/list" && response.request().method() === "GET";
      } catch {
        return false;
      }
    }, { timeout: 5_000 });
    try {
      await clickDom(button);
      dialog = await this.waitForVisible(page, this.selectors.projects.newProjectDialog, 5_000);
      if (!dialog) return [];
      const customerInput = await firstVisibleWithin(dialog, this.selectors.projects.customerInputs);
      if (customerInput) await clickDom(customerInput);
      const response = await responsePromise;
      const body = await response.json() as { code?: unknown; data?: unknown };
      if (Number(body.code) !== 0 || !Array.isArray(body.data)) return [];
      return [...new Set(body.data.flatMap((item) => item && typeof item === "object"
        && typeof (item as { client_name?: unknown }).client_name === "string"
        ? [(item as { client_name: string }).client_name.trim()]
        : []).filter(Boolean))];
    } finally {
      void responsePromise.catch(() => undefined);
      if (dialog) {
        const cancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
        if ((await cancel.count()) > 0) await clickDom(cancel).catch(() => undefined);
      }
    }
  }

  private async readProjectFormOptions(page: Page): Promise<{ customerOptions: string[]; creationTypeOptions: string[] }> {
    const existingDialog = await firstVisible(page, this.selectors.projects.newProjectDialog);
    if (existingDialog) {
      const existingCancel = existingDialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
      if ((await existingCancel.count()) > 0) {
        await clickDom(existingCancel);
        await existingDialog.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => undefined);
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
    const button = await firstVisible(page, this.selectors.projects.newProjectButtons);
    if (!button) return { customerOptions: [], creationTypeOptions: [] };
    await clickDom(button);
    const dialog = await this.waitForVisible(page, this.selectors.projects.newProjectDialog, 8_000);
    if (!dialog) return { customerOptions: [], creationTypeOptions: [] };
    const read = async (input: Locator | null, chooseFirst: boolean): Promise<string[]> => {
      if (!input) return [];
      await clickDom(input);
      const control = await input.getAttribute("aria-controls");
      const options = control ? page.locator(`[id="${control}"] [role="option"]`).filter({ visible: true }) : page.getByRole("option").filter({ visible: true });
      await options.first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
      const values = (await options.allTextContents()).map((item) => item.trim()).filter(Boolean);
      if (chooseFirst && values.length && !(await input.inputValue()).trim()) await clickDom(options.first());
      else await page.keyboard.press("Escape");
      return values;
    };
    try {
      const customerInput = await firstVisibleWithin(dialog, this.selectors.projects.customerInputs);
      const creationTypeInput = await firstVisibleWithin(dialog, this.selectors.projects.creationTypeInputs);
      const customerOptions = await read(customerInput, true);
      const creationTypeOptions = await read(creationTypeInput, false);
      return { customerOptions, creationTypeOptions };
    } finally {
      const cancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
      if ((await cancel.count()) > 0) await clickDom(cancel).catch(() => undefined);
    }
  }

  async syncPlatformCatalog(previous?: PlatformCatalogSnapshot): Promise<PlatformCatalogSnapshot> {
    const page = await this.page();
    const originalUrl = page.url();
    const syncedAt = new Date().toISOString();
    try {
      // Capture the read-only JSON responses that Heart's own selector issues.
      // This keeps the official workspace switch behavior while avoiding slow
      // card-by-card DOM reconstruction and returns every full projectId in one
      // sync. Keep the DOM route as a compatibility fallback if the response
      // schema changes.
      return await this.readPlatformCatalogApi(page, syncedAt, previous);
    } catch {
      // Fall through to the selector-driven compatibility path below.
    }
    const currentUrl = new URL(originalUrl);
    const currentRemoteId = currentUrl.searchParams.get("projectId") ?? "";
    const readCatalog = async (): Promise<PlatformCatalogSnapshot> => {
      await this.ensureHomePage(page);
      const trigger = await this.waitForVisible(page, this.selectors.projects.selectorTrigger, 20_000);
      const triggerParts = ((await trigger?.innerText().catch(() => "")) ?? "").split("｜").map((item) => item.trim());
      const currentWorkspaceName = triggerParts[0] ?? "";
      const currentProjectName = triggerParts[1] ?? "";
      let panel = await this.openProjectSelector(page);
      const workspaceItems = await this.showWorkspaceLayer(page, panel);
      const workspaces = await this.readWorkspaceList(workspaceItems, syncedAt, currentWorkspaceName);
      const projects: PlatformProject[] = [];
      for (const workspace of workspaces) {
        panel = await this.openProjectSelector(page);
        await this.chooseWorkspace(page, panel, workspace);
        projects.push(...await this.readProjectList(panel, workspace, syncedAt, workspace.isCurrent ? currentProjectName : "", workspace.isCurrent ? currentRemoteId : ""));
        const back = panel.getByText("返回", { exact: true }).filter({ visible: true }).first();
        if ((await back.count()) > 0) await clickDom(back);
      }
      const options = await this.readProjectFormOptions(page);
      const currentProject = projects.find((project) => project.isCurrent);
      return {
        workspaces,
        projects,
        currentWorkspaceId: workspaces.find((workspace) => workspace.isCurrent)?.id ?? "",
        currentProjectId: currentProject?.id ?? "",
        ...options,
        syncedAt,
      };
    };
    try {
      return await this.retryProjectNavigation(page, readCatalog);
    } finally {
      if (page.url() !== originalUrl) {
        await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      }
    }
  }

  async listPlatformConversations(catalog: PlatformCatalogSnapshot, projectId: string): Promise<PlatformConversation[]> {
    const project = catalog.projects.find((item) => item.id === projectId && item.available);
    if (!project) throw new AppError("PLATFORM_PROJECT_NOT_FOUND", "所选心影项目不在当前同步目录中");
    const workspace = catalog.workspaces.find((item) => item.id === project.workspaceId && item.available);
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "所选项目的心影空间当前不可用");
    const page = await this.page();
    const resolveRemoteId = async (): Promise<string> => {
      if (project.remoteId) return project.remoteId;
      await this.ensureHomePage(page);
      const panel = await this.openProjectSelector(page);
      await this.chooseWorkspace(page, panel, workspace);
      return this.chooseProject(page, panel, project);
    };
    const remoteId = await this.retryProjectNavigation(page, resolveRemoteId);
    const current = safeGenerationUrl(page.url());
    const currentSessionId = current?.searchParams.get("projectId") === remoteId
      ? current.searchParams.get("sessionId") ?? ""
      : "";
    if (current?.searchParams.get("projectId") !== remoteId) {
      const target = `${this.selectors.baseUrl.replace(/\/$/, "")}/avpAgent?projectId=${encodeURIComponent(remoteId)}`;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    this.requireAuthenticatedPage(page);
    const composer = await this.waitForVisible(page, this.selectors.generation.composer, 20_000);
    if (!composer) throw new AppError("GENERATION_PAGE_NOT_READY", "心影内容生成页未完成加载，暂时无法读取对话记录");
    let body: unknown;
    try {
      body = await page.evaluate(async ({ remoteProjectId }) => {
        const sessions: unknown[] = [];
        let pageNumber = 1;
        let total = Number.POSITIVE_INFINITY;
        while (sessions.length < total && pageNumber <= 100) {
          const url = new URL("/api/avp_agent/session/list", window.location.origin);
          url.searchParams.set("page", String(pageNumber));
          url.searchParams.set("page_size", "40");
          url.searchParams.set("project_id", remoteProjectId);
          url.searchParams.set("session_biz_type", "stooory");
          const response = await fetch(url.toString(), { method: "GET", credentials: "include" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const envelope = await response.json() as { code?: unknown; message?: unknown; data?: { sessions?: unknown[]; total?: unknown } };
          if (Number(envelope.code) !== 0) throw new Error(typeof envelope.message === "string" ? envelope.message : "心影返回了错误状态");
          const rows = Array.isArray(envelope.data?.sessions) ? envelope.data.sessions : [];
          sessions.push(...rows);
          const parsedTotal = Number(envelope.data?.total);
          total = Number.isFinite(parsedTotal) ? parsedTotal : sessions.length;
          if (!rows.length || rows.length < 40) break;
          pageNumber += 1;
        }
        return { code: 0, data: { sessions, total: Number.isFinite(total) ? total : sessions.length } };
      }, { remoteProjectId: remoteId });
    } catch (error) {
      throw new AppError("PLATFORM_CONVERSATIONS_LOAD_FAILED", "未能读取该项目的心影对话记录，请稍后重试", error);
    }
    return platformConversationsFromApi(body, project.id, currentSessionId);
  }

  async openPlatformProject(catalog: PlatformCatalogSnapshot, projectId: string, conversationId?: string): Promise<PlatformProjectBinding> {
    const project = catalog.projects.find((item) => item.id === projectId && item.available);
    if (!project) throw new AppError("PLATFORM_PROJECT_NOT_FOUND", "所选心影项目不在当前同步目录中");
    const workspace = catalog.workspaces.find((item) => item.id === project.workspaceId && item.available);
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "所选项目的心影空间当前不可用");
    const page = await this.page();
    const open = async () => {
      // Once a project has been opened, its full remoteId is persisted. Going
      // straight to avpAgent avoids the slow and occasionally stale selector.
      if (project.remoteId) {
        const generationUrl = await this.openGenerationSession(page, project.remoteId, conversationId);
        return { remoteId: project.remoteId, generationUrl };
      }
      await this.ensureHomePage(page);
      const panel = await this.openProjectSelector(page);
      await this.chooseWorkspace(page, panel, workspace);
      const remoteId = await this.chooseProject(page, panel, project);
      const generationUrl = await this.openGenerationSession(page, remoteId, conversationId);
      return { remoteId, generationUrl };
    };
    const { remoteId, generationUrl } = await this.retryProjectNavigation(page, open);
    return {
      workspace: { ...workspace, isCurrent: true, lastSeenAt: new Date().toISOString() },
      project: {
        ...project,
        remoteId,
        homeUrl: `${this.selectors.baseUrl.replace(/\/$/, "")}${this.selectors.projects.homePath}?projectId=${encodeURIComponent(remoteId)}`,
        isCurrent: true,
        lastSeenAt: new Date().toISOString(),
      },
      generationUrl,
    };
  }

  async createPlatformProject(catalog: PlatformCatalogSnapshot, input: PlatformProjectCreateInput): Promise<PlatformProjectBinding> {
    const workspace = catalog.workspaces.find((item) => item.id === input.workspaceId && item.available);
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "请选择有效的个人或团队空间");
    const name = input.name.trim();
    if (!name) throw new AppError("INVALID_PROJECT", "项目名称不能为空");
    const page = await this.page();
    await this.ensureHomePage(page);
    let panel = await this.openProjectSelector(page);
    await this.chooseWorkspace(page, panel, workspace);
    const anchorProject = catalog.projects.find((project) => project.workspaceId === workspace.id && project.available);
    if (anchorProject) {
      await this.chooseProject(page, panel, anchorProject);
      await this.ensureHomePage(page);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    const existingDialog = await firstVisible(page, this.selectors.projects.newProjectDialog);
    if (existingDialog) {
      const existingCancel = existingDialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
      if ((await existingCancel.count()) > 0) {
        await clickDom(existingCancel);
        await existingDialog.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => undefined);
      }
    }
    const button = await firstVisible(page, this.selectors.projects.newProjectButtons);
    if (!button) throw new AppError("NEW_PROJECT_BUTTON_NOT_FOUND", "找不到心影“新建项目”入口");
    await clickDom(button);
    const dialog = await this.waitForVisible(page, this.selectors.projects.newProjectDialog, 8_000);
    if (!dialog) throw new AppError("NEW_PROJECT_DIALOG_NOT_FOUND", "心影新建项目表单未打开");
    const nameInput = await firstVisibleWithin(dialog, this.selectors.projects.projectNameInputs);
    if (!nameInput) throw new AppError("NEW_PROJECT_FORM_CHANGED", "找不到心影项目名称输入框");
    await nameInput.fill(name);
    const choose = async (combo: Locator, value: string): Promise<void> => {
      await clickDom(combo);
      const option = page.getByRole("option", { name: value, exact: true }).filter({ visible: true }).first();
      await option.waitFor({ state: "visible", timeout: 8_000 });
      await clickDom(option);
    };
    const customerCombo = await firstVisibleWithin(dialog, this.selectors.projects.customerInputs);
    const creationTypeCombo = await firstVisibleWithin(dialog, this.selectors.projects.creationTypeInputs);
    if (customerCombo) {
      if (!input.customer.trim()) throw new AppError("NEW_PROJECT_CUSTOMER_REQUIRED", "团队空间新建项目必须选择所属客户");
      await choose(customerCombo, input.customer);
    }
    if (!creationTypeCombo) throw new AppError("NEW_PROJECT_FORM_CHANGED", "心影新建项目缺少“视频创作类型”字段");
    await choose(creationTypeCombo, input.creationType);
    const confirm = dialog.getByText("确认", { exact: true }).filter({ visible: true }).first();
    if ((await confirm.count()) === 0 || !(await confirm.isEnabled())) throw new AppError("NEW_PROJECT_FORM_INCOMPLETE", "心影新建项目表单尚未满足提交条件");
    await clickDom(confirm);
    await dialog.waitFor({ state: "hidden", timeout: 20_000 });
    const deadline = Date.now() + 20_000;
    let remoteId = "";
    while (Date.now() < deadline) {
      remoteId = new URL(page.url()).searchParams.get("projectId") ?? "";
      const trigger = await firstVisible(page, this.selectors.projects.selectorTrigger);
      if (remoteId && ((await trigger?.innerText().catch(() => "")) ?? "").includes(name)) break;
      await page.waitForTimeout(250);
    }
    if (!remoteId) throw new AppError("PLATFORM_PROJECT_CREATE_FAILED", "心影未返回新项目编号");
    panel = await this.openProjectSelector(page);
    if ((await panel.getByText("项目列表", { exact: true }).filter({ visible: true }).count()) === 0) await this.chooseWorkspace(page, panel, workspace);
    const rows = await this.readProjectList(panel, workspace, new Date().toISOString(), name, remoteId);
    const created = rows.find((item) => item.name === name) ?? {
      id: platformProjectIdentity(workspace.id, name, remoteId),
      workspaceId: workspace.id,
      name,
      shortId: remoteId.slice(0, 8),
      remoteId,
      homeUrl: `${this.selectors.baseUrl.replace(/\/$/, "")}${this.selectors.projects.homePath}?projectId=${encodeURIComponent(remoteId)}`,
      available: true,
      isCurrent: true,
      sortOrder: 0,
      lastSeenAt: new Date().toISOString(),
    };
    const generationUrl = await this.openGenerationSession(page, remoteId);
    return { workspace: { ...workspace, isCurrent: true }, project: { ...created, remoteId, isCurrent: true }, generationUrl };
  }

  async syncPlatformPortraits(targetUrl?: string, modelName = "Seedance 2.5 全能参考", workspaceId = ""): Promise<PlatformPortrait[]> {
    const page = await this.page();
    const originalUrl = page.url();
    const target = targetUrl ? safeGenerationUrl(targetUrl) : safeGenerationUrl(originalUrl);
    if (!target) throw new AppError("GENERATION_PAGE_REQUIRED", "请先绑定或打开一个心影内容生成会话，再同步虚拟人像库");
    if (safeGenerationUrl(page.url())?.toString() !== target.toString()) {
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    this.requireAuthenticatedPage(page);
    const composer = await this.waitForVisible(page, this.selectors.generation.composer, 20_000);
    if (!composer) throw new AppError("GENERATION_PAGE_NOT_READY", "心影内容生成页未完成加载");
    const modelToggle = await firstVisible(page, this.selectors.generation.modelToggle);
    const originalModel = (await modelToggle?.innerText().catch(() => ""))?.trim() ?? "";
    const modelCheckpoint = await this.configureModel(page, modelName);
    if (modelCheckpoint) throw new AppError("PORTRAIT_MODEL_UNAVAILABLE", modelCheckpoint.message);
    const entry = await firstVisible(page, this.selectors.generation.portraitEntry);
    if (!entry) throw new AppError("PORTRAIT_PICKER_NOT_FOUND", "当前心影模型未显示“+V角色”入口");

    let dialog: Locator | null = null;
    try {
      await clickDom(entry);
      dialog = await this.waitForVisible(page, this.selectors.generation.portraitDialog, 8_000);
      if (!dialog) throw new AppError("PORTRAIT_PICKER_NOT_FOUND", "心影认证角色库未打开");
      await dialog.waitFor({ state: "visible", timeout: 8_000 });
      await this.setPortraitSourceFilter(page, dialog, "全部");
      const cards = await waitForCollectionWithin(dialog, this.selectors.generation.portraitCards, 20_000);
      if (!cards) throw new AppError("PORTRAIT_LIBRARY_EMPTY", "心影认证角色库没有可同步的人像卡片");
      // “全部人像”会持续按约 45 张一批追加，实际不是一个可穷尽的快照。
      // 读取最新的一段窗口并由本地增量合并；不能因本轮未滚到旧角色而将其失效。
      await this.loadPortraitCards(page, cards, 30, 6, 400);
      const syncedAt = new Date().toISOString();
      const entries = await this.readPortraitCardEntries(cards);
      const unique = new Map<string, PlatformPortrait>();
      for (const [index, item] of entries.entries()) {
        const identity = platformPortraitIdentity(item.displayName, item.previewUrl, workspaceId);
        unique.set(identity.id, {
          ...identity,
          displayName: item.displayName,
          previewUrl: item.previewUrl,
          workspaceId,
          mediaKind: portraitMediaKindFromPreviewUrl(item.previewUrl),
          sortOrder: index,
          deleteSortOrder: null,
          canDelete: item.canDelete,
          available: true,
          lastSeenAt: syncedAt,
        });
      }
      await this.setPortraitSourceFilter(page, dialog, "上传人像");
      const uploadedCards = await waitForCollectionWithin(dialog, this.selectors.generation.portraitCards, 20_000);
      if (!uploadedCards) throw new AppError("PORTRAIT_LIBRARY_EMPTY", "心影上传人像筛选结果为空");
      await this.loadPortraitCards(page, uploadedCards, 30, 6, 400);
      const uploadedEntries = await this.readPortraitCardEntries(uploadedCards);
      for (const [index, item] of uploadedEntries.entries()) {
        const identity = platformPortraitIdentity(item.displayName, item.previewUrl, workspaceId);
        const existing = unique.get(identity.id);
        unique.set(identity.id, {
          ...identity,
          displayName: item.displayName,
          previewUrl: item.previewUrl,
          workspaceId,
          mediaKind: existing?.mediaKind ?? portraitMediaKindFromPreviewUrl(item.previewUrl),
          sortOrder: existing?.sortOrder ?? unique.size,
          deleteSortOrder: index,
          canDelete: item.canDelete,
          available: true,
          lastSeenAt: syncedAt,
        });
      }
      await this.setPortraitSourceFilter(page, dialog, "全部");
      return [...unique.values()];
    } finally {
      if (dialog && (await dialog.isVisible().catch(() => false))) {
        const cancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
        if ((await cancel.count()) > 0) await clickDom(cancel).catch(() => undefined);
      }
      if (originalModel && originalModel !== modelName && safeGenerationUrl(page.url())) {
        await this.configureModel(page, originalModel).catch(() => undefined);
      }
      if (originalUrl !== page.url()) {
        let restore: URL | null = null;
        try {
          const parsed = new URL(originalUrl);
          if (hostMatches(parsed.hostname, "blueaivideo.com")) restore = parsed;
        } catch {
          restore = null;
        }
        if (restore) await page.goto(restore.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      }
    }
  }

  private async setPortraitSourceFilter(page: Page, dialog: Locator, label: "全部" | "上传人像"): Promise<void> {
    const trigger = dialog.locator(".filter-trigger").filter({ visible: true }).first();
    if ((await trigger.count()) === 0) throw new AppError("PORTRAIT_FILTER_NOT_FOUND", "找不到心影角色来源筛选入口");
    await clickDom(trigger);
    await page.waitForTimeout(150);
    const options = page.locator(".filter-tag").filter({ visible: true });
    let target: Locator | null = null;
    for (let index = 0; index < await options.count(); index += 1) {
      const candidate = options.nth(index);
      const text = (await candidate.innerText().catch(() => "")).trim();
      const className = (await candidate.getAttribute("class")) ?? "";
      if (text === label && !className.includes("disabled")) {
        target = candidate;
        break;
      }
    }
    if (!target) throw new AppError("PORTRAIT_FILTER_CHANGED", `心影角色筛选中找不到“${label}”`);
    const className = (await target.getAttribute("class")) ?? "";
    if (!className.includes("active")) await clickDom(target);
    const confirm = page.locator(".confirm-btn").filter({ visible: true }).first();
    if ((await confirm.count()) === 0) throw new AppError("PORTRAIT_FILTER_CHANGED", "心影角色筛选确认按钮不存在");
    await clickDom(confirm);
    await page.waitForTimeout(650);
  }

  private async readPortraitCardEntries(cards: Locator): Promise<Array<{ displayName: string; previewUrl: string; canDelete: boolean }>> {
    return cards.evaluateAll((elements) => elements.map((card) => ({
      displayName: (card.querySelector(".face-name-text")?.textContent ?? card.textContent ?? "").replace(/\s+/g, " ").trim(),
      previewUrl: card.querySelector<HTMLImageElement>("img:not(.previewBg)")?.src
        ?? card.querySelector<HTMLImageElement>("img")?.src
        ?? "",
      canDelete: Boolean(card.querySelector(".icon-shanchu")),
    })).filter((item) => item.displayName && item.previewUrl));
  }

  private async loadPortraitCards(page: Page, cards: Locator, maxRounds: number, stableThreshold: number, delayMs: number): Promise<void> {
    let stableRounds = 0;
    let highestCount = -1;
    for (let round = 0; round < maxRounds && stableRounds < stableThreshold; round += 1) {
      const count = await cards.count();
      if (count > 0) await cards.last().scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(delayMs);
      const nextCount = await cards.count();
      if (nextCount > highestCount) {
        highestCount = nextCount;
        stableRounds = 0;
      } else {
        stableRounds += 1;
      }
    }
  }

  private async findPlatformPortraitCard(cards: Locator, portrait: PlatformPortrait): Promise<Locator | null> {
    const candidates = cards.filter({ hasText: portrait.displayName });
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      const exactName = (await candidate.locator(".face-name-text").innerText().catch(() => "")).trim() === portrait.displayName;
      const imageUrl = await candidate.locator("img:not(.previewBg)").first().getAttribute("src").catch(() => null)
        ?? await candidate.locator("img").first().getAttribute("src").catch(() => null);
      const sameAsset = !imageUrl || imageUrl.split("?")[0] === portrait.previewUrl.split("?")[0];
      if (exactName && sameAsset) return candidate;
    }
    return null;
  }

  async deletePlatformPortraits(
    targetUrl: string,
    modelName: string,
    portraits: PlatformPortrait[],
    onProgress?: (progress: PlatformPortraitDeleteProgress) => void,
  ): Promise<PlatformPortraitDeleteResult> {
    const result: PlatformPortraitDeleteResult = { requestedIds: portraits.map((portrait) => portrait.id), deletedIds: [] };
    const report = (
      status: PlatformPortraitDeleteProgress["status"],
      index: number,
      portrait: PlatformPortrait | null,
      message: string,
    ) => onProgress?.({
      status,
      requestedIds: result.requestedIds,
      deletedIds: [...result.deletedIds],
      currentId: portrait?.id ?? null,
      currentName: portrait?.displayName ?? null,
      current: index,
      total: portraits.length,
      message,
    });
    const page = await this.page();
    const originalUrl = page.url();
    const target = safeGenerationUrl(targetUrl);
    if (!target) throw new AppError("GENERATION_PAGE_REQUIRED", "请先选择一个已绑定的心影项目，再删除虚拟人像");
    if (safeGenerationUrl(page.url())?.toString() !== target.toString()) {
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    this.requireAuthenticatedPage(page);
    const composer = await this.waitForVisible(page, this.selectors.generation.composer, 20_000);
    if (!composer) throw new AppError("GENERATION_PAGE_NOT_READY", "心影内容生成页未完成加载");
    const modelToggle = await firstVisible(page, this.selectors.generation.modelToggle);
    const originalModel = (await modelToggle?.innerText().catch(() => ""))?.trim() ?? "";
    const modelCheckpoint = await this.configureModel(page, modelName);
    if (modelCheckpoint) throw new AppError("PORTRAIT_MODEL_UNAVAILABLE", modelCheckpoint.message);
    const entry = await firstVisible(page, this.selectors.generation.portraitEntry);
    if (!entry) throw new AppError("PORTRAIT_PICKER_NOT_FOUND", "当前心影模型未显示“+V角色”入口");

    let dialog: Locator | null = null;
    try {
      await clickDom(entry);
      dialog = await this.waitForVisible(page, this.selectors.generation.portraitDialog, 8_000);
      if (!dialog) throw new AppError("PORTRAIT_PICKER_NOT_FOUND", "心影认证角色库未打开");
      await this.setPortraitSourceFilter(page, dialog, "上传人像");
      const initialCards = await waitForCollectionWithin(dialog, this.selectors.generation.portraitCards, 20_000);
      if (!initialCards) throw new AppError("PORTRAIT_LIBRARY_EMPTY", "心影认证角色库没有可管理的人像卡片");
      await this.loadPortraitCards(page, initialCards, 30, 6, 400);

      for (const [index, portrait] of portraits.entries()) {
        try {
          report("deleting", index + 1, portrait, `正在删除 ${index + 1} / ${portraits.length}：${portrait.displayName}`);
          const cards = await firstCollectionWithin(dialog, this.selectors.generation.portraitCards);
          if (!cards) throw new AppError("PORTRAIT_LIBRARY_EMPTY", "心影认证角色库没有可管理的人像卡片");
          const matched = await this.findPlatformPortraitCard(cards, portrait);
          if (!matched) throw new AppError("PLATFORM_PORTRAIT_NOT_FOUND", `心影角色库中找不到“${portrait.displayName}”，请重新同步`);
          await matched.scrollIntoViewIfNeeded().catch(() => undefined);
          const deleteIcon = matched.locator(".icon-shanchu").filter({ visible: true }).first();
          if ((await deleteIcon.count()) === 0) {
            throw new AppError("PLATFORM_PORTRAIT_DELETE_FORBIDDEN", `心影未提供“${portrait.displayName}”的删除权限`);
          }
          await clickDom(deleteIcon);
          const title = page.getByText("确定删除角色", { exact: true }).filter({ visible: true }).last();
          await title.waitFor({ state: "visible", timeout: 8_000 });
          const popover = title.locator("xpath=ancestor::*[contains(@class,'el-popper') or contains(@class,'el-popover')][1]");
          const confirmationScope = (await popover.count()) > 0 ? popover : title.locator("xpath=../..");
          const irreversible = confirmationScope.getByText("删除后，角色将不可恢复。", { exact: true }).filter({ visible: true }).first();
          if ((await irreversible.count()) === 0) throw new AppError("PLATFORM_DELETE_DIALOG_CHANGED", "心影删除确认框内容已变化，已停止操作");
          const confirmDelete = confirmationScope.getByText("确定", { exact: true }).filter({ visible: true }).first();
          if ((await confirmDelete.count()) === 0 || !(await confirmDelete.isEnabled())) {
            throw new AppError("PLATFORM_DELETE_CONFIRM_UNAVAILABLE", "心影删除确认按钮不可用");
          }
          await clickDom(confirmDelete);

          const deadline = Date.now() + 20_000;
          let disappeared = false;
          while (Date.now() < deadline) {
            const currentCards = await firstCollectionWithin(dialog, this.selectors.generation.portraitCards);
            if (!currentCards || !(await this.findPlatformPortraitCard(currentCards, portrait))) {
              disappeared = true;
              break;
            }
            await page.waitForTimeout(250);
          }
          if (!disappeared) throw new AppError("PLATFORM_PORTRAIT_DELETE_UNCONFIRMED", `心影未确认删除“${portrait.displayName}”`);
          result.deletedIds.push(portrait.id);
          report("deleted", index + 1, portrait, `已删除 ${index + 1} / ${portraits.length}：${portrait.displayName}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.failed = { id: portrait.id, displayName: portrait.displayName, message };
          report("failed", index + 1, portrait, `删除“${portrait.displayName}”失败：${message}`);
          break;
        }
      }
      return result;
    } finally {
      if (dialog && (await dialog.isVisible().catch(() => false))) {
        const popoverCancel = page.locator(".faceCard-delete-confirm").filter({ visible: true }).getByText("取消", { exact: true }).filter({ visible: true }).first();
        if ((await popoverCancel.count()) > 0) await clickDom(popoverCancel).catch(() => undefined);
        await this.setPortraitSourceFilter(page, dialog, "全部").catch(() => undefined);
        const cancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).last();
        if ((await cancel.count()) > 0) await clickDom(cancel).catch(() => undefined);
      }
      if (originalModel && originalModel !== modelName && safeGenerationUrl(page.url())) {
        await this.configureModel(page, originalModel).catch(() => undefined);
      }
      if (originalUrl !== page.url()) {
        let restore: URL | null = null;
        try {
          const parsed = new URL(originalUrl);
          if (hostMatches(parsed.hostname, "blueaivideo.com")) restore = parsed;
        } catch {
          restore = null;
        }
        if (restore) await page.goto(restore.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      }
    }
  }

  private async checkpoint(page: Page): Promise<HumanCheckpoint | null> {
    if (page.url().includes("/login")) return { reason: "login", message: "心影登录已失效，请重新飞书扫码" };
    for (const text of this.selectors.humanCheckpointTexts) {
      const candidates = page.getByText(text, { exact: false }).filter({ visible: true });
      let actionable = false;
      for (let index = 0; index < Math.min(await candidates.count(), 20); index += 1) {
        const candidate = candidates.nth(index);
        const outsideConversation = await candidate.evaluate((element) =>
          !element.closest(".ContentChatListItem, .ContentChatInput, .mention-editor"),
        ).catch(() => false);
        if (outsideConversation) {
          actionable = true;
          break;
        }
      }
      if (actionable) {
        const reason: HumanCheckpoint["reason"] = text.includes("支付") || text.includes("余额")
          ? "payment"
          : text.includes("实名")
            ? "identity"
            : text.includes("验证") || text.includes("验证码")
              ? "captcha"
              : text.includes("登录") || text.includes("扫码")
                ? "login"
                : "approval";
        return { reason, message: `心影页面需要人工处理：${text}` };
      }
    }
    return null;
  }

  private async ensureGenerationPage(job: Job): Promise<Page | AdapterOutcome> {
    const page = await this.page();
    const targetValue = stringParameter(job, "platformUrl");
    if (targetValue) {
      const target = safeGenerationUrl(targetValue);
      if (!target || !target.searchParams.get("projectId")) {
        return {
          status: "needs-human",
          checkpoint: { reason: "page-changed", message: "项目绑定的心影生成链接无效，请重新选择该项目" },
        };
      }
      const recordedRef = decodeChatTaskRef(job.platformTaskId) ?? decodePendingTaskRef(job.platformTaskId);
      const recordedSessionId = recordedRef?.sessionId && recordedRef.sessionId !== "uninitialized" ? recordedRef.sessionId : "";
      if (!target.searchParams.get("sessionId") && recordedSessionId) target.searchParams.set("sessionId", recordedSessionId);
      const current = safeGenerationUrl(page.url());
      const sameProject = current?.searchParams.get("projectId") === target.searchParams.get("projectId");
      const sameSession = !target.searchParams.get("sessionId") || current?.searchParams.get("sessionId") === target.searchParams.get("sessionId");
      if (!sameProject || !sameSession) {
        await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(600);
      }
    }
    const checkpoint = await this.checkpoint(page);
    if (checkpoint) {
      return checkpoint.reason === "login"
        ? { status: "needs-login", message: checkpoint.message }
        : { status: "needs-human", checkpoint };
    }
    if (!safeGenerationUrl(page.url())) {
      return {
        status: "needs-human",
        checkpoint: { reason: "page-changed", message: "请为项目绑定心影 avpAgent 会话链接，或在原网页模式中打开内容生成会话" },
      };
    }
    const composer = await this.waitForVisible(page, this.selectors.generation.composer, 20_000);
    if (!composer) {
      const delayedCheckpoint = await this.checkpoint(page);
      if (delayedCheckpoint) {
        return delayedCheckpoint.reason === "login"
          ? { status: "needs-login", message: delayedCheckpoint.message }
          : { status: "needs-human", checkpoint: delayedCheckpoint };
      }
      return {
        status: "needs-human",
        checkpoint: { reason: "page-changed", message: "心影生成页在 20 秒内未完成加载，请在原网页模式检查页面或刷新后恢复任务" },
      };
    }
    return page;
  }

  private async uploadedMaterialCount(page: Page): Promise<number> {
    const list = await firstVisible(page, this.selectors.generation.materialList);
    if (!list) return 0;
    return list.locator(":scope > *").evaluateAll((elements) => {
      const staticLabels = new Set(["+V角色", "图片", "视频", "音频", "首帧", "尾帧"]);
      return elements.filter((element) => !staticLabels.has((element.textContent ?? "").trim())).length;
    });
  }

  private async uploadedMaterialLabels(page: Page): Promise<string[]> {
    return (await this.uploadedMaterialSnapshots(page)).map((material) => material.label);
  }

  private async uploadedMaterialSnapshots(page: Page): Promise<UploadedMaterialSnapshot[]> {
    const list = await firstVisible(page, this.selectors.generation.materialList);
    if (!list) return [];
    return list.locator(":scope > *").evaluateAll((elements) => elements.flatMap((element) => {
      const label = (element.textContent ?? "").trim();
      if (!/^(?:图|视频|音频)\d+$/.test(label)) return [];
      const previewParts = [element.getAttribute("style") ?? ""];
      for (const child of Array.from(element.querySelectorAll("[style], [src], [poster]"))) {
        previewParts.push(child.getAttribute("style") ?? "", child.getAttribute("src") ?? "", child.getAttribute("poster") ?? "");
      }
      return [{ label, previewText: previewParts.filter(Boolean).join("\n") }];
    }));
  }

  private async clearUploadedMaterials(page: Page): Promise<void> {
    const list = await firstVisible(page, this.selectors.generation.materialList);
    if (!list) return;
    for (let guard = 0; guard < 60; guard += 1) {
      const material = list.locator(":scope > .ContentChatUploadItem").filter({ has: page.locator(".content-delete") }).last();
      if ((await material.count()) === 0) break;
      const remove = material.locator(".content-delete").first();
      await remove.evaluate((element) => (element as HTMLElement).click());
      await page.waitForTimeout(100);
    }
    if ((await this.uploadedMaterialCount(page)) !== 0) throw new AppError("DRAFT_CLEAR_FAILED", "APP 未能清空心影素材草稿");
  }

  private async reuseGenerationDraft(
    page: Page,
    job: Job,
    sourcePlatformTaskId: string,
    expectedMaterialCount: number,
    firstLastMode: boolean,
  ): Promise<{ promptForPlatform: string } | HumanCheckpoint> {
    const sourceRef = decodeChatTaskRef(sourcePlatformTaskId);
    const target = safeGenerationUrl(stringParameter(job, "platformUrl"));
    if (!sourceRef || !target || sourceRef.projectId !== target.searchParams.get("projectId")) {
      return { reason: "page-changed", message: "批次上一条任务缺少可复用的心影会话定位，已安全停止后续提交" };
    }

    const current = safeGenerationUrl(page.url());
    if (sourceRef.sessionId !== "uninitialized" && current?.searchParams.get("sessionId") !== sourceRef.sessionId) {
      target.searchParams.set("sessionId", sourceRef.sessionId);
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(600);
      const composer = await this.waitForVisible(page, this.selectors.generation.composer, 20_000);
      if (!composer) return { reason: "page-changed", message: "上一条心影会话未能加载，无法使用“重新编辑”复用提交" };
    }

    await this.clearUploadedMaterials(page).catch(() => undefined);
    const prompt = await firstVisible(page, this.selectors.generation.prompt);
    if (!prompt) return { reason: "page-changed", message: "找不到心影提示词输入框，无法复用上一条生成" };
    await prompt.fill("");

    let source: Awaited<ReturnType<PlaywrightXinyingAdapter["userForTask"]>> = null;
    const sourceDeadline = Date.now() + 12_000;
    while (Date.now() < sourceDeadline && !source) {
      source = await this.userForTask(page, sourceRef, job.promptSnapshot);
      if (!source) await page.waitForTimeout(250);
    }
    if (!source) return { reason: "page-changed", message: "找不到批次上一条心影消息，无法使用“重新编辑”复用提交" };

    const edit = source.user.locator("a.edit-btn").filter({ visible: true }).first();
    if ((await edit.count()) === 0) {
      return { reason: "page-changed", message: "心影没有显示“重新编辑”入口，已停止后续批次以避免重复上传或错单" };
    }
    await clickDom(edit);

    let promptForPlatform = "";
    const hydrateDeadline = Date.now() + 15_000;
    while (Date.now() < hydrateDeadline) {
      promptForPlatform = (await prompt.innerText().catch(() => "")).trim();
      const materialCount = await this.uploadedMaterialCount(page);
      const promptReady = normalizeReusablePrompt(promptForPlatform) === normalizeReusablePrompt(job.promptSnapshot);
      const materialsReady = firstLastMode || materialCount === expectedMaterialCount;
      if (promptReady && materialsReady) break;
      await page.waitForTimeout(250);
    }
    if (normalizeReusablePrompt(promptForPlatform) !== normalizeReusablePrompt(job.promptSnapshot)) {
      await this.clearUploadedMaterials(page).catch(() => undefined);
      await prompt.fill("").catch(() => undefined);
      return { reason: "page-changed", message: "心影“重新编辑”还原的提示词与本批次快照不一致，已安全停止" };
    }

    if (!firstLastMode) {
      const materials = await this.uploadedMaterialSnapshots(page);
      if (materials.length !== expectedMaterialCount || new Set(materials.map((material) => material.label)).size !== expectedMaterialCount) {
        await this.clearUploadedMaterials(page).catch(() => undefined);
        await prompt.fill("").catch(() => undefined);
        return { reason: "page-changed", message: `心影“重新编辑”只还原了 ${materials.length}/${expectedMaterialCount} 项素材，已安全停止` };
      }
      const actualLabels = new Set(materials.map((material) => `@${material.label}`));
      const invalidLabels = [...new Set(promptMaterialLabels(promptForPlatform).filter((label) => !actualLabels.has(label)))];
      if (invalidLabels.length) {
        await this.clearUploadedMaterials(page).catch(() => undefined);
        await prompt.fill("").catch(() => undefined);
        return { reason: "page-changed", message: `心影“重新编辑”后的提示词引用了未还原素材：${invalidLabels.join("、")}` };
      }
    }
    return { promptForPlatform };
  }

  private async referenceUploadInput(page: Page, mimeType: string): Promise<Locator | null> {
    const kind = mediaKindFromMime(mimeType);
    const extension = kind === "audio" ? ".wav" : kind === "video" ? ".mp4" : ".png";
    const inputs = page.locator(`input[type='file'][accept*='${extension}']`);
    return (await inputs.count()) > 0 ? inputs.first() : null;
  }

  private mediaKindFromPlatformLabel(label: string): PlatformPortrait["mediaKind"] | "audio" {
    if (label.startsWith("视频")) return "video";
    if (label.startsWith("音频")) return "audio";
    return "image";
  }

  private async waitForMaterialCount(page: Page, expected: number): Promise<boolean> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if ((await this.uploadedMaterialCount(page)) >= expected) return true;
      const failure = page.getByText(/上传失败|素材解析失败|文件不支持/).filter({ visible: true }).first();
      if ((await failure.count()) > 0) return false;
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async configureModel(page: Page, modelName: string): Promise<HumanCheckpoint | null> {
    if (!modelName) return null;
    const toggle = await firstVisible(page, this.selectors.generation.modelToggle);
    if (!toggle) return { reason: "page-changed", message: "找不到心影模型选择入口" };
    const settleDeadline = Date.now() + 5_000;
    while (Date.now() < settleDeadline) {
      if ((await toggle.innerText().catch(() => "")).trim().includes(modelName)) return null;
      await page.waitForTimeout(200);
    }
    await clickDom(toggle);
    const dialog = await firstVisible(page, this.selectors.generation.modelDialog);
    if (!dialog) return { reason: "page-changed", message: "心影模型选择面板未打开" };
    const option = dialog.getByText(modelName, { exact: true }).filter({ visible: true }).first();
    if ((await option.count()) === 0) {
      return { reason: "page-changed", message: `当前心影账号未显示模型：${modelName}` };
    }
    await clickDom(option);
    await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(350);
    if (!(await toggle.innerText()).trim().includes(modelName)) {
      return { reason: "page-changed", message: `心影未确认切换到模型：${modelName}` };
    }
    return null;
  }

  private async configureParameters(page: Page, job: Job): Promise<HumanCheckpoint | null> {
    const toggle = await firstVisible(page, this.selectors.generation.parameterToggle);
    if (!toggle) return { reason: "page-changed", message: "找不到心影比例、分辨率和时长设置入口" };
    const openPopover = async (): Promise<Locator | null> => {
      const alreadyOpen = await firstVisible(page, this.selectors.generation.parameterPopover);
      if (alreadyOpen) return alreadyOpen;
      const liveToggle = await firstVisible(page, this.selectors.generation.parameterToggle);
      if (!liveToggle) return null;
      await clickDom(liveToggle);
      await page.waitForTimeout(150);
      return firstVisible(page, this.selectors.generation.parameterPopover);
    };

    const aspectRatio = explicitParameterValue(job, "aspectRatio");
    const resolution = explicitParameterValue(job, "resolution");
    for (const value of [aspectRatio, resolution].filter((item): item is string => Boolean(item))) {
      if ((await toggle.innerText().catch(() => "")).includes(value)) continue;
      const popover = await openPopover();
      if (!popover) return { reason: "page-changed", message: "心影参数面板未打开" };
      const option = popover.getByText(value, { exact: true }).filter({ visible: true }).first();
      if ((await option.count()) === 0) return { reason: "page-changed", message: `当前模型不支持参数：${value}` };
      await clickDom(option);
      await page.waitForTimeout(150);
      if (!(await toggle.innerText().catch(() => "")).includes(value)) {
        return { reason: "page-changed", message: `心影未确认参数：${value}` };
      }
    }

    const duration = Number(job.parameters.duration);
    if (Number.isInteger(duration) && !(await toggle.innerText().catch(() => "")).includes(`${duration}s`)) {
      const popover = await openPopover();
      if (!popover) return { reason: "page-changed", message: "心影参数面板未打开" };
      const adaptive = popover.locator("input[role='switch']").first();
      if ((await adaptive.count()) > 0 && (await adaptive.getAttribute("aria-checked")) === "true") {
        await clickDom(adaptive.locator("xpath=.."));
        await page.waitForTimeout(150);
      }
      const durationInput = popover.locator("input[role='spinbutton']").first();
      if ((await durationInput.count()) === 0) return { reason: "page-changed", message: "找不到心影时长输入框" };
      await durationInput.evaluate((input, nextDuration) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, String(nextDuration));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      }, duration);
      await page.waitForTimeout(300);
      if (Number(await durationInput.inputValue()) !== duration) {
        return { reason: "page-changed", message: `心影未接受时长参数：${duration} 秒` };
      }
    }

    const openAfterConfiguration = await firstVisible(page, this.selectors.generation.parameterPopover);
    if (openAfterConfiguration) await clickDom(toggle).catch(() => undefined);
    const audioToggle = await firstVisible(page, this.selectors.generation.audioToggle);
    const requested = Boolean(job.parameters.audioEnabled);
    if (!audioToggle && requested) {
      return { reason: "page-changed", message: "当前心影模型未显示声音开关，无法确认“生成声音”参数" };
    }
    if (audioToggle) {
      const enabled = audioToggle ? (await audioToggle.getAttribute("class"))?.includes("isActive") === true : false;
      if (enabled !== requested) {
        await clickDom(audioToggle);
        await page.waitForTimeout(100);
      }
      const confirmed = ((await audioToggle.getAttribute("class")) ?? "").includes("isActive");
      if (confirmed !== requested) {
        return { reason: "page-changed", message: `心影未确认声音参数：${requested ? "有声" : "无声"}` };
      }
    }
    return null;
  }

  private async selectPlatformPortraits(page: Page, portraits: PlatformPortrait[], expectedMaterialCount = portraits.length): Promise<HumanCheckpoint | null> {
    if (!portraits.length) return null;
    const entry = await firstVisible(page, this.selectors.generation.portraitEntry);
    if (!entry) return { reason: "page-changed", message: "当前心影模型未显示“+V角色”入口" };
    await clickDom(entry);
    const dialog = await this.waitForVisible(page, this.selectors.generation.portraitDialog, 8_000);
    if (!dialog) return { reason: "page-changed", message: "心影认证角色库未打开" };
    await dialog.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);

    for (const portrait of portraits) {
      const collection = await waitForCollectionWithin(dialog, this.selectors.generation.portraitCards, 20_000);
      if (!collection) return { reason: "page-changed", message: "心影认证角色库没有可选择的人像卡片" };
      const cards = collection.filter({ hasText: portrait.displayName });
      let matched: Locator | null = null;
      for (let index = 0; index < await cards.count(); index += 1) {
        const candidate = cards.nth(index);
        const exactName = (await candidate.locator(".face-name-text").innerText().catch(() => "")).trim() === portrait.displayName;
        const imageUrl = await candidate.locator("img:not(.previewBg)").first().getAttribute("src").catch(() => null);
        const sameAsset = !imageUrl || imageUrl.split("?")[0] === portrait.previewUrl.split("?")[0];
        if (exactName && sameAsset) {
          matched = candidate;
          break;
        }
      }
      if (!matched) {
        const cancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
        if ((await cancel.count()) > 0) await clickDom(cancel).catch(() => undefined);
        return { reason: "approval", message: `心影认证角色库中找不到已选虚拟人像：${portrait.displayName}，请重新同步` };
      }
      await matched.scrollIntoViewIfNeeded().catch(() => undefined);
      const checkbox = await firstVisibleWithin(matched, this.selectors.generation.portraitCheckbox);
      if (!checkbox) return { reason: "page-changed", message: `虚拟人像不可选择：${portrait.displayName}` };
      const alreadySelected = (await checkbox.locator(".check-inner, .check-icon").count()) > 0;
      if (!alreadySelected) {
        await checkbox.click({ force: true });
        const selectionDeadline = Date.now() + 3_000;
        while (Date.now() < selectionDeadline && (await checkbox.locator(".check-inner, .check-icon").count()) === 0) {
          await page.waitForTimeout(100);
        }
        if ((await checkbox.locator(".check-inner, .check-icon").count()) === 0) {
          return { reason: "page-changed", message: `心影没有勾选虚拟人像：${portrait.displayName}` };
        }
      }
    }

    let selectedCount: number | null = null;
    const selectedCountDeadline = Date.now() + 5_000;
    while (Date.now() < selectedCountDeadline) {
      const selectedText = dialog.getByText(/已选\s*\d+\s*项/).filter({ visible: true }).first();
      selectedCount = (await selectedText.count()) > 0
        ? parseSelectedPortraitCount(await selectedText.innerText().catch(() => ""))
        : null;
      if (selectedCount === portraits.length) break;
      await page.waitForTimeout(150);
    }
    if (selectedCount !== portraits.length) {
      const cancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
      if ((await cancel.count()) > 0) await clickDom(cancel).catch(() => undefined);
      return {
        reason: "page-changed",
        message: `心影角色库显示已选 ${selectedCount ?? "未知"} 项，但 APP 需要 ${portraits.length} 项；已停止提交，请重新同步后再试`,
      };
    }
    const confirm = dialog.getByText("确定", { exact: true }).filter({ visible: true }).first();
    if ((await confirm.count()) === 0 || !(await confirm.isEnabled())) return { reason: "page-changed", message: "心影虚拟人像确认按钮不可用" };
    await clickDom(confirm);
    await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    if (!(await this.waitForMaterialCount(page, expectedMaterialCount))) {
      return { reason: "approval", message: "所选虚拟人像未能进入心影生成素材槽位" };
    }
    return null;
  }

  async submitGeneration(job: Job, reuseFromPlatformTaskId?: string): Promise<AdapterOutcome> {
    const ensured = await this.ensureGenerationPage(job);
    if (!(ensured instanceof Object) || !("locator" in ensured)) return ensured as AdapterOutcome;
    const page = ensured as Page;

    const pendingRef = decodePendingTaskRef(job.platformTaskId);
    if (pendingRef) {
      const submittedUser = await this.userForTask(page, pendingRef, job.promptSnapshot);
      if (submittedUser) {
        return this.inspectRunningJob({ ...job, platformTaskId: encodeChatTaskRef(pendingRef) });
      }
    }

    const prompt = await firstVisible(page, this.selectors.generation.prompt);
    if (!prompt) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "找不到心影提示词输入框，请在兼容模式中确认页面" } };
    }

    const selectedPortraits = platformPortraitsParameter(job);
    const portraitsById = new Map(selectedPortraits.map((portrait) => [portrait.id, portrait]));
    const referencesById = new Map(job.references.map((reference) => [reference.id, reference]));
    const requestedOrder = materialOrderParameter(job);
    const materialOrder = requestedOrder.length
      ? requestedOrder
      : [
        ...selectedPortraits.map((portrait) => portraitMaterialKey(portrait.id)),
        ...[...job.references].sort((a, b) => a.position - b.position).map((reference) => referenceMaterialKey(reference.id)),
      ];
    const orderedReferences = materialOrder
      .map(parseMaterialKey)
      .filter((item): item is { kind: "reference"; id: string } => item?.kind === "reference")
      .map((item) => referencesById.get(item.id))
      .filter((reference): reference is Job["references"][number] => Boolean(reference));
    if (orderedReferences.some((reference) => !fs.existsSync(reference.filePath))) {
      throw new AppError("REFERENCE_FILE_MISSING", "至少一项参考素材文件已丢失");
    }
    const firstLastMode = stringParameter(job, "mode") === "first-last-frame";
    let promptForPlatform = job.promptSnapshot;
    let reusedDraft = false;
    if (reuseFromPlatformTaskId) {
      const reused = await this.reuseGenerationDraft(page, job, reuseFromPlatformTaskId, materialOrder.length, firstLastMode);
      if ("reason" in reused) return { status: "needs-human", checkpoint: reused };
      promptForPlatform = reused.promptForPlatform;
      reusedDraft = true;
    } else {
      const existingMaterialCount = await this.uploadedMaterialCount(page);
      if (existingMaterialCount > 0) await this.clearUploadedMaterials(page);
    }

    const modelCheckpoint = await this.configureModel(page, stringParameter(job, "modelName"));
    if (modelCheckpoint) return { status: "needs-human", checkpoint: modelCheckpoint };
    const parameterCheckpoint = await this.configureParameters(page, job);
    if (parameterCheckpoint) return { status: "needs-human", checkpoint: parameterCheckpoint };

    if (!reusedDraft && firstLastMode) {
      for (let index = 0; index < orderedReferences.length; index += 1) {
        const inputs = await firstCollection(page, this.selectors.generation.imageInput);
        const input = inputs && (await inputs.count()) > index ? inputs.nth(index) : inputs?.first();
        if (!input || (await input.count()) === 0) {
          return { status: "needs-human", checkpoint: { reason: "page-changed", message: `找不到心影参考图上传入口；尚未上传 @图${index + 1}` } };
        }
        await input.setInputFiles(orderedReferences[index].filePath);
        await page.waitForTimeout(1_000);
        const failure = page.getByText(/上传失败|素材解析失败|文件不支持/).filter({ visible: true }).first();
        if ((await failure.count()) > 0) {
          return { status: "needs-human", checkpoint: { reason: "approval", message: `@图${index + 1} 未能进入${index === 0 ? "首帧" : "尾帧"}槽位，请人工检查` } };
        }
      }
    } else if (!reusedDraft) {
      let materialCount = 0;
      let portraitsAdded = false;
      const actualLabelByKey = new Map<string, string>();
      const orderedPortraits = materialOrder
        .map(parseMaterialKey)
        .filter((item): item is { kind: "portrait"; id: string } => item?.kind === "portrait")
        .map((item) => portraitsById.get(item.id))
        .filter((portrait): portrait is PlatformPortrait => Boolean(portrait));
      if (orderedPortraits.length !== selectedPortraits.length) {
        return { status: "needs-human", checkpoint: { reason: "page-changed", message: "任务快照中的虚拟人像顺序不完整，已安全停止" } };
      }
      for (let materialIndex = 0; materialIndex < materialOrder.length; materialIndex += 1) {
        const key = materialOrder[materialIndex];
        const item = parseMaterialKey(key);
        if (item?.kind === "portrait") {
          if (portraitsAdded) continue;
          const portraitCheckpoint = await this.selectPlatformPortraits(page, orderedPortraits, materialCount + orderedPortraits.length);
          if (portraitCheckpoint) return { status: "needs-human", checkpoint: portraitCheckpoint };
          portraitsAdded = true;
          materialCount += orderedPortraits.length;
          const materials = await this.uploadedMaterialSnapshots(page);
          for (const portrait of orderedPortraits) {
            const matches = materials.filter((material) => material.previewText.includes(portrait.platformAssetId));
            if (matches.length !== 1) {
              await this.clearUploadedMaterials(page);
              return {
                status: "needs-human",
                checkpoint: {
                  reason: "page-changed",
                  message: `心影已加入虚拟人像“${portrait.displayName}”，但 APP 无法唯一确认它的实际编号，已安全停止`,
                },
              };
            }
            const actual = matches[0].label;
            const actualKind = this.mediaKindFromPlatformLabel(actual);
            if (actualKind === "audio") {
              await this.clearUploadedMaterials(page);
              return { status: "needs-human", checkpoint: { reason: "page-changed", message: `心影把虚拟人像“${portrait.displayName}”识别成音频，已安全停止` } };
            }
            this.persistPlatformPortraitMediaKind?.(portrait.id, actualKind);
            if (portrait.mediaKind !== "unknown" && portrait.mediaKind !== actualKind) {
              await this.clearUploadedMaterials(page);
              return { status: "needs-human", checkpoint: { reason: "page-changed", message: `虚拟人像“${portrait.displayName}”实际编号为 @${actual}，APP 已更新类型；请检查提示词后重新提交` } };
            }
            actualLabelByKey.set(portraitMaterialKey(portrait.id), `@${actual}`);
          }
          if (actualLabelByKey.size < orderedPortraits.length) {
            await this.clearUploadedMaterials(page);
            return { status: "needs-human", checkpoint: { reason: "page-changed", message: "心影没有为全部虚拟人像返回可核验编号，已安全停止" } };
          }
          continue;
        }
        if (item?.kind !== "reference") continue;
        const reference = referencesById.get(item.id);
        if (!reference) return { status: "needs-human", checkpoint: { reason: "page-changed", message: `任务快照缺少参考素材：${item.id}` } };
        const beforeLabels = await this.uploadedMaterialLabels(page);
        const input = await this.referenceUploadInput(page, reference.mimeType);
        if (!input || (await input.count()) === 0) {
          return { status: "needs-human", checkpoint: { reason: "page-changed", message: `找不到心影${mediaKindFromMime(reference.mimeType) === "audio" ? "音频" : mediaKindFromMime(reference.mimeType) === "video" ? "视频" : "图片"}上传入口：${reference.name}` } };
        }
        await input.setInputFiles(reference.filePath);
        materialCount += 1;
        if (!(await this.waitForMaterialCount(page, materialCount))) {
          await this.clearUploadedMaterials(page).catch(() => undefined);
          return { status: "needs-human", checkpoint: { reason: "approval", message: `参考素材“${reference.name}”上传未完成或被心影拒绝` } };
        }
        const labels = await this.uploadedMaterialLabels(page);
        const actual = findAddedMediaLabel(beforeLabels, labels) ?? "";
        if (!actual) {
          await this.clearUploadedMaterials(page);
          return { status: "needs-human", checkpoint: { reason: "page-changed", message: `参考素材“${reference.name}”上传后没有产生可识别的新编号，已安全停止` } };
        }
        const expectedKind = mediaKindFromMime(reference.mimeType);
        if (this.mediaKindFromPlatformLabel(actual) !== expectedKind) {
          await this.clearUploadedMaterials(page);
          return { status: "needs-human", checkpoint: { reason: "page-changed", message: `心影把“${reference.name}”编号为 @${actual}，与 APP 识别类型不一致，已安全停止` } };
        }
        actualLabelByKey.set(key, `@${actual}`);
      }
      const actualLabels = materialOrder.map((key) => actualLabelByKey.get(key) ?? "");
      if (actualLabels.some((label) => !label) || new Set(actualLabels).size !== materialOrder.length) {
        await this.clearUploadedMaterials(page);
        return { status: "needs-human", checkpoint: { reason: "page-changed", message: "心影实际素材编号与 APP 素材清单无法一一对应，已安全停止" } };
      }
      const expectedLabels = assignMediaLabels(materialOrder.map((key) => {
        const item = parseMaterialKey(key)!;
        if (item.kind === "reference") return mediaKindFromMime(referencesById.get(item.id)!.mimeType);
        const portrait = portraitsById.get(item.id)!;
        const actual = actualLabelByKey.get(key) ?? "";
        return portrait.mediaKind === "unknown" ? this.mediaKindFromPlatformLabel(actual.replace(/^@/, "")) as "image" | "video" : portrait.mediaKind;
      }));
      const promptLabels = promptMaterialLabels(job.promptSnapshot);
      const invalidPromptLabels = [...new Set(promptLabels.filter((label) => !expectedLabels.includes(label)))];
      if (invalidPromptLabels.length) {
        await this.clearUploadedMaterials(page);
        return { status: "needs-human", checkpoint: { reason: "approval", message: `提示词引用了当前 APP 素材清单中不存在的编号：${invalidPromptLabels.join("、")}；已停止提交` } };
      }
      promptForPlatform = remapPromptLabels(job.promptSnapshot, new Map(expectedLabels.map((label, index) => [label, actualLabels[index]])));
    }
    if (!firstLastMode && (await this.uploadedMaterialCount(page)) !== materialOrder.length) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "心影素材槽位数量与本地参考顺序不一致，已暂停提交" } };
    }

    await prompt.fill(promptForPlatform);
    const userMessages = await firstCollection(page, this.selectors.generation.userMessages);
    const beforeUserCount = userMessages ? await userMessages.count() : 0;
    const currentUrl = safeGenerationUrl(page.url());
    const taskRef: ChatTaskRef = {
      projectId: currentUrl?.searchParams.get("projectId") ?? "unknown",
      sessionId: currentUrl?.searchParams.get("sessionId") ?? "uninitialized",
      userIndex: beforeUserCount,
    };
    const submit = await firstVisible(page, this.selectors.generation.submitButtons);
    if (!submit) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "心影发送按钮不可用，请检查提示词、素材或当前额度" } };
    }
    const afterFillCheckpoint = await this.checkpoint(page);
    if (afterFillCheckpoint) return { status: "needs-human", checkpoint: afterFillCheckpoint };

    const pendingTaskId = encodePendingTaskRef(taskRef);
    this.persistPendingTaskRef?.(job.id, pendingTaskId);
    await clickDom(submit);
    let submitted = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const currentMessages = await firstCollection(page, this.selectors.generation.userMessages);
      if (currentMessages && (await currentMessages.count()) > beforeUserCount) {
        submitted = true;
        break;
      }
      const checkpoint = await this.checkpoint(page);
      if (checkpoint) return { status: "needs-human", platformTaskId: pendingTaskId, checkpoint };
      await page.waitForTimeout(350);
    }
    if (!submitted) {
      return {
        status: "needs-human",
        platformTaskId: pendingTaskId,
        checkpoint: { reason: "unknown", message: "发送后未检测到新的心影对话记录。请在原网页模式确认是否已提交，再恢复任务" },
      };
    }
    const submittedUrl = safeGenerationUrl(page.url());
    const platformTaskId = encodeChatTaskRef({
      ...taskRef,
      sessionId: submittedUrl?.searchParams.get("sessionId") ?? taskRef.sessionId,
    });
    return {
      status: "running",
      platformTaskId,
      message: reusedDraft
        ? "已通过心影“重新编辑”复用上一条的提示词、素材与参数并再次提交生成"
        : "已核验虚拟人像并按 APP 顺序映射心影实际编号后提交生成",
    };
  }

  async submitPortraitReview(job: Job, portrait: PortraitAsset): Promise<AdapterOutcome> {
    if (!portrait.consentConfirmed) throw new AppError("CONSENT_REQUIRED", "未确认虚拟人像素材授权");
    if (job.platformTaskId?.startsWith("portrait-staged:") || job.platformTaskId?.startsWith("portrait:")) {
      return this.inspectPortraitReview(job, portrait);
    }
    const page = await this.page();
    const targetGenerationUrl = stringParameter(job, "platformUrl");
    if (targetGenerationUrl) {
      const target = safeGenerationUrl(targetGenerationUrl);
      if (!target) return { status: "needs-human", checkpoint: { reason: "page-changed", message: "虚拟人像任务绑定的心影项目链接无效" } };
      const targetProjectId = target.searchParams.get("projectId");
      if (targetProjectId && new URL(page.url()).searchParams.get("projectId") !== targetProjectId) {
        await page.goto(`${this.selectors.baseUrl.replace(/\/$/, "")}${this.selectors.portrait.pagePath}?projectId=${encodeURIComponent(targetProjectId)}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
    }
    const checkpoint = await this.checkpoint(page);
    if (checkpoint) return checkpoint.reason === "login" ? { status: "needs-login", message: checkpoint.message } : { status: "needs-human", checkpoint };

    const current = new URL(page.url());
    const projectId = current.searchParams.get("projectId");
    if (!projectId) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "请先在原网页模式打开心影首页或任一项目，再恢复虚拟人像任务" } };
    }
    if (current.pathname !== this.selectors.portrait.pagePath) {
      await page.goto(`${this.selectors.baseUrl.replace(/\/$/, "")}${this.selectors.portrait.pagePath}?projectId=${encodeURIComponent(projectId)}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }

    let dialog = await firstVisible(page, this.selectors.portrait.dialog);
    if (!dialog) {
      const create = await this.waitForTextEntry(page, this.selectors.portrait.createTexts, 20_000);
      if (!create) return { status: "needs-human", checkpoint: { reason: "page-changed", message: "找不到“新建虚拟形象”入口" } };
      await clickDom(create);
      const localUpload = await this.waitForTextEntry(page, this.selectors.portrait.localUploadTexts, 8_000);
      if (!localUpload) return { status: "needs-human", checkpoint: { reason: "page-changed", message: "找不到虚拟人像“本地上传”入口" } };
      await clickDom(localUpload);
      dialog = await this.waitForVisible(page, this.selectors.portrait.dialog, 8_000);
      if (!dialog) return { status: "needs-human", checkpoint: { reason: "page-changed", message: "新建虚拟人像表单未打开" } };
    }
    const input = await firstExisting(page, this.selectors.portrait.uploadInput);
    if (!input) return { status: "needs-human", checkpoint: { reason: "page-changed", message: "找不到虚拟人像图片/视频上传控件" } };
    await input.setInputFiles(portrait.filePath);
    await page.waitForTimeout(1_200);
    const failure = dialog.getByText(/上传失败|文件不支持|素材解析失败/).filter({ visible: true }).first();
    if ((await failure.count()) > 0) {
      return { status: "failed", code: "PORTRAIT_UPLOAD_REJECTED", message: (await failure.innerText()).trim() };
    }
    const nameInput = dialog.locator("input[placeholder='请输入人像名称']").first();
    const nameReady = await nameInput.waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
    if (!nameReady) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "找不到虚拟人像名称输入框" } };
    }
    await nameInput.fill(portrait.displayName);
    for (const selection of configurablePortraitOptions(portrait)) {
      if (!(await this.choosePortraitOption(page, dialog, selection.index, selection.value))) {
        const fieldName = ["性别", "年龄", "人种"][selection.index] ?? "资料";
        return { status: "needs-human", checkpoint: { reason: "page-changed", message: `心影虚拟人像${fieldName}选项不可用：${selection.value}` } };
      }
    }
    const domestic = portrait.applicationScope === "domestic" || portrait.applicationScope === "both";
    const overseas = portrait.applicationScope === "overseas" || portrait.applicationScope === "both";
    if (!(await this.setPortraitScope(dialog, "火山Seedance国内版", domestic)) || !(await this.setPortraitScope(dialog, "火山Seedance海外版", overseas))) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "无法确认虚拟人像国内/海外应用范围" } };
    }
    if (!(await this.setPortraitScope(dialog, "我已阅读并同意", true))) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "无法确认心影虚拟人像合规承诺复选框" } };
    }
    const submit = await firstVisible(page, this.selectors.portrait.submitButtons);
    if (!submit || !(await submit.isEnabled())) {
      return { status: "needs-human", checkpoint: { reason: "approval", message: "心影虚拟人像表单尚未满足提交条件，请在原网页模式检查素材与合规承诺" } };
    }
    await clickDom(submit);
    await dialog.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => undefined);
    if (await dialog.isVisible().catch(() => false)) {
      const failureText = await dialog.getByText(/上传失败|文件不支持|素材解析失败|审核失败/).filter({ visible: true }).first().innerText().catch(() => "");
      return failureText
        ? { status: "failed", code: "PORTRAIT_UPLOAD_REJECTED", message: failureText.trim() }
        : { status: "needs-human", checkpoint: { reason: "approval", message: "心影未关闭虚拟人像提交表单，请人工检查页面提示" } };
    }
    return { status: "running", platformTaskId: `portrait:${job.id}`, message: `虚拟人像“${portrait.displayName}”已自动勾选合规承诺并提交心影审核` };
  }

  async inspectPortraitReview(job: Job, portrait: PortraitAsset, options: { timeoutMs?: number } = {}): Promise<AdapterOutcome> {
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 15_000);
    const inspectionDeadline = Date.now() + timeoutMs;
    const page = await this.page();
    let current = new URL(page.url());
    if (current.pathname !== this.selectors.portrait.pagePath) {
      const projectId = current.searchParams.get("projectId");
      if (!projectId) {
        return {
          status: "needs-human",
          platformTaskId: job.platformTaskId ?? undefined,
          checkpoint: { reason: "page-changed", message: "当前心影页面缺少 projectId，无法打开角色库核对审核状态" },
        };
      }
      await page.goto(`${this.selectors.baseUrl.replace(/\/$/, "")}${this.selectors.portrait.pagePath}?projectId=${encodeURIComponent(projectId)}`, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1_000, Math.min(30_000, inspectionDeadline - Date.now())),
      });
      current = new URL(page.url());
      if (current.pathname !== this.selectors.portrait.pagePath) {
        return {
          status: "needs-human",
          platformTaskId: job.platformTaskId ?? undefined,
          checkpoint: { reason: "page-changed", message: "心影没有进入角色库页面，请在原网页模式中检查" },
        };
      }
      const readyTimeout = Math.max(250, inspectionDeadline - Date.now());
      if (readyTimeout > 250) await this.waitForTextEntry(page, this.selectors.portrait.createTexts, readyTimeout);
    }
    const checkpoint = await this.checkpoint(page);
    if (checkpoint) return checkpoint.reason === "login" ? { status: "needs-login", message: checkpoint.message } : { status: "needs-human", platformTaskId: job.platformTaskId ?? undefined, checkpoint };
    const dialog = await firstVisible(page, this.selectors.portrait.dialog);
    if (dialog) {
      return {
        status: "needs-human",
        platformTaskId: job.platformTaskId ?? undefined,
        checkpoint: { reason: "approval", message: "未能验证虚拟人像合规承诺的自动勾选或最终提交，请人工检查页面" },
      };
    }
    while (Date.now() < inspectionDeadline) {
      const namedAssets = page.locator(".faceCard .face-name-text").filter({ visible: true });
      const matchingIndex = await namedAssets.evaluateAll((elements, displayName) =>
        elements.findIndex((element) => (element.textContent ?? "").trim() === displayName), portrait.displayName);
      if (matchingIndex >= 0) {
        const namedAsset = namedAssets.nth(matchingIndex);
        const card = namedAsset.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' faceCard ')][1]");
        await page.waitForTimeout(800);
        const cardText = (await card.innerText().catch(() => "")).trim();
        const cardState = classifyPortraitCardText(cardText);
        if (cardState === "failed") {
          return { status: "failed", platformTaskId: job.platformTaskId ?? undefined, code: "PORTRAIT_REJECTED", message: cardText || "心影显示虚拟人像审核失败" };
        }
        if (cardState === "running") {
          return { status: "running", platformTaskId: job.platformTaskId ?? undefined, message: `虚拟人像“${portrait.displayName}”已提交，心影正在审核` };
        }
        return { status: "completed", platformTaskId: job.platformTaskId ?? undefined, message: `虚拟人像“${portrait.displayName}”已出现在心影角色库` };
      }
      await page.waitForTimeout(350);
    }
    return {
      status: "running",
      platformTaskId: job.platformTaskId ?? undefined,
      message: `虚拟人像“${portrait.displayName}”已提交，正在等待心影角色库更新`,
    };
  }

  async inspectRunningJob(job: Job): Promise<AdapterOutcome> {
    const ensured = await this.ensureGenerationPage(job);
    if (!(ensured instanceof Object) || !("locator" in ensured)) return ensured as AdapterOutcome;
    const page = ensured as Page;
    const taskRef = decodeChatTaskRef(job.platformTaskId);
    if (!taskRef) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "任务缺少可验证的心影对话定位标识，请在原网页模式确认结果" } };
    }
    const current = safeGenerationUrl(page.url());
    if (taskRef.sessionId !== "uninitialized" && current?.searchParams.get("sessionId") !== taskRef.sessionId) {
      return { status: "needs-human", checkpoint: { reason: "page-changed", message: "当前心影会话与任务记录不一致，已暂停状态判断" } };
    }
    const matched = await this.responseForTask(page, taskRef, job.promptSnapshot);
    if (!matched) return { status: "running", platformTaskId: job.platformTaskId ?? undefined, message: "心影任务已提交，等待返回结果" };
    const { response } = matched;
    const matchedTaskId = encodeChatTaskRef({ ...taskRef, userIndex: matched.userIndex });
    const text = (await response.innerText().catch(() => "")).trim();
    if (classifyGenerationCard(text, "", false) === "failed") {
      return { status: "failed", platformTaskId: matchedTaskId, code: "PLATFORM_TASK_FAILED", message: text || "心影显示任务失败" };
    }
    const result = response.locator(".content-item._video").first();
    if ((await result.count()) > 0) {
      const media = response.locator("video[src], source[src]").first();
      const outputUrl = (await media.count()) > 0 ? await media.getAttribute("src") : null;
      let hasDownloadControl = false;
      for (const selector of this.selectors.generation.downloadButtons) {
        if ((await response.locator(selector).count()) > 0) {
          hasDownloadControl = true;
          break;
        }
      }
      const cardState = classifyGenerationCard(
        text,
        (await result.getAttribute("class")) ?? "",
        Boolean(outputUrl) || hasDownloadControl,
      );
      if (cardState === "failed") {
        return { status: "failed", platformTaskId: matchedTaskId, code: "PLATFORM_TASK_FAILED", message: text || "心影显示任务失败" };
      }
      if (cardState === "running") {
        return { status: "running", platformTaskId: matchedTaskId, message: text || "心影任务仍在运行" };
      }
      return {
        status: "completed",
        platformTaskId: matchedTaskId,
        ...(outputUrl && /^https?:\/\//.test(outputUrl) ? { outputUrl } : {}),
        message: "已在对应的心影对话回复中检测到视频结果",
      };
    }
    return { status: "running", platformTaskId: matchedTaskId, message: "心影任务仍在运行" };
  }

  private async loadAllConversationMessages(page: Page): Promise<void> {
    let stableRounds = 0;
    for (let round = 0; round < 8 && stableRounds < 2; round += 1) {
      const before = await page.locator(".ContentChatListItem").count();
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(".ContentChatList, .content-chat-list, [class*='chatList'], [class*='chat-list']"));
        const scroller = candidates.find((element) => element.scrollHeight > element.clientHeight) ?? document.scrollingElement;
        scroller?.scrollTo({ top: 0 });
      });
      await page.waitForTimeout(180);
      const after = await page.locator(".ContentChatListItem").count();
      if (after === before) stableRounds += 1; else stableRounds = 0;
    }
  }

  private async collectCurrentConversationResults(
    page: Page,
    target: URL,
    project: Project,
    fallbackSessionId: string,
    results: Map<string, PlatformResult>,
  ): Promise<void> {
    await this.loadAllConversationMessages(page);
    const current = safeGenerationUrl(page.url());
    const sessionId = current?.searchParams.get("sessionId") ?? fallbackSessionId;
    const entries = await page.evaluate(() => {
      const users = Array.from(document.querySelectorAll<HTMLElement>(".ContentChatListItem.userChat"));
      return Array.from(document.querySelectorAll<HTMLElement>(".ContentChatListItem.agentChat")).flatMap((agent, agentIndex) =>
        Array.from(agent.querySelectorAll<HTMLElement>(".content-item._video")).map((card, videoIndex) => {
          const video = card.querySelector<HTMLVideoElement>("video");
          const sourceElement = card.querySelector<HTMLSourceElement>("source");
          const background = getComputedStyle(card).backgroundImage || card.style.backgroundImage;
          const poster = background.match(/url\(["']?(.*?)["']?\)/)?.[1] ?? "";
          const inferredVideo = poster.replace(/_cover\.(?:jpg|jpeg|png)(?:\?.*)?$/i, "_720p.mp4");
          return {
            agentIndex,
            videoIndex,
            source: video?.currentSrc || video?.src || sourceElement?.src || (inferredVideo !== poster ? inferredVideo : ""),
            poster: video?.poster || poster,
            prompt: (users[agentIndex]?.innerText ?? "").split("\n重新编辑")[0].trim(),
          };
        }).filter((item) => /^https:\/\//.test(item.source) || /^https:\/\//.test(item.poster)));
    });
    for (const { agentIndex, videoIndex, source, poster, prompt } of entries) {
        const identity = crypto.createHash("sha256").update(`${project.platformProjectId}\n${sessionId}\n${agentIndex}\n${videoIndex}\n${source.split("?")[0]}\n${(poster ?? "").split("?")[0]}`).digest("hex");
        const timestamp = new Date().toISOString();
        results.set(identity, {
          id: identity,
          projectId: project.id,
          platformProjectId: project.platformProjectId,
          platformTaskId: encodeChatTaskRef({ projectId: target.searchParams.get("projectId") ?? project.platformProjectId, sessionId, userIndex: agentIndex }),
          jobId: null,
          source: "personal",
          mediaKind: "video",
          name: path.basename(source.split("?")[0]) || `心影视频-${agentIndex + 1}.mp4`,
          prompt,
          outputUrl: /^https:\/\//.test(source) ? source : null,
          previewUrl: poster && /^https:\/\//.test(poster) ? poster : null,
          outputPath: null,
          marked: false,
          available: true,
          createdAt: timestamp,
          lastSeenAt: timestamp,
        });
    }
  }

  async syncProjectMaterials(project: Project): Promise<PlatformResult[]> {
    const generationTarget = safeGenerationUrl(project.platformUrl);
    const remoteProjectId = generationTarget?.searchParams.get("projectId") || project.platformProjectId || "";
    if (!remoteProjectId) throw new AppError("GENERATION_PAGE_REQUIRED", "请先绑定心影项目，再同步项目全员素材");
    const page = await this.page();
    this.requireAuthenticatedPage(page);
    const syncedAt = new Date().toISOString();
    const materialResults = new Map<string, PlatformResult>();
    const completedKinds = new Set<PlatformResultMediaKind>();
    const activeRoutes = new Set<Promise<void>>();
    let genericFailure = false;
    const routePattern = "**/api/v2/materials/list";

    const processRoute = async (route: Route): Promise<void> => {
      const request = route.request();
      let payload: Record<string, unknown> = {};
      try {
        payload = recordValue(request.postDataJSON());
      } catch {
        // Let Heart handle an unknown request unchanged.
      }
      const kind = payload.material_type === "image" || payload.material_type === "video"
        ? payload.material_type as PlatformResultMediaKind
        : null;
      if (!kind || payload.project_id !== remoteProjectId) {
        await route.continue();
        return;
      }
      try {
        const firstResponse = await route.fetch();
        const firstBody = recordValue(await firstResponse.json());
        const firstData = recordValue(firstBody.data);
        if (Number(firstBody.code) !== 0 || !Array.isArray(firstData.items)) throw new Error("Heart material list rejected");
        const firstPageInfo = recordValue(firstData.page_info);
        const totalCount = Math.max(0, Number(firstPageInfo.total_count) || 0);
        const requestedPageSize = totalCount > 50 ? Math.min(200, totalCount) : Number(payload.page_size) || 50;
        let pagePayload = { ...payload, page_size: requestedPageSize };
        let pages: Array<Array<Record<string, unknown>>>;
        let totalPages: number;
        if (totalCount > 50) {
          const response = await route.fetch({
            postData: JSON.stringify({ ...pagePayload, page_index: 1 }),
          });
          const body = recordValue(await response.json());
          const data = recordValue(body.data);
          if (Number(body.code) !== 0 || !Array.isArray(data.items)) throw new Error("Heart material batch rejected");
          pages = [data.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))];
          totalPages = Math.max(1, Math.min(500, Number(recordValue(data.page_info).total_page) || 1));
        } else {
          pages = [firstData.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))];
          totalPages = Math.max(1, Math.min(500, Number(firstPageInfo.total_page) || 1));
        }
        for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += 1) {
          const response = await route.fetch({
            postData: JSON.stringify({ ...pagePayload, page_index: pageIndex }),
          });
          const body = recordValue(await response.json());
          const data = recordValue(body.data);
          if (Number(body.code) !== 0 || !Array.isArray(data.items)) throw new Error("Heart material page rejected");
          pages.push(data.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")));
        }
        let order = 0;
        for (const item of pages.flat()) {
          const result = platformMaterialResult(project, remoteProjectId, kind, item, syncedAt, order);
          order += 1;
          if (result) materialResults.set(result.id, result);
        }
        completedKinds.add(kind);
        await route.fulfill({ response: firstResponse });
      } catch {
        genericFailure = true;
        await route.continue().catch(() => undefined);
      }
    };
    const routeHandler = (route: Route): Promise<void> => {
      const task = processRoute(route).finally(() => activeRoutes.delete(task));
      activeRoutes.add(task);
      return task;
    };
    const waitForKind = async (kind: PlatformResultMediaKind): Promise<void> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !completedKinds.has(kind) && !genericFailure) await page.waitForTimeout(100);
      if (!completedKinds.has(kind)) throw new AppError("PROJECT_MATERIAL_SYNC_FAILED", `心影没有返回项目${kind === "video" ? "视频" : "图片"}素材`);
    };

    await page.route(routePattern, routeHandler);
    try {
      const homeUrl = `${this.selectors.baseUrl.replace(/\/$/, "")}${this.selectors.projects.homePath}?projectId=${encodeURIComponent(remoteProjectId)}`;
      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.requireAuthenticatedPage(page);
      const assetIcon = page.locator(".icon-asset").filter({ visible: true }).first();
      await assetIcon.waitFor({ state: "visible", timeout: 20_000 });
      await clickDom(assetIcon.locator("xpath=.."));
      const originalTab = page.getByText("原始素材", { exact: true }).filter({ visible: true }).first();
      if ((await originalTab.count()) > 0) await clickDom(originalTab);
      const videoTab = page.getByText("视频素材", { exact: true }).filter({ visible: true }).first();
      await videoTab.waitFor({ state: "visible", timeout: 15_000 });
      await clickDom(videoTab);
      await waitForKind("video");
      const imageTab = page.getByText("图片素材", { exact: true }).filter({ visible: true }).first();
      await clickDom(imageTab);
      await waitForKind("image");
    } finally {
      while (activeRoutes.size) await Promise.allSettled([...activeRoutes]);
      await page.unroute(routePattern, routeHandler).catch(() => undefined);
    }
    return [...materialResults.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async syncProjectResults(project: Project): Promise<PlatformResult[]> {
    const target = safeGenerationUrl(project.platformUrl);
    if (!target) throw new AppError("GENERATION_PAGE_REQUIRED", "请先绑定心影生成项目，再同步结果库");
    const page = await this.page();
    if (safeGenerationUrl(page.url())?.searchParams.get("projectId") !== target.searchParams.get("projectId")) {
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    this.requireAuthenticatedPage(page);
    const composer = await this.waitForVisible(page, this.selectors.generation.composer, 20_000);
    if (!composer) throw new AppError("GENERATION_PAGE_NOT_READY", "心影当前项目结果页未完成加载");
    await page.keyboard.press("Escape").catch(() => undefined);
    const results = new Map<string, PlatformResult>();
    const processed = new Set<string>();
    const initialSessionId = safeGenerationUrl(page.url())?.searchParams.get("sessionId");
    if (initialSessionId) {
      await this.collectCurrentConversationResults(page, target, project, initialSessionId, results);
      processed.add(initialSessionId);
    }
    const sessionRows = page.locator(".session-panel .session");
    const sessionScroller = page.locator(".session-panel .session-scrollbar .el-scrollbar__wrap").first();
    let stableRounds = 0;
    let previousCount = -1;
    for (let round = 0; round < 30 && stableRounds < 3; round += 1) {
      const count = await sessionRows.count();
      if ((await sessionScroller.count()) > 0) await sessionScroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
      else if (count > 0) await sessionRows.last().scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(180);
      const nextCount = await sessionRows.count();
      if (nextCount === previousCount) stableRounds += 1; else stableRounds = 0;
      previousCount = nextCount;
    }
    const sessionCount = Math.min(await sessionRows.count(), 300);
    for (let index = 0; index < sessionCount; index += 1) {
      const row = sessionRows.nth(index);
      await row.scrollIntoViewIfNeeded().catch(() => undefined);
      await clickDom(row);
      await page.waitForTimeout(650);
      const sessionId = safeGenerationUrl(page.url())?.searchParams.get("sessionId") ?? `sidebar-${index}`;
      if (processed.has(sessionId)) continue;
      await this.collectCurrentConversationResults(page, target, project, sessionId, results);
      processed.add(sessionId);
    }
    return [...results.values()];
  }

  async downloadVisibleResult(job: Job): Promise<string> {
    const ensured = await this.ensureGenerationPage(job);
    if (!(ensured instanceof Object) || !("locator" in ensured)) throw new AppError("PLATFORM_NOT_READY", "心影页面尚未准备好下载结果");
    const page = ensured as Page;
    const taskRef = decodeChatTaskRef(job.platformTaskId);
    if (!taskRef) throw new AppError("TASK_REF_MISSING", "任务缺少对应的心影对话定位标识");
    const matched = await this.responseForTask(page, taskRef, job.promptSnapshot);
    if (!matched) throw new AppError("RESULT_NOT_FOUND", "找不到该任务对应的心影回复");
    const { response } = matched;
    let button: Locator | null = null;
    for (const selector of this.selectors.generation.downloadButtons) {
      const candidate = response.locator(selector).first();
      if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
        const actionable = candidate.locator("xpath=ancestor-or-self::*[self::button or self::a or @role='button' or contains(concat(' ', normalize-space(@class), ' '), ' btn-option ')][1]");
        button = (await actionable.count()) > 0 ? actionable : candidate;
        break;
      }
    }
    if (!button) throw new AppError("DOWNLOAD_BUTTON_NOT_FOUND", "找不到该心影结果卡片的下载按钮");
    if (this.captureDownload) {
      const capturePromise = this.captureDownload(job.id, 120_000);
      void capturePromise.catch(() => undefined);
      try {
        // 心影把结果操作栏放在内部滚动容器中；元素可能可见但位于
        // Playwright 计算的顶层视口之外。直接触发已定位节点自己的
        // click 仍会走心影原有的 Vue 处理器，并由 Electron 接管下载。
        await button.evaluate((element) => (element as HTMLElement).click());
      } catch (error) {
        this.cancelDownloadCapture?.(job.id, "未能触发心影下载按钮");
        await capturePromise.catch(() => undefined);
        throw new AppError("DOWNLOAD_CLICK_FAILED", error instanceof Error ? error.message : "未能触发心影下载按钮", error);
      }
      try {
        return await capturePromise;
      } catch (error) {
        throw new AppError("DOWNLOAD_FAILED", error instanceof Error ? error.message : "心影下载失败", error);
      }
    }
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
    await button.evaluate((element) => (element as HTMLElement).click());
    const download = await downloadPromise;
    const fileName = download.suggestedFilename().replace(/[<>:"/\\|?*]+/g, "-");
    const target = path.join(this.paths.outputsDir, `${job.id}-${fileName}`);
    await download.saveAs(target);
    return target;
  }

  async diagnosticSnapshot(): Promise<Record<string, unknown>> {
    const page = await this.page();
    return page.evaluate(() => {
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      return {
        url: location.href,
        title: document.title,
        buttons: Array.from(document.querySelectorAll("button,[role='button']")).filter(visible).slice(0, 100).map((item) => item.textContent?.trim()).filter(Boolean),
        inputs: Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")).filter(visible).slice(0, 100).map((item) => ({
          tag: item.tagName.toLowerCase(),
          type: item.getAttribute("type"),
          placeholder: item.getAttribute("placeholder") ?? item.getAttribute("data-placeholder"),
          accept: item.getAttribute("accept"),
        })),
      };
    });
  }

  private async firstTextEntry(page: Page, texts: string[]): Promise<Locator | null> {
    for (const text of texts) {
      const locator = page.getByText(text, { exact: true }).filter({ visible: true }).last();
      if ((await locator.count()) > 0) return locator;
    }
    return null;
  }

  private async waitForTextEntry(page: Page, texts: string[], timeout: number): Promise<Locator | null> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const entry = await this.firstTextEntry(page, texts);
      if (entry) return entry;
      await page.waitForTimeout(200);
    }
    return null;
  }

  private async waitForVisible(page: Page, selectors: string[], timeout: number): Promise<Locator | null> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const locator = await firstVisible(page, selectors);
      if (locator) return locator;
      await page.waitForTimeout(200);
    }
    return null;
  }

  private async choosePortraitOption(page: Page, dialog: Locator, index: number, value: string): Promise<boolean> {
    const input = dialog.locator("input[role='combobox']").nth(index);
    if ((await input.count()) === 0) return false;
    const control = await input.getAttribute("aria-controls");
    if (!control) return false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await input.inputValue()) === value) return true;
      await page.waitForTimeout(attempt === 0 ? 500 : 750);
      const inputBox = await input.boundingBox();
      if (!inputBox) return false;
      await page.mouse.click(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
      await page.waitForTimeout(350);
      const options = page.locator(`[id="${control}"] [role="option"]`);
      const matchingIndex = await options.evaluateAll((elements, requested) =>
        elements.findIndex((element) => (element.textContent ?? "").trim() === requested), value);
      if (matchingIndex >= 0) {
        const option = options.nth(matchingIndex);
        // The "其他" ethnicity option is below Element Plus' popover fold.
        await option.evaluate((element) => {
          const scroller = element.closest(".el-select-dropdown__wrap");
          if (scroller instanceof HTMLElement) scroller.scrollTop = (element as HTMLElement).offsetTop;
        });
        await page.waitForTimeout(150);
        await clickDom(option);
      }
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        if ((await input.inputValue()) === value) {
          await page.waitForTimeout(750);
          return true;
        }
        await page.waitForTimeout(50);
      }
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    return false;
  }

  private async setPortraitScope(dialog: Locator, text: string, requested: boolean): Promise<boolean> {
    const label = dialog.locator("label.p-checkbox").filter({ hasText: text }).first();
    if ((await label.count()) === 0) return false;
    const indicator = label.locator(".checkbox-input");
    const checked = ((await indicator.getAttribute("class")) ?? "").includes("is-checked");
    if (checked !== requested) await clickDom(indicator);
    return (((await indicator.getAttribute("class")) ?? "").includes("is-checked")) === requested;
  }

  private async userForTask(page: Page, ref: ChatTaskRef, promptSnapshot: string): Promise<{ user: Locator; userIndex: number } | null> {
    const users = await firstCollection(page, this.selectors.generation.userMessages);
    if (!users) return null;
    const count = await users.count();
    const normalizedSnapshot = normalizePromptLabels(promptSnapshot);
    const matchesSnapshot = (text: string) => text.includes(promptSnapshot)
      || (Boolean(normalizedSnapshot) && normalizePromptLabels(text).includes(normalizedSnapshot));
    if (count > ref.userIndex) {
      const indexed = users.nth(ref.userIndex);
      const indexedText = (await indexed.innerText().catch(() => "")).trim();
      if (!promptSnapshot || matchesSnapshot(indexedText)) return { user: indexed, userIndex: ref.userIndex };
    }
    if (!promptSnapshot) return null;
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = users.nth(index);
      const text = (await candidate.innerText().catch(() => "")).trim();
      if (matchesSnapshot(text)) return { user: candidate, userIndex: index };
    }
    return null;
  }

  private async responseForTask(page: Page, ref: ChatTaskRef, promptSnapshot: string): Promise<MatchedChatResponse | null> {
    const matched = await this.userForTask(page, ref, promptSnapshot);
    if (!matched) return null;
    const { user, userIndex } = matched;
    const response = user.locator("xpath=following-sibling::*[1][contains(concat(' ', normalize-space(@class), ' '), ' agentChat ')]");
    return (await response.count()) > 0 ? { response, userIndex } : null;
  }

  private async visibleTaskId(page: Page): Promise<string | undefined> {
    for (const attribute of this.selectors.generation.taskIdAttributes) {
      const locator = page.locator(`[${attribute}]`).filter({ visible: true }).last();
      if ((await locator.count()) > 0) {
        const value = await locator.getAttribute(attribute);
        if (value) return value;
      }
    }
    return undefined;
  }
}

export const adapterInternals = {
  encodeChatTaskRef,
  decodeChatTaskRef,
  encodePendingTaskRef,
  decodePendingTaskRef,
  safeGenerationUrl,
  explicitParameterValue,
  parseSelectedPortraitCount,
  remapPromptLabels,
  normalizePromptLabels,
  normalizeReusablePrompt,
  classifyPortraitCardText,
  classifyGenerationCard,
  platformPortraitIdentity,
  platformWorkspaceIdentity,
  platformProjectIdentity,
  platformConversationsFromApi,
  platformCatalogFromApi,
  platformMaterialResult,
  configurablePortraitOptions,
};
