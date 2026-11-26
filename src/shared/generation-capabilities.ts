import type { GenerationCapabilities } from "./contracts";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Only expose documented generation capabilities, never arbitrary response fields. */
export function parseGenerationCapabilities(value: unknown): GenerationCapabilities {
  const envelope = record(value);
  if (Number(envelope.code) !== 0) throw new Error(String(envelope.message || "无法读取官网生成选项，请检查登录"));
  const data = record(envelope.data);
  const config = record(data.model_config_list);
  const models: GenerationCapabilities["models"] = [];
  for (const row of Array.isArray(config.img2video_config_list) ? config.img2video_config_list : []) {
    const model = record(row);
    const output = record(record(Array.isArray(model.function_list) ? model.function_list[0] : {}).outputConfig);
    const supports = (key: string) => record(output[key]).supported === true;
    if (typeof model.model_name !== "string") continue;
    models.push({ name: model.model_name, autoPortraitAudit: supports("auto_portrait_audit"),
      promptOptimizer: supports("prompt_optimizer"), draftMode: supports("is_draft"),
      smartBalance: supports("enhance_video_hd"), inspiration: supports("promptInspiration_dict") });
  }
  const inspirations: Record<string, string[]> = {};
  for (const [category, values] of Object.entries(record(data.promptInspiration_dict))) {
    if (!Array.isArray(values)) continue;
    const names = values.map((item) => record(item).display_name).filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
    if (names.length) inspirations[category] = [...new Set(names)];
  }
  return { models, inspirations };
}
