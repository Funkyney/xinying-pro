import { chromium } from "playwright-core";

const port = Number(process.env.XINYING_CDP_PORT ?? 9333);
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  const renderer = browser.contexts().flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("file:") || page.url().includes("127.0.0.1:5173"));
  if (!renderer) throw new Error("找不到心影Pro渲染页面");
  const dashboard = await renderer.evaluate(() => window.xinying.dashboard());
  const project = dashboard.projects.find((item) => item.platformUrl && item.platformWorkspaceId);
  if (!project) throw new Error("没有已绑定心影空间与项目的本地项目");
  const startedAt = Date.now();
  const result = await renderer.evaluate(async (projectId) => {
    const [catalog, portraits] = await Promise.all([
      window.xinying.platformProjects.sync(),
      window.xinying.portraits.sync(projectId),
    ]);
    return {
      workspaceCount: catalog.workspaces.filter((item) => item.available).length,
      projectCount: catalog.projects.filter((item) => item.available).length,
      portraitCount: portraits.filter((item) => item.available).length,
    };
  }, project.id);
  if (!result.workspaceCount || !result.projectCount || !result.portraitCount) {
    throw new Error("并发触发后的同步结果不完整");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, elapsedMs: Date.now() - startedAt }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
