import { chromium } from "playwright-core";

if (!process.argv.includes("--confirm-cleanup")) {
  throw new Error("清理心影测试草稿前必须添加 --confirm-cleanup");
}

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`, { timeout: 10_000 });
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
    try { return new URL(candidate.url()).hostname === "blueaivideo.com" && new URL(candidate.url()).pathname === "/avpAgent"; } catch { return false; }
  });
  if (!page) throw new Error("找不到 APP 内心影生成会话");
  const items = page.locator(".ContentChatInput .material-list > .ContentChatUploadItem");
  const allLabels = [];
  for (let index = 0; index < await items.count(); index += 1) allLabels.push(((await items.nth(index).innerText()) ?? "").trim());
  const labels = allLabels.filter((label) => /^图\d+$/.test(label));
  const beforeCount = labels.length;
  if (beforeCount !== 3 || labels.some((label, index) => label !== `图${index + 1}`)) {
    throw new Error(`草稿素材不是预期的图1/图2/图3，已中止清理：${JSON.stringify(labels)}`);
  }
  const prompt = page.locator(".ContentChatInput .mention-editor[contenteditable='true']").first();
  if ((((await prompt.textContent()) ?? "").trim()).length !== 0) throw new Error("提示词区非空，已中止清理并等待人工检查");
  const userMessagesBefore = await page.locator(".ContentChatListItem.userChat").count();

  for (let index = beforeCount - 1; index >= 0; index -= 1) {
    const expectedLabel = `图${index + 1}`;
    const candidates = page.locator(".ContentChatInput .material-list > .ContentChatUploadItem").filter({ hasText: expectedLabel });
    let item = null;
    for (let candidateIndex = 0; candidateIndex < await candidates.count(); candidateIndex += 1) {
      if ((((await candidates.nth(candidateIndex).innerText()) ?? "").trim()) === expectedLabel) {
        item = candidates.nth(candidateIndex);
        break;
      }
    }
    if (!item) throw new Error(`清理前找不到唯一的${expectedLabel}槽位`);
    const label = ((await item.innerText()) ?? "").trim();
    const remove = item.locator(".content-delete").first();
    if ((await remove.count()) !== 1) throw new Error(`图${index + 1} 没有唯一的删除控件`);
    await remove.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })));
    await page.waitForFunction((expected) => Array.from(document.querySelectorAll(".ContentChatInput .material-list > .ContentChatUploadItem")).filter((element) => /^图\d+$/.test((element.textContent ?? "").trim())).length === expected, index, { timeout: 10_000 });
    process.stdout.write(`${JSON.stringify({ progress: "removed", label, remaining: index })}\n`);
  }

  const remaining = await page.locator(".ContentChatInput .material-list > .ContentChatUploadItem").evaluateAll((elements) => elements.filter((element) => /^图\d+$/.test((element.textContent ?? "").trim())).length);
  const userMessagesAfter = await page.locator(".ContentChatListItem.userChat").count();
  const report = {
    ok: remaining === 0 && userMessagesAfter === userMessagesBefore,
    removed: labels,
    remaining,
    promptTextLength: (((await prompt.textContent()) ?? "").trim()).length,
    userMessagesBefore,
    userMessagesAfter,
    generated: false,
    cleanedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
}
