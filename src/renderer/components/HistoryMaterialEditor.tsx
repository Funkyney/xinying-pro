import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, FileAudio2, GripVertical, ImagePlus, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import type { ConversationHistorySource, ReferenceAsset, ReferenceRole } from "../../shared/contracts";
import type { EditableHistoryMaterial } from "../../shared/history-material-order";
import { historyMaterialPreviewUrls } from "../../shared/conversation-history";
import { HistoryPreview } from "./ConversationHistory";
import type { ReferenceAuthorizationState } from "./ReferenceBoard";

interface EditorProps {
  source: ConversationHistorySource;
  materials: EditableHistoryMaterial[];
  busy: boolean;
  onOrder: (keys: string[]) => void;
  onAdd: () => void;
  onReplace: (key: string) => void;
  onReset: () => void;
  onExit: () => void;
  onRole: (id: string, role: ReferenceRole) => void;
  onAuthorize: (reference: ReferenceAsset) => void;
  authorizationStates: Record<string, ReferenceAuthorizationState>;
  nativeImageAudit: boolean;
}

function MaterialCard({ material, index, props }: { material: EditableHistoryMaterial; index: number; props: EditorProps }) {
  const sortable = useSortable({ id: material.key, disabled: props.busy });
  const reference = material.reference;
  const previewUrls = material.cloud ? historyMaterialPreviewUrls(material.cloud) : material.portrait ? [material.portrait.previewUrl]
    : reference ? [window.xinying.references.mediaUrl(reference.filePath)] : [];
  const authorization = reference ? props.authorizationStates[reference.id] : undefined;
  const move = (offset: number) => props.onOrder(arrayMove(props.materials.map((item) => item.key), index, index + offset));
  return <figure ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, opacity: sortable.isDragging ? .55 : 1 }} className="history-edit-material" data-material-key={material.key}>
    <div className="history-edit-preview">
      {reference && material.kind === "video" ? <video src={previewUrls[0]} muted preload="metadata" /> : material.kind === "audio" ? <FileAudio2 size={30} /> : <HistoryPreview key={JSON.stringify(previewUrls)} urls={previewUrls} alt={material.name} />}
      <button type="button" className="history-edit-grip" {...sortable.attributes} {...sortable.listeners} aria-label={`拖动 ${material.label}`} title="拖动调整参考素材顺序"><GripVertical size={16} /></button>
    </div>
    <figcaption><strong>{material.label}</strong><span title={material.name}>{material.name}</span><small>{material.cloud ? "官网原素材 · 无需重传" : material.portrait ? "已授权角色" : "本地新素材"}</small></figcaption>
    <div className="history-edit-actions">
      <button type="button" className="icon-button" disabled={props.busy || index === 0} aria-label={`前移 ${material.label}`} onClick={() => move(-1)}><ArrowLeft size={14} /></button>
      <button type="button" className="icon-button" disabled={props.busy || index === props.materials.length - 1} aria-label={`后移 ${material.label}`} onClick={() => move(1)}><ArrowRight size={14} /></button>
      <button type="button" className="icon-button" disabled={props.busy} aria-label={`替换 ${material.label}`} title="替换素材，保留当前位置" onClick={() => props.onReplace(material.key)}><RefreshCw size={14} /></button>
      <button type="button" className="icon-button danger" disabled={props.busy} aria-label={`移除 ${material.label}`} title="仅从本次草稿移除，不删除官网原素材" onClick={() => props.onOrder(props.materials.filter((item) => item.key !== material.key).map((item) => item.key))}><Trash2 size={14} /></button>
    </div>
    {reference && material.kind !== "audio" && <select aria-label={`${material.label} 素材用途`} value={reference.role} disabled={props.busy} onChange={(event) => props.onRole(reference.id, event.target.value as ReferenceRole)}><option value="other">其他参考</option><option value="character">人物</option><option value="scene">场景</option><option value="product">产品</option><option value="style">风格</option><option value="motion">动作</option><option value="first-frame">首帧</option><option value="last-frame">尾帧</option></select>}
    {reference && (material.kind === "video" || material.kind === "image" && !props.nativeImageAudit) && <button type="button" className="button ghost history-edit-authorize" disabled={props.busy || authorization?.status === "authorizing" || authorization?.status === "authorized"} onClick={() => props.onAuthorize(reference)}><ShieldCheck size={13} />{authorization?.status === "authorizing" ? "授权中" : authorization?.status === "authorized" ? "已授权" : "人物素材授权"}</button>}
    {reference && material.kind === "image" && props.nativeImageAudit && <small className="history-edit-audit">提交后官网自动审核</small>}
  </figure>;
}

export function HistoryMaterialEditor(props: EditorProps) {
  const editor = useRef<HTMLElement>(null);
  useEffect(() => {
    editor.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [props.source.eventId]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const keys = props.materials.map((item) => item.key);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (props.busy || !over || active.id === over.id) return;
    const from = keys.indexOf(String(active.id)), to = keys.indexOf(String(over.id));
    if (from >= 0 && to >= 0) props.onOrder(arrayMove(keys, from, to));
  };
  return <section ref={editor} className="history-material-tray history-material-editor" aria-label="历史记录参考素材" aria-busy={props.busy}>
    <div className="conversation-history-heading"><div><h2>已回填历史记录</h2><span>记录 {props.source.eventId}</span></div><div className="history-editor-tools"><button type="button" className="button ghost" disabled={props.busy || !props.source.materialOrder} onClick={props.onReset}><RotateCcw size={14} />恢复原素材</button><button type="button" className="button secondary" disabled={props.busy} onClick={props.onAdd}><ImagePlus size={14} />添加图片/视频/音频</button><button type="button" className="button ghost" disabled={props.busy} onClick={props.onExit}>退出历史编辑</button></div></div>
    <p className="conversation-history-hint">可替换、上传、移除和拖动排序。官网原素材直接复用，仅上传新文件；按当前编号生成，提交前核对官网素材。移除不会删除官网历史记录。</p>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={keys} strategy={horizontalListSortingStrategy}><div className="history-material-items">{props.materials.map((material, index) => <MaterialCard key={material.key} material={material} index={index} props={props} />)}{!keys.length && <p className="conversation-history-hint">本次草稿尚无参考素材，可添加上传或从下方素材库选择。</p>}</div></SortableContext></DndContext>
  </section>;
}
