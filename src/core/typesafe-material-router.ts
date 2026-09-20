import path from "node:path";
import {
  choice,
  TypeSafeClient,
  type ChoiceQuestion,
  type ChoiceResponse,
} from "@typesafe-ai/sdk";
import type { XinyingService } from "./service";
import type {
  DirectorFileMaterialInput,
  DirectorManifest,
  ReferenceMediaKind,
} from "../shared/contracts";

export type MaterialRoutingChoice = "portrait_authorization" | "ordinary_upload" | "manual_review";

export interface MaterialRoutingInput {
  index: number;
  fileName: string;
  mediaKind: Exclude<ReferenceMediaKind, "audio">;
  role: DirectorFileMaterialInput["role"];
  verdict: NonNullable<DirectorFileMaterialInput["personCheck"]>["verdict"];
  localConfidence: number | null;
  summary: string;
  inspectedFrames: number | null;
  inspectionComplete: boolean;
}

export interface MaterialRoutingAssessment {
  index: number;
  choice: MaterialRoutingChoice;
  confidence: number;
  source: "typesafe" | "cache" | "unavailable";
}

export interface MaterialRoutingAdvisor {
  assess(inputs: readonly MaterialRoutingInput[]): Promise<MaterialRoutingAssessment[]>;
}

export interface DirectorMaterialRoutingSummary {
  nonAudio: number;
  explicit: number;
  cacheHits: number;
  deterministic: number;
  typesafe: number;
  unresolved: number;
}

export interface DirectorMaterialRoutingResult {
  manifest: DirectorManifest;
  summary: DirectorMaterialRoutingSummary;
}

const ROUTE_CRITERIA = {
  portrait_authorization: "The evidence indicates any visible real, virtual, illustrated, partial, distant, or background person; use the virtual-portrait authorization workflow.",
  ordinary_upload: "The complete visual inspection reliably indicates that the whole image or video contains no person or human-like character.",
  manual_review: "The evidence is incomplete, conflicting, or too uncertain to safely choose an upload route.",
} as const;

type RouteQuestion = ChoiceQuestion<typeof ROUTE_CRITERIA>;
type RouteAnswer = ChoiceResponse<typeof ROUTE_CRITERIA>;

const CACHE_TTL_MS = 10 * 60_000;
const CIRCUIT_BREAKER_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 200;
const DEFAULT_TIMEOUT_MS = 1_500;
const DIRECT_NO_PERSON_CONFIDENCE = 0.98;
const MIN_PORTRAIT_CONFIDENCE = 0.72;
const MIN_ORDINARY_LOCAL_CONFIDENCE = 0.85;
const MIN_ORDINARY_JEV_CONFIDENCE = 0.94;

interface CachedAssessment {
  value: MaterialRoutingAssessment;
  expiresAt: number;
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function assessmentCacheKey(input: MaterialRoutingInput): string {
  return JSON.stringify({
    mediaKind: input.mediaKind,
    role: input.role ?? null,
    verdict: input.verdict,
    localConfidence: input.localConfidence,
    summary: input.summary,
    inspectedFrames: input.inspectedFrames,
    inspectionComplete: input.inspectionComplete,
  });
}

function unavailableAssessment(index: number): MaterialRoutingAssessment {
  return { index, choice: "manual_review", confidence: 0, source: "unavailable" };
}

export class TypeSafeMaterialRoutingAdvisor implements MaterialRoutingAdvisor {
  private readonly client: TypeSafeClient;
  private readonly cache = new Map<string, CachedAssessment>();
  private disabledUntil = 0;

  constructor(apiKey: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.client = new TypeSafeClient({
      apiKey,
      timeout: timeoutMs,
      retry: { maxRetries: 0 },
      logLevel: "error",
    });
  }

  async assess(inputs: readonly MaterialRoutingInput[]): Promise<MaterialRoutingAssessment[]> {
    if (!inputs.length) return [];
    if (Date.now() < this.disabledUntil) return inputs.map((input) => unavailableAssessment(input.index));

    const output = new Map<number, MaterialRoutingAssessment>();
    const missing: MaterialRoutingInput[] = [];
    for (const input of inputs) {
      const key = assessmentCacheKey(input);
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        output.set(input.index, { ...cached.value, index: input.index, source: "cache" });
      } else {
        if (cached) this.cache.delete(key);
        missing.push(input);
      }
    }

    if (missing.length) {
      try {
        const questions: Record<string, RouteQuestion> = {};
        missing.forEach((input, position) => {
          questions[`material_${position}`] = choice({
            task: "Choose the safe upload route for this one media asset from the supplied inspection evidence.",
            materialIndex: input.index,
          }, ROUTE_CRITERIA);
        });
        const response = await this.client.systemOne({
          model: "jev-latest",
          state: {
            application: "Xinying Pro media upload router",
            safetyPolicy: [
              "Any visible real, virtual, illustrated, partial, distant, or background person requires portrait authorization.",
              "Ordinary upload is allowed only when a complete inspection reliably establishes that the entire asset contains no person.",
              "When evidence is incomplete or conflicting, choose manual_review.",
            ],
            materials: missing.map((input, position) => ({
              question: `material_${position}`,
              mediaKind: input.mediaKind,
              role: input.role ?? null,
              localVerdict: input.verdict,
              localConfidence: input.localConfidence,
              evidenceSummary: input.summary,
              inspectedFrames: input.inspectedFrames,
              inspectionComplete: input.inspectionComplete,
            })),
          },
          questions,
        }, {
          timeout: this.timeoutMs,
          retry: { maxRetries: 0 },
        });

        missing.forEach((input, position) => {
          const answer = response.answers[`material_${position}`] as RouteAnswer;
          const value: MaterialRoutingAssessment = {
            index: input.index,
            choice: answer.choice,
            confidence: clampProbability(answer.confidence),
            source: "typesafe",
          };
          this.remember(assessmentCacheKey(input), value);
          output.set(input.index, value);
        });
      } catch {
        this.disabledUntil = Date.now() + CIRCUIT_BREAKER_MS;
        missing.forEach((input) => output.set(input.index, unavailableAssessment(input.index)));
      }
    }

    return inputs.map((input) => output.get(input.index) ?? unavailableAssessment(input.index));
  }

  private remember(key: string, value: MaterialRoutingAssessment): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

let defaultAdvisor: MaterialRoutingAdvisor | null | undefined;

export function createTypeSafeMaterialRoutingAdvisor(
  apiKey = process.env.TYPESAFE_API_KEY,
): MaterialRoutingAdvisor | null {
  const normalized = apiKey?.trim();
  return normalized ? new TypeSafeMaterialRoutingAdvisor(normalized) : null;
}

export function defaultTypeSafeMaterialRoutingAdvisor(): MaterialRoutingAdvisor | null {
  if (defaultAdvisor === undefined) defaultAdvisor = createTypeSafeMaterialRoutingAdvisor();
  return defaultAdvisor;
}

export async function resolveDirectorMaterialRouting(
  service: XinyingService,
  manifest: DirectorManifest,
  advisor: MaterialRoutingAdvisor | null = defaultTypeSafeMaterialRoutingAdvisor(),
): Promise<DirectorMaterialRoutingResult> {
  const fileMaterials = manifest.materials
    .map((material, index) => ({ material, index }))
    .filter((entry): entry is { material: DirectorFileMaterialInput; index: number } => entry.material.kind === "file");
  const cacheEntries = service.mediaAnalysisCache(fileMaterials.map(({ material }) => material.path));
  const cacheByPath = new Map(cacheEntries.map((entry) => [path.resolve(entry.path).toLowerCase(), entry]));
  const materials = [...manifest.materials];
  const summary: DirectorMaterialRoutingSummary = {
    nonAudio: cacheEntries.filter((entry) => entry.mediaKind !== "audio").length,
    explicit: 0,
    cacheHits: 0,
    deterministic: 0,
    typesafe: 0,
    unresolved: 0,
  };
  const ambiguous: MaterialRoutingInput[] = [];

  for (const { material, index } of fileMaterials) {
    const cached = cacheByPath.get(path.resolve(material.path).toLowerCase());
    if (!cached || cached.mediaKind === "audio") continue;

    let containsPerson = material.containsPerson;
    if (containsPerson !== undefined) {
      if (
        !containsPerson
        && (material.role === "character" || material.authorizeAsPortrait || material.personCheck?.verdict === "person")
      ) containsPerson = true;
      summary.explicit += 1;
    } else if (material.role === "character" || material.personCheck?.verdict === "person") {
      containsPerson = true;
      summary.deterministic += 1;
    } else if (cached.hit && cached.containsPerson !== null) {
      containsPerson = cached.containsPerson;
      summary.cacheHits += 1;
    } else if (
      material.personCheck?.verdict === "no-person"
      && material.personCheck.inspectionComplete === true
      && (material.personCheck.confidence ?? 0) >= DIRECT_NO_PERSON_CONFIDENCE
    ) {
      containsPerson = false;
      summary.deterministic += 1;
    } else if (material.personCheck) {
      ambiguous.push({
        index,
        fileName: path.basename(material.path),
        mediaKind: cached.mediaKind,
        role: material.role,
        verdict: material.personCheck.verdict,
        localConfidence: material.personCheck.confidence ?? null,
        summary: material.personCheck.summary,
        inspectedFrames: material.personCheck.inspectedFrames ?? null,
        inspectionComplete: material.personCheck.inspectionComplete === true,
      });
    }

    if (containsPerson !== undefined) {
      materials[index] = {
        ...material,
        containsPerson,
        authorizeAsPortrait: containsPerson ? true : material.authorizeAsPortrait,
      };
    }
  }

  if (ambiguous.length && advisor) {
    const assessments = await advisor.assess(ambiguous);
    const inputsByIndex = new Map(ambiguous.map((input) => [input.index, input]));
    for (const assessment of assessments) {
      const input = inputsByIndex.get(assessment.index);
      const material = materials[assessment.index];
      if (!input || material.kind !== "file") continue;
      if (assessment.choice === "portrait_authorization" && assessment.confidence >= MIN_PORTRAIT_CONFIDENCE) {
        materials[assessment.index] = { ...material, containsPerson: true, authorizeAsPortrait: true };
        summary.typesafe += 1;
        continue;
      }
      const localConfidence = input.localConfidence ?? 0;
      if (
        assessment.choice === "ordinary_upload"
        && assessment.confidence >= MIN_ORDINARY_JEV_CONFIDENCE
        && input.verdict === "no-person"
        && input.inspectionComplete
        && localConfidence >= MIN_ORDINARY_LOCAL_CONFIDENCE
      ) {
        materials[assessment.index] = { ...material, containsPerson: false };
        summary.typesafe += 1;
      }
    }
  }

  summary.unresolved = materials.filter((material) => material.kind === "file"
    && cacheByPath.get(path.resolve(material.path).toLowerCase())?.mediaKind !== "audio"
    && material.containsPerson === undefined).length;

  return { manifest: { ...manifest, materials }, summary };
}
