import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { PlaywrightXinyingAdapter } from "../dist-electron/main/playwright-adapter.js";
import { createAppPaths } from "../dist-electron/core/paths.js";
import { XinyingDatabase } from "../dist-electron/core/database.js";
import { XinyingService } from "../dist-electron/core/service.js";

const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), "xinying-composer-draft-"));
const selectors = JSON.parse(fs.readFileSync(path.join(root, "config/xinying-selectors.json"), "utf8"));
const adapter = new PlaywrightXinyingAdapter(0, selectors, createAppPaths(temp));
const controls = '<div class="ContentChatUploadItem">+ V 角色</div><div class="ContentChatUploadItem">图片 0/30</div><div class="ContentChatUploadItem">视频</div><div class="ContentChatUploadItem">音频</div><div class="skeleton"></div><input type="file" hidden>';
const html = cards => `<div class="ContentChatInput"><div class="material-list">${controls}${cards}</div><textarea>保留本地提示词</textarea></div>`;
let app;
try {
  app = await electron.launch({ args: [`--user-data-dir=${path.join(temp, "profile")}`, path.join(root, "scripts/fixtures/generation-options-main.cjs")] });
  const page = await app.firstWindow();
  await page.setContent(html(""));
  assert.equal(await adapter.uploadedMaterialCount(page), 0);
  await adapter.clearUploadedMaterials(page);
  await page.setContent(html('<div class="ContentChatUploadItem" data-material-key="image:1" onmouseenter="if(!this.querySelector(\'.content-delete\'))this.insertAdjacentHTML(\'beforeend\',\'<div class=&quot;content-delete&quot; onclick=&quot;this.parentElement.remove()&quot;></div>\')"><div class="content-preview"></div>图1/1</div>'));
  assert.equal(await adapter.uploadedMaterialCount(page), 1);
  assert.equal(await page.locator(".content-delete").count(), 0);
  await adapter.clearUploadedMaterials(page);
  assert.equal(await adapter.uploadedMaterialCount(page), 0);
  await page.setContent(html('<div class="ContentChatUploadItem" data-material-key="image:2"><div class="content-preview"></div>图1/1<div class="content-delete" onclick="window.clicks=(window.clicks||0)+1;const card=this.parentElement;setTimeout(()=>card.remove(),450)"></div></div>'));
  await adapter.clearUploadedMaterials(page);
  assert.equal(await page.evaluate(() => window.clicks), 1, "Wait for removal instead of clicking a stale element repeatedly");
  assert.equal(await adapter.uploadedMaterialCount(page), 0);
  assert.equal(await page.locator("textarea").inputValue(), "保留本地提示词");
  await page.setContent(html('<div class="ContentChatUploadItem" data-material-key="image:3"><div class="content-preview"></div>图1/1<div class="content-delete"></div></div>'));
  await assert.rejects(adapter.clearUploadedMaterials(page), error => error.code === "DRAFT_CLEAR_FAILED");
  assert.equal(await adapter.uploadedMaterialCount(page), 1, "A real undeleted material must still block submission");
  // Reproduce selecting a shared asset in a newly bound conversation. Keep the
  // service's actual immutable snapshot and the adapter's real upload/mapping.
  const paths = createAppPaths(temp), database = new XinyingDatabase(paths.databasePath);
  let job;
  try {
    const service = new XinyingService(database, paths);
    const project = service.createProject({ name: "新会话共享素材验收", prompt: "参考 @图1，保持构图。", mode: "reference-to-video", autoPortraitAudit: true,
      platformProjectId: "fixture", platformWorkspaceId: "fixture", platformUrl: "https://blueaivideo.com/agentlab?projectId=fixture&sessionId=new-session" });
    const shared = service.addSharedMedia([path.join(root, "src/renderer/assets/dashboard-director.png")])[0];
    const references = service.addSharedMediaToProject(project.id, shared.id);
    assert.equal(references[0].sourceSharedMediaId, shared.id);
    job = service.submitGeneration(project.id);
  } finally { database.close(); }
  let uploads = 0, submissions = 0;
  const submitAdapter = new PlaywrightXinyingAdapter(0, { ...selectors, generation: { ...selectors.generation, prompt: ["textarea"], submitButtons: ["#send"] } }, paths);
  submitAdapter.ensureGenerationPage = async () => page;
  submitAdapter.configureModel = async () => null;
  submitAdapter.configureParameters = async () => null;
  submitAdapter.checkpoint = async () => null;
  await page.exposeFunction("recordFixtureUpload", () => { uploads++; });
  await page.route("https://heart-fixture.invalid/**", route => {
    if (new URL(route.request().url()).pathname === "/api/generation_invoke") {
      submissions++;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: { base_task_id: "fixture-new-session-task" } }) });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8">${html('<div class="ContentChatUploadItem" data-material-key="image:old"><div class="content-preview"></div>图1/1<div class="content-delete" onclick="const card=this.parentElement;setTimeout(()=>card.remove(),350)"></div></div>')}
      <input type="file" multiple accept=".png,.jpg"><button id="send">发送</button><script>
      document.querySelector('input[accept]').addEventListener('change',e=>{
        window.recordFixtureUpload();
        for(const file of e.target.files){const card=document.createElement('div');card.className='ContentChatUploadItem';card.dataset.materialKey='image:new';card.innerHTML='<div class="content-preview"></div>图1/1<div class="content-delete" onclick="this.parentElement.remove()"></div>';document.querySelector('.material-list').append(card);}
      });
      document.querySelector('#send').onclick=()=>{ const user=document.createElement('div');user.className='ContentChatListItem userChat';user.textContent=document.querySelector('textarea').value;document.body.append(user);fetch('/api/generation_invoke',{method:'POST'}); };
      </script>` });
  });
  await page.goto("https://heart-fixture.invalid/agentlab?projectId=fixture&sessionId=new-session");
  const submitted = await submitAdapter.submitGeneration(job);
  assert.equal(submitted.status, "running", JSON.stringify(submitted));
  assert.equal(submitted.platformExecutionId, "fixture-new-session-task");
  assert.equal(uploads, 1); assert.equal(submissions, 1);
  assert.equal(await adapter.uploadedMaterialCount(page), 1);
  assert.equal(await page.locator("textarea").inputValue(), job.promptSnapshot);
  console.log(JSON.stringify({ ok: true, ignoresNewSessionControls: true, hoverOnlyDelete: true, waitsForVueRemoval: true, preservesPrompt: true, blocksRealStaleMedia: true, newConversationSharedAssetSubmission: true, realGenerations: 0 }, null, 2));
} finally { if (app) await app.close().catch(() => undefined); }
