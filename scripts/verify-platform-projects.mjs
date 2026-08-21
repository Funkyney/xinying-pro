import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const port = Number(process.env.XINYING_CDP_PORT ?? 9333);
const createRequested = process.env.XINYING_VERIFY_CREATE === "1";
const testProjectName = process.env.XINYING_VERIFY_PROJECT_NAME ?? "APP功能验证-20260821";
let browser;

try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  const renderer = browser.contexts().flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("file:") || page.url().includes("127.0.0.1:5173"));
  if (!renderer) throw new Error("找不到心影Pro渲染页面");

  const catalog = await renderer.evaluate(() => window.xinying.platformProjects.sync());
  const personal = catalog.workspaces.find((workspace) => workspace.kind === "personal" && workspace.available);
  const team = catalog.workspaces.find((workspace) => workspace.kind === "team" && workspace.available);
  if (!personal || !team) throw new Error("同步结果没有同时包含个人空间和团队空间");
  if (!catalog.projects.some((project) => project.workspaceId === personal.id)
    || !catalog.projects.some((project) => project.workspaceId === team.id)) {
    throw new Error("个人或团队空间没有读到可见项目");
  }
  if (!catalog.creationTypeOptions.length) {
    throw new Error("新建项目的视频创作类型选项为空");
  }

  let platformProject = catalog.projects.find((project) => project.workspaceId === personal.id && project.name === testProjectName);
  let created = false;
  let localProject;
  if (createRequested && !platformProject) {
    localProject = await renderer.evaluate((input) => window.xinying.platformProjects.create(input), {
      workspaceId: personal.id,
      name: testProjectName,
      customer: catalog.customerOptions[0] ?? "",
      creationType: catalog.creationTypeOptions.includes("其他") ? "其他" : catalog.creationTypeOptions[0],
    });
    created = true;
  } else {
    platformProject ??= catalog.projects.find((project) => project.workspaceId === personal.id && project.available);
    if (!platformProject) throw new Error("个人空间没有可供切换的项目");
    localProject = await renderer.evaluate((projectId) => window.xinying.platformProjects.open(projectId), platformProject.id);
  }

  if (!localProject.platformUrl.includes("/avpAgent") || !localProject.platformUrl.includes("projectId=")) {
    throw new Error("切换或创建项目后没有进入内容生成页");
  }
  const portraits = await renderer.evaluate((projectId) => window.xinying.portraits.sync(projectId), localProject.id);
  const available = portraits.filter((portrait) => portrait.available && portrait.workspaceId === localProject.platformWorkspaceId);
  if (!available.length) throw new Error("当前空间的心影虚拟人像库为空");
  const ordered = [...available].sort((a, b) => a.sortOrder - b.sortOrder);
  if (ordered.some((portrait, index) => portrait.id !== available[index]?.id)) {
    throw new Error("虚拟人像缓存未保持心影页面的最新优先顺序");
  }

  const preview = await renderer.evaluate(async ({ binding, portrait }) => {
    const promptLabel = portrait.mediaKind === "video" ? "@视频1" : "@图1";
    const project = await window.xinying.projects.create({
      name: `同步回归校验 ${Date.now()}`,
      prompt: `${promptLabel}保持角色一致，固定机位。`,
      modelName: binding.modelName,
      platformUrl: binding.platformUrl,
      platformWorkspaceId: binding.platformWorkspaceId,
      platformProjectId: binding.platformProjectId,
      mode: "reference-to-video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "1080p",
      audioEnabled: true,
      portraitIds: [portrait.id],
    });
    try {
      return await window.xinying.jobs.preview(project.id);
    } finally {
      await window.xinying.projects.remove(project.id);
    }
  }, { binding: localProject, portrait: available[0] });
  const expectedLabel = available[0].mediaKind === "video" ? "@视频1" : available[0].mediaKind === "image" ? "@图1" : "@待心影校验";
  if (!preview.ready || preview.selectedPortraits.length !== 1 || !preview.orderedLabels[0]?.includes(expectedLabel)) {
    throw new Error("共享虚拟人像未能按实际媒体类型加入当前项目");
  }
  const results = await renderer.evaluate((projectId) => window.xinying.results.sync(projectId), localProject.id);

  const proof = {
    ok: true,
    created,
    testProjectName: localProject.name,
    localProjectId: localProject.id,
    platformWorkspaceId: localProject.platformWorkspaceId,
    platformProjectId: localProject.platformProjectId,
    workspaceCounts: {
      personal: catalog.projects.filter((project) => project.workspaceId === personal.id).length,
      team: catalog.projects.filter((project) => project.workspaceId === team.id).length,
    },
    customerOptions: catalog.customerOptions.length,
    creationTypeOptions: catalog.creationTypeOptions,
    availablePortraits: available.length,
    firstPortrait: { id: available[0].id, name: available[0].displayName, sortOrder: available[0].sortOrder },
    preview: { ready: preview.ready, firstLabel: preview.orderedLabels[0] },
    syncedResults: results.length,
    generated: false,
    verifiedAt: new Date().toISOString(),
  };
  const proofPath = path.resolve("test-results", "platform-projects-proof.json");
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...proof, proofPath }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
