import { useEffect, useRef, useState } from "react";
import { PencilLine, RefreshCw } from "lucide-react";
import type { ConversationHistoryEntry, ConversationHistoryPage, ConversationHistorySource } from "../../shared/contracts";
import { historyMaterialPreviewUrls } from "../../shared/conversation-history";
import { HistoryPreview } from "./HistoryPreview";
import { HistoryResultCover, HistoryResultViewer } from "./HistoryResultPreview";
import { StudioDisclosure, useStudioDisclosure } from "./StudioDisclosure";
export { HistoryPreview } from "./HistoryPreview";

export function ConversationHistory({ projectId, sessionId, selectedEventId, disabled, onEdit }: {
  projectId: string; sessionId: string; selectedEventId?: string; disabled?: boolean;
  onEdit: (entry: ConversationHistoryEntry) => void;
}) {
  const [expanded, setExpanded] = useStudioDisclosure("history");
  const [history, setHistory] = useState<ConversationHistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ projectId: string; sessionId: string; entry: ConversationHistoryEntry } | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const load = async (beforeEventId?: string) => {
    if (!sessionId || inFlight.current) return;
    inFlight.current = true;
    const request = ++sequence.current;
    setLoading(true); setError("");
    try {
      const page = await window.xinying.platformProjects.history(projectId, sessionId, beforeEventId);
      if (request !== sequence.current) return;
      if (page.sessionId !== sessionId) throw Error("心影返回了其他对话的记录，请重试");
      setHistory((previous) => {
        if (!beforeEventId || !previous) return page;
        const seen = new Set(previous.entries.map((entry) => entry.eventId));
        return { ...page, entries: [...previous.entries, ...page.entries.filter((entry) => !seen.has(entry.eventId))] };
      });
    } catch (reason) {
      if (request === sequence.current) setError(reason instanceof Error ? reason.message : "生成记录读取失败，请重试");
    } finally {
      if (request === sequence.current) { setLoading(false); inFlight.current = false; }
    }
  };
  useEffect(() => {
    setHistory(null); setHoveredId(null); setPreview(null); inFlight.current = false;
    if (expanded) void load();
    return () => { sequence.current += 1; };
  }, [projectId, sessionId]);
  useEffect(() => {
    if (expanded && !history && !inFlight.current) void load();
  }, [expanded]);
  useEffect(() => {
    const pause = () => setHoveredId(null);
    window.addEventListener("blur", pause); document.addEventListener("visibilitychange", pause);
    return () => { window.removeEventListener("blur", pause); document.removeEventListener("visibilitychange", pause); };
  }, []);

  return <StudioDisclosure className="conversation-history" title="当前对话的生成记录" summary={history ? `${history.entries.length}${history.hasMore ? "+" : ""} 条记录` : "按需查看 · 重新编辑"} expanded={expanded} onExpandedChange={next => { setExpanded(next); if (!next) { setHoveredId(null); setPreview(null); } }} actions={
      <button type="button" className="button ghost" disabled={loading || disabled || !sessionId} onClick={() => void load()}><RefreshCw size={14} className={loading ? "spinning" : ""} />刷新记录</button>}>
    <p className="conversation-history-hint">悬停视频静音播放，点击封面放大查看。选择“重新编辑”回填提示词、官网原素材和参数，不提交生成。</p>
    {error && <div className="project-conversation-error" role="alert">{error}<button type="button" disabled={loading || disabled} onClick={() => void load()}>重试</button></div>}
    {!history && loading && <p role="status" className="conversation-history-hint">正在读取所选对话…</p>}
    {!loading && !error && (!sessionId || history?.entries.length === 0) && <p className="conversation-history-empty">{sessionId ? "这个对话还没有生成记录。可以在下方开始创作。" : "选择左侧对话后，这里会显示它的生成记录。"}</p>}
    {!!history?.entries.length && <div className="conversation-history-entries">{history.entries.map((entry) => <article key={entry.eventId} className={`conversation-history-entry${selectedEventId === entry.eventId ? " selected" : ""}`} onMouseEnter={() => setHoveredId(entry.eventId)} onMouseLeave={() => setHoveredId((current) => current === entry.eventId ? null : current)}>
      <HistoryResultCover entry={entry} active={hoveredId === entry.eventId && !preview} onView={() => setPreview({ projectId, sessionId, entry })} onFocus={() => setHoveredId(entry.eventId)} onBlur={() => setHoveredId((current) => current === entry.eventId ? null : current)} />
      <div className="conversation-history-entry-content"><small>{entry.createdAt ? new Date(entry.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : `记录 ${entry.eventId}`}</small><p>{entry.prompt || "无提示词"}</p>
      <span>{[entry.settings.modelName, entry.settings.aspectRatio, entry.settings.duration ? `${entry.settings.duration}秒` : "", entry.settings.resolution?.toUpperCase()].filter(Boolean).join(" · ")}</span>
      <div className="conversation-history-entry-actions"><small>{entry.source.materials.length} 项参考素材</small><button type="button" className="button ghost" disabled={disabled || Boolean(entry.editUnavailableReason)} title={entry.editUnavailableReason || "回填草稿，不会生成"} onClick={() => { setHoveredId(null); onEdit(entry); }}><PencilLine size={14} />重新编辑</button></div>
      {entry.editUnavailableReason && <small className="conversation-history-hint">{entry.editUnavailableReason}</small>}
      <details><summary>完整提示词</summary><div className="history-full-prompt">{entry.prompt}</div></details></div>
    </article>)}</div>}
    {history?.hasMore && <button type="button" className="button ghost history-load-more" disabled={loading || disabled} onClick={() => void load(history.beforeEventId ?? undefined)}>{loading ? "正在读取…" : "加载更早记录"}</button>}
    {preview?.projectId === projectId && preview.sessionId === sessionId && <HistoryResultViewer key={preview.entry.eventId} entry={preview.entry} disabled={disabled} onClose={() => setPreview(null)} onEdit={() => { setPreview(null); setHoveredId(null); onEdit(preview.entry); }} />}
  </StudioDisclosure>;
}

export function HistoryMaterialTray({ source, onExit }: { source: ConversationHistorySource; onExit: () => void }) {
  return <section className="history-material-tray" aria-label="历史记录参考素材"><div className="conversation-history-heading"><div><h2>已回填历史记录</h2><span>记录 {source.eventId}</span></div><button type="button" className="button ghost" onClick={onExit}>退出历史编辑</button></div>
    <p className="conversation-history-hint">提示词和参数可在下方修改；素材按原记录的编号与顺序从心影直接复用，不重新上传。本地素材未删除，不会混入本次生成。</p>
    <div className="history-material-items">{source.materials.map((material) => {
      const urls = historyMaterialPreviewUrls(material);
      return <figure key={material.key}><div><HistoryPreview key={JSON.stringify(urls)} urls={urls} alt={material.name} /></div><figcaption><strong>{material.label}</strong><span title={material.name}>{material.name}</span></figcaption></figure>;
    })}{!source.materials.length && <p className="conversation-history-hint">原记录没有参考素材</p>}</div>
  </section>;
}
