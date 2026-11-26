import type { ConversationHistoryMaterial, ConversationHistorySource, PlatformPortrait, ReferenceAsset } from "./contracts";
import { assignMediaLabels, mediaKindFromMime } from "./media";
import { parseMaterialKey } from "./material-order";

export function historyMaterialKey(key: string): string { return `history:${key}`; }
export function historyMaterialOrder(source: ConversationHistorySource): string[] {
  return source.materialOrder ?? source.materials.map((material) => historyMaterialKey(material.key));
}

export function updateHistoryMaterialSelection(order: string[], selectedKeys: string[], replaceKey?: string): string[] {
  const keys = [...new Set(selectedKeys)];
  if (replaceKey) return order.flatMap((key) => key === replaceKey ? keys : keys.includes(key) ? [] : [key]);
  return [...order, ...keys.filter((key) => !order.includes(key))];
}

export interface EditableHistoryMaterial {
  key: string;
  kind: "image" | "video" | "audio" | "unknown";
  name: string;
  label: string;
  cloud?: ConversationHistoryMaterial;
  reference?: ReferenceAsset;
  portrait?: PlatformPortrait;
  unavailable?: boolean;
}

/** Only explicit selections participate; unrelated local drafts never leak in. */
export function resolveHistoryMaterials(source: ConversationHistorySource, references: ReferenceAsset[], portraits: PlatformPortrait[]): EditableHistoryMaterial[] {
  const cloud = new Map(source.materials.map((item) => [historyMaterialKey(item.key), item]));
  const local = new Map(references.map((item) => [item.id, item]));
  const characters = new Map(portraits.map((item) => [item.id, item]));
  const materials = historyMaterialOrder(source).map((key): EditableHistoryMaterial => {
    const original = cloud.get(key);
    if (original) return { key, kind: original.kind, name: original.name, label: "", cloud: original };
    const selection = parseMaterialKey(key);
    const reference = selection?.kind === "reference" ? local.get(selection.id) : undefined;
    if (reference) return { key, kind: mediaKindFromMime(reference.mimeType), name: reference.name, label: "", reference };
    const portrait = selection?.kind === "portrait" ? characters.get(selection.id) : undefined;
    if (portrait) return { key, kind: portrait.mediaKind, name: portrait.displayName, label: "", portrait, unavailable: !portrait.available };
    return { key, kind: "unknown", name: "素材已失效，请移除或重新选择", label: "", unavailable: true };
  });
  const labels = assignMediaLabels(materials.map((item) => item.kind));
  return materials.map((item, index) => ({ ...item, label: labels[index] }));
}
