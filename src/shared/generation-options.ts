import type { GenerationOptions } from "./contracts";

/** 已核验 Seedance 2.0/2.5 的官方图片审核；视频和其他模型保留独立授权。 */
export function nativeImageAuditEnabled(options: GenerationOptions & { modelName?: string }): boolean {
  return options.autoPortraitAudit ?? /^Seedance 2\.(?:0|5)\s/.test(options.modelName ?? "");
}

export function generationOptions(options: GenerationOptions & { modelName?: string }): Required<GenerationOptions> {
  return {
    autoPortraitAudit: nativeImageAuditEnabled(options),
    promptOptimizer: options.promptOptimizer ?? false,
    draftMode: options.draftMode ?? false,
    smartBalance: options.draftMode ? false : options.smartBalance ?? false,
    inspiration: options.inspiration ?? {},
  };
}
