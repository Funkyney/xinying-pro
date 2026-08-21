import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { PlaywrightXinyingAdapter, adapterInternals } from "../dist-electron/main/playwright-adapter.js";
import { createAppPaths } from "../dist-electron/core/paths.js";

if (!process.argv.includes("--confirm-stage")) {
  throw new Error("该脚本会临时选择心影虚拟人像并清空草稿；必须添加 --confirm-stage");
}

const port = Number(process.env.XINYING_CDP_PORT ?? 9333);
const targetUrl = process.env.XINYING_INSPECT_URL ?? "";
const requestedNames = JSON.parse(process.env.XINYING_PORTRAIT_NAMES ?? "[]");
if (!targetUrl || !Array.isArray(requestedNames) || requestedNames.length < 2 || requestedNames.some((name) => typeof name !== "string")) {
  throw new Error("缺少 XINYING_INSPECT_URL，或 XINYING_PORTRAIT_NAMES 不是至少包含两个名称的 JSON 数组");
}
const parsedTarget = new URL(targetUrl);
if (parsedTarget.protocol !== "https:" || parsedTarget.hostname !== "blueaivideo.com" || parsedTarget.pathname !== "/avpAgent") {
  throw new Error("XINYING_INSPECT_URL 必须是心影 avpAgent HTTPS 地址");
}

const selectors = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "xinying-selectors.json"), "utf8"));
const remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
let adapter;
let platformPage;
try {
  const pages = remote.contexts().flatMap((context) => context.pages());
  const renderer = pages.find((page) => page.url().startsWith("file:") || page.url().includes("127.0.0.1:5173"));
  if (!renderer) throw new Error("找不到心影Pro主窗口");
  const platformPortraits = await renderer.evaluate(() => window.xinying.portraits.platformList());
  const portraits = requestedNames.map((name) => {
    const matches = platformPortraits.filter((portrait) => portrait.available && portrait.displayName === name);
    if (matches.length !== 1) throw new Error(`名称“${name}”匹配到 ${matches.length} 个可用虚拟人像`);
    return matches[0];
  });

  adapter = new PlaywrightXinyingAdapter(port, selectors, createAppPaths());
  platformPage = await adapter.page();
  await platformPage.goto(parsedTarget.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await platformPage.locator(".ContentChatInput").waitFor({ state: "visible", timeout: 25_000 });
  await adapter.clearUploadedMaterials(platformPage);

  const checkpoint = await adapter.selectPlatformPortraits(platformPage, portraits, portraits.length);
  if (checkpoint) throw new Error(checkpoint.message);
  const materials = await platformPage.locator(".ContentChatInput .material-list > .ContentChatUploadItem").evaluateAll((elements) => elements
    .filter((element) => /^(?:图|视频)\d+$/.test((element.textContent ?? "").trim()))
    .map((element) => ({
      label: (element.textContent ?? "").trim(),
      style: element.querySelector(".preview-bg")?.getAttribute("style") ?? "",
    })));
  const actualAssetIds = materials.map((material) => portraits.find((portrait) => material.style.includes(portrait.platformAssetId))?.platformAssetId ?? "unknown");
  const expectedAssetIds = portraits.map((portrait) => portrait.platformAssetId);
  if (actualAssetIds.includes("unknown") || new Set(actualAssetIds).size !== portraits.length || expectedAssetIds.some((id) => !actualAssetIds.includes(id))) {
    throw new Error(`心影没有返回完整且唯一的虚拟人像素材：${actualAssetIds.join(", ")}`);
  }
  const actualLabelByAssetId = new Map(materials.map((material, index) => [actualAssetIds[index], `@${material.label}`]));
  const counters = { image: 0, video: 0 };
  const plannedLabels = portraits.map((portrait) => {
    const actual = actualLabelByAssetId.get(portrait.platformAssetId) ?? "";
    const kind = actual.startsWith("@视频") ? "video" : "image";
    counters[kind] += 1;
    return `@${kind === "video" ? "视频" : "图"}${counters[kind]}`;
  });
  const actualLabelsForPlan = portraits.map((portrait) => actualLabelByAssetId.get(portrait.platformAssetId) ?? "");
  const samplePrompt = plannedLabels.map((label, index) => `${label} 是角色${index + 1}`).join("；");
  const remappedPrompt = adapterInternals.remapPromptLabels(samplePrompt, new Map(plannedLabels.map((label, index) => [label, actualLabelsForPlan[index]])));
  if (actualLabelsForPlan.some((label) => !remappedPrompt.includes(label))) throw new Error("提示词编号没有映射到心影实际角色编号");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    generated: false,
    requestedNames,
    expectedAssetIds,
    actualAssetIds,
    platformOrderMatchesApp: JSON.stringify(actualAssetIds) === JSON.stringify(expectedAssetIds),
    plannedLabels,
    actualLabelsForPlan,
    samplePrompt,
    remappedPrompt,
  }, null, 2)}\n`);
} finally {
  if (adapter && platformPage) await adapter.clearUploadedMaterials(platformPage).catch(() => undefined);
  await adapter?.close().catch(() => undefined);
  await remote.close().catch(() => undefined);
}
