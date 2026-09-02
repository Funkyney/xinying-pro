import type { ProjectMode, VideoFormat } from "./contracts";

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
  networkSearchSupported: boolean;
  videoFormats: VideoFormat[];
  materialLimits: {
    maxTotal: number;
    image: number;
    video: number;
    audio: number;
    maxVideoDurationSeconds: number;
    maxAudioDurationSeconds: number;
  };
}

const COMMON_ASPECT_RATIOS = ["9:16", "16:9", "4:3", "1:1", "3:4", "21:9", "自适应"];

export const XINYING_MODEL_PROFILES: XinyingModelProfile[] = [
  {
    name: "Seedance 2.5 全能参考",
    shortName: "SEEDANCE 2.5",
    description: "最多 50 项 · 30 图 / 10 视频 / 10 音频 · 音频/视频各≤30秒",
    modes: ["text-to-video", "reference-to-video"],
    aspectRatios: COMMON_ASPECT_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 4,
    maxDuration: 30,
    audioSupported: true,
    networkSearchSupported: true,
    videoFormats: ["mp4", "mov"],
    materialLimits: {
      maxTotal: 50,
      image: 30,
      video: 10,
      audio: 10,
      maxVideoDurationSeconds: 30,
      maxAudioDurationSeconds: 30,
    },
  },
  {
    name: "Seedance 2.0 全能参考",
    shortName: "SEEDANCE 2.0",
    description: "最多 15 项 · 9 图 / 3 视频 / 3 音频 · 最长 15 秒 · 支持 4K",
    modes: ["reference-to-video"],
    aspectRatios: COMMON_ASPECT_RATIOS,
    resolutions: ["480p", "720p", "1080p", "4k"],
    minDuration: 4,
    maxDuration: 15,
    audioSupported: true,
    networkSearchSupported: false,
    videoFormats: ["mp4"],
    materialLimits: {
      maxTotal: 15,
      image: 9,
      video: 3,
      audio: 3,
      maxVideoDurationSeconds: 15,
      maxAudioDurationSeconds: 15,
    },
  },
];

export function modelProfile(modelName: string | undefined): XinyingModelProfile | undefined {
  return XINYING_MODEL_PROFILES.find((profile) => profile.name === modelName);
}

export function resolutionLabel(value: string): string {
  return value.toLowerCase() === "4k" ? "4K" : value;
}
