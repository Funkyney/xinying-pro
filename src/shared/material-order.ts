export type MaterialKind = "portrait" | "reference";

export function portraitMaterialKey(id: string): string {
  return `portrait:${id}`;
}

export function referenceMaterialKey(id: string): string {
  return `reference:${id}`;
}

export function parseMaterialKey(key: string): { kind: MaterialKind; id: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  const kind = key.slice(0, separator);
  if (kind !== "portrait" && kind !== "reference") return null;
  return { kind, id: key.slice(separator + 1) };
}

export function reconcileMaterialOrder(
  order: readonly string[] | undefined,
  portraitIds: readonly string[],
  referenceIds: readonly string[],
): string[] {
  const valid = new Set([
    ...portraitIds.map(portraitMaterialKey),
    ...referenceIds.map(referenceMaterialKey),
  ]);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const key of order ?? []) {
    if (valid.has(key) && !seen.has(key)) {
      normalized.push(key);
      seen.add(key);
    }
  }
  for (const id of portraitIds) {
    const key = portraitMaterialKey(id);
    if (!seen.has(key)) normalized.push(key);
  }
  for (const id of referenceIds) {
    const key = referenceMaterialKey(id);
    if (!seen.has(key)) normalized.push(key);
  }
  return normalized;
}

export function portraitsAreContiguous(order: readonly string[]): boolean {
  const positions = order
    .map((key, index) => parseMaterialKey(key)?.kind === "portrait" ? index : -1)
    .filter((index) => index >= 0);
  return positions.length < 2 || positions.at(-1)! - positions[0] + 1 === positions.length;
}
