import { useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckCircle2, FileAudio2, GripVertical, ImagePlus, LoaderCircle, RefreshCw, ShieldAlert, Trash2, UserRoundCheck, Video } from "lucide-react";
import type { PlatformPortrait, ReferenceAsset, ReferenceRole } from "../../shared/contracts";
import { parseMaterialKey, portraitMaterialKey, referenceMaterialKey } from "../../shared/material-order";
import { assignMediaLabels, mediaKindFromMime } from "../../shared/media";

const roleLabels: Record<ReferenceRole, string> = {
  "first-frame": "首帧",
  "last-frame": "尾帧",
  character: "角色",
  scene: "场景",
  product: "产品",
  style: "风格",
  motion: "动作",
  other: "其他",
};

function sortableStyle(sortable: ReturnType<typeof useSortable>) {
  return {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.55 : 1,
    zIndex: sortable.isDragging ? 5 : undefined,
  };
}

interface ReferenceCardProps {
  asset: ReferenceAsset;
  label: string;
  onRole: (id: string, role: ReferenceRole) => void;
  onReplace: (id: string) => void;
  onAuthorize: (asset: ReferenceAsset) => void;
  onRemove: (id: string) => void;
  authorizationState: ReferenceAuthorizationState;
}

export interface ReferenceAuthorizationState {
  status: "idle" | "authorizing" | "authorized" | "needs-human" | "failed";
  message?: string;
}

function ReferenceCard({ asset, label, onRole, onReplace, onAuthorize, onRemove, authorizationState }: ReferenceCardProps) {
  const sortable = useSortable({ id: referenceMaterialKey(asset.id) });
  const stopPointerPropagation = (event: React.PointerEvent<HTMLButtonElement>) => event.stopPropagation();
  const kind = mediaKindFromMime(asset.mimeType);
  const canAuthorize = kind !== "audio" && (authorizationState.status === "idle" || authorizationState.status === "failed");
  const authorizationLabel = authorizationState.status === "authorizing" ? "授权中"
    : authorizationState.status === "authorized" ? "已授权"
      : authorizationState.status === "needs-human" ? "需要处理"
        : authorizationState.status === "failed" ? "重新授权"
          : "授权为虚拟人像";
  const AuthorizationIcon = authorizationState.status === "authorizing" ? LoaderCircle
    : authorizationState.status === "authorized" ? CheckCircle2
      : authorizationState.status === "needs-human" ? ShieldAlert
        : UserRoundCheck;
  return (
    <article ref={sortable.setNodeRef} style={sortableStyle(sortable)} className="reference-card">
      <div className="reference-preview">
        {kind === "video" ? <video src={window.xinying.references.mediaUrl(asset.filePath)} muted preload="metadata" />
          : kind === "audio" ? <div className="audio-reference-preview"><FileAudio2 size={34} /><audio src={window.xinying.references.mediaUrl(asset.filePath)} controls preload="metadata" /></div>
            : <img src={window.xinying.references.mediaUrl(asset.filePath)} alt={asset.name} />}
        <span className="reference-index">{label}</span>
        <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} title="拖动调整最终参考素材顺序">
          <GripVertical size={17} />
        </button>
      </div>
      <div className="reference-meta">
        <strong title={asset.name}>{asset.name}</strong>
        {kind === "audio" ? <span className="media-role-chip">音频参考</span>
          : <select value={asset.role} onChange={(event) => onRole(asset.id, event.target.value as ReferenceRole)}>
              {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>}
      </div>
      <div className="reference-actions">
        <button type="button" className={`authorize-reference-button authorization-${authorizationState.status}`} disabled={!canAuthorize} onPointerDown={stopPointerPropagation} onClick={() => onAuthorize(asset)} title={kind === "audio" ? "音频不能授权为虚拟人像" : authorizationState.message || (canAuthorize ? "将这项图片或视频素材加入虚拟人像库并完成授权" : authorizationLabel)}><AuthorizationIcon size={14} className={authorizationState.status === "authorizing" ? "spinning" : undefined} />{kind === "audio" ? "不可授权" : authorizationLabel}</button>
        <button type="button" className="icon-button" onPointerDown={stopPointerPropagation} onClick={() => onReplace(asset.id)} title="替换但保留编号"><RefreshCw size={15} /></button>
        <button type="button" className="icon-button danger" onPointerDown={stopPointerPropagation} onClick={() => onRemove(asset.id)} title="从当前项目删除这项参考素材"><Trash2 size={15} /></button>
      </div>
    </article>
  );
}

function PortraitReferenceCard({ portrait, label, onRemove }: { portrait: PlatformPortrait; label: string; onRemove: (id: string) => void }) {
  const sortable = useSortable({ id: portraitMaterialKey(portrait.id) });
  return (
    <article ref={sortable.setNodeRef} style={sortableStyle(sortable)} className="reference-card portrait-reference-card">
      <div className="reference-preview">
        <img src={portrait.previewUrl} alt={portrait.displayName} />
        <span className="reference-index">{label}</span>
        {portrait.mediaKind === "video" && <span className="portrait-video-badge"><Video size={12} />视频角色</span>}
        <span className="authorized-material-badge"><UserRoundCheck size={12} />已授权</span>
        <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} title="拖动调整最终 @图顺序">
          <GripVertical size={17} />
        </button>
      </div>
      <div className="reference-meta portrait-reference-meta">
        <strong title={portrait.displayName}>{portrait.displayName}</strong>
        <span>心影虚拟人像</span>
      </div>
      <div className="reference-actions portrait-reference-actions">
        <span>无需重复上传</span>
        <button type="button" className="icon-button danger" onPointerDown={(event) => event.stopPropagation()} onClick={() => onRemove(portrait.id)} title="从上方参考素材中移除（不会删除心影角色）"><Trash2 size={15} /></button>
      </div>
    </article>
  );
}

interface ReferenceBoardProps {
  assets: ReferenceAsset[];
  portraits: PlatformPortrait[];
  materialOrder: string[];
  onAdd: () => void;
  onBatchReplace: () => void;
  onReorder: (ids: string[]) => void;
  onRole: (id: string, role: ReferenceRole) => void;
  onReplace: (id: string) => void;
  onAuthorize: (asset: ReferenceAsset) => void;
  onRemove: (id: string) => void;
  onRemovePortrait: (id: string) => void;
  authorizationStates: Record<string, ReferenceAuthorizationState>;
}

export function ReferenceBoard(props: ReferenceBoardProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const referencesById = useMemo(() => new Map(props.assets.map((asset) => [asset.id, asset])), [props.assets]);
  const portraitsById = useMemo(() => new Map(props.portraits.map((portrait) => [portrait.id, portrait])), [props.portraits]);
  const ids = useMemo(() => props.materialOrder.filter((key) => {
    const item = parseMaterialKey(key);
    return item?.kind === "reference" ? referencesById.has(item.id) : item?.kind === "portrait" ? portraitsById.has(item.id) : false;
  }), [props.materialOrder, referencesById, portraitsById]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    props.onReorder(arrayMove(ids, from, to));
  };

  return (
    <section className="panel reference-board">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">FINAL REFERENCE ORDER</span>
          <h2>参考素材 · 最终编号顺序</h2>
          <p>APP 保留任意混排；心影重排虚拟人像时，会按角色逐项回读并自动映射实际编号。</p>
        </div>
        <div className="heading-actions">
          <button className="button ghost" disabled={!props.assets.length} onClick={props.onBatchReplace}><RefreshCw size={16} />批量替换本地素材</button>
          <button className="button secondary" onClick={props.onAdd}><ImagePlus size={16} />添加图片/视频/音频</button>
        </div>
      </div>
      {ids.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <div className="reference-grid">
              {(() => {
                const labels = assignMediaLabels(ids.map((key) => {
                  const item = parseMaterialKey(key);
                  if (item?.kind === "portrait") return portraitsById.get(item.id)?.mediaKind ?? "unknown";
                  const asset = item?.kind === "reference" ? referencesById.get(item.id) : undefined;
                  return asset ? mediaKindFromMime(asset.mimeType) : "unknown";
                }));
                return ids.map((key, index) => {
                const item = parseMaterialKey(key);
                if (item?.kind === "portrait") {
                  const portrait = portraitsById.get(item.id);
                  return portrait ? <PortraitReferenceCard key={key} portrait={portrait} label={labels[index]} onRemove={props.onRemovePortrait} /> : null;
                }
                const asset = item?.kind === "reference" ? referencesById.get(item.id) : undefined;
                return asset ? <ReferenceCard key={key} asset={asset} label={labels[index]} onRole={props.onRole} onReplace={props.onReplace} onAuthorize={props.onAuthorize} onRemove={props.onRemove} authorizationState={props.authorizationStates[asset.id] ?? { status: "idle" }} /> : null;
              });
              })()}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <button className="empty-drop" onClick={props.onAdd}>
          <ImagePlus size={28} />
          <strong>添加图片、视频、音频，或点击下方已授权虚拟人像</strong>
          <span>加入后会按媒体类型分别编号，并支持任意混排</span>
        </button>
      )}
    </section>
  );
}
