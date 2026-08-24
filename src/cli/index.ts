#!/usr/bin/env node
import path from "node:path";
import { Command, CommanderError } from "commander";
import type {
  CliEnvelope,
  PlatformResult,
  PlatformProjectCreateInput,
  PortraitAgeGroup,
  PortraitApplicationScope,
  PortraitEthnicity,
  PortraitGender,
  PortraitMetadataInput,
  ProjectInput,
  ReferenceRole,
} from "../shared/contracts";
import { loadDirectorManifest } from "../core/director-manifest";
import { createAppPaths } from "../core/paths";
import { XinyingDatabase } from "../core/database";
import { XinyingService } from "../core/service";
import { AppError, asAppError } from "../core/errors";
import { automationPortCandidates } from "../shared/automation-port";
import type { Browser } from "playwright-core";

let currentCommand = "xinying";
let database: XinyingDatabase | null = null;
const commanderMessages: string[] = [];

function runtime() {
  const paths = createAppPaths();
  database = new XinyingDatabase(paths.databasePath);
  return { paths, service: new XinyingService(database, paths) };
}

function envelope<T>(ok: boolean, data?: T, error?: CliEnvelope["error"]): CliEnvelope<T> {
  return { ok, command: currentCommand, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}), timestamp: new Date().toISOString() };
}

function serializeEnvelope(value: CliEnvelope<unknown>): string {
  const json = JSON.stringify(value, null, 2);
  return process.env.XINYING_CLI_ASCII_JSON === "1"
    ? json.replace(/[\u0080-\uFFFF]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    : json;
}

function output<T>(data: T): void {
  process.stdout.write(`${serializeEnvelope(envelope(true, data))}\n`);
}

function requireConfirm(confirm: boolean | undefined, action: string): void {
  if (!confirm) throw new AppError("CONFIRMATION_REQUIRED", `${action} 会改变心影或本地任务状态，请明确添加 --confirm`);
}

function parseBoolean(value: string): boolean {
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new AppError("INVALID_BOOLEAN", `无法解析布尔值：${value}`);
}

function compactResult(result: PlatformResult) {
  return {
    id: result.id,
    projectId: result.projectId,
    source: result.source,
    mediaKind: result.mediaKind,
    name: result.name,
    platformTaskId: result.platformTaskId,
    promptPreview: result.prompt.slice(0, 160),
    outputUrl: result.outputUrl,
    previewUrl: result.previewUrl,
    outputPath: result.outputPath,
    marked: result.marked,
    available: result.available,
    createdAt: result.createdAt,
  };
}

type AppOperation = "platform-sync" | "platform-conversations" | "platform-open" | "platform-create" | "portrait-sync" | "portrait-delete" | "results-sync";

async function invokeRunningApp(operation: AppOperation, args: unknown[] = []): Promise<unknown> {
  const { chromium } = await import("playwright-core");
  const ports = automationPortCandidates(createAppPaths().dataDir, process.env.XINYING_CDP_PORT);
  let remote: Browser | null = null;
  let connectionError: unknown;
  for (const port of ports) {
    try {
      remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3_500 });
      break;
    } catch (error) {
      connectionError = error;
    }
  }
  if (!remote) throw new AppError("APP_NOT_RUNNING", "请先启动心影Pro APP，再执行需要操作心影网页的命令", connectionError);
  try {
    const renderer = remote.contexts().flatMap((context) => context.pages())
      .find((page) => page.url().startsWith("file:") || page.url().includes("127.0.0.1:5173"));
    if (!renderer) throw new AppError("APP_RENDERER_NOT_FOUND", "已连接 APP，但找不到心影Pro主界面");
    return await renderer.evaluate(async ({ operation: requested, args: values }) => {
      switch (requested) {
        case "platform-sync": return window.xinying.platformProjects.sync();
        case "platform-conversations": return window.xinying.platformProjects.conversations(String(values[0]));
        case "platform-open": return window.xinying.platformProjects.open(String(values[0]), values[1] ? String(values[1]) : undefined);
        case "platform-create": return window.xinying.platformProjects.create(values[0] as PlatformProjectCreateInput);
        case "portrait-sync": return window.xinying.portraits.sync(values[0] ? String(values[0]) : undefined);
        case "portrait-delete": return window.xinying.portraits.deletePlatform(String(values[0]), values[1] as string[]);
        case "results-sync": return window.xinying.results.sync(String(values[0]), values[1] === "project" ? "project" : "personal");
      }
    }, { operation, args });
  } finally {
    await remote.close().catch(() => undefined);
  }
}

const program = new Command();
program
  .name("xinying")
  .description("心影Pro Codex 友好命令行；所有输出均为 JSON")
  .version("0.5.0")
  .exitOverride()
  .configureOutput({
    writeOut: (value) => commanderMessages.push(value),
    writeErr: (value) => commanderMessages.push(value),
  })
  .hook("preAction", (_thisCommand, actionCommand) => {
    const parts: string[] = [];
    let cursor: Command | null = actionCommand;
    while (cursor) {
      parts.unshift(cursor.name());
      cursor = cursor.parent;
    }
    currentCommand = parts.join(" ");
  });

const project = program.command("project").description("管理本地项目");
project.command("list").description("列出项目").action(() => output(runtime().service.listProjects()));
project.command("show").argument("<id>").description("读取项目及参考素材").action((id: string) => {
  const { service } = runtime();
  output({ project: service.getProject(id), references: service.listReferences(id) });
});
project.command("create")
  .requiredOption("--name <name>", "项目名称")
  .option("--description <text>", "项目说明")
  .option("--mode <mode>", "生成模式", "reference-to-video")
  .option("--prompt <text>", "提示词", "")
  .option("--model <name>", "心影模型名称", "Seedance 2.5 全能参考")
  .option("--platform-url <url>", "绑定的心影 avpAgent 会话链接", "")
  .option("--platform-workspace-id <id>", "绑定的心影空间目录 ID", "")
  .option("--platform-project-id <id>", "绑定的心影项目目录 ID", "")
  .option("--aspect-ratio <ratio>", "画幅", "16:9")
  .option("--duration <seconds>", "时长", "5")
  .option("--resolution <value>", "分辨率；auto 表示沿用心影当前值", "auto")
  .option("--audio <boolean>", "是否生成声音", "true")
  .option("--portrait-ids <ids>", "心影已同步虚拟人像 ID，逗号分隔", "")
  .option("--material-order <keys>", "最终素材顺序，逗号分隔；使用 portrait:<id> 或 reference:<id>", "")
  .action((options) => {
    const input: ProjectInput = {
      name: options.name,
      description: options.description,
      mode: options.mode,
      prompt: options.prompt,
      modelName: options.model,
      platformUrl: options.platformUrl,
      platformWorkspaceId: options.platformWorkspaceId,
      platformProjectId: options.platformProjectId,
      aspectRatio: options.aspectRatio,
      duration: Number(options.duration),
      resolution: options.resolution,
      audioEnabled: parseBoolean(options.audio),
      portraitIds: options.portraitIds.split(",").map((item: string) => item.trim()).filter(Boolean),
      materialOrder: options.materialOrder.split(",").map((item: string) => item.trim()).filter(Boolean),
    };
    output(runtime().service.createProject(input));
  });
project.command("update")
  .argument("<id>")
  .option("--name <name>")
  .option("--description <text>")
  .option("--prompt <text>")
  .option("--model <name>")
  .option("--platform-url <url>")
  .option("--platform-workspace-id <id>")
  .option("--platform-project-id <id>")
  .option("--mode <mode>")
  .option("--aspect-ratio <ratio>")
  .option("--duration <seconds>")
  .option("--resolution <value>")
  .option("--audio <boolean>")
  .option("--portrait-ids <ids>", "心影已同步虚拟人像 ID，逗号分隔；传空字符串可清空")
  .option("--material-order <keys>", "最终素材顺序，逗号分隔；使用 portrait:<id> 或 reference:<id>")
  .action((id: string, options) => {
    const input: Partial<ProjectInput> = {
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.model !== undefined ? { modelName: options.model } : {}),
      ...(options.platformUrl !== undefined ? { platformUrl: options.platformUrl } : {}),
      ...(options.platformWorkspaceId !== undefined ? { platformWorkspaceId: options.platformWorkspaceId } : {}),
      ...(options.platformProjectId !== undefined ? { platformProjectId: options.platformProjectId } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
      ...(options.duration !== undefined ? { duration: Number(options.duration) } : {}),
      ...(options.resolution !== undefined ? { resolution: options.resolution } : {}),
      ...(options.audio !== undefined ? { audioEnabled: parseBoolean(options.audio) } : {}),
      ...(options.portraitIds !== undefined ? { portraitIds: options.portraitIds.split(",").map((item: string) => item.trim()).filter(Boolean) } : {}),
      ...(options.materialOrder !== undefined ? { materialOrder: options.materialOrder.split(",").map((item: string) => item.trim()).filter(Boolean) } : {}),
    };
    output(runtime().service.updateProject(id, input));
  });
project.command("remove").argument("<id>").option("--confirm", "确认删除").action((id: string, options) => {
  requireConfirm(options.confirm, "删除项目");
  const { service } = runtime();
  service.removeProject(id);
  output({ removed: id });
});

const platform = program.command("platform").description("读取并操控 APP 内已登录的心影空间与项目");
platform.command("catalog").description("读取最近一次同步的空间与项目目录").action(() => output(runtime().service.getPlatformCatalog()));
platform.command("sync").description("通过运行中的 APP 同步个人空间、团队空间和项目").action(async () => output(await invokeRunningApp("platform-sync")));
platform.command("conversations")
  .argument("<catalog-project-id>")
  .description("读取所选心影项目的历史对话，供后续精确复用")
  .action(async (projectId: string) => output(await invokeRunningApp("platform-conversations", [projectId])));
platform.command("open")
  .argument("<catalog-project-id>")
  .option("--conversation-id <id>", "复用该项目中的指定历史对话；省略时新建对话")
  .description("切换到目录中的心影项目并绑定新建或指定的生成对话")
  .action(async (projectId: string, options) => output(await invokeRunningApp("platform-open", [projectId, options.conversationId])));
platform.command("create")
  .requiredOption("--workspace-id <id>", "目标个人或团队空间目录 ID")
  .requiredOption("--name <name>", "项目名称")
  .option("--customer <name>", "团队空间的心影所属客户选项", "")
  .requiredOption("--creation-type <name>", "心影视频创作类型选项")
  .option("--confirm", "确认在心影中新建项目")
  .action(async (options) => {
    requireConfirm(options.confirm, "在心影中新建项目");
    const input: PlatformProjectCreateInput = {
      workspaceId: options.workspaceId,
      name: options.name,
      customer: options.customer,
      creationType: options.creationType,
    };
    output(await invokeRunningApp("platform-create", [input]));
  });

const refs = program.command("refs").description("管理参考素材及顺序");
refs.command("list").argument("<project-id>").action((projectId: string) => output(runtime().service.listReferences(projectId)));
refs.command("add")
  .argument("<project-id>")
  .requiredOption("--file <path...>", "一个或多个图片、视频或音频路径")
  .action((projectId: string, options) => output(runtime().service.addReferences(projectId, options.file.map((item: string) => path.resolve(item)))));
refs.command("reorder")
  .argument("<project-id>")
  .requiredOption("--ids <ids>", "按顺序排列的素材 ID，逗号分隔")
  .action((projectId: string, options) => output(runtime().service.reorderReferences(projectId, options.ids.split(",").map((item: string) => item.trim()))));
refs.command("role")
  .argument("<id>")
  .requiredOption("--role <role>")
  .action((id: string, options) => output(runtime().service.updateReferenceRole(id, options.role as ReferenceRole)));
refs.command("replace")
  .argument("<id>")
  .requiredOption("--file <path>")
  .action((id: string, options) => output(runtime().service.replaceReference(id, path.resolve(options.file))));
refs.command("batch-replace")
  .argument("<project-id>")
  .requiredOption("--file <path...>", "按当前卡片顺序提供全部替换文件")
  .action((projectId: string, options) => output(runtime().service.batchReplaceReferences(projectId, options.file.map((item: string) => path.resolve(item)))));
refs.command("remove").argument("<id>").option("--confirm").action((id: string, options) => {
  requireConfirm(options.confirm, "删除参考素材");
  const { service } = runtime();
  service.removeReference(id);
  output({ removed: id });
});

const library = program.command("library").description("管理 APP 级共享图片、视频和音频素材库");
library.command("list").description("按最新上传顺序列出共享素材").action(() => output(runtime().service.listSharedMedia()));
library.command("add")
  .requiredOption("--file <path...>", "上传一个或多个图片、视频或音频文件")
  .action((options) => output(runtime().service.addSharedMedia(options.file.map((item: string) => path.resolve(item)))));
library.command("project-add")
  .argument("<id>", "共享素材 ID")
  .requiredOption("--project-id <id>", "目标本地项目 ID")
  .action((id: string, options) => output(runtime().service.addSharedMediaToProject(options.projectId, id)));
library.command("project-remove")
  .argument("<id>", "共享素材 ID")
  .requiredOption("--project-id <id>", "目标本地项目 ID")
  .action((id: string, options) => output(runtime().service.removeSharedMediaFromProject(options.projectId, id)));
library.command("remove").argument("<id>").option("--confirm", "确认删除共享库母版").action((id: string, options) => {
  requireConfirm(options.confirm, "删除共享素材库母版");
  const { service } = runtime();
  service.removeSharedMedia(id);
  output({ removed: id });
});

const portrait = program.command("portrait").description("管理虚拟人像素材与审核任务");
portrait.command("list").action(() => output(runtime().service.listPortraits()));
portrait.command("platform-list")
  .description("列出 APP 已从心影同步、可直接调用的虚拟人像")
  .option("--workspace-id <id>", "只看指定个人或团队空间")
  .option("--include-unavailable", "同时列出历史上已失效或已迁移的缓存")
  .action((options) => {
    const rows = runtime().service.listPlatformPortraits(options.workspaceId);
    output(options.includeUnavailable ? rows : rows.filter((portrait) => portrait.available));
  });
portrait.command("platform-sync")
  .description("通过运行中的 APP 同步当前项目所属空间的虚拟人像库")
  .option("--project-id <id>", "本地已绑定的项目 ID")
  .action(async (options) => output(await invokeRunningApp("portrait-sync", [options.projectId])));
portrait.command("platform-delete")
  .description("通过运行中的 APP 从当前心影空间永久删除一批虚拟人像")
  .requiredOption("--project-id <id>", "本地已绑定的项目 ID")
  .requiredOption("--ids <ids>", "待删除的心影虚拟人像 ID，逗号分隔")
  .option("--confirm", "确认永久删除心影虚拟人像")
  .action(async (options) => {
    requireConfirm(options.confirm, "永久删除心影虚拟人像");
    const ids = options.ids.split(",").map((item: string) => item.trim()).filter(Boolean);
    output(await invokeRunningApp("portrait-delete", [options.projectId, ids]));
  });
portrait.command("add")
  .requiredOption("--file <path...>")
  .option("--consent", "确认原创虚拟人像合规承诺与授权，可由 APP 自动勾选心影承诺")
  .action((options) => output(runtime().service.addPortraits(options.file.map((item: string) => path.resolve(item)), Boolean(options.consent))));
portrait.command("update")
  .argument("<id>")
  .option("--name <name>", "心影角色库显示名称")
  .option("--gender <value>", "男、女或其他")
  .option("--age-group <value>", "心影年龄组选项")
  .option("--ethnicity <value>", "心影人种选项")
  .option("--scope <value>", "domestic、overseas 或 both")
  .action((id: string, options) => {
    const input: PortraitMetadataInput = {
      ...(options.name !== undefined ? { displayName: options.name } : {}),
      ...(options.gender !== undefined ? { gender: options.gender as PortraitGender } : {}),
      ...(options.ageGroup !== undefined ? { ageGroup: options.ageGroup as PortraitAgeGroup } : {}),
      ...(options.ethnicity !== undefined ? { ethnicity: options.ethnicity as PortraitEthnicity } : {}),
      ...(options.scope !== undefined ? { applicationScope: options.scope as PortraitApplicationScope } : {}),
    };
    output(runtime().service.updatePortraitMetadata(id, input));
  });
portrait.command("submit")
  .argument("<id>")
  .option("--project-id <id>", "用于上传审核的本地已绑定项目 ID")
  .option("--confirm", "确认创建审核任务")
  .action((id: string, options) => {
    requireConfirm(options.confirm, "提交虚拟人像审核");
    output(runtime().service.submitPortraitReview(id, options.projectId));
  });
portrait.command("authorize-reference")
  .argument("<reference-id>")
  .requiredOption("--project-id <id>", "参考图所属的本地已绑定项目 ID")
  .option("--confirm", "确认合规承诺并创建人像审核任务")
  .action((referenceId: string, options) => {
    requireConfirm(options.confirm, "授权参考图并提交虚拟人像审核");
    output(runtime().service.authorizeReference(referenceId, options.projectId, true));
  });

const job = program.command("job").description("预览、提交、查询和下载任务");
job.command("list").action(() => output(runtime().service.listJobs()));
job.command("preview").argument("<project-id>").action((projectId: string) => output(runtime().service.previewSubmission(projectId)));
job.command("submit")
  .argument("<project-id>")
  .option("--count <number>", "一次排队生成的条数（1-20）", "1")
  .option("--confirm", "确认提交生成任务")
  .action((projectId: string, options) => {
    requireConfirm(options.confirm, "提交生成任务");
    const count = Number(options.count);
    const { service } = runtime();
    output(count === 1 ? service.submitGeneration(projectId) : service.submitGenerationBatch(projectId, count));
  });
job.command("status").argument("<id>").action((id: string) => output(runtime().service.getJob(id)));
job.command("events").argument("<id>").action((id: string) => output(runtime().service.listJobEvents(id)));
job.command("resume").argument("<id>").option("--confirm").action((id: string, options) => {
  requireConfirm(options.confirm, "恢复任务");
  output(runtime().service.resumeJob(id));
});
job.command("cancel").argument("<id>").option("--confirm").action((id: string, options) => {
  requireConfirm(options.confirm, "取消任务");
  output(runtime().service.cancelJob(id));
});
job.command("download")
  .argument("<id>")
  .requiredOption("--output <path>")
  .action(async (id: string, options) => output(await runtime().service.downloadJob(id, path.resolve(options.output))));

const results = program.command("results").description("同步、标记和下载当前心影项目结果库");
results.command("list")
  .option("--project-id <id>", "只列出指定本地项目")
  .option("--compact", "省略完整提示词，便于 Codex 批处理")
  .action((options) => {
    const items = runtime().service.listResults(options.projectId);
    output(options.compact ? items.map(compactResult) : items);
  });
results.command("sync")
  .requiredOption("--project-id <id>", "要同步素材的本地已绑定项目 ID")
  .option("--source <source>", "personal 同步个人生成；project 同步项目全员图片与视频", "personal")
  .action(async (options) => {
    if (!["personal", "project"].includes(options.source)) throw new AppError("INVALID_RESULT_SOURCE", "--source 必须是 personal 或 project");
    const items = await invokeRunningApp("results-sync", [options.projectId, options.source]) as PlatformResult[];
    output({
      count: items.filter((item) => item.source === options.source).length,
      downloadable: items.filter((item) => item.source === options.source && (item.outputUrl || item.outputPath)).length,
      results: items.filter((item) => item.source === options.source).map(compactResult),
    });
  });
results.command("mark")
  .requiredOption("--ids <ids>", "结果 ID，逗号分隔")
  .option("--value <boolean>", "true 标记，false 取消标记", "true")
  .action((options) => output(runtime().service.markResults(
    options.ids.split(",").map((item: string) => item.trim()).filter(Boolean),
    parseBoolean(options.value),
  ).map(compactResult)));
results.command("download")
  .argument("<id>")
  .requiredOption("--output <path>")
  .action(async (id: string, options) => output(compactResult(await runtime().service.exportResult(id, path.resolve(options.output)))));
results.command("batch-download")
  .requiredOption("--ids <ids>", "结果 ID，逗号分隔")
  .requiredOption("--output-dir <path>", "批量保存目录")
  .action(async (options) => {
    const ids = options.ids.split(",").map((item: string) => item.trim()).filter(Boolean);
    const destination = path.resolve(options.outputDir);
    const { service } = runtime();
    const downloaded = [];
    for (const [index, id] of ids.entries()) {
      downloaded.push(await service.exportResult(id, path.join(destination, `${String(index + 1).padStart(3, "0")}-${id}.mp4`)));
    }
    output(downloaded.map(compactResult));
  });

const director = program.command("director").description("执行 Seedance 导演任务清单：素材、授权、参数与批量生成");
director.command("validate")
  .requiredOption("--manifest <path>", "导演任务 JSON 清单")
  .action((options) => {
    const manifest = loadDirectorManifest(options.manifest);
    output(runtime().service.validateDirectorRun(manifest));
  });
director.command("prepare")
  .requiredOption("--manifest <path>", "导演任务 JSON 清单")
  .description("按清单配置本地项目并给出人像授权与最终编号预检；不会提交心影")
  .action((options) => {
    const manifest = loadDirectorManifest(options.manifest);
    output(runtime().service.prepareDirectorRun(manifest));
  });
director.command("authorize")
  .requiredOption("--manifest <path>", "导演任务 JSON 清单")
  .option("--confirm", "确认合规承诺并把清单中标记的人物素材提交心影审核")
  .action((options) => {
    requireConfirm(options.confirm, "自动勾选合规承诺并提交清单中的人物素材授权");
    const manifest = loadDirectorManifest(options.manifest);
    const { service } = runtime();
    const preparation = service.prepareDirectorRun(manifest);
    const jobs = preparation.authorizationReferenceIds.map((referenceId) =>
      service.authorizeReference(referenceId, manifest.projectId, true));
    output({ preparation, jobs });
  });
director.command("resolve")
  .requiredOption("--manifest <path>", "导演任务 JSON 清单")
  .description("同步心影角色库，并把审核通过的人物素材原位替换为已授权虚拟人像")
  .action(async (options) => {
    const manifest = loadDirectorManifest(options.manifest);
    await invokeRunningApp("portrait-sync", [manifest.projectId]);
    output(runtime().service.prepareDirectorRun(manifest));
  });
director.command("submit")
  .requiredOption("--manifest <path>", "导演任务 JSON 清单")
  .option("--count <number>", "覆盖清单中的生成条数（1-20）")
  .option("--confirm", "确认按指定数量创建可能扣费的心影生成任务")
  .action((options) => {
    requireConfirm(options.confirm, "按导演任务清单提交可能扣费的心影生成任务");
    const manifest = loadDirectorManifest(options.manifest);
    const { service } = runtime();
    const preparation = service.prepareDirectorRun(manifest);
    const unresolved = preparation.materials.filter((material) =>
      material.referenceId && material.authorizationState !== "not-needed");
    if (unresolved.length) {
      throw new AppError(
        "PORTRAIT_AUTHORIZATION_PENDING",
        "人物素材尚未全部替换为心影已授权虚拟人像；请先完成 director authorize，再执行 director resolve",
        unresolved,
      );
    }
    const count = options.count === undefined ? manifest.count : Number(options.count);
    output({ preparation, batch: service.submitGenerationBatch(manifest.projectId, count) });
  });

program.command("doctor").description("检查本地数据和 APP 队列状态").action(() => {
  const { paths, service } = runtime();
  output({
    dataDir: paths.dataDir,
    databasePath: paths.databasePath,
    projects: service.listProjects().length,
    queuedJobs: service.listQueuedJobs().length,
    note: "CLI 负责写入共享 SQLite 队列；需要启动心影Pro APP 才会执行网页任务。",
  });
});

program.parseAsync(process.argv)
  .catch((error: unknown) => {
    if (error instanceof CommanderError && error.exitCode === 0) {
      output({ text: commanderMessages.join("").trim() });
      return;
    }
    const appError = error instanceof CommanderError
      ? new AppError("CLI_USAGE_ERROR", error.message, {
        commanderCode: error.code,
        usage: commanderMessages.join("").trim() || undefined,
      })
      : asAppError(error);
    process.stdout.write(`${serializeEnvelope(envelope(false, undefined, { code: appError.code, message: appError.message, details: appError.details }))}\n`);
    process.exitCode = 1;
  })
  .finally(() => database?.close());
