import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const source = path.join(root, "build", "icon.svg");
const outputs = [
  { path: path.join(root, "build", "icon.png"), scale: 1 },
  { path: path.join(root, "build", "icon-mac.png"), scale: 4 },
];
const candidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error("找不到可用于栅格化应用图标的 Edge 或 Chrome");

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const svg = fs.readFileSync(source, "utf8");
  for (const output of outputs) {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: output.scale });
    await page.setContent(`<!doctype html><html><head><style>
      html, body { width: 256px; height: 256px; margin: 0; overflow: hidden; background: transparent; }
      body { display: grid; place-items: center; }
      svg { display: block; width: 232px; height: 232px; }
    </style></head><body>${svg}</body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: output.path, omitBackground: true });
    await page.close();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, source, outputs: outputs.map((output) => output.path) })}\n`);
} finally {
  await browser.close();
}
