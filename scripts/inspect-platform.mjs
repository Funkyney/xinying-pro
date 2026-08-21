import { chromium } from "playwright-core";

const port = Number(process.env.XINYING_CDP_PORT ?? 9333);
const isXinyingPage = (candidate) => {
  try { return new URL(candidate.url()).hostname.endsWith("blueaivideo.com"); } catch { return false; }
};
const isAuthPage = (candidate) => {
  try {
    const host = new URL(candidate.url()).hostname;
    return host.endsWith("feishu.cn") || host.endsWith("larksuite.com");
  } catch {
    return false;
  }
};
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  let pages = browser.contexts().flatMap((context) => context.pages());
  if (process.argv.includes("--show")) {
    const renderer = pages.find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
    const compatibilityButton = renderer?.getByRole("button", { name: "原网页模式", exact: true });
    if (compatibilityButton && (await compatibilityButton.count()) > 0) {
      await compatibilityButton.click();
      await renderer.waitForTimeout(800);
      pages = browser.contexts().flatMap((context) => context.pages());
    }
  }
  let page = pages.find(isXinyingPage) ?? pages.find(isAuthPage);
  if (!page) {
    const renderer = pages.find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
    const compatibilityButton = renderer?.getByRole("button", { name: "原网页模式", exact: true });
    if (compatibilityButton && (await compatibilityButton.count()) > 0) {
      await compatibilityButton.click();
      await renderer.waitForTimeout(2_000);
      pages = browser.contexts().flatMap((context) => context.pages());
      page = pages.find(isXinyingPage) ?? pages.find(isAuthPage);
    }
  }
  if (!page) {
    const available = await Promise.all(pages.map(async (candidate) => ({ url: candidate.url(), title: await candidate.title().catch(() => "") })));
    throw new Error(`没有找到心影官方页面，请先在 APP 中打开原网页模式。当前页面：${JSON.stringify(available)}`);
  }
  const requestedUrl = process.env.XINYING_INSPECT_URL;
  if (requestedUrl) {
    const parsed = new URL(requestedUrl);
    if (parsed.protocol !== "https:" || !(parsed.hostname === "blueaivideo.com" || parsed.hostname.endsWith(".blueaivideo.com"))) {
      throw new Error("XINYING_INSPECT_URL 只允许 https://blueaivideo.com 域名");
    }
    await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);
  }
  const snapshot = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const clean = (value) => {
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      if (/\b1\d{10}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) return "[账号信息已隐藏]";
      return text.slice(0, 120);
    };
    const materialList = document.querySelector(".ContentChatInput .material-list");
    const staticMaterialLabels = new Set(["+V角色", "图片", "视频", "音频", "首帧", "尾帧"]);
    const stagedMaterials = materialList
      ? Array.from(materialList.children).filter((element) => !staticMaterialLabels.has(clean(element.textContent))).map((element, index) => ({
        index: index + 1,
        text: clean(element.textContent),
        className: element.getAttribute("class"),
        controls: Array.from(element.querySelectorAll("button,[role='button']")).map((control) => ({
          title: clean(control.getAttribute("title")),
          ariaLabel: clean(control.getAttribute("aria-label")),
          className: control.getAttribute("class"),
        })),
        descendants: Array.from(element.querySelectorAll("*")).slice(0, 40).map((child) => ({
          tag: child.tagName.toLowerCase(),
          className: child.getAttribute("class"),
          title: clean(child.getAttribute("title")),
          ariaLabel: clean(child.getAttribute("aria-label")),
        })),
      }))
      : [];
    const promptElement = document.querySelector(".ContentChatInput .mention-editor[contenteditable='true']");
    return {
      url: location.href,
      stage: location.hostname.endsWith("feishu.cn") || location.hostname.endsWith("larksuite.com")
        ? "feishu-qr"
        : location.pathname.includes("/login") ? "xinying-login" : "xinying-authenticated",
      needsHuman: location.hostname.endsWith("feishu.cn") || location.hostname.endsWith("larksuite.com") || location.pathname.includes("/login"),
      title: document.title,
      buttons: Array.from(document.querySelectorAll("button, [role='button']")).filter(isVisible).slice(0, 120).map((element) => clean(element.textContent)).filter(Boolean),
      fields: Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")).filter(isVisible).slice(0, 120).map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        placeholder: clean(element.getAttribute("placeholder")),
        accept: element.getAttribute("accept"),
        ariaLabel: clean(element.getAttribute("aria-label")),
      })),
      headings: Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']")).filter(isVisible).slice(0, 80).map((element) => clean(element.textContent)).filter(Boolean),
      adapterCounts: {
        composer: document.querySelectorAll(".ContentChatInput").length,
        prompt: document.querySelectorAll(".ContentChatInput .mention-editor[contenteditable='true']").length,
        imageInputs: document.querySelectorAll("input[type='file'][accept*='.jpeg'][accept*='.png']").length,
        materialLists: document.querySelectorAll(".ContentChatInput .material-list").length,
        modelToggles: document.querySelectorAll(".ContentChatInput .ContentChatOptionItem._model").length,
        parameterToggles: document.querySelectorAll(".ContentChatInput .ContentChatOptionItem._popover").length,
        userMessages: document.querySelectorAll(".ContentChatListItem.userChat").length,
        agentMessages: document.querySelectorAll(".ContentChatListItem.agentChat").length,
        videoResults: document.querySelectorAll(".ContentChatListItem.agentChat .content-item._video").length,
        downloadButtons: document.querySelectorAll(".icon-xiazai").length,
        stagedMaterials: stagedMaterials.length,
      },
      adapterDetails: {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        modelToggles: Array.from(document.querySelectorAll(".ContentChatInput .ContentChatOptionItem._model")).map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent?.trim() ?? "",
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        }),
        audioToggles: Array.from(document.querySelectorAll(".ContentChatInput .ContentChatOptionItem._toggle"))
          .filter((element) => /有声|无声/.test(element.textContent ?? ""))
          .map((element) => ({ text: clean(element.textContent), className: element.getAttribute("class"), ariaChecked: element.getAttribute("aria-checked") })),
        stagedMaterials,
        promptTextLength: (promptElement?.textContent ?? "").trim().length,
      },
    };
  });
  const screenshotPath = process.env.XINYING_SCREENSHOT_PATH;
  if (screenshotPath) {
    const composer = page.locator(".ContentChatInput").first();
    const box = await composer.boundingBox();
    if (!box) throw new Error("无法取得心影生成区截图范围");
    await page.screenshot({ path: screenshotPath, clip: box, animations: "disabled" });
    snapshot.screenshotPath = screenshotPath;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, snapshot }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
