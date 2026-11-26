import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, PencilLine, Play, X } from "lucide-react";
import type { ConversationHistoryEntry } from "../../shared/contracts";
import { historyResultMediaKind, historyResultPlaybackUrl } from "../../shared/conversation-history";
import { HistoryPreview } from "./HistoryPreview";

const statusLabels = { completed: "已完成", running: "生成中", failed: "生成失败", unknown: "状态未知" };

function HoverVideo({ src, onError }: { src: string; onError: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current!;
    video.src = src;
    video.muted = true;
    void video.play().catch(() => {}); // Autoplay policy can reject; click-to-view remains available.
    return () => { video.pause(); video.removeAttribute("src"); video.load(); };
  }, [src]);
  return <video ref={ref} className="history-hover-video" src={src} muted loop playsInline preload="none" onError={onError} aria-hidden="true" />;
}

export function HistoryResultCover({ entry, active, onView, onFocus, onBlur }: {
  entry: ConversationHistoryEntry; active: boolean; onView: () => void; onFocus: () => void; onBlur: () => void;
}) {
  const src = historyResultPlaybackUrl(entry), video = historyResultMediaKind(entry) === "video";
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <button type="button" className="conversation-history-cover" disabled={!src} onClick={onView} onFocus={onFocus} onBlur={onBlur}
    aria-label={`查看生成记录 ${entry.eventId}`} title={src ? (video ? "悬停静音播放，点击放大查看" : "点击放大查看") : "此记录尚无可查看的生成结果"}>
    <HistoryPreview key={entry.previewUrl} urls={entry.previewUrl ? [entry.previewUrl] : video ? [] : src ? [src] : []} alt="生成缩略图" />
    {active && video && src && failedUrl !== src && <HoverVideo key={src} src={src} onError={() => setFailedUrl(src)} />}
    {src && <span className="history-view-hint">{video ? <Play size={14} /> : <Maximize2 size={14} />}<span>{failedUrl === src ? "点击查看" : video ? "悬停播放 · 点击查看" : "点击查看"}</span></span>}
    <span className={`history-status ${entry.status}`}>{statusLabels[entry.status]}</span>
  </button>;
}

/** Native top-layer dialog: viewport-centered, keyboard-contained and portal-safe. */
export function HistoryResultViewer({ entry, disabled, onClose, onEdit }: {
  entry: ConversationHistoryEntry; disabled?: boolean; onClose: () => void; onEdit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const src = historyResultPlaybackUrl(entry), isVideo = historyResultMediaKind(entry) === "video";
  useEffect(() => {
    const node = dialog.current!, player = video.current, trigger = document.activeElement;
    node.showModal(); closeButton.current?.focus({ preventScroll: true });
    void player?.play().catch(() => {});
    return () => {
      player?.pause();
      node.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="history-result-viewer" aria-label="历史生成预览"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header><div><h2>生成预览</h2><span>记录 {entry.eventId} · {statusLabels[entry.status]}</span></div><div>
      <button type="button" className="button ghost" disabled={disabled || Boolean(entry.editUnavailableReason)} title={entry.editUnavailableReason || "回填草稿，不会生成"} onClick={onEdit}><PencilLine size={15} />重新编辑</button>
      <button ref={closeButton} type="button" className="icon-button" aria-label="关闭生成预览" onClick={onClose}><X size={20} /></button>
    </div></header>
    <div className="history-result-viewer-body"><div className="history-result-stage">
      {src && !failed ? isVideo ? <video ref={video} src={src} poster={entry.previewUrl ?? undefined} controls autoPlay playsInline preload="metadata" onError={() => setFailed(true)} />
        : <HistoryPreview key={src} urls={[src]} alt="生成图片" />
        : <p role="status">{failed ? "视频暂时无法播放，请刷新记录后重试。" : "此记录尚无可查看的生成结果。"}</p>}
    </div><aside><h3>生成提示词</h3><p>{entry.prompt || "无提示词"}</p><h3>生成参数</h3><div className="history-result-settings">
      {[entry.settings.modelName, entry.settings.aspectRatio, entry.settings.duration ? `${entry.settings.duration} 秒` : "", entry.settings.resolution?.toUpperCase()].filter(Boolean).map((value, index) => <span key={index}>{value}</span>)}
    </div><small>预览不会提交生成或修改草稿。{entry.editUnavailableReason}</small></aside></div>
  </dialog>, document.body);
}
