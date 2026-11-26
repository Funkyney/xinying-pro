import { useId, useState, type KeyboardEvent } from "react";
import { Check, Settings2, SlidersHorizontal } from "lucide-react";
import type { Project, ProjectInput } from "../../shared/contracts";
import type { ProjectDraft } from "../../shared/project-draft";
import { modelProfile, resolutionLabel, XINYING_MODEL_PROFILES } from "../../shared/model-profiles";
import { AdvancedGenerationControls } from "./AdvancedGenerationControls";

const modes: Record<Project["mode"], string> = { "text-to-video": "文生视频", "image-to-video": "图生视频", "reference-to-video": "全能参考", "first-last-frame": "首尾帧" };
const tabs = [{ id: "model", label: "模型", icon: Settings2 }, { id: "advanced", label: "高级选项", icon: SlidersHorizontal }] as const;

export function StudioParameters({ value, project, onChange, onModelChange }: {
  value: ProjectDraft; project: Project; onChange: (patch: ProjectDraft) => void; onModelChange: (name: string) => void;
}) {
  const [active, setActive] = useState<"model" | "advanced">("model");
  const id = useId();
  const profile = modelProfile(value.modelName);
  const update = <K extends keyof ProjectInput>(key: K, next: ProjectInput[K]) => onChange({ [key]: next });
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;
    if (next < 0) return;
    event.preventDefault(); setActive(tabs[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const formats = profile?.videoFormats ?? [value.videoFormat ?? project.videoFormat];
  return <section className="studio-parameters" aria-label="生成参数">
    <div className="studio-parameters-heading"><h2>生成参数</h2><span>{profile?.shortName ?? value.modelName} · {value.aspectRatio ?? project.aspectRatio} · {value.duration ?? project.duration} 秒</span></div>
    <div className="studio-parameter-tabs" role="tablist" aria-label="生成参数分类">{tabs.map((tab, index) => <button type="button" role="tab" key={tab.id} id={`${id}-${tab.id}-tab`} aria-selected={active === tab.id} aria-controls={`${id}-${tab.id}-panel`} tabIndex={active === tab.id ? 0 : -1} onClick={() => setActive(tab.id)} onKeyDown={event => onTabKey(event, index)}><tab.icon size={15} aria-hidden="true" />{tab.label}</button>)}</div>
    <div className="studio-parameter-panel studio-model-panel" role="tabpanel" id={`${id}-model-panel`} aria-labelledby={`${id}-model-tab`} hidden={active !== "model"} tabIndex={0}>
      <div className="studio-model-picker"><span className="studio-field-label">模型选择</span><div className="model-choice-grid">{XINYING_MODEL_PROFILES.map(item => <button type="button" key={item.name} className={`model-choice ${value.modelName === item.name ? "active" : ""}`} aria-pressed={value.modelName === item.name} onClick={() => onModelChange(item.name)}><strong>{item.shortName}{value.modelName === item.name && <Check size={15} aria-hidden="true" />}</strong><span>{item.description}</span></button>)}</div></div>
      <div className="form-grid studio-model-options">
        <label>生成模式<select value={value.mode ?? project.mode} onChange={event => update("mode", event.target.value as ProjectInput["mode"])}>{(profile?.modes ?? [project.mode]).map(mode => <option value={mode} key={mode}>{modes[mode]}</option>)}</select></label>
        <label>画面比例<select value={value.aspectRatio ?? project.aspectRatio} onChange={event => update("aspectRatio", event.target.value)}>{(profile?.aspectRatios ?? [project.aspectRatio]).map(ratio => <option key={ratio}>{ratio}</option>)}</select></label>
        <label>时长<select value={value.duration ?? project.duration} onChange={event => update("duration", Number(event.target.value))}>{Array.from({ length: (profile?.maxDuration ?? 30) - (profile?.minDuration ?? 4) + 1 }, (_, i) => i + (profile?.minDuration ?? 4)).map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label>
        <label>分辨率<select disabled={Boolean(value.draftMode)} value={value.resolution ?? project.resolution} onChange={event => update("resolution", event.target.value)}><option value="auto">跟随心影当前值（推荐）</option>{(profile?.resolutions ?? []).map(resolution => <option key={resolution} value={resolution}>{resolutionLabel(resolution)}</option>)}</select></label>
        <label>视频格式<select disabled={Boolean(value.draftMode) || formats.length === 1} value={value.videoFormat ?? project.videoFormat} onChange={event => update("videoFormat", event.target.value as Project["videoFormat"])}>{formats.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label>
        {value.draftMode && <p className="studio-draft-note">样片模式使用 480P MP4；可在高级选项中关闭。</p>}
      </div>
    </div>
    <div className="studio-parameter-panel studio-advanced-panel" role="tabpanel" id={`${id}-advanced-panel`} aria-labelledby={`${id}-advanced-tab`} hidden={active !== "advanced"} tabIndex={0}>
      <div className="studio-media-switches">
        <label className="switch-row"><div><strong>生成声音</strong><span>{profile?.audioSupported ? "当前心影模型支持音画同出" : "具体能力以当前心影页面为准"}</span></div><input type="checkbox" checked={value.audioEnabled ?? project.audioEnabled} onChange={event => update("audioEnabled", event.target.checked)} /></label>
        <label className="switch-row"><div><strong>联网搜索</strong><span>{profile?.networkSearchSupported ? "生成时允许心影使用联网信息" : "当前模型不支持联网搜索"}</span></div><input type="checkbox" disabled={!profile?.networkSearchSupported && !value.networkEnabled} checked={value.networkEnabled ?? project.networkEnabled} onChange={event => update("networkEnabled", event.target.checked)} /></label>
      </div>
      <AdvancedGenerationControls value={value} showInspiration={false} onChange={onChange} />
    </div>
  </section>;
}
