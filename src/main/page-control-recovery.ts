import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import type {
  PageRecoveryAction,
  PageRecoveryCandidate,
} from "./typesafe-page-recovery";

export interface PageControlLocatorDescriptor {
  strategy: "selector" | "role" | "text";
  value: string;
  role?: string;
}

export interface PageControlCandidate extends PageRecoveryCandidate {
  locator: PageControlLocatorDescriptor;
}

export interface PageControlSnapshot {
  id: string;
  route: string;
  title: string;
  candidates: PageControlCandidate[];
}

interface RecoveryCacheEntry {
  locator: PageControlLocatorDescriptor;
  updatedAt: string;
}

type RecoveryCacheFile = Record<string, RecoveryCacheEntry>;

const RECOVERY_ATTRIBUTE = "data-xinying-recovery-control";

function stableHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function recoveryCacheKey(shell: string, intent: string, action: PageRecoveryAction): string {
  return `${shell}|${action}|${stableHash(intent)}`;
}

export class PageControlRecoveryCache {
  private entries: RecoveryCacheFile = {};

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 7 * 24 * 60 * 60_000,
    private readonly maxEntries = 120,
  ) {
    this.load();
  }

  preferred(shell: string, intent: string, action: PageRecoveryAction): PageControlLocatorDescriptor | null {
    const key = recoveryCacheKey(shell, intent, action);
    const entry = this.entries[key];
    if (!entry) return null;
    const updatedAt = Date.parse(entry.updatedAt);
    if (!Number.isFinite(updatedAt) || this.now() - updatedAt > this.ttlMs) {
      delete this.entries[key];
      this.persist();
      return null;
    }
    return entry.locator;
  }

  remember(shell: string, intent: string, action: PageRecoveryAction, locator: PageControlLocatorDescriptor): void {
    const key = recoveryCacheKey(shell, intent, action);
    this.entries[key] = { locator, updatedAt: new Date(this.now()).toISOString() };
    const ordered = Object.entries(this.entries).sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt));
    this.entries = Object.fromEntries(ordered.slice(0, this.maxEntries));
    this.persist();
  }

  forget(shell: string, intent: string, action: PageRecoveryAction): void {
    const key = recoveryCacheKey(shell, intent, action);
    if (!this.entries[key]) return;
    delete this.entries[key];
    this.persist();
  }

  snapshot(): RecoveryCacheFile {
    return structuredClone(this.entries);
  }

  private load(): void {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as RecoveryCacheFile;
      if (value && typeof value === "object") this.entries = value;
    } catch {
      this.entries = {};
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
    } catch {
      // Recovery cache failure must never block the deterministic automation path.
    }
  }
}

export async function capturePageControlSnapshot(page: Page, limit = 64): Promise<PageControlSnapshot> {
  const id = crypto.randomUUID();
  const snapshot = await page.evaluate(({ snapshotId, attribute, maximum }) => {
    const compact = (value: string | null | undefined, maxLength = 180): string => (
      value ?? ""
    ).replace(/\s+/g, " ").trim().slice(0, maxLength);
    const visible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) <= 0 || rect.width < 2 || rect.height < 2) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const textFromIdRefs = (value: string | null): string => compact((value ?? "").split(/\s+/).map((ref) => document.getElementById(ref)?.textContent ?? "").join(" "));
    const labelFor = (element: Element): string => {
      const aria = compact(element.getAttribute("aria-label"));
      if (aria) return aria;
      const labelled = textFromIdRefs(element.getAttribute("aria-labelledby"));
      if (labelled) return labelled;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const explicit = element.id ? document.querySelector(`label[for=${JSON.stringify(element.id)}]`)?.textContent : "";
        const wrapped = element.closest("label")?.textContent;
        const formLabel = compact(explicit || wrapped);
        if (formLabel) return formLabel;
      }
      return compact(element.textContent)
        || compact(element.getAttribute("placeholder"))
        || compact(element.getAttribute("title"))
        || compact(element.getAttribute("name"));
    };
    const semanticRole = (element: Element): string => {
      const declared = compact(element.getAttribute("role"), 40);
      if (declared) return declared;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "dialog") return "dialog";
      if (element instanceof HTMLInputElement) {
        if (["button", "submit", "reset"].includes(element.type)) return "button";
        if (["checkbox", "radio"].includes(element.type)) return element.type;
        return "textbox";
      }
      if (element.getAttribute("contenteditable") === "true") return "textbox";
      return tag;
    };
    const selectorDescriptor = (element: Element, role: string, label: string): { strategy: "selector" | "role" | "text"; value: string; role?: string } => {
      const cssEscape = (value: string): string => window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      for (const key of ["data-testid", "data-test", "data-cy"] as const) {
        const value = compact(element.getAttribute(key), 120);
        if (value) return { strategy: "selector", value: `[${key}="${cssEscape(value)}"]` };
      }
      const elementId = compact(element.id, 120);
      if (elementId && !/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(elementId)) {
        return { strategy: "selector", value: `#${cssEscape(elementId)}` };
      }
      if (label && ["button", "link", "menuitem", "option", "tab", "checkbox", "radio", "combobox", "switch", "textbox", "dialog"].includes(role)) {
        return { strategy: "role", role, value: label };
      }
      return { strategy: "text", value: label };
    };

    document.querySelectorAll(`[${attribute}]`).forEach((element) => element.removeAttribute(attribute));
    const query = [
      "button", "a[href]", "input:not([type='hidden'])", "textarea", "select", "dialog", "[contenteditable='true']",
      "[role='button']", "[role='link']", "[role='menuitem']", "[role='option']", "[role='tab']", "[role='checkbox']",
      "[role='radio']", "[role='combobox']", "[role='switch']", "[role='dialog']",
    ].join(",");
    const candidates = Array.from(document.querySelectorAll(query))
      .filter(visible)
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const role = semanticRole(element);
        const label = labelFor(element);
        const placeholder = compact(element.getAttribute("placeholder") ?? element.getAttribute("data-placeholder"));
        const disabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || element.classList.contains("is-disabled");
        return { element, tag, role, label, placeholder, disabled };
      })
      .filter((candidate) => Boolean(candidate.label || candidate.placeholder))
      .slice(0, maximum)
      .map((candidate, index) => {
        const candidateId = `control_${index + 1}`;
        candidate.element.setAttribute(attribute, `${snapshotId}:${candidateId}`);
        return {
          id: candidateId,
          role: candidate.role,
          tag: candidate.tag,
          label: candidate.label,
          placeholder: candidate.placeholder,
          disabled: candidate.disabled,
          locator: selectorDescriptor(candidate.element, candidate.role, candidate.label || candidate.placeholder),
        };
      });
    return {
      route: `${location.origin}${location.pathname}`,
      title: document.title,
      candidates,
    };
  }, { snapshotId: id, attribute: RECOVERY_ATTRIBUTE, maximum: Math.max(1, Math.min(100, limit)) });
  return { id, ...snapshot };
}

export function locatorFromDescriptor(page: Page, descriptor: PageControlLocatorDescriptor): Locator {
  if (descriptor.strategy === "selector") return page.locator(descriptor.value).filter({ visible: true }).first();
  if (descriptor.strategy === "role" && descriptor.role) {
    return page.getByRole(descriptor.role as never, { name: descriptor.value, exact: true }).filter({ visible: true }).last();
  }
  return page.getByText(descriptor.value, { exact: true }).filter({ visible: true }).last();
}

export function locatorFromSnapshot(page: Page, snapshot: PageControlSnapshot, candidateId: string): Locator {
  return page.locator(`[${RECOVERY_ATTRIBUTE}="${snapshot.id}:${candidateId}"]`).filter({ visible: true }).first();
}

export async function validateRecoveredControl(locator: Locator, action: PageRecoveryAction): Promise<boolean> {
  if ((await locator.count()) === 0) return false;
  return locator.evaluate((element, expectedAction) => {
    if (!element.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) <= 0 || rect.width < 2 || rect.height < 2) return false;
    if (expectedAction === "click" && (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || element.classList.contains("is-disabled"))) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    return Boolean(top && (top === element || element.contains(top) || top.contains(element)));
  }, action).catch(() => false);
}
