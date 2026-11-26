import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, chromium } from "playwright-core";
import { setLocalInputFiles } from "../dist-electron/main/local-file-upload.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-local-upload-"));
const MiB = 1024 * 1024;
// Synthetic sparse files: this checks file handoff, not website media approval.
const files = Array.from({ length: 18 }, (_, index) => {
  const file = path.join(temp, `参考 image-${String(index + 1).padStart(2, "0")}.png`);
  const fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, (index === 17 ? 15 : 7) * MiB); fs.closeSync(fd);
  return file;
});
const large = path.join(temp, "large-51MiB.mov");
const fd = fs.openSync(large, "w"); fs.ftruncateSync(fd, 51 * MiB); fs.closeSync(fd);
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});
let app, browser;
try {
  app = await electron.launch({ args: [`--user-data-dir=${path.join(temp, "profile")}`, `--remote-debugging-port=${port}`, path.join(root, "scripts/fixtures/generation-options-main.cjs")], timeout: 20_000 });
  await app.firstWindow();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.setContent(`<input id="files" type="file" multiple><script>window.events=[];document.querySelector('input').addEventListener('change',e=>window.events.push([...e.target.files].map(f=>({name:f.name,size:f.size}))));</script>`);
  const started = Date.now();
  await setLocalInputFiles(page, page.locator("#files"), files);
  const batch = await page.evaluate(() => events);
  assert.equal(batch.length, 1, "A single native selection must not duplicate change events");
  assert.deepEqual(batch[0], files.map(file => ({ name: path.basename(file), size: fs.statSync(file).size })));
  assert.equal(await page.locator("[data-xinying-upload]").count(), 0);
  await setLocalInputFiles(page, page.locator("#files"), large);
  const events = await page.evaluate(() => window.events);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], [{ name: path.basename(large), size: 51 * MiB }]);
  assert.equal(await page.locator("input").evaluate(node => [...node.attributes].some(attr => attr.name.startsWith("data-xinying-upload-"))), false);
  console.log(JSON.stringify({ ok: true, syntheticOnly: true, batchImages: files.length, batchMiB: 134, singleVideoMiB: 51, orderAndSizesPreserved: true, elapsedMs: Date.now() - started, realUploads: 0, realGenerations: 0 }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (app) await app.close().catch(() => undefined);
}
