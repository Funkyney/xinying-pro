import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { PlaywrightXinyingAdapter } from "../dist-electron/main/playwright-adapter.js";
import { createAppPaths } from "../dist-electron/core/paths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-generation-options-"));
const selectors = JSON.parse(fs.readFileSync(path.join(root, "config/xinying-selectors.json"), "utf8"));
const adapter = new PlaywrightXinyingAdapter(0, selectors, createAppPaths(temp));
// Isolated official-DOM contract fixture; never connects to the user's account.
const switchMarkup = (checked, label = "", locked = false) => `<span class="el-switch" onclick="${locked ? "" : "const input=this.querySelector('input');input.setAttribute('aria-checked',input.getAttribute('aria-checked')!=='true')"}"><input role="switch" aria-label="${label}" aria-checked="${checked}"></span>`;
const adaptiveMarkup = (kind, delay, locked) => {
  if (!kind) return "";
  const change = locked ? "" : `this.querySelector('[aria-checked]')?.setAttribute('aria-checked','false');this.setAttribute('aria-checked','false');setTimeout(()=>document.querySelector('.duration-input input').disabled=false,${delay});window.adaptiveClicks=(window.adaptiveClicks||0)+1`;
  return `<div class="duration-header"><span>时长</span><div class="flex items-center g-6"><span>自适应</span>${kind === "input"
    ? `<span class="el-switch" onclick="${change}"><input role="switch" aria-checked="true"></span>`
    : `<span class="el-switch is-checked" role="switch" aria-checked="true" onclick="${change}"><input type="checkbox" hidden aria-hidden="true"><span class="el-switch__core"></span></span>`}</div></div>`;
};
const html = ({ missingAudit = false, lockedAudit = false, summaryDuration = 5, lockedSummary = false, adaptiveKind = "", adaptiveDelay = 0, lockedAdaptive = false, lockedDuration = false } = {}) => `
<div class="ContentChatInput">
<button class="ContentChatOptionItem _toggle" onclick="this.classList.toggle('isActive')">样片模式</button>
<button class="ContentChatOptionItem _popover" id="parameterSummary" onclick="params.hidden=!params.hidden">16:9 · 480p · 1080p · ${summaryDuration}s</button>
<button class="ContentChatOptionItem _toggle isActive" onclick="this.classList.toggle('isActive')">有声</button>
<button class="ContentChatOptionItem _toggle" onclick="advanced.hidden=!advanced.hidden">高级配置</button>
</div>
<div class="ContentChatOptionItemPopover" id="params" hidden>
 ${adaptiveMarkup(adaptiveKind, adaptiveDelay, lockedAdaptive)}
 <div class="duration-input"><input role="spinbutton" ${adaptiveKind || lockedDuration ? "disabled" : ""} value="${summaryDuration}" oninput="${lockedSummary ? "" : "parameterSummary.textContent='16:9 · 480p · 1080p · '+this.value+'s'"}"></div>
 <div class="inline-toggle-control">智能均衡模式${switchMarkup(true)}</div>
</div>
<div class="ContentConfigPopover" id="advanced" hidden>
 <div class="config-row">联网搜索${switchMarkup(false)}</div>
 <div class="config-row">提示词优化${switchMarkup(true)}</div>
 ${missingAudit ? "" : `<div class="config-row">自动图片人像审核${switchMarkup(false, "自动图片人像审核", lockedAudit)}</div>`}
 <div class="config-row" onclick="inspiration.hidden=!inspiration.hidden">灵感镜头</div>
 <div class="InspirationPanel" id="inspiration" hidden>
  <button class="clear-btn" onclick="document.querySelectorAll('.option-item').forEach(el=>el.classList.remove('isActive'))">清空选择</button>
  <button>相机</button><div class="option-item isActive" onclick="this.classList.toggle('isActive')"><span>旧镜头</span></div>
  <div class="option-item" onclick="this.classList.toggle('isActive')"><span>测试镜头</span></div>
 </div>
 <div class="config-row">视频格式<div class="format-chip isActive" onclick="format(this)">MP4</div><div class="format-chip" onclick="format(this)">MOV</div></div>
</div>
<script>window.adaptiveClicks=0;function format(el){document.querySelectorAll('.format-chip').forEach(e=>e.classList.remove('isActive'));el.classList.add('isActive');}</script>`;
const job = { parameters: { modelName: "Seedance 2.5 全能参考", aspectRatio: "16:9", duration: 8, resolution: "1080p",
  audioEnabled: true, videoFormat: "mov", networkEnabled: true, autoPortraitAudit: true, promptOptimizer: false, smartBalance: false,
  inspiration: { 相机: "测试镜头" } }, references: [{ mimeType: "image/png" }] };
let app;
try {
  app = await electron.launch({ args: [`--user-data-dir=${path.join(temp, "profile")}`, path.join(root, "scripts/fixtures/generation-options-main.cjs")], timeout: 20_000 });
  const page = await app.firstWindow();
  const cases = [];
  await page.setContent(html());
  assert.equal(await adapter.configureParameters(page, job), null);
  assert.equal(await page.locator("[aria-label='自动图片人像审核']").getAttribute("aria-checked"), "true");
  assert.equal(await page.locator(".duration-input input").inputValue(), "8");
  assert.equal(await page.locator(".config-row").filter({ hasText: "提示词优化" }).locator("[role='switch']").getAttribute("aria-checked"), "false");
  assert.equal(await page.locator(".format-chip.isActive").innerText(), "MOV");
  assert.equal(await page.locator(".option-item.isActive").innerText(), "测试镜头");
  cases.push("official switches, custom duration, MOV and inspiration confirmed");

  await page.setContent(html({ summaryDuration: 15 }));
  const fiveSecondJob = { ...job, parameters: { ...job.parameters, duration: 5 } };
  assert.equal(await adapter.configureParameters(page, fiveSecondJob), null);
  assert.equal(await page.locator(".duration-input input").inputValue(), "5");
  assert.match(await page.locator("#parameterSummary").innerText(), / · 5s$/);
  cases.push("a 5-second request replaces 15s rather than matching its suffix");

  for (const adaptiveKind of ["input", "wrapper"]) {
    await page.setContent(html({ summaryDuration: 15, adaptiveKind, adaptiveDelay: 650 }));
    assert.equal(await adapter.configureParameters(page, fiveSecondJob), null);
    assert.equal(await page.locator(".duration-input input").inputValue(), "5");
    assert.equal(await page.evaluate(() => window.adaptiveClicks), 1);
  }
  cases.push("adaptive duration supports both hidden-input and wrapper switches and waits for delayed unlock");

  await page.setContent(html({ summaryDuration: 15, adaptiveKind: "wrapper", lockedAdaptive: true }));
  const lockedDurationResult = await adapter.configureParameters(page, fiveSecondJob);
  assert.equal(lockedDurationResult.reason, "unknown");
  assert.match(lockedDurationResult.message, /未确认关闭自适应时长/);
  assert.equal(await page.locator(".duration-input input").isDisabled(), true, "Never remove a website disabled/review restriction");
  cases.push("unconfirmed adaptive controls stop once without forcing disabled inputs or submitting");

  await page.setContent(html({ summaryDuration: 15, lockedSummary: true }));
  assert.match((await adapter.configureParameters(page, fiveSecondJob)).message, /未接受时长参数/);
  cases.push("a changed input without an updated official summary stops submission");

  await page.setContent(html());
  const seedance20Job = { ...job, parameters: { ...job.parameters, modelName: "Seedance 2.0 全能参考", videoFormat: "mp4" } };
  assert.equal(await adapter.configureParameters(page, seedance20Job), null);
  assert.equal(await page.locator("[aria-label='自动图片人像审核']").getAttribute("aria-checked"), "true");
  assert.equal(await page.locator(".config-row").filter({ hasText: "联网搜索" }).locator("[role='switch']").getAttribute("aria-checked"), "true");
  cases.push("Seedance 2.0 confirms both official image review and web search");

  await page.setContent(html({ missingAudit: true }));
  assert.match((await adapter.configureParameters(page, job)).message, /未提供.*自动图片人像审核/);
  cases.push("missing audit switch stops image submission");

  await page.setContent(html({ lockedAudit: true }));
  assert.match((await adapter.configureParameters(page, job)).message, /未确认自动图片人像审核/);
  cases.push("unconfirmed audit switch cannot silently fall back");

  await page.setContent(html());
  assert.equal(await adapter.configureParameters(page, { ...job, parameters: { ...job.parameters, draftMode: true, smartBalance: true, inspiration: {} } }), null);
  assert.equal(await page.locator(".format-chip.isActive").innerText(), "MP4");
  assert.equal(await page.locator(".inline-toggle-control [role='switch']").getAttribute("aria-checked"), "false");
  assert.equal(await page.locator(".option-item.isActive").count(), 0);
  cases.push("draft mode enforces MP4, disables balance and clears old inspiration");

  // Local-only receipt fixture. All .invalid traffic is fulfilled in process;
  // it neither uploads files nor contacts Heart or creates real tasks.
  const receiptAdapter = new PlaywrightXinyingAdapter(0, {
    ...selectors, generation: { ...selectors.generation, prompt: ["textarea"], submitButtons: ["#send"] },
  }, createAppPaths(temp));
  receiptAdapter.ensureGenerationPage = async () => page;
  receiptAdapter.configureModel = async () => null;
  receiptAdapter.configureParameters = async () => null;
  receiptAdapter.uploadedMaterialCount = async () => 0;
  receiptAdapter.checkpoint = async () => null;
  let accepted = false;
  let omitTaskId = false;
  let submitClicks = 0;
  await page.route("https://heart-fixture.invalid/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/generation_invoke") {
      submitClicks += 1;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(accepted
        ? { code: 0, data: omitTaskId ? {} : { base_task_id: "fixture-task" } }
        : { code: 400, message: "自动图片审核失败" }) });
    }
    return route.fulfill({ contentType: "text/html", body: `<textarea></textarea><button id="send">发送</button><script>
      document.querySelector('#send').addEventListener('click', () => {
        const message = document.createElement('div');
        message.className = 'ContentChatListItem userChat'; message.textContent = 'fixture prompt';
        document.body.append(message); fetch('/api/generation_invoke', { method: 'POST' });
      });
    </script>` });
  });
  const receiptJob = { id: "fixture-job", platformTaskId: null, promptSnapshot: "fixture prompt", references: [],
    parameters: { modelName: "Seedance 2.5 全能参考", autoPortraitAudit: true, reuseUnknownMaterials: true } };
  await page.goto("https://heart-fixture.invalid/agentlab?sessionId=fixture");
  const rejected = await receiptAdapter.submitGeneration(receiptJob);
  assert.equal(rejected.status, "needs-human");
  assert.match(rejected.checkpoint.message, /自动图片审核失败/);
  assert.match(rejected.platformTaskId, /^pending-chat:/);
  assert.equal(submitClicks, 1);
  cases.push("optimistic user bubble cannot hide a delayed official review rejection");

  accepted = true;
  await page.goto("https://heart-fixture.invalid/agentlab?sessionId=fixture");
  const submitted = await receiptAdapter.submitGeneration(receiptJob);
  assert.equal(submitted.status, "running");
  assert.equal(submitted.platformExecutionId, "fixture-task");
  assert.equal(submitClicks, 2);
  cases.push("only a successful backend receipt reaches the generating boundary");

  omitTaskId = true;
  await page.goto("https://heart-fixture.invalid/agentlab?sessionId=fixture");
  const ambiguous = await receiptAdapter.submitGeneration(receiptJob);
  assert.equal(ambiguous.status, "needs-human");
  assert.match(ambiguous.checkpoint.message, /缺少正式任务编号/);
  assert.equal(submitClicks, 3);
  cases.push("an incomplete success envelope cannot masquerade as a created task");

  receiptAdapter.responseForTask = async () => null;
  const resumed = await receiptAdapter.submitGeneration({ ...receiptJob, platformTaskId: rejected.platformTaskId });
  assert.equal(resumed.status, "needs-human");
  assert.equal(resumed.platformTaskId, rejected.platformTaskId);
  assert.equal(submitClicks, 3);
  cases.push("recovering an unconfirmed review never resubmits or trusts a transient bubble");
  process.stdout.write(JSON.stringify({ ok: true, cases }, null, 2) + "\n");
} finally {
  await app?.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
