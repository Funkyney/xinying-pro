import type { ProjectMode } from "./contracts";

export const DEFAULT_XINYING_MODEL = "Seedance 2.5 全能参考";

export interface XinyingModelProfile {
  name: string;
  shortName: string;
  description: string;
  modes: ProjectMode[];
  aspectRatios: string[];
  resolutions: string[];
  minDuration: number;
  maxDuration: number;
  audioSupported: boolean;
}

const COMMON_ASPECT_RATIOS = ["9:16", "16:9", "4:3", "1:1", "3:4", "21:9", "自适应"];

export const XINYING_MODEL_PROFILES: XinyingModelProfile[] = [
  {
    name: "Seedance 2.5 全能参考",
    shortName: "SEEDANCE 2.5",
    description: "文生视频 / 参考生视频 · 最长 30 秒 · 最高 1080p",
    modes: ["text-to-video", "reference-to-video"],
    aspectRatios: COMMON_ASPECT_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 4,
    maxDuration: 30,
    audioSupported: true,
  },
  {
    name: "Seedance 2.0 全能参考",
    shortName: "SEEDANCE 2.0",
    description: "参考生视频 / 视频处理 · 最长 15 秒 · 支持 4K",
    modes: ["reference-to-video"],
    aspectRatios: COMMON_ASPECT_RATIOS,
    resolutions: ["480p", "720p", "1080p", "4k"],
    minDuration: 4,
    maxDuration: 15,
    audioSupported: true,
  },
];

export function modelProfile(modelName: string | undefined): XinyingModelProfile | undefined {
  return XINYING_MODEL_PROFILES.find((profile) => profile.name === modelName);
}

export function resolutionLabel(value: string): string {
  return value.toLowerCase() === "4k" ? "4K" : value;
}

