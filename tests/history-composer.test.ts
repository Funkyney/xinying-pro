// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { emptyHistoryMaterials, historyComposerMaterials, historyCloudIdentity } from "../src/main/history-composer";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("compares stable cloud identities even when the official composer regenerates widget keys", () => {
  const material = { material_id: 123, cdn_url: "https://example.com/ref.png", _uid: "image_1" };
  expect(historyCloudIdentity(material)).toBe(historyCloudIdentity({ ...material, _uid: "image_9" }));
  expect(historyCloudIdentity(material)).not.toBe(historyCloudIdentity({ ...material, material_id: 456 }));
});
it("uses only the official configuration event, preserving model/review settings and never invoking submission", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => queueMicrotask(callback));
  const submit = vi.fn(), restoreEditor = vi.fn();
  const component = { type: { __name: "ContentChatInput" }, exposed: { restoreEditor, submit }, props: { config: { ...emptyHistoryMaterials(), model_name: "original", auto_portrait_audit: true } }, emit: vi.fn((event, next) => { expect(event).toBe("update:config"); component.props.config = next; }) };
  (document.querySelector("#app") as any)._vnode = { children: [{ component }] };
  const page = { evaluate: (fn: any, arg: any) => fn(arg) } as Page;
  const desired = { ...emptyHistoryMaterials(), image: [{ material_id: "same-cloud-id", cdn_url: "https://example.com/ref.png" }] };
  expect(await historyComposerMaterials(page, desired)).toEqual(desired);
  expect(component.props.config).toMatchObject({ model_name: "original", auto_portrait_audit: true });
  expect(submit).not.toHaveBeenCalled(); expect(restoreEditor).not.toHaveBeenCalled();
  expect(await historyComposerMaterials(page)).toEqual(desired);
  expect(component.emit).toHaveBeenCalledTimes(1);
});
it("fails closed if the official component contract changes", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const page = { evaluate: (fn: any, arg: any) => fn(arg) } as Page;
  await expect(historyComposerMaterials(page, emptyHistoryMaterials())).rejects.toThrow(/已停止提交/);
});
