import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DirectorManifest } from "../shared/contracts";
import { AppError } from "./errors";

const referenceRoleSchema = z.enum([
  "first-frame",
  "last-frame",
  "character",
  "scene",
  "product",
  "style",
  "motion",
  "other",
]);

const projectModeSchema = z.enum([
  "text-to-video",
  "image-to-video",
  "reference-to-video",
  "first-last-frame",
]);

const fileMaterialSchema = z.object({
  kind: z.literal("file"),
  path: z.string().trim().min(1),
  role: referenceRoleSchema.optional(),
  containsPerson: z.boolean().optional(),
  authorizeAsPortrait: z.boolean().optional().default(false),
}).strict();

const platformPortraitMaterialSchema = z.object({
  kind: z.literal("platform-portrait"),
  portraitId: z.string().trim().min(1),
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  projectId: z.string().trim().min(1),
  prompt: z.string().min(1),
  count: z.number().int().min(1).max(20).optional().default(1),
  replaceMaterials: z.boolean().optional().default(true),
  settings: z.object({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    modelName: z.string().trim().min(1).optional(),
    mode: projectModeSchema.optional(),
    aspectRatio: z.string().trim().min(1).optional(),
    duration: z.number().int().optional(),
    resolution: z.string().trim().min(1).optional(),
    audioEnabled: z.boolean().optional(),
  }).strict().optional(),
  materials: z.array(z.discriminatedUnion("kind", [fileMaterialSchema, platformPortraitMaterialSchema])).max(50),
}).strict();

export function parseDirectorManifest(value: unknown, baseDir = process.cwd()): DirectorManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("INVALID_DIRECTOR_MANIFEST", "导演任务清单格式无效", parsed.error.issues);
  }
  return {
    ...parsed.data,
    materials: parsed.data.materials.map((material) => material.kind === "file"
      ? { ...material, path: path.resolve(baseDir, material.path) }
      : material),
  };
}

export function loadDirectorManifest(filePath: string): DirectorManifest {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new AppError("DIRECTOR_MANIFEST_NOT_FOUND", `找不到导演任务清单：${resolved}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new AppError("INVALID_DIRECTOR_MANIFEST_JSON", "导演任务清单不是有效 JSON", error);
  }
  return parseDirectorManifest(raw, path.dirname(resolved));
}
