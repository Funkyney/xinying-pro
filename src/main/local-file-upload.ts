import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Locator, Page } from "playwright-core";
import { AppError } from "../core/errors";

const PAYLOAD_LIMIT = 50 * 1024 * 1024;

/** Hand local paths to Chromium; never base64-encode an entire media batch.
 * This only selects files in the normal input. Website validation, uploads,
 * portrait review and submission still run unchanged in the website.
 */
export async function setLocalInputFiles(page: Page, input: Locator, files: string | readonly string[]): Promise<void> {
  const paths = (typeof files === "string" ? [files] : [...files]).map(file => path.resolve(file));
  const sizes = await Promise.all(paths.map(async file => {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new AppError("REFERENCE_FILE_MISSING", `找不到待上传素材：${path.basename(file)}`);
    return stat.size;
  }));
  const marker = `data-xinying-upload-${crypto.randomUUID()}`;
  let cdp: CDPSession | undefined;
  let selecting = false;
  try {
    cdp = await page.context().newCDPSession(page);
    await input.evaluate((node, attribute) => {
      if (!(node instanceof HTMLInputElement) || node.type !== "file") throw new Error("上传入口不是文件输入控件");
      node.setAttribute(attribute, "");
    }, marker);
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[${marker}]` });
    if (!nodeId) throw new Error("本地上传控件已变化");
    // Once selection starts, never fall back/replay: the site's change handler
    // may already have queued uploads even if the protocol response is lost.
    selecting = true;
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: paths });
  } catch (error) {
    if (selecting) throw new AppError("LOCAL_FILE_HANDOFF_FAILED", "向浏览器交接本地素材时连接中断，已停止以避免重复上传；请检查原网页素材状态后恢复", { cause: error instanceof Error ? error.message : String(error) });
    if (sizes.reduce((sum, size) => sum + size, 0) >= PAYLOAD_LIMIT) {
      throw new AppError("LOCAL_FILE_HANDOFF_UNAVAILABLE", "本地文件交接暂不可用，已停止整批传输以避免触发自动化组件的 50 MB 限制；请重启心影Pro后恢复原任务");
    }
    // Compatibility fallback for small files only. Do not split here: callers
    // must verify the website committed each run before adding another one.
    await input.setInputFiles(paths);
  } finally {
    await input.evaluate((node, attribute) => node.removeAttribute(attribute), marker).catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
  }
}
