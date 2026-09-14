#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

type Browser = import("playwright-core").Browser;
type Page = import("playwright-core").Page;

const SERVER_VERSION = "0.1.0";

function dataDir(): string {
  if (process.env.XINYING_DATA_DIR?.trim()) return path.resolve(process.env.XINYING_DATA_DIR.trim());
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "xinying-director");
}

function automationPorts(): number[] {
  let marker = 0;
  try {
    marker = Number(fs.readFileSync(path.join(dataDir(), "automation-port"), "utf8").trim());
  } catch {
    // The app may not have been launched on this machine yet.
  }
  return [...new Set([marker, 9333, 9334].filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function failedResult(error: unknown) {
  const data = { ok: false, error: errorMessage(error) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}

class HeartAppBridge {
  private browser: Browser | null = null;
  private launching: Promise<void> | null = null;

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  private async connectOnce(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const { chromium } = await import("playwright-core");
    let latestError: unknown;
    for (const port of automationPorts()) {
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_500 });
        return this.browser;
      } catch (error) {
        latestError = error;
      }
    }
    throw latestError instanceof Error ? latestError : new Error("无法连接心影Pro");
  }

  private async launchApp(): Promise<void> {
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const executable = process.env.XINYING_APP_EXECUTABLE?.trim();
      if (!executable || !fs.existsSync(executable)) {
        throw new Error("心影Pro未运行，且 MCP 找不到客户端程序；请先启动心影Pro");
      }
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: environment,
      });
      child.unref();
      const deadline = Date.now() + 30_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          await this.connectOnce();
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      throw new Error(`心影Pro启动后仍无法连接：${errorMessage(lastError)}`);
    })().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async renderer(): Promise<Page> {
    let browser: Browser;
    try {
      browser = await this.connectOnce();
    } catch {
      await this.launchApp();
      browser = await this.connectOnce();
    }
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
    if (!page) throw new Error("已连接心影Pro，但主界面尚未就绪");
    return page;
  }

  async invoke(operation: string, args: unknown = {}): Promise<unknown> {
    const page = await this.renderer();
    return page.evaluate(async ({ requested, input }) => {
      if (!window.xinying) throw new Error("心影Pro本地控制接口尚未就绪");
      const value = input as Record<string, unknown>;
      switch (requested) {
        case "status": {
          const [session, projects, jobs] = await Promise.all([
            window.xinying.session.status(),
            window.xinying.projects.list(),
            window.xinying.jobs.list(),
          ]);
          return {
            ok: true,
            session,
            projects: projects.map((project) => ({
              id: project.id,
              name: project.name,
              platformProjectId: project.platformProjectId,
              platformUrl: project.platformUrl,
              updatedAt: project.updatedAt,
            })),
            activeJobs: jobs.filter((job) => ["queued", "preparing", "uploading", "running", "needs-human", "needs-login"].includes(job.status))
              .slice(0, 20)
              .map((job) => ({ id: job.id, projectId: job.projectId, kind: job.kind, status: job.status, progress: job.progress, progressLabel: job.progressLabel })),
          };
        }
        case "catalog": {
          const catalog = value.force ? await window.xinying.platformProjects.sync() : await window.xinying.platformProjects.catalog();
          const query = String(value.query ?? "").trim().toLocaleLowerCase();
          const workspaceId = String(value.workspaceId ?? "").trim();
          const projects = catalog.projects.filter((project) => project.available)
            .filter((project) => !workspaceId || project.workspaceId === workspaceId)
            .filter((project) => !query || `${project.name} ${project.shortId}`.toLocaleLowerCase().includes(query))
            .slice(0, 200)
            .map((project) => ({ id: project.id, workspaceId: project.workspaceId, name: project.name, shortId: project.shortId, remoteId: project.remoteId, isCurrent: project.isCurrent }));
          return {
            ok: true,
            source: value.force ? "heart" : "cache",
            syncedAt: catalog.syncedAt,
            currentWorkspaceId: catalog.currentWorkspaceId,
            currentProjectId: catalog.currentProjectId,
            workspaces: catalog.workspaces.filter((workspace) => workspace.available).map((workspace) => ({ id: workspace.id, name: workspace.name, kind: workspace.kind, isCurrent: workspace.isCurrent })),
            projects,
          };
        }
        case "conversations": {
          const rows = await window.xinying.platformProjects.conversations(String(value.projectId));
          return { ok: true, projectId: value.projectId, conversations: rows };
        }
        case "select": {
          const project = await window.xinying.platformProjects.open(
            String(value.projectId),
            value.conversationId ? String(value.conversationId) : undefined,
          );
          return { ok: true, project: { id: project.id, name: project.name, platformProjectId: project.platformProjectId, platformUrl: project.platformUrl } };
        }
        case "generate":
          return window.xinying.automation.directorRun({
            manifestPath: String(value.manifestPath),
            ...(value.count === undefined ? {} : { count: Number(value.count) }),
            timeoutMs: Number(value.timeoutMinutes ?? 45) * 60_000,
            confirm: value.confirm === true,
          });
        case "jobs": {
          const ids = Array.isArray(value.ids) ? value.ids.map(String) : [];
          const jobs = ids.length ? await Promise.all(ids.map((id) => window.xinying.jobs.status(id))) : await window.xinying.jobs.list();
          const selected = jobs.filter((job) => ids.length || ["queued", "preparing", "uploading", "running", "needs-human", "needs-login"].includes(job.status)).slice(0, 50);
          return { ok: true, jobs: selected.map((job) => ({ id: job.id, projectId: job.projectId, kind: job.kind, status: job.status, platformTaskId: job.platformTaskId, progress: job.progress, progressLabel: job.progressLabel, errorCode: job.errorCode, errorMessage: job.errorMessage, requiresHumanReason: job.requiresHumanReason, updatedAt: job.updatedAt })) };
        }
        case "portraits": {
          const projectId = value.projectId ? String(value.projectId) : undefined;
          const rows = value.force ? await window.xinying.portraits.sync(projectId) : await window.xinying.portraits.platformList(projectId);
          const query = String(value.query ?? "").trim().toLocaleLowerCase();
          const limit = Math.max(1, Math.min(200, Number(value.limit ?? 50)));
          return { ok: true, count: rows.length, portraits: rows.filter((portrait) => portrait.available).filter((portrait) => !query || portrait.displayName.toLocaleLowerCase().includes(query)).slice(0, limit).map((portrait) => ({ id: portrait.id, displayName: portrait.displayName, workspaceId: portrait.workspaceId, mediaKind: portrait.mediaKind, platformAssetId: portrait.platformAssetId })) };
        }
        case "results": {
          const projectId = value.projectId ? String(value.projectId) : undefined;
          const rows = value.force && projectId
            ? await window.xinying.results.sync(projectId, value.source === "project" ? "project" : "personal")
            : await window.xinying.results.list(projectId);
          const limit = Math.max(1, Math.min(200, Number(value.limit ?? 50)));
          return { ok: true, count: rows.length, results: rows.slice(0, limit).map((result) => ({ id: result.id, projectId: result.projectId, source: result.source, mediaKind: result.mediaKind, name: result.name, platformTaskId: result.platformTaskId, outputUrl: result.outputUrl, outputPath: result.outputPath, createdAt: result.createdAt })) };
        }
        default:
          throw new Error(`未知心影Pro MCP 操作：${requested}`);
      }
    }, { requested: operation, input: args });
  }
}

const bridge = new HeartAppBridge();

function buildServer(): McpServer {
  const server = new McpServer({ name: "xinying-pro", version: SERVER_VERSION }, {
    instructions: "心影Pro负责执行已完成的Seedance提示词。优先一次调用generate完成清单校验、素材上传、所有含人物图片/视频的虚拟人像授权、编号映射和批量提交；当返回successBoundary=heart-generating时立即视为成功，不继续轮询或下载。目录与人像默认读缓存，仅在用户要求刷新或缓存过期时force=true。任何生成必须由用户明确要求并传confirm=true。登录、验证码、实名、审核或付费检查不得绕过。",
  });

  server.registerTool("status", {
    title: "检查心影Pro",
    description: "检查客户端登录态、本地项目和正在处理的任务。",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return jsonResult(await bridge.invoke("status") as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  server.registerTool("catalog", {
    title: "读取心影空间与项目",
    description: "读取心影空间和项目。默认使用本地缓存；force=true才访问心影刷新。",
    inputSchema: z.object({
      force: z.boolean().optional().default(false),
      query: z.string().optional().describe("按项目名称或短ID筛选"),
      workspaceId: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try { return jsonResult(await bridge.invoke("catalog", input) as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  server.registerTool("conversations", {
    title: "读取项目对话",
    description: "通过项目目录ID读取历史对话，便于复用同一个会话。",
    inputSchema: z.object({ projectId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try { return jsonResult(await bridge.invoke("conversations", input) as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  server.registerTool("select", {
    title: "选择心影项目与对话",
    description: "把心影Pro绑定到一个项目和指定历史对话；省略conversationId时新建对话。",
    inputSchema: z.object({ projectId: z.string().min(1), conversationId: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try { return jsonResult(await bridge.invoke("select", input) as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  server.registerTool("generate", {
    title: "用心影Pro生成",
    description: "一次完成导演清单的素材上传、含人物图片/视频授权、编号映射和1-20条提交；全部进入生成中后立刻返回。",
    inputSchema: z.object({
      manifestPath: z.string().min(1).describe("已完成的.xinying-run.json绝对路径"),
      count: z.number().int().min(1).max(20).optional(),
      timeoutMinutes: z.number().positive().max(240).optional().default(45),
      confirm: z.literal(true).describe("用户已明确授权人物合规承诺并接受可能扣费"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try { return jsonResult(await bridge.invoke("generate", input) as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  server.registerTool("jobs", {
    title: "查看心影Pro任务",
    description: "读取指定任务；不传ID时只返回最近的活动或需处理任务。",
    inputSchema: z.object({ ids: z.array(z.string()).max(50).optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try { return jsonResult(await bridge.invoke("jobs", input) as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  server.registerTool("portraits", {
    title: "读取心影虚拟人像",
    description: "搜索已授权虚拟人像。默认读缓存；force=true时同步当前项目空间。",
    inputSchema: z.object({ projectId: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(200).optional().default(50), force: z.boolean().optional().default(false) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try { return jsonResult(await bridge.invoke("portraits", input) as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  server.registerTool("results", {
    title: "读取心影结果",
    description: "读取本地结果缓存；force=true时同步指定项目的个人生成或项目素材。",
    inputSchema: z.object({ projectId: z.string().optional(), source: z.enum(["personal", "project"]).optional().default("personal"), limit: z.number().int().min(1).max(200).optional().default(50), force: z.boolean().optional().default(false) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try { return jsonResult(await bridge.invoke("results", input) as Record<string, unknown>); } catch (error) { return failedResult(error); }
  });

  return server;
}

const handle = serveStdio(buildServer, { onerror: (error) => console.error(`[xinying-pro-mcp] ${error.message}`) });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void bridge.close().finally(() => handle.close()).finally(() => process.exit(0));
  });
}
