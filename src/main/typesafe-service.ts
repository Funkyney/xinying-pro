import { safeStorage } from "electron";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { XinyingDatabase } from "../core/database";
import {
  TypeSafeMaterialRoutingAdvisor,
  type MaterialRoutingAdvisor,
} from "../core/typesafe-material-router";
import type { TypeSafeConnectionResult, TypeSafeSettingsStatus } from "../shared/contracts";
import type { RecoveryAdvisor, RecoveryDecision, RecoveryFailure } from "./recovery-engine";
import { TypeSafeRecoveryAdvisor } from "./typesafe-recovery-advisor";
import type { Job } from "../shared/contracts";

const SETTING_KEY = "typesafe_api_key_v1";
const TEST_TIMEOUT_MS = 5_000;

interface StoredCredential {
  version: 1;
  encrypted: string;
}

interface CachedAdvisor<T> {
  apiKey: string;
  advisor: T;
}

function maskKey(apiKey: string): string {
  return `••••••••${apiKey.slice(-4)}`;
}

export class TypeSafeService {
  private materialCache: CachedAdvisor<MaterialRoutingAdvisor> | null = null;
  private recoveryCache: CachedAdvisor<RecoveryAdvisor> | null = null;

  constructor(private readonly database: XinyingDatabase) {}

  status(): TypeSafeSettingsStatus {
    const stored = this.readStoredKey();
    const environment = process.env.TYPESAFE_API_KEY?.trim() ?? "";
    const apiKey = stored || environment;
    return {
      configured: Boolean(apiKey),
      source: stored ? "app" : environment ? "environment" : "none",
      maskedKey: apiKey ? maskKey(apiKey) : null,
      secureStorageAvailable: safeStorage.isEncryptionAvailable(),
      model: "jev-latest",
    };
  }

  async save(apiKey: string): Promise<TypeSafeConnectionResult> {
    const normalized = apiKey.trim();
    if (normalized.length < 16 || /\s/.test(normalized)) {
      throw new Error("TypeSafe API Key 格式无效，请粘贴完整 Key");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统安全存储不可用，未保存 TypeSafe API Key");
    }
    const connection = await this.testKey(normalized);
    const payload: StoredCredential = {
      version: 1,
      encrypted: safeStorage.encryptString(normalized).toString("base64"),
    };
    this.database.db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(SETTING_KEY, JSON.stringify(payload), new Date().toISOString());
    this.materialCache = null;
    this.recoveryCache = null;
    return { ...this.status(), ...connection };
  }

  clear(): TypeSafeSettingsStatus {
    this.database.db.prepare("DELETE FROM settings WHERE key = ?").run(SETTING_KEY);
    this.materialCache = null;
    this.recoveryCache = null;
    return this.status();
  }

  async test(): Promise<TypeSafeConnectionResult> {
    const apiKey = this.effectiveKey();
    if (!apiKey) throw new Error("请先在设置中填写 TypeSafe API Key");
    return { ...this.status(), ...await this.testKey(apiKey) };
  }

  private async testKey(apiKey: string): Promise<Pick<TypeSafeConnectionResult, "connected" | "latencyMs" | "jevAvailable" | "availableModelCount">> {
    const startedAt = Date.now();
    const models = await new TypeSafeClient({
      apiKey,
      timeout: TEST_TIMEOUT_MS,
      retry: { maxRetries: 0 },
      logLevel: "error",
    }).models.list({ timeout: TEST_TIMEOUT_MS, retry: { maxRetries: 0 } });
    return {
      connected: true,
      latencyMs: Date.now() - startedAt,
      jevAvailable: models.some((model) => model.name === "jev-latest" || model.name.startsWith("jev-")),
      availableModelCount: models.length,
    };
  }

  materialRoutingAdvisor(): MaterialRoutingAdvisor | null {
    const apiKey = this.effectiveKey();
    if (!apiKey) return null;
    if (this.materialCache?.apiKey !== apiKey) {
      this.materialCache = { apiKey, advisor: new TypeSafeMaterialRoutingAdvisor(apiKey) };
    }
    return this.materialCache.advisor;
  }

  recoveryAdvisor(): RecoveryAdvisor {
    return {
      advise: async (job: Job, failure: RecoveryFailure, fallback: RecoveryDecision) => {
        const apiKey = this.effectiveKey();
        if (!apiKey) return fallback;
        if (this.recoveryCache?.apiKey !== apiKey) {
          this.recoveryCache = { apiKey, advisor: new TypeSafeRecoveryAdvisor(apiKey) };
        }
        return this.recoveryCache.advisor.advise(job, failure, fallback);
      },
    };
  }

  private effectiveKey(): string {
    return this.readStoredKey() || process.env.TYPESAFE_API_KEY?.trim() || "";
  }

  private readStoredKey(): string {
    const row = this.database.db.prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(SETTING_KEY) as { value_json: string } | undefined;
    if (!row || !safeStorage.isEncryptionAvailable()) return "";
    try {
      const payload = JSON.parse(row.value_json) as StoredCredential;
      if (payload.version !== 1 || typeof payload.encrypted !== "string") return "";
      return safeStorage.decryptString(Buffer.from(payload.encrypted, "base64")).trim();
    } catch {
      return "";
    }
  }
}
