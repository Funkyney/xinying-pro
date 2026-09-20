import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type FastPathLookupMode = "visible" | "existing" | "collection";

export interface PageShellSnapshot {
  url: string;
  bodyClass: string;
  assets: string[];
  roots: string[];
}

interface FastPathEntry {
  selector: string;
  updatedAt: string;
}

interface FastPathFile {
  version: 1;
  entries: Record<string, FastPathEntry>;
}

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 400;

function stableHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function normalizedRoute(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return rawUrl.split(/[?#]/, 1)[0] ?? rawUrl;
  }
}

export function pageShellFingerprint(snapshot: PageShellSnapshot): string {
  const stable = {
    route: normalizedRoute(snapshot.url),
    bodyClass: snapshot.bodyClass.trim().split(/\s+/).filter(Boolean).sort().join(" "),
    assets: [...new Set(snapshot.assets.map((value) => value.trim()).filter(Boolean))].sort(),
    roots: [...new Set(snapshot.roots.map((value) => value.trim()).filter(Boolean))].sort(),
  };
  return `${stable.route}|${stableHash(JSON.stringify(stable))}`;
}

export function selectorGroupKey(
  shellFingerprint: string,
  mode: FastPathLookupMode,
  selectors: readonly string[],
): string {
  return `${shellFingerprint}|${mode}|${stableHash(JSON.stringify(selectors))}`;
}

export class AutomationFastPathCache {
  private entries = new Map<string, FastPathEntry>();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    this.load();
  }

  preferred(
    shellFingerprint: string,
    mode: FastPathLookupMode,
    selectors: readonly string[],
  ): string | null {
    const key = selectorGroupKey(shellFingerprint, mode, selectors);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const updatedAt = Date.parse(entry.updatedAt);
    if (!selectors.includes(entry.selector) || !Number.isFinite(updatedAt) || this.now() - updatedAt > this.ttlMs) {
      this.entries.delete(key);
      this.persist();
      return null;
    }
    return entry.selector;
  }

  remember(
    shellFingerprint: string,
    mode: FastPathLookupMode,
    selectors: readonly string[],
    selector: string,
  ): void {
    if (!selectors.includes(selector)) return;
    const key = selectorGroupKey(shellFingerprint, mode, selectors);
    if (this.entries.get(key)?.selector === selector) return;
    this.entries.set(key, { selector, updatedAt: new Date(this.now()).toISOString() });
    this.prune();
    this.persist();
  }

  snapshot(): Record<string, FastPathEntry> {
    return Object.fromEntries(this.entries);
  }

  private load(): void {
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<FastPathFile>;
      if (payload.version !== CACHE_VERSION || !payload.entries || typeof payload.entries !== "object") return;
      this.entries = new Map(Object.entries(payload.entries).filter(([, entry]) => (
        Boolean(entry) && typeof entry.selector === "string" && typeof entry.updatedAt === "string"
      )));
      this.prune();
    } catch {
      this.entries.clear();
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      const updatedAt = Date.parse(entry.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.entries()]
      .sort((left, right) => Date.parse(left[1].updatedAt) - Date.parse(right[1].updatedAt));
    for (const [key] of oldest.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(key);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: FastPathFile = { version: CACHE_VERSION, entries: this.snapshot() };
      fs.writeFileSync(this.filePath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    } catch {
      // Selector learning is an optimization only. Never block official web automation.
    }
  }
}
