import type { PlatformResult } from "./contracts";
import { platformVideoIdentity } from "./platform-results";

/** Same asset across library tabs/local bindings. Never group by task or name:
 * one task may emit multiple distinct clips. Arbitrary external URLs retain queries. */
export function resultAnnotationGroups(results: PlatformResult[]): Map<string, PlatformResult[]> {
  const parents = results.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const seen = new Map<string, number>();
  results.forEach((result, index) => {
    const scope = result.platformProjectId ? `remote:${result.platformProjectId}` : `local:${result.projectId}`;
    const identity = result.mediaKind === "video" ? platformVideoIdentity(result.outputUrl) : null;
    const keys = [identity && `video:${identity}`, result.outputUrl && `url:${result.outputUrl}`, result.outputPath && `file:${result.outputPath}`];
    for (const key of keys) {
      if (!key) continue;
      const scoped = JSON.stringify([scope, result.mediaKind, key]);
      const previous = seen.get(scoped);
      if (previous !== undefined) parents[root(index)] = root(previous);
      else seen.set(scoped, index);
    }
  });
  const groups = new Map<number, PlatformResult[]>();
  results.forEach((result, index) => {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  });
  return new Map(results.map((result, index) => [result.id, groups.get(root(index))!]));
}

export function normalizedClipMarkers(times: readonly number[]): number[] {
  return [...new Set(times.filter(time => Number.isSafeInteger(time) && time >= 0))].sort((a, b) => a - b);
}

export function mergedResultAnnotations(results: PlatformResult[]): Pick<PlatformResult, "marked" | "clipMarkersMs" | "platformMarked"> {
  const remoteFlags = results.map(result => result.platformMarked).filter(flag => typeof flag === "boolean");
  return {
    marked: results.some(result => result.marked),
    ...(remoteFlags.length ? { platformMarked: remoteFlags.some(Boolean) } : {}),
    clipMarkersMs: normalizedClipMarkers(results.flatMap(result => result.clipMarkersMs ?? [])),
  };
}
