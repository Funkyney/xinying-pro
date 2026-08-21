import fs from "node:fs";
import { chromium } from "playwright-core";

if (!process.argv.includes("--confirm-upload")) {
  throw new Error("该脚本会上传一张测试图并选择一个已授权角色；必须添加 --confirm-upload");
}

const targetUrl = process.env.XINYING_INSPECT_URL ?? "";
const referenceFile = process.env.XINYING_REFERENCE_FILE ?? "";
const portraitName = process.env.XINYING_PORTRAIT_NAME ?? "";
const secondPortraitName = process.env.XINYING_SECOND_PORTRAIT_NAME ?? "";
if (!targetUrl || !referenceFile || !portraitName || !fs.existsSync(referenceFile)) {
  throw new Error("缺少 XINYING_INSPECT_URL、XINYING_REFERENCE_FILE 或 XINYING_PORTRAIT_NAME");
}

const clickDom = (locator) => locator.evaluate((element) => {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
});

const materialItems = (page) => page.locator(".ContentChatInput .material-list > .ContentChatUploadItem")
  .filter({ hasNotText: "+V角色" })
  .filter({ hasNotText: "图片" })
  .filter({ hasNotText: "视频" })
  .filter({ hasNotText: "音频" });

const snapshot = async (page) => materialItems(page).evaluateAll((elements) => elements
  .filter((element) => /^图\d+$/.test((element.textContent ?? "").trim()))
  .map((element) => ({
    label: (element.textContent ?? "").trim(),
    className: element.className,
    draggable: element.getAttribute("draggable"),
    imageUrls: Array.from(element.querySelectorAll("img")).map((image) => image.src),
    html: element.outerHTML.slice(0, 1200),
  })));

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
    try { return new URL(candidate.url()).hostname === "blueaivideo.com"; } catch { return false; }
  });
  if (!page) throw new Error("找不到 APP 内心影页面");
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator(".ContentChatInput").waitFor({ state: "visible", timeout: 25_000 });
  const initial = await snapshot(page);
  if (initial.length > 1) throw new Error("心影素材草稿超过一项，已中止测试");

  let checkboxBefore = null;
  let checkboxAfter = null;
  let selectedText = "existing portrait draft";
  if (initial.length === 0) {
    const openDialog = page.locator(".Dialog4StudioSetting:has-text('心影认证角色库')").filter({ visible: true }).first();
    if ((await openDialog.count()) === 0) {
      await clickDom(page.locator(".ContentChatInput .material-list .ContentChatUploadItem:has-text('+V角色') .characterWrapper").first());
    }
    const dialog = page.locator(".Dialog4StudioSetting:has-text('心影认证角色库')").first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.locator(".faceCard").first().waitFor({ state: "visible", timeout: 20_000 });
    const cards = dialog.locator(".faceCard").filter({ hasText: portraitName });
    let card = null;
    for (let index = 0; index < await cards.count(); index += 1) {
      if (((await cards.nth(index).locator(".face-name-text").innerText().catch(() => "")).trim()) === portraitName) {
        card = cards.nth(index);
        break;
      }
    }
    if (!card) throw new Error(`找不到角色：${portraitName}`);
    const checkbox = card.locator(".p-checkbox-black").first();
    checkboxBefore = await checkbox.evaluate((element) => ({ html: element.outerHTML, className: element.className, ariaChecked: element.getAttribute("aria-checked") }));
    await clickDom(checkbox);
    checkboxAfter = await checkbox.evaluate((element) => ({ html: element.outerHTML, className: element.className, ariaChecked: element.getAttribute("aria-checked") }));
    selectedText = await dialog.locator("text=/已选\\s*\\d+\\s*项/").filter({ visible: true }).first().innerText().catch(() => "");
    await clickDom(dialog.getByText("确定", { exact: true }).filter({ visible: true }).first());
    await page.waitForFunction(() => document.querySelectorAll(".ContentChatInput .material-list > .ContentChatUploadItem").length > 1, null, { timeout: 15_000 });
  }

  await page.locator("input[type='file'][accept*='.jpeg'][accept*='.png']").first().setInputFiles(referenceFile);
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".ContentChatInput .material-list > .ContentChatUploadItem")).filter((element) => /^图\d+$/.test((element.textContent ?? "").trim())).length === 2, null, { timeout: 90_000 });
  const before = await snapshot(page);
  let reopened = null;
  let afterSecondPortrait = null;
  if (secondPortraitName) {
    await clickDom(page.locator(".ContentChatInput .material-list .ContentChatUploadItem:has-text('+V角色') .characterWrapper").first());
    const dialog = page.locator(".Dialog4StudioSetting:has-text('心影认证角色库')").first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.locator(".faceCard").first().waitFor({ state: "visible", timeout: 20_000 });
    const firstCard = dialog.locator(".faceCard").filter({ hasText: portraitName }).first();
    const secondCard = dialog.locator(".faceCard").filter({ hasText: secondPortraitName }).first();
    reopened = {
      firstCheckbox: await firstCard.locator(".p-checkbox-black").first().innerHTML(),
      selectedText: await dialog.locator("text=/已选\\s*\\d+\\s*项/").filter({ visible: true }).first().innerText().catch(() => ""),
    };
    await clickDom(secondCard.locator(".p-checkbox-black").first());
    await clickDom(dialog.getByText("确定", { exact: true }).filter({ visible: true }).first());
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".ContentChatInput .material-list > .ContentChatUploadItem")).filter((element) => /^图\d+$/.test((element.textContent ?? "").trim())).length === 3, null, { timeout: 15_000 });
    afterSecondPortrait = await snapshot(page);
  }
  const items = materialItems(page).filter({ hasText: /^图\d+$/ });
  await items.nth(1).dragTo(items.nth(0)).catch(() => undefined);
  await page.waitForTimeout(1_000);
  const afterDrag = await snapshot(page);

  for (let index = (await materialItems(page).count()) - 1; index >= 0; index -= 1) {
    const item = materialItems(page).nth(index);
    if (!/^图\d+$/.test(((await item.innerText().catch(() => "")).trim()))) continue;
    const remove = item.locator(".content-delete").first();
    if ((await remove.count()) === 1) await clickDom(remove);
    await page.waitForTimeout(300);
  }

  process.stdout.write(`${JSON.stringify({ checkboxBefore, checkboxAfter, selectedText, before, reopened, afterSecondPortrait, afterDrag, remaining: await snapshot(page) }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
}
