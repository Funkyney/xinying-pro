import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, MessageSquare, Pin, Plus, RefreshCw, Search } from "lucide-react";
import type { PlatformConversation, Project } from "../../shared/contracts";
import { userFacingError } from "../interaction";

export function conversationIdFromUrl(url?: string): string {
  try { return url ? new URL(url).searchParams.get("sessionId") ?? "" : ""; } catch { return ""; }
}

/** The same project-scoped conversation browser in the studio and project picker. */
export function ProjectConversations({ projectId, projectName, selectedId, beforeOpen, onOpened, onBusyChange }: {
  projectId: string;
  projectName: string;
  selectedId: string;
  beforeOpen?: () => Promise<unknown>;
  onOpened: (project: Project) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<PlatformConversation[]>([]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const openingRef = useRef(false);
  const mounted = useRef(false);

  const load = async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await window.xinying.platformProjects.conversations(projectId);
      if (mounted.current && request === sequence.current) setItems(next);
    } catch (cause) {
      if (mounted.current && request === sequence.current) setError(userFacingError(cause));
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    setItems([]);
    setQuery("");
    setNotice("");
    void load();
    return () => { mounted.current = false; sequence.current += 1; };
  }, [projectId]);

  const open = async (id?: string) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(id ?? "new");
    setError("");
    setNotice("");
    onBusyChange?.(true);
    try {
      await beforeOpen?.();
      const opened = await window.xinying.platformProjects.open(projectId, id);
      const confirmedId = conversationIdFromUrl(opened.platformUrl);
      if (!confirmedId || (id && id !== confirmedId) || (!id && selectedId === confirmedId)) throw new Error("心影未确认所选对话编号，请刷新列表确认后再试");
      if (!mounted.current) return;
      // Keep a confirmed empty conversation visible even if Heart's list takes
      // a moment to index it. Never invent a remote session ID client-side.
      if (!id) {
        const createdId = conversationIdFromUrl(opened.platformUrl);
        setItems((current) => [{ id: createdId, projectId, title: "新会话", updatedAt: new Date().toISOString(), isCurrent: false }, ...current.filter((item) => item.id !== createdId)]);
        setQuery("");
        setCollapsed(false);
      }
      await onOpened(opened);
      if (mounted.current) setNotice(id ? "已切换，后续生成追加到这条对话" : "已新建空白会话，未提交生成");
    } catch (cause) {
      if (mounted.current) setError(`${userFacingError(cause)}${id ? "" : "；如遇超时，请先刷新列表确认，避免重复新建。"}`);
    } finally {
      openingRef.current = false;
      if (mounted.current) { setOpening(null); onBusyChange?.(false); }
    }
  };

  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = items.filter((item) => !normalized || `${item.title} ${item.id}`.toLocaleLowerCase("zh-CN").includes(normalized));
  const selected = items.find((item) => item.id === selectedId);
  return <aside className="project-conversations" aria-label={`${projectName}的对话`} aria-busy={loading || opening !== null}>
    <div className="project-conversations-context"><small>当前项目</small><strong title={projectName}>{projectName}</strong></div>
    <label className="project-conversation-search"><Search size={15} /><input aria-label="搜索聊天" placeholder="搜索聊天" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="project-conversations-heading">
      <button type="button" className="conversation-category-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><ChevronDown size={14} className={collapsed ? "collapsed" : ""} />对话</button>
      <div><button type="button" className="conversation-tool" aria-label="刷新对话" title="刷新官网对话列表" disabled={loading || opening !== null} onClick={() => void load()}><RefreshCw size={14} className={loading ? "spinning" : ""} /></button><button type="button" className="conversation-tool" aria-label="新建会话" title="在当前项目新建空白会话，不生成" disabled={opening !== null} onClick={() => void open()}><Plus size={17} /></button></div>
    </div>
    <div className="project-conversation-rows" hidden={collapsed}>
      {loading && !items.length && <div className="project-conversation-state" role="status">正在读取官网对话…</div>}
      {filtered.map((item) => <button type="button" key={item.id} className={`project-conversation-item ${item.id === selectedId ? "selected" : ""}`} aria-current={item.id === selectedId ? "true" : undefined} title={`${item.title}\n${item.id}`} disabled={opening !== null} onClick={() => void open(item.id)}>
        <MessageSquare size={16} /><span><strong>{item.title}</strong><small>{item.updatedAt && Number.isFinite(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : item.id.slice(0, 8)}{item.id === selectedId ? " · 当前对话" : ""}</small></span>{opening === item.id ? <RefreshCw size={14} className="spinning" /> : item.id === selectedId ? <Check size={15} /> : item.isPinned ? <Pin size={13} /> : null}
      </button>)}
      {!loading && !error && !filtered.length && <div className="project-conversation-state">{query ? "没有匹配的聊天" : "暂无对话，点击右上角 ＋ 新建会话"}</div>}
      {selectedId && !selected && !loading && <div className="project-conversation-state">已绑定对话 {selectedId.slice(0, 8)}…<br />列表中暂未找到，不会自动改绑。</div>}
    </div>
    {opening === "new" && <div className="project-conversation-state" role="status">正在新建会话…</div>}
    {error && <div className="project-conversation-error" role="alert"><span>{error}</span><button type="button" disabled={loading || opening !== null} onClick={() => void load()}>重新读取</button></div>}
    {notice && <div className="project-conversation-notice" role="status">{notice}</div>}
    <p className="project-conversations-footnote">选中的对话用于工作台和 Codex 后续生成。切换不清空本地草稿，历史任务不变。</p>
  </aside>;
}
