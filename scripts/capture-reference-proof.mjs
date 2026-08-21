import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const outputDir = path.join(process.cwd(), "test-results");
const screenshotPath = path.join(outputDir, "reference-upload-proof.png");
const reportPath = path.join(outputDir, "reference-upload-proof.json");
fs.mkdirSync(outputDir, { recursive: true });

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`, { timeout: 10_000 });
  const context = browser.contexts()[0];
  const page = context.pages().find((candidate) => {
    try { return new URL(candidate.url()).hostname === "blueaivideo.com" && new URL(candidate.url()).pathname === "/avpAgent"; } catch { return false; }
  });
  if (!page) throw new Error("找不到 APP 内心影生成会话");
  const composer = page.locator(".ContentChatInput").first();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  const box = await composer.boundingBox();
  if (!box) throw new Error("无法取得心影生成区范围");
  const proof = await page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const list = document.querySelector(".ContentChatInput .material-list");
    const staticLabels = new Set(["+V角色", "图片", "视频", "音频", "首帧", "尾帧"]);
    const materials = list ? Array.from(list.children)
      .filter((element) => !staticLabels.has(clean(element.textContent)))
      .map((element, index) => ({ index: index + 1, label: clean(element.textContent), className: element.getAttribute("class") })) : [];
    return {
      pageUrl: location.href,
      materials,
      promptTextLength: clean(document.querySelector(".ContentChatInput .mention-editor[contenteditable='true']")?.textContent).length,
      userMessages: document.querySelectorAll(".ContentChatListItem.userChat").length,
      agentMessages: document.querySelectorAll(".ContentChatListItem.agentChat").length,
    };
  });
  const report = {
    ok: proof.materials.length === 3 && proof.materials.every((material, index) => material.label === `图${index + 1}`) && proof.promptTextLength === 0,
    generated: false,
    submitButtonClicked: false,
    ...proof,
    screenshotPath: null,
    verifiedAt: new Date().toISOString(),
  };
  if (process.argv.includes("--screenshot")) {
    const client = await context.newCDPSession(page);
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    report.screenshotPath = screenshotPath;
  }
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
}
