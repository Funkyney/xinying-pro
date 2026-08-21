import { chromium } from "playwright-core";

const port = Number(process.env.XINYING_CDP_PORT ?? 9333);
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  const renderer = browser.contexts().flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("file:") || page.url().includes("127.0.0.1:5173"));
  if (!renderer) throw new Error("找不到心影Pro渲染页面");
  const dashboard = await renderer.evaluate(() => window.xinying.dashboard());
  const boundProject = dashboard.projects.find((project) => project.platformWorkspaceId && project.platformProjectId && project.platformUrl);
  if (!boundProject) throw new Error("没有已选择心影空间和项目的本地项目");
  const synced = await renderer.evaluate((projectId) => window.xinying.portraits.sync(projectId), boundProject.id);
  const cached = await renderer.evaluate(() => window.xinying.portraits.platformList());
  const available = cached.filter((portrait) => portrait.available && (!portrait.workspaceId || portrait.workspaceId === boundProject.platformWorkspaceId));
  const unique = new Set(available.map((portrait) => portrait.id));
  if (!available.length || unique.size !== available.length) throw new Error("心影虚拟人像同步结果为空或存在重复 ID");
  const verification = await renderer.evaluate(async ({ portrait, binding }) => {
    const promptLabel = portrait.mediaKind === "video" ? "@视频1" : "@图1";
    const project = await window.xinying.projects.create({
      name: `0.3.0 角色与4K校验 ${Date.now()}`,
      prompt: `${promptLabel}保持角色一致，固定机位。`,
      modelName: "Seedance 2.0 全能参考",
      platformUrl: binding.platformUrl,
      platformWorkspaceId: binding.platformWorkspaceId,
      platformProjectId: binding.platformProjectId,
      mode: "reference-to-video",
      aspectRatio: "16:9",
      duration: 15,
      resolution: "4k",
      audioEnabled: true,
      portraitIds: [portrait.id],
    });
    try {
      const preview = await window.xinying.jobs.preview(project.id);
      return {
        modelName: project.modelName,
        resolution: project.resolution,
        duration: project.duration,
        mediaKind: portrait.mediaKind,
        portraitCount: preview.selectedPortraits.length,
        firstLabel: preview.orderedLabels[0],
        ready: preview.ready,
      };
    } finally {
      await window.xinying.projects.remove(project.id);
    }
  }, { portrait: available[0], binding: boundProject });
  const expectedLabel = verification.mediaKind === "video" ? "@视频1" : verification.mediaKind === "image" ? "@图1" : "@待心影校验";
  if (!verification.ready || verification.resolution !== "4k" || verification.portraitCount !== 1 || !verification.firstLabel?.includes(expectedLabel)) {
    throw new Error("Seedance 2.0 4K 与心影虚拟人像项目快照校验失败");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    synced: synced.length,
    available: available.length,
    uniqueIds: unique.size,
    hasPreviewUrls: available.every((portrait) => portrait.previewUrl.startsWith("https://")),
    projectVerification: verification,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
