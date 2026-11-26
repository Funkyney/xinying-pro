import type { Page } from "playwright-core";

export type HistoryMaterialSlot = "firstFrame" | "tailFrame" | "image" | "video" | "audio";
export type HistoryComposerMaterials = Record<HistoryMaterialSlot, Record<string, any>[]>;
export const historyMaterialSlots: HistoryMaterialSlot[] = ["firstFrame", "tailFrame", "image", "video", "audio"];
export function emptyHistoryMaterials(): HistoryComposerMaterials { return { firstFrame: [], tailFrame: [], image: [], video: [], audio: [] }; }
export function historyCloudIdentity(item: Record<string, any>): string {
  // _uid belongs to the website's UI and is regenerated on config updates.
  // Compare stable cloud identities, not ephemeral widget keys.
  return JSON.stringify([item.material_id ?? "", item.portrait_id ?? "", item.cdn_url ?? "", item.vlc_id ?? ""]);
}

/** Use the official composer's own v-model event, never DOM-only card changes.
 * No submit handler, credential, or approval flag is accessed or modified.
 * A missing/changed component fails closed instead of guessing its state.
 */
export async function historyComposerMaterials(page: Page, materials?: HistoryComposerMaterials): Promise<HistoryComposerMaterials> {
  return page.evaluate(async (requested) => {
    const root = document.querySelector("#app") as (Element & { _vnode?: any }) | null;
    const stack = [root?._vnode], seen = new Set();
    let composer: any;
    for (let guard = 0; stack.length && guard < 5_000; guard += 1) {
      const vnode = stack.pop();
      if (!vnode || typeof vnode !== "object" || seen.has(vnode)) continue;
      seen.add(vnode);
      if (vnode.component) {
        const component = vnode.component;
        if (component.type?.__name === "ContentChatInput" && typeof component.exposed?.restoreEditor === "function") {
          composer = component; break;
        }
        stack.push(component.subTree);
      }
      if (Array.isArray(vnode.children)) stack.push(...vnode.children);
      if (vnode.suspense) stack.push(vnode.suspense.activeBranch);
    }
    if (!composer || !composer.props?.config || typeof composer.emit !== "function") throw Error("官网素材编辑接口已变化，已停止提交，请更新心影Pro");
    const slots = ["firstFrame", "tailFrame", "image", "video", "audio"] as const;
    if (requested) {
      if (slots.some((slot) => !Array.isArray(requested[slot]))) throw Error("历史素材编辑清单不完整");
      composer.emit("update:config", { ...composer.props.config, ...requested, document: [] });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    const result = Object.fromEntries(slots.map((slot) => [slot, composer.props.config[slot] ?? []]));
    if (slots.some((slot) => !Array.isArray(result[slot]))) throw Error("官网未返回可核验的素材清单，已停止提交");
    return JSON.parse(JSON.stringify(result));
  }, materials);
}
