import { choice, TypeSafeClient, type ChoiceCriteria } from "@typesafe-ai/sdk";

export type PageRecoveryAction = "click" | "observe";

export interface PageRecoveryCandidate {
  id: string;
  role: string;
  tag: string;
  label: string;
  placeholder: string;
  disabled: boolean;
}

export interface PageRecoveryRequest {
  route: string;
  title: string;
  intent: string;
  action: PageRecoveryAction;
  candidates: readonly PageRecoveryCandidate[];
}

export interface PageRecoveryDecision {
  candidateId: string | null;
  confidence: number;
  source: "typesafe" | "cache" | "unavailable";
}

export interface PageRecoveryAdvisor {
  choose(request: PageRecoveryRequest): Promise<PageRecoveryDecision>;
}

interface CachedDecision {
  value: PageRecoveryDecision;
  expiresAt: number;
}

const NO_MATCH = "none";
const DEFAULT_TIMEOUT_MS = 1_200;
const CACHE_TTL_MS = 2 * 60_000;
const CIRCUIT_BREAKER_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 100;

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function compact(value: string, maxLength = 180): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function decisionCacheKey(request: PageRecoveryRequest): string {
  return JSON.stringify({
    route: request.route,
    intent: request.intent,
    action: request.action,
    candidates: request.candidates.map((candidate) => [
      candidate.id,
      candidate.role,
      candidate.tag,
      candidate.label,
      candidate.placeholder,
      candidate.disabled,
    ]),
  });
}

export function pageRecoveryCriteria(candidates: readonly PageRecoveryCandidate[]): ChoiceCriteria {
  const criteria: ChoiceCriteria = {};
  for (const candidate of candidates) {
    criteria[candidate.id] = {
      kind: candidate.role || candidate.tag,
      label: compact(candidate.label),
      placeholder: compact(candidate.placeholder),
      disabled: candidate.disabled,
    };
  }
  criteria[NO_MATCH] = "None of the visible controls safely matches the requested intent.";
  return criteria;
}

export function acceptedPageRecoveryCandidate(
  request: PageRecoveryRequest,
  decision: PageRecoveryDecision,
  minimumConfidence = 0.84,
): PageRecoveryCandidate | null {
  if (!decision.candidateId || decision.confidence < minimumConfidence) return null;
  const candidate = request.candidates.find((item) => item.id === decision.candidateId) ?? null;
  if (!candidate || (request.action === "click" && candidate.disabled)) return null;
  return candidate;
}

function unavailableDecision(): PageRecoveryDecision {
  return { candidateId: null, confidence: 0, source: "unavailable" };
}

export class TypeSafePageRecoveryAdvisor implements PageRecoveryAdvisor {
  private readonly client: TypeSafeClient;
  private readonly cache = new Map<string, CachedDecision>();
  private disabledUntil = 0;

  constructor(apiKey: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.client = new TypeSafeClient({
      apiKey,
      timeout: timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "error",
    });
  }

  async choose(request: PageRecoveryRequest): Promise<PageRecoveryDecision> {
    if (!request.candidates.length || Date.now() < this.disabledUntil) return unavailableDecision();
    const key = decisionCacheKey(request);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.value, source: "cache" };
    if (cached) this.cache.delete(key);

    try {
      const response = await this.client.systemOne({
        model: "jev-latest",
        state: {
          application: "Xinying Pro desktop web automation recovery",
          page: { route: compact(request.route, 240), title: compact(request.title, 160) },
          safety: [
            "Select only a currently visible candidate from the supplied closed set.",
            "Choose none when the intent is ambiguous or no candidate is a close semantic match.",
            "This decision may locate a control; application code still validates freshness, visibility, disabled state, and click occlusion.",
          ],
        },
        questions: {
          target: choice({
            task: "Choose the single visible page control that most directly satisfies the requested intent.",
            intent: compact(request.intent, 300),
            expectedAction: request.action,
          }, pageRecoveryCriteria(request.candidates)),
        },
      }, {
        timeout: this.timeoutMs,
        retry: { maxRetries: 0 },
      });
      const selected = response.answers.target.choice;
      const value: PageRecoveryDecision = {
        candidateId: selected === NO_MATCH ? null : selected,
        confidence: clampProbability(response.answers.target.confidence),
        source: "typesafe",
      };
      this.remember(key, value);
      return value;
    } catch {
      this.disabledUntil = Date.now() + CIRCUIT_BREAKER_MS;
      return unavailableDecision();
    }
  }

  private remember(key: string, value: PageRecoveryDecision): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
