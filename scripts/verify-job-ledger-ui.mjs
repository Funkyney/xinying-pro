import { chromium } from "playwright-core";

const projectId = process.env.XINYING_JOB_PROJECT_ID ?? "008677c8-228e-44c8-a8dc-a1512aa0cb39";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("找不到心影Pro主窗口");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".topbar-actions > select").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".topbar-actions > select").selectOption(projectId);
  const latest = await page.evaluate((id) => window.xinying.jobs.list().then((jobs) =>
    jobs.find((job) => job.projectId === id && job.kind === "generation")), projectId);
  if (!latest) throw new Error("测试项目没有生成任务记录");

  await page.getByRole("button", { name: "任务队列", exact: true }).click();
  await page.getByRole("heading", { name: "任务队列", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const row = page.locator("tbody tr").filter({ hasText: latest.id.slice(0, 8) });
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await row.getByTitle("查看任务详情与事件").click();
  const modal = page.locator(".job-detail-modal");
  await modal.waitFor({ state: "visible", timeout: 5_000 });
  const text = await modal.innerText();
  if (!text.includes(latest.id) || !text.includes("SUBMIT_INTENT_RECORDED") || !text.includes("PLATFORM_TASK_FAILED")) {
    throw new Error("任务详情没有完整显示提交防重与平台失败事件");
  }
  await modal.getByRole("button", { name: "关闭", exact: true }).click();
  process.stdout.write(`${JSON.stringify({ ok: true, jobId: latest.id, status: latest.status, eventAuditVisible: true }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => undefined);
}
