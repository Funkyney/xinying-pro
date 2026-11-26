import { useState } from "react";
import type { GenerationCapabilities, GenerationOptions } from "../../shared/contracts";
import { generationOptions } from "../../shared/generation-options";

export function AdvancedGenerationControls({ value, onChange }: {
  value: GenerationOptions & { modelName?: string };
  onChange: (next: GenerationOptions & { resolution?: string; videoFormat?: "mp4" | "mov" }) => void;
}) {
  const [capabilities, setCapabilities] = useState<GenerationCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const options = generationOptions(value);
  // Verified baseline prevents unsupported Seedance options before a manual
  // sync. Live account-specific capability flags always take precedence.
  const model = capabilities?.models.find((item) => item.name === value.modelName)
    ?? (/^Seedance 2\.(?:0|5)\s/.test(value.modelName ?? "") ? {
      autoPortraitAudit: true, promptOptimizer: false, draftMode: value.modelName?.includes("Seedance 2.5") === true,
      smartBalance: true, inspiration: true,
    } : undefined);
  const switches = [
    { key: "autoPortraitAudit", label: "自动图片人像审核", note: "图片直接交由心影自动分析、审核并录入角色库，不再单独上传授权。含人物视频仍须角色库授权。" },
    { key: "promptOptimizer", label: "提示词优化", note: "由心影自动润色提示词；需要严格执行定稿提示词时请关闭。" },
    { key: "draftMode", label: "样片模式", note: "先生成 480P MP4 样片，官网支持在 7 天内二次渲染高清版本；后续渲染在原网页操作。" },
    { key: "smartBalance", label: "智能均衡模式", note: "官网智能调配生成资源以降低积分消耗，生成时间可能略有延长。" },
  ] as const;
  return <div className="advanced-generation-controls">
    <div className="panel-heading compact"><h3>官网高级配置</h3><button type="button" className="button ghost" disabled={loading} onClick={async () => {
      setLoading(true); setError("");
      try { setCapabilities(await window.xinying.generationCapabilities()); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "读取官网选项失败，请检查登录"); }
      finally { setLoading(false); }
    }}>{loading ? "读取中…" : "同步官网选项"}</button></div>
    {switches.map(({ key, label, note }) => <label className="switch-row" key={key}>
      <div><strong>{label}</strong><span>{note}{model?.[key] === false ? " 当前账号/模型暂不支持。" : ""}</span></div>
      <input type="checkbox" checked={options[key]} disabled={(model?.[key] === false && !options[key]) || key === "smartBalance" && options.draftMode} onChange={(event) => onChange({ [key]: event.target.checked, ...(key === "draftMode" && event.target.checked ? { resolution: "480p", videoFormat: "mp4" as const, smartBalance: false } : {}) })} />
    </label>)}
    {options.autoPortraitAudit && <p className="muted-text">官方实验功能，审核可能失败且增加处理时间；请勿传入真人形象 IP。角色库满 300 项时，心影会自动删除最旧素材。开启视为同意<a href="https://bluefocus.feishu.cn/docx/FB2JdsKJbo1XzoxKzI6cTetGn8e" target="_blank" rel="noreferrer">《虚拟人像素材合规承诺与授权确认书》</a>。</p>}
    <div className="form-stack"><strong>灵感镜头</strong>
      {!capabilities && <small>点击“同步官网选项”，读取当前账号支持的镜头与风格预设。</small>}
      {model?.inspiration !== false && Object.entries(capabilities?.inspirations ?? {}).map(([category, names]) => <label key={category}>{category}<select value={options.inspiration[category] ?? ""} onChange={(event) => {
        const next = { ...options.inspiration }; if (event.target.value) next[category] = event.target.value; else delete next[category]; onChange({ inspiration: next });
      }}><option value="">不使用</option>{names.map((name) => <option key={name}>{name}</option>)}</select></label>)}
      {Object.keys(options.inspiration).length > 0 && <><small>{Object.entries(options.inspiration).map(([category, name]) => `${category}：${name}`).join(" · ")}</small><button type="button" className="button ghost" onClick={() => onChange({ inspiration: {} })}>清空灵感镜头</button></>}
    </div>
    {error && <p role="alert" className="danger-text">{error}</p>}
    <small className="muted-text">选项以账号和模型能力为准；提交前逐项确认，未支持或未生效时停止，不静默忽略。</small>
  </div>;
}
