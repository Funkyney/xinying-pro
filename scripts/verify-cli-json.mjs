import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectDir, "dist-electron", "cli", "index.js");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-cli-json-"));

function run(name, args, expectedExitCode, expectedOk) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    env: { ...process.env, XINYING_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${name} 未输出纯 JSON：${result.stdout || result.stderr}`, { cause: error });
  }
  if (result.status !== expectedExitCode || envelope.ok !== expectedOk || typeof envelope.command !== "string") {
    throw new Error(`${name} JSON 包装不符合约定：${JSON.stringify({ status: result.status, envelope })}`);
  }
  return { name, exitCode: result.status, ok: envelope.ok, command: envelope.command, data: envelope.data };
}

try {
  const sharedImage = path.join(dataDir, "shared-cli.png");
  fs.copyFileSync(path.join(projectDir, "build", "icon.png"), sharedImage);
  const cases = [
    run("success", ["doctor"], 0, true),
    run("help", ["--help"], 0, true),
    run("error", ["job", "status", "missing-job"], 1, false),
    run("platform-confirmation", ["platform", "create", "--workspace-id", "personal", "--name", "test", "--creation-type", "其他"], 1, false),
    run("portrait-delete-confirmation", ["portrait", "platform-delete", "--project-id", "test", "--ids", "portrait-1"], 1, false),
    run("shared-library-add", ["library", "add", "--file", sharedImage], 0, true),
    run("shared-library-list", ["library", "list"], 0, true),
    run("shared-library-delete-confirmation", ["library", "remove", "missing-library-id"], 1, false),
  ];
  const project = run("director-project", ["project", "create", "--name", "director-cli", "--mode", "text-to-video"], 0, true);
  const manifestPath = path.join(dataDir, "director-run.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projectId: project.data.id,
    prompt: "固定机位，人物缓慢转身。",
    count: 2,
    materials: [],
  }));
  cases.push(
    project,
    run("director-validate", ["director", "validate", "--manifest", manifestPath], 0, true),
    run("director-prepare", ["director", "prepare", "--manifest", manifestPath], 0, true),
    run("director-submit-confirmation", ["director", "submit", "--manifest", manifestPath], 1, false),
  );
  process.stdout.write(`${JSON.stringify({ ok: true, cases }, null, 2)}\n`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
