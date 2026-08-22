import { useMemo, useState } from "react";
import { Image as ImageIcon, Music2, Plus, RefreshCw, Trash2, Upload, UserRoundCheck, Video } from "lucide-react";
import type { PlatformPortrait, ReferenceAsset, ReferenceMediaKind, SharedMediaAsset } from "../../shared/contracts";
import { portraitMaterialKey, referenceMaterialKey } from "../../shared/material-order";

type LibraryCategory = "all" | "portrait" | ReferenceMediaKind;

interface SharedMaterialLibraryProps {
  assets: SharedMediaAsset[];
  portraits: PlatformPortrait[];
  references: ReferenceAsset[];
  materialOrder: string[];
  materialLabels: string[];
  onUpload: () => void;
  onSyncPortraits: () => void;
  onToggleAsset: (asset: SharedMediaAsset) => void;
  onDeleteAsset: (asset: SharedMediaAsset) => void;
  onTogglePortrait: (portrait: PlatformPortrait) => void;
}

type LibraryEntry =
  | { type: "media"; asset: SharedMediaAsset; selectedOrder: number; selectedLabel: string }
  | { type: "portrait"; portrait: PlatformPortrait; selectedOrder: number; selectedLabel: string };

const categoryLabels: Array<{ key: LibraryCategory; label: string }> = [
  { key: "all", label: "全部" },
  { key: "portrait", label: "虚拟人像" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
  { key: "audio", label: "音频" },
];

function MediaPreview({ asset }: { asset: SharedMediaAsset }) {
  const src = window.xinying.references.mediaUrl(asset.filePath);
  if (asset.mediaKind === "video") return <video src={src} muted preload="metadata" />;
  if (asset.mediaKind === "audio") {
    return <div className="shared-audio-preview"><Music2 size={30} /><audio src={src} controls preload="metadata" onClick={(event) => event.stopPropagation()} /></div>;
  }
  return <img src={src} alt={asset.name} loading="lazy" />;
}

export function SharedMaterialLibrary(props: SharedMaterialLibraryProps) {
  const [category, setCategory] = useState<LibraryCategory>("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const referenceBySharedId = useMemo(() => new Map(
    props.references.filter((reference) => reference.sourceSharedMediaId).map((reference) => [reference.sourceSharedMediaId!, reference]),
  ), [props.references]);

  const counts: Record<LibraryCategory, number> = {
    all: props.assets.length + props.portraits.length,
    portrait: props.portraits.length,
    image: props.assets.filter((asset) => asset.mediaKind === "image").length,
    video: props.assets.filter((asset) => asset.mediaKind === "video").length,
    audio: props.assets.filter((asset) => asset.mediaKind === "audio").length,
  };

  const entries = useMemo(() => {
    const mediaEntries: LibraryEntry[] = props.assets
      .filter((asset) => (category === "all" || category === asset.mediaKind)
        && (!normalizedQuery || asset.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery)))
      .map((asset) => {
        const reference = referenceBySharedId.get(asset.id);
        const selectedOrder = reference ? props.materialOrder.indexOf(referenceMaterialKey(reference.id)) : -1;
        return { type: "media", asset, selectedOrder, selectedLabel: selectedOrder >= 0 ? props.materialLabels[selectedOrder] ?? "已加入" : "" };
      });
    const portraitEntries: LibraryEntry[] = category !== "all" && category !== "portrait" ? [] : props.portraits
      .filter((portrait) => !normalizedQuery || portrait.displayName.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
      .map((portrait) => {
        const selectedOrder = props.materialOrder.indexOf(portraitMaterialKey(portrait.id));
        return { type: "portrait", portrait, selectedOrder, selectedLabel: selectedOrder >= 0 ? props.materialLabels[selectedOrder] ?? "已加入" : "" };
      });
    return [...mediaEntries, ...portraitEntries].sort((left, right) => {
      const leftSelected = left.selectedOrder >= 0;
      const rightSelected = right.selectedOrder >= 0;
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      if (leftSelected && rightSelected) return left.selectedOrder - right.selectedOrder;
      if (left.type !== right.type) return left.type === "media" ? -1 : 1;
      return 0;
    });
  }, [category, normalizedQuery, props.assets, props.materialLabels, props.materialOrder, props.portraits, referenceBySharedId]);
  const visibleEntries = entries.slice(0, 120);

  return (
    <section className="panel shared-material-library">
      <div className="panel-heading compact">
        <div><span className="eyebrow">SHARED MATERIAL LIBRARY</span><h2>共享素材库</h2><p>图片、视频、音频跨项目复用；虚拟人像按当前心影空间同步。点击卡片即可加入或移出上方创作顺序。</p></div>
        <div className="portrait-toolbar">
          <input className="portrait-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索素材或角色名称…" />
          <button className="button ghost" onClick={props.onSyncPortraits}><RefreshCw size={15} />同步人像</button>
          <button className="button secondary" onClick={props.onUpload}><Upload size={15} />上传共享素材</button>
        </div>
      </div>
      <div className="shared-library-tabs">
        {categoryLabels.map((item) => <button type="button" key={item.key} className={category === item.key ? "active" : ""} onClick={() => setCategory(item.key)}>{item.key === "portrait" ? <UserRoundCheck size={14} /> : item.key === "image" ? <ImageIcon size={14} /> : item.key === "video" ? <Video size={14} /> : item.key === "audio" ? <Music2 size={14} /> : <Plus size={14} />}<span>{item.label}</span><b>{counts[item.key]}</b></button>)}
        <span className="library-count">显示 {visibleEntries.length} / {entries.length}</span>
      </div>
      <div className="shared-library-grid">
        {visibleEntries.map((entry) => entry.type === "media" ? (
          <article role="button" tabIndex={0} key={`media:${entry.asset.id}`} className={`shared-library-card ${entry.selectedOrder >= 0 ? "selected" : ""}`} onClick={() => props.onToggleAsset(entry.asset)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") props.onToggleAsset(entry.asset); }}>
            <div className="shared-library-preview"><MediaPreview asset={entry.asset} /><span className={`shared-kind-badge kind-${entry.asset.mediaKind}`}>{entry.asset.mediaKind === "image" ? "图片" : entry.asset.mediaKind === "video" ? "视频" : "音频"}</span>{entry.selectedLabel && <b>{entry.selectedLabel}</b>}<button type="button" className="shared-library-delete" title="从共享素材库删除" onClick={(event) => { event.stopPropagation(); props.onDeleteAsset(entry.asset); }}><Trash2 size={13} /></button></div>
            <div className="shared-library-meta"><strong>{entry.asset.name}</strong><span>{entry.selectedOrder >= 0 ? "已加入当前项目，点击移出" : "点击加入当前项目"}</span></div>
          </article>
        ) : (
          <article role="button" tabIndex={0} key={`portrait:${entry.portrait.id}`} className={`shared-library-card portrait ${entry.selectedOrder >= 0 ? "selected" : ""}`} onClick={() => props.onTogglePortrait(entry.portrait)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") props.onTogglePortrait(entry.portrait); }}>
            <div className="shared-library-preview"><img src={entry.portrait.previewUrl} alt={entry.portrait.displayName} loading="lazy" /><span className="shared-kind-badge kind-portrait"><UserRoundCheck size={11} />虚拟人像</span>{entry.selectedLabel && <b>{entry.selectedLabel}</b>}</div>
            <div className="shared-library-meta"><strong>{entry.portrait.displayName}</strong><span>{entry.selectedOrder >= 0 ? "已加入当前项目，点击移出" : entry.portrait.mediaKind === "video" ? "视频角色 · 点击加入" : "图片角色 · 点击加入"}</span></div>
          </article>
        ))}
        {!visibleEntries.length && <div className="shared-library-empty"><Plus size={24} /><strong>当前分类还没有素材</strong><span>{category === "portrait" ? "点击“同步人像”读取当前心影空间的授权角色。" : "点击“上传共享素材”导入图片、视频或音频。"}</span></div>}
      </div>
      {entries.length > visibleEntries.length && <p className="shared-library-limit">当前显示前 120 项；可通过分类或搜索快速定位其余素材。</p>}
    </section>
  );
}
