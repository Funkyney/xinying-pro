import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const candidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error("找不到 Edge 或 Chrome");

const outputDir = path.join(process.cwd(), "test-results", "reference-fixtures");
fs.mkdirSync(outputDir, { recursive: true });
const fixtures = [
  { number: 1, label: "@图1 / FIRST", start: "#6D44E4", end: "#A77BFF" },
  { number: 2, label: "@图2 / SECOND", start: "#087E93", end: "#58D7EC" },
  { number: 3, label: "@图3 / THIRD", start: "#16875D", end: "#4ED39A" },
];

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 768, height: 768 }, deviceScaleFactor: 1 });
  for (const fixture of fixtures) {
    await page.setContent(`<!doctype html><style>
      *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
      body{display:grid;place-items:center;color:white;background:linear-gradient(145deg,${fixture.start},${fixture.end})}
      main{display:grid;place-items:center;width:690px;height:690px;border:4px solid rgba(255,255,255,.76);border-radius:56px;background:rgba(8,10,18,.12);box-shadow:0 28px 80px rgba(8,10,18,.28)}
      strong{font-size:360px;line-height:.9;text-shadow:0 18px 45px rgba(8,10,18,.24)}
      span{font-size:42px;font-weight:800;letter-spacing:.08em}
    </style><main><strong>${fixture.number}</strong><span>${fixture.label}</span></main>`);
    const output = path.join(outputDir, `reference-${fixture.number}.png`);
    await page.screenshot({ path: output });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, outputDir, files: fixtures.map((fixture) => path.join(outputDir, `reference-${fixture.number}.png`)) }, null, 2)}\n`);
} finally {
  await browser.close();
}
