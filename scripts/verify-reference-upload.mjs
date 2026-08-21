import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

if (!process.argv.includes("--confirm-upload")) {
  throw new Error("该脚本会向心影上传文件；必须在用户明确授权后添加 --confirm-upload");
}

const rawUrl = process.env.XINYING_INSPECT_URL ?? "";
const targetUrl = new URL(rawUrl);
if (targetUrl.protocol !== "https:" || targetUrl.hostname !== "blueaivideo.com" || targetUrl.pathname !== "/avpAgent") {
  throw new Error("XINYING_INSPECT_URL 必须是 https://blueaivideo.com/avpAgent 会话地址");
}
if (!targetUrl.searchParams.get("projectId") || !targetUrl.searchParams.get("sessionId")) {
  throw new Error("心影会话地址缺少 projectId 或 sessionId");
}

const files = JSON.parse(process.env.XINYING_REFERENCE_FILES ?? "[]");
if (!Array.isArray(files) || files.length !== 3 || files.some((file) => typeof file !== "string")) {
  throw new Error("XINYING_REFERENCE_FILES 必须是恰好包含 3 个文件路径的 JSON 数组");
}
for (const file of files) {
  const extension = path.extname(file).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(extension) || !fs.statSync(file).isFile()) {
    throw new Error(`测试文件无效：${file}`);
  }
}

const selectors = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "xinying-selectors.json"), "utf8"));
const outputDir = path.join(process.cwd(), "test-results");
fs.mkdirSync(outputDir, { recursive: true });
const screenshotPath = path.join(outputDir, "reference-upload-proof.png");
const reportPath = path.join(outputDir, "reference-upload-proof.json");

const firstCollection = async (page, candidates) => {
  for (const selector of candidates) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0) return locator;
  }
  return null;
};

const waitForCollection = async (page, candidates, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const collection = await firstCollection(page, candidates);
    if (collection) return collection;
    await page.waitForTimeout(250);
  }
  return null;
};

const materialEntries = async (page) => {
  const lists = await firstCollection(page, selectors.generation.materialList);
  if (!lists) return [];
  return lists.first().locator(":scope > *").evaluateAll((elements) => {
    const staticLabels = new Set(["+V角色", "图片", "视频", "音频", "首帧", "尾帧"]);
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    return elements
      .filter((element) => !staticLabels.has(clean(element.textContent)))
      .map((element, index) => ({
        index,
        text: clean(element.textContent),
        className: element.getAttribute("class") ?? "",
        title: clean(element.getAttribute("title")),
        images: Array.from(element.querySelectorAll("img")).map((image) => ({
          alt: clean(image.getAttribute("alt")),
          title: clean(image.getAttribute("title")),
        })),
        controls: Array.from(element.querySelectorAll("button, [role='button']")).map((control) => ({
          text: clean(control.textContent),
          title: clean(control.getAttribute("title")),
          ariaLabel: clean(control.getAttribute("aria-label")),
          className: control.getAttribute("class") ?? "",
        })),
      }));
  });
};

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`, { timeout: 10_000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => {
    try { return new URL(candidate.url()).hostname === "blueaivideo.com"; } catch { return false; }
  });
  if (!page) throw new Error("找不到 APP 内心影页面");
  if (page.url() !== targetUrl.toString()) {
    await page.goto(targetUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  const composer = page.locator(selectors.generation.composer.join(", ")).first();
  await composer.waitFor({ state: "visible", timeout: 25_000 });

  const before = await materialEntries(page);
  if (before.length !== 0) {
    throw new Error(`心影生成区已有 ${before.length} 项未提交素材，已中止且未上传测试图`);
  }

  const uploaded = [];
  for (let index = 0; index < files.length; index += 1) {
    const inputs = await waitForCollection(page, selectors.generation.imageInput);
    if (!inputs) throw new Error(`上传 @图${index + 1} 前找不到心影图片输入控件`);
    await inputs.first().setInputFiles(files[index]);
    const deadline = Date.now() + 90_000;
    let entries = [];
    while (Date.now() < deadline) {
      entries = await materialEntries(page);
      if (entries.length >= index + 1) break;
      const failure = page.getByText(/上传失败|素材解析失败|文件不支持/).filter({ visible: true }).first();
      if ((await failure.count()) > 0) throw new Error(`@图${index + 1} 被心影拒绝：${(await failure.innerText()).trim()}`);
      await page.waitForTimeout(500);
    }
    if (entries.length < index + 1) throw new Error(`等待 @图${index + 1} 素材槽位超时`);
    uploaded.push({
      expectedIndex: index + 1,
      fileName: path.basename(files[index]),
      sha256: crypto.createHash("sha256").update(fs.readFileSync(files[index])).digest("hex"),
      observedCount: entries.length,
    });
    process.stdout.write(`${JSON.stringify({ progress: "uploaded", ...uploaded.at(-1) })}\n`);
  }

  const entries = await materialEntries(page);
  if (entries.length !== files.length) throw new Error(`最终素材槽位数 ${entries.length} 与测试图数量 ${files.length} 不一致`);
  await composer.screenshot({ path: screenshotPath });
  const prompt = page.locator(selectors.generation.prompt.join(", ")).first();
  const promptText = (await prompt.count()) > 0 ? ((await prompt.textContent()) ?? "").trim() : "";
  const report = {
    ok: true,
    generated: false,
    submitButtonClicked: false,
    pageUrl: page.url(),
    uploaded,
    materialCount: entries.length,
    entries,
    promptEmpty: promptText.length === 0,
    screenshotPath,
    verifiedAt: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
}
