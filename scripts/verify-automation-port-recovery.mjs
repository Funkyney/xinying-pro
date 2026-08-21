import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "Electron.app/Contents/MacOS/Electron");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-update-port-"));
const child = spawn(executable, [`--user-data-dir=${path.join(dataDir, "electron-user-data")}`, root, "--updated"], {
  cwd: root,
  env: { ...process.env, XINYING_DATA_DIR: dataDir, XINYING_DISABLE_AUTO_UPDATE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let remote;
try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !remote) {
    remote = await chromium.connectOverCDP("http://127.0.0.1:9334", { timeout: 1_000 }).catch(() => undefined);
    if (!remote) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!remote) throw new Error("带 --updated 的 APP 未在备用端口 9334 启动");

  const page = remote.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:") || candidate.url().includes("127.0.0.1:5173"));
  if (!page) throw new Error("备用端口已启动，但没有找到 APP 主窗口");
  const marker = fs.readFileSync(path.join(dataDir, "automation-port"), "utf8").trim();
  if (marker !== "9334") throw new Error(`端口标记错误：${marker}`);

  process.stdout.write(`${JSON.stringify({ ok: true, port: 9334, marker, title: await page.title() }, null, 2)}\n`);
  await page.close();
  await new Promise((resolve) => child.once("exit", resolve));
} finally {
  await remote?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
