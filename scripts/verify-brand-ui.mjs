import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const remote = await chromium.connectOverCDP("http://127.0.0.1:9333", { timeout: 15_000 });
try {
  const page = remote.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("找不到心影Pro主窗口");
  await page.getByRole("button", { name: "总览", exact: true }).click();
  await page.getByRole("heading", { name: "心影让你当指挥家，心影Pro让你直接把片交了。" }).waitFor();
  await page.getByText("AgentLab Pro", { exact: true }).waitFor();
  const logoReady = await page.locator('img[alt="心影Pro Logo"]').evaluate((image) => image.complete && image.naturalWidth > 0);
  if (!logoReady) throw new Error("品牌 SVG 未完成加载");
  const output = path.resolve("test-results", "brand-dashboard.png");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, title: await page.title(), logoReady, output }, null, 2)}\n`);
} finally {
  await remote.close();
}
