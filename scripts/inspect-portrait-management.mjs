import { chromium } from "playwright-core";

const clickDom = (locator) => locator.evaluate((element) => {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
});

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
    try { return new URL(candidate.url()).hostname === "blueaivideo.com" && new URL(candidate.url()).pathname === "/avpAgent"; } catch { return false; }
  });
  if (!page) throw new Error("找不到 APP 内心影生成会话");
  await page.locator(".ContentChatInput").waitFor({ state: "visible", timeout: 20_000 });
  const visibleDialog = page.locator(".Dialog4StudioSetting:has-text('心影认证角色库')").filter({ visible: true }).first();
  if ((await visibleDialog.count()) === 0) {
    await clickDom(page.locator(".ContentChatInput .material-list .ContentChatUploadItem:has-text('+V角色') .characterWrapper").first());
  }
  const dialog = page.locator(".Dialog4StudioSetting:has-text('心影认证角色库')").first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.locator(".faceCard").first().waitFor({ state: "visible", timeout: 20_000 });
  const cards = dialog.locator(".faceCard");
  const cardCount = await cards.count();
  const inspect = async (card) => card.evaluate((element) => ({
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
    controls: Array.from(element.querySelectorAll("button, [role='button'], [class*='more'], [class*='delete'], [class*='time'], [class*='menu']")).map((control) => ({
      tag: control.tagName,
      text: (control.textContent ?? "").replace(/\s+/g, " ").trim(),
      className: control.getAttribute("class") ?? "",
      title: control.getAttribute("title") ?? "",
      ariaLabel: control.getAttribute("aria-label") ?? "",
    })),
    html: element.outerHTML.slice(0, 5000),
  }));
  const first = await inspect(cards.first());
  const lastLoaded = await inspect(cards.last());
  const dialogControls = await dialog.locator("button, [role='button']").evaluateAll((elements) => elements.map((element) => ({
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    className: element.getAttribute("class") ?? "",
    title: element.getAttribute("title") ?? "",
    ariaLabel: element.getAttribute("aria-label") ?? "",
  })).filter((item) => item.text || item.title || item.ariaLabel));
  const dialogLabels = await dialog.locator("span, label, [class*='filter'], [class*='source']").evaluateAll((elements) => elements.map((element) => ({
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    className: element.getAttribute("class") ?? "",
  })).filter((item) => item.text && item.text.length < 80).slice(0, 160));
  const filterTrigger = dialog.locator(".filter-trigger").filter({ visible: true }).first();
  let filterPanel = null;
  let filterLabels = [];
  if ((await filterTrigger.count()) > 0) {
    await clickDom(filterTrigger);
    await page.waitForTimeout(200);
    const visiblePopper = page.locator(".el-popper, [role='tooltip']").filter({ visible: true }).last();
    if ((await visiblePopper.count()) > 0) filterPanel = await visiblePopper.evaluate((element) => ({ text: (element.textContent ?? "").replace(/\s+/g, " ").trim(), html: element.outerHTML.slice(0, 15_000) }));
    filterLabels = await page.locator("body *").evaluateAll((elements) => elements.filter((element) => element.children.length === 0).map((element) => ({ text: (element.textContent ?? "").replace(/\s+/g, " ").trim(), className: element.getAttribute("class") ?? "" })).filter((item) => item.text && item.text.length < 40 && /来源|上传|公共|公开|全部|我的|团队|确定|重置/.test(item.text)).slice(0, 120));
  }
  process.stdout.write(`${JSON.stringify({ pageUrl: page.url(), cardCount, first, lastLoaded, dialogControls, dialogLabels, filterPanel, filterLabels }, null, 2)}\n`);
  const cancel = dialog.getByText("取消", { exact: true }).filter({ visible: true }).first();
  if ((await cancel.count()) > 0) await clickDom(cancel);
} finally {
  await browser?.close().catch(() => undefined);
}
