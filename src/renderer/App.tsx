import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Building2,
  CheckCircle2,
  CheckSquare2,
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
  ChevronRight,
  CircleUserRound,
  Clapperboard,
  Clock3,
  Download,
  ExternalLink,
  Film,
  FolderKanban,
  FolderPlus,
  Image as ImageIcon,
  LayoutDashboard,
  ListTree,
  LogIn,
  Plus,
  RefreshCw,
  Save,
  Square,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserRoundCheck,
  UsersRound,
  Video,
  X,
} from "lucide-react";
import type {
  AppUpdateState,
  CodexExtensionStatus,
  DashboardSnapshot,
  Job,
  JobEvent,
  JobStatus,
  PlatformAutomationState,
  PortraitAsset,
  PlatformPortrait,
  PlatformPortraitDeleteProgress,
  PlatformProject,
  PlatformProjectCreateInput,
  PlatformResult,
  PlatformResultSource,
  PlatformWorkspace,
  Project,
  ProjectInput,
  ReferenceAsset,
  ReferenceRole,
  SharedMediaAsset,
  SubmissionPreview,
} from "../shared/contracts";
import { modelProfile, resolutionLabel, XINYING_MODEL_PROFILES } from "../shared/model-profiles";
import {
  parseMaterialKey,
  portraitMaterialKey,
  reconcileMaterialOrder,
  referenceMaterialKey,
} from "../shared/material-order";
import { assignMediaLabels, mediaKindFromMime } from "../shared/media";
import { ReferenceBoard, type ReferenceAuthorizationState } from "./components/ReferenceBoard";
import { SharedMaterialLibrary } from "./components/SharedMaterialLibrary";
import { PlatformPanel } from "./components/PlatformPanel";
import { InteractionGate, userFacingError } from "./interaction";
import xinyingLogo from "./assets/xinying-logo.svg";

type PageKey = "dashboard" | "projects" | "studio" | "portraits" | "jobs" | "results" | "codex" | "platform";

const navigation: Array<{ key: PageKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: "dashboard", label: "总览", icon: LayoutDashboard },
  { key: "projects", label: "空间与项目", icon: Building2 },
  { key: "studio", label: "生成工作台", icon: Clapperboard },
  { key: "portraits", label: "虚拟人像", icon: CircleUserRound },
  { key: "jobs", label: "任务队列", icon: Activity },
  { key: "results", label: "结果库", icon: Film },
  { key: "codex", label: "Codex扩展", icon: Bot },
  { key: "platform", label: "原网页模式", icon: ExternalLink },
];

const statusLabels: Record<JobStatus, string> = {
  draft: "草稿",
  queued: "排队中",
  submitting: "提交中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  "needs-login": "需要登录",
  "needs-human": "需要人工处理",
  cancelled: "已取消",
};

const modeLabels: Record<Project["mode"], string> = {
  "text-to-video": "文生视频",
  "image-to-video": "图生视频",
  "reference-to-video": "多模态参考",
  "first-last-frame": "首尾帧",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function AppLogo() {
  return <div className="app-logo"><div className="logo-mark"><img src={xinyingLogo} alt="心影Pro Logo" /></div><div><strong>心影Pro</strong><span>AgentLab Pro</span></div></div>;
}

function UpdateControl({ state, onClick }: { state: AppUpdateState; onClick: () => void }) {
  const checking = state.status === "checking";
  const downloading = state.status === "downloading";
  const downloaded = state.status === "downloaded";
  const label = state.status === "available" ? `更新至 ${state.availableVersion}`
    : downloading ? `下载 ${Math.round(state.progress ?? 0)}%`
      : downloaded ? "重启安装"
        : state.status === "not-available" ? "已是最新版"
          : state.status === "error" ? "重试更新"
            : state.status === "unsupported" ? "开发版本"
              : checking ? "检查中…" : "检查更新";
  const Icon = downloaded ? CheckCircle2 : state.status === "available" || downloading ? Download : RefreshCw;
  return <button className={`update-button update-${state.status}`} disabled={checking || downloading || state.status === "unsupported"} onClick={onClick} title={state.message ?? label}><Icon size={15} className={checking ? "spinning" : ""} /><span><strong>{label}</strong><small>v{state.currentVersion}</small></span></button>;
}

function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`status-pill status-${status}`}>{statusLabels[status]}</span>;
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-state"><Sparkles size={28} /><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function App() {
  const [page, setPage] = useState<PageKey>("dashboard");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<string>("");
  const [updateState, setUpdateState] = useState<AppUpdateState>({ status: "idle", currentVersion: "…" });
  const [platformAutomation, setPlatformAutomation] = useState<PlatformAutomationState>({
    phase: "idle", label: "", detail: "", pendingCount: 0, current: null, total: null, startedAt: null,
  });
  const actionGateRef = useRef(new InteractionGate());
  const updateGateRef = useRef(new InteractionGate());
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(async (clearPreviousError = false) => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const next = await window.xinying.dashboard();
      if (sequence !== refreshSequenceRef.current) return;
      setSnapshot(next);
      setSelectedProjectId((current) => next.projects.some((project) => project.id === current) ? current : next.projects[0]?.id || "");
      if (clearPreviousError) setError("");
    } catch (cause) {
      if (sequence === refreshSequenceRef.current) setError(userFacingError(cause));
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !actionGateRef.current.isActive) void refresh();
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    void window.xinying.updates.state().then(setUpdateState).catch((cause) => {
      setUpdateState((current) => ({ ...current, status: "error", message: userFacingError(cause) }));
    });
    return window.xinying.updates.onStateChange(setUpdateState);
  }, []);

  useEffect(() => window.xinying.session.onLoginCompleted(() => {
    setPage("dashboard");
    setToast("飞书登录成功，已返回工作台");
    void refresh(true);
  }), [refresh]);

  useEffect(() => window.xinying.platformView.onAutomationStateChange(setPlatformAutomation), []);

  useEffect(() => {
    if (snapshot?.platformAutomation) setPlatformAutomation(snapshot.platformAutomation);
  }, [snapshot?.platformAutomation]);

  const handleUpdate = async () => {
    if (!updateGateRef.current.tryEnter()) return;
    try {
      if (updateState.status === "downloaded") {
        if (confirm("新版已经下载完成。现在重启心影Pro并安装更新？")) await window.xinying.updates.install();
        return;
      }
      setUpdateState((current) => ({ ...current, status: current.status === "available" ? "downloading" : "checking", message: "正在连接更新服务…" }));
      const next = updateState.status === "available"
        ? await window.xinying.updates.download()
        : await window.xinying.updates.check();
      setUpdateState(next);
    } catch (cause) {
      setUpdateState((current) => ({ ...current, status: "error", message: userFacingError(cause) }));
    } finally {
      updateGateRef.current.leave();
    }
  };

  const run = async (action: () => Promise<unknown>, success?: string) => {
    if (!actionGateRef.current.tryEnter()) {
      setToast("上一项操作正在处理，请稍候");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      if (success) setToast(success);
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      actionGateRef.current.leave();
      setBusy(false);
    }
  };

  const selectedProject = snapshot?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedPlatformWorkspace = snapshot?.platformCatalog.workspaces.find((workspace) => workspace.id === selectedProject?.platformWorkspaceId);
  const selectedPlatformProject = snapshot?.platformCatalog.projects.find((project) => project.id === selectedProject?.platformProjectId);
  const session = snapshot?.session;

  return (
    <div className="app-shell" aria-busy={busy}>
      <aside className="sidebar">
        <AppLogo />
        <nav>
          <span className="nav-section">工作空间</span>
          {navigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => setPage(item.key)}><Icon size={18} /><span>{item.label}</span>{page === item.key && <ChevronRight size={14} />}</button>;
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className={`session-card session-${session?.status ?? "unknown"}`}>
          <div className="session-dot" />
          <div><strong>{session?.status === "logged-in" ? "心影已连接" : session?.status === "needs-human" ? "等待扫码确认" : "心影未连接"}</strong><span>{session?.status === "logged-in" ? (session.accountLabel ?? "飞书会话有效") : session?.status === "needs-human" ? "请在手机飞书确认" : "请扫码登录"}</span></div>
          {session?.status !== "logged-in" && <button title="登录心影" aria-label="登录心影" onClick={() => { setPage("platform"); void run(() => window.xinying.session.openLogin()); }}><LogIn size={15} /></button>}
        </div>
        <div className="codex-card"><Bot size={18} /><div><strong>Codex Ready</strong><span>xinying CLI · JSON</span></div></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>心影Pro</span><ChevronRight size={14} /><strong>{navigation.find((item) => item.key === page)?.label}</strong></div>
          <div className="topbar-actions">
            <UpdateControl state={updateState} onClick={() => void handleUpdate()} />
            <button className="platform-context-button" onClick={() => setPage("projects")} title="切换个人/团队空间或心影项目"><Building2 size={15} /><span><small>{selectedPlatformWorkspace?.kind === "personal" ? "个人空间" : selectedPlatformWorkspace?.name ?? "尚未选择心影空间"}</small><strong>{selectedPlatformProject?.name ?? (selectedProject?.platformProjectId ? selectedProject.name : "选择项目后开始生成")}</strong></span><ChevronRight size={14} /></button>
            {selectedProject && <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>{snapshot?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}
            <button className="icon-button" onClick={() => void refresh(true)} title="刷新" aria-label="刷新工作台"><RefreshCw size={16} className={busy ? "spinning" : ""} /></button>
          </div>
        </header>

        {error && <div className="error-banner"><ShieldAlert size={17} /><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}

        <div className="page-content">
          {!snapshot ? <div className="loading-screen"><div className="loader" /><span>正在载入本地工作台…</span></div> : (
            <>
              {page === "dashboard" && <DashboardPage snapshot={snapshot} onNavigate={setPage} />}
              {page === "projects" && <PlatformProjectsPage snapshot={snapshot} run={run} onOpen={async (platformProjectId) => { await run(async () => { const opened = await window.xinying.platformProjects.open(platformProjectId); setSelectedProjectId(opened.id); setPage("studio"); }, "已切换心影项目并建立生成会话"); }} onCreated={(project) => { setSelectedProjectId(project.id); setPage("studio"); }} />}
              {page === "studio" && <StudioPage project={selectedProject} projects={snapshot.projects} portraits={snapshot.portraits} platformPortraits={snapshot.platformPortraits} jobs={snapshot.jobs} onSelect={setSelectedProjectId} onNavigate={setPage} run={run} onOpenPlatform={(url) => run(async () => { await window.xinying.session.openUrl(url); setPage("platform"); })} onDelete={(id) => run(async () => { await window.xinying.projects.remove(id); setSelectedProjectId(""); setPage("dashboard"); }, "项目及其本地素材已删除")} />}
              {page === "portraits" && <PortraitsPage portraits={snapshot.portraits} platformPortraits={snapshot.platformPortraits} projects={snapshot.projects} selectedProject={selectedProject} workspaceName={selectedPlatformWorkspace?.name ?? "当前心影空间"} onSelectProject={setSelectedProjectId} run={run} onNavigate={setPage} />}
              {page === "jobs" && <JobsPage jobs={snapshot.jobs} projects={snapshot.projects} portraits={snapshot.portraits} run={run} />}
              {page === "results" && <ResultsPage results={snapshot.results} projects={snapshot.projects} selectedProject={selectedProject} onSelectProject={setSelectedProjectId} run={run} />}
              {page === "codex" && <CodexExtensionPage />}
              {page === "platform" && <PlatformPanel />}
            </>
          )}
        </div>
      </main>
      {(busy || platformAutomation.phase !== "idle") && <div className="busy-overlay" role="status" aria-live="polite"><div className="loader" /><span><strong>{platformAutomation.phase === "queued" ? `排队等待：${platformAutomation.label}` : platformAutomation.label || "正在处理…"}</strong><small>{platformAutomation.detail || (busy ? "正在更新本地工作台" : "")}{platformAutomation.pendingCount > 0 ? ` · 后面还有 ${platformAutomation.pendingCount} 项` : ""}</small>{platformAutomation.total && platformAutomation.current !== null ? <em>{platformAutomation.current} / {platformAutomation.total}</em> : null}</span></div>}
    </div>
  );
}

function CodexExtensionPage() {
  const [status, setStatus] = useState<CodexExtensionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const statusGateRef = useRef(new InteractionGate());
  const operationGateRef = useRef(new InteractionGate());

  const refreshStatus = useCallback(async () => {
    if (!statusGateRef.current.tryEnter()) return;
    setLoading(true);
    try {
      setStatus(await window.xinying.codexExtension.status());
      setError("");
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      statusGateRef.current.leave();
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const install = async () => {
    if (!status) return;
    const replaceExisting = status.conflict;
    if (replaceExisting && !confirm("检测到同名的现有 Skill。心影Pro会先完整备份它，再安装受管版本。继续吗？")) return;
    if (!operationGateRef.current.tryEnter()) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const result = await window.xinying.codexExtension.install(replaceExisting);
      setStatus(result);
      setMessage(result.backupPath
        ? `安装完成；原 Skill 已备份到 ${result.backupPath}。请新建 Codex 任务或重启 Codex 后使用。`
        : "安装完成。请新建 Codex 任务或重启 Codex 后使用。");
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      operationGateRef.current.leave();
      setWorking(false);
    }
  };

  const openExtensionFolder = async () => {
    if (!operationGateRef.current.tryEnter()) return;
    setOpeningFolder(true);
    setError("");
    try {
      await window.xinying.codexExtension.openFolder();
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      operationGateRef.current.leave();
      setOpeningFolder(false);
    }
  };

  const actionLabel = status?.state === "conflict" ? "备份现有 Skill 并安装"
    : status?.state === "update-available" ? "更新 Codex 扩展"
      : status?.state === "installed" ? "重新安装"
        : "安装到 Codex";
  const stateLabel = status?.state === "installed" ? "已就绪"
    : status?.state === "update-available" ? "可更新"
      : status?.state === "conflict" ? "需要确认"
        : status?.state === "source-missing" ? "资源缺失"
          : "未安装";

  return <div className="codex-extension-page">
    <div className="page-heading">
      <div><span className="eyebrow">CODEX EXTENSION</span><h1>让 Codex 直接指挥心影Pro</h1><p>一次安装后，Codex 能把定稿提示词、参考素材、人物授权与生成数量交给本机心影Pro执行。</p></div>
      <button className="button ghost" disabled={loading} onClick={() => void refreshStatus()}><RefreshCw size={15} className={loading ? "spinning" : ""} />刷新状态</button>
    </div>

    <section className="codex-extension-hero panel">
      <div className="codex-extension-icon"><Bot size={38} /></div>
      <div className="codex-extension-summary">
        <div><span className={`extension-state extension-${status?.state ?? "loading"}`}><span />{loading ? "检测中" : stateLabel}</span><small>心影Pro × Codex</small></div>
        <h2>心影Pro 自动生成 Skill</h2>
        <p>{status?.message ?? "正在检测本机 Codex 扩展目录…"}</p>
      </div>
      <div className="codex-extension-actions">
        <button className="button primary" disabled={!status?.available || working || loading} onClick={() => void install()}>{working ? <RefreshCw size={16} className="spinning" /> : <Download size={16} />}{working ? "安装中…" : actionLabel}</button>
        <button className="button ghost" disabled={!status || working || openingFolder} onClick={() => void openExtensionFolder()}>{openingFolder ? <RefreshCw size={15} className="spinning" /> : <FolderKanban size={15} />}{openingFolder ? "打开中…" : "打开扩展目录"}</button>
      </div>
    </section>

    {message && <div className="extension-notice success"><CheckCircle2 size={17} /><span>{message}</span></div>}
    {error && <div className="extension-notice error"><ShieldAlert size={17} /><span>{error}</span></div>}

    <div className="codex-extension-grid">
      <section className="panel extension-detail-card"><span className="eyebrow">INSTALLATION</span><h3>安装状态</h3><dl><div><dt>APP内置版本</dt><dd>{status?.currentVersion ?? "—"}</dd></div><div><dt>已安装版本</dt><dd>{status?.installedVersion ?? "未安装"}</dd></div><div><dt>更新联动</dt><dd>APP更新后此页会提示扩展更新</dd></div></dl></section>
      <section className="panel extension-detail-card"><span className="eyebrow">LOCAL PATH</span><h3>本机位置</h3><dl><div><dt>Codex目录</dt><dd title={status?.codexHome}>{status?.codexHome ?? "检测中…"}</dd></div><div><dt>Skill目录</dt><dd title={status?.skillPath}>{status?.skillPath ?? "检测中…"}</dd></div><div><dt>CLI启动器</dt><dd title={status?.launcherPath ?? undefined}>{status?.launcherPath ?? "安装时自动生成"}</dd></div></dl></section>
      <section className="panel extension-detail-card extension-workflow-card"><span className="eyebrow">WORKFLOW</span><h3>同事怎么使用</h3><ol><li><b>1</b><span>安装心影Pro并用飞书登录自己的心影账号</span></li><li><b>2</b><span>在此页点击“安装到 Codex”</span></li><li><b>3</b><span>在 Codex 中完成 Seedance 提示词后说“用心影Pro生成 N 条”</span></li></ol></section>
    </div>

    <section className="extension-safety panel"><ShieldAlert size={18} /><div><strong>授权与费用仍由每位使用者控制</strong><span>Skill只在用户明确要求生成时才提交并可能扣费；不会读取 Cookie、Token、二维码，也不会绕过登录、审核、额度或付费确认。</span></div></section>
  </div>;
}

function DashboardPage({ snapshot, onNavigate }: { snapshot: DashboardSnapshot; onNavigate: (page: PageKey) => void }) {
  const running = snapshot.jobs.filter((job) => ["queued", "submitting", "running"].includes(job.status)).length;
  const needsHuman = snapshot.jobs.filter((job) => ["needs-human", "needs-login"].includes(job.status)).length;
  const completed = snapshot.jobs.filter((job) => job.status === "completed").length;
  return <div className="dashboard-page">
    <section className="hero-panel">
      <div><span className="eyebrow">CREATIVE OPERATIONS</span><h1>心影让你当指挥家，心影Pro让你直接把片交了。</h1><p>整理参考图、锁定编号、管理虚拟人像与生成任务；需要时随时切回心影原网页。</p><div className="hero-actions"><button className="button primary" onClick={() => onNavigate("studio")}><Clapperboard size={17} />进入生成工作台</button><button className="button ghost" onClick={() => onNavigate("platform")}><ExternalLink size={17} />打开心影原网页</button></div></div>
      <div className="hero-orbit"><div className="orbit-ring"><Video size={34} /></div><span>DIRECT · ORGANIZE · GENERATE</span></div>
    </section>
    <section className="metric-grid">
      <Metric icon={FolderKanban} value={snapshot.projects.length} label="创作项目" tone="purple" />
      <Metric icon={Clock3} value={running} label="运行中任务" tone="blue" />
      <Metric icon={CheckCircle2} value={completed} label="已完成结果" tone="green" />
      <Metric icon={ShieldAlert} value={needsHuman} label="需要人工处理" tone="amber" />
    </section>
    <div className="dashboard-columns">
      <section className="panel">
        <div className="panel-heading compact"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>最近任务</h2></div><button className="link-button" onClick={() => onNavigate("jobs")}>查看全部<ChevronRight size={14} /></button></div>
        <div className="activity-list">{snapshot.jobs.slice(0, 6).map((job) => <div className="activity-row" key={job.id}><div className="activity-icon"><Video size={16} /></div><div><strong>{snapshot.projects.find((project) => project.id === job.projectId)?.name ?? (job.kind === "portrait-review" ? "虚拟人像审核" : "未知项目")}</strong><span>{formatDate(job.updatedAt)} · {job.id.slice(0, 8)}</span></div><StatusPill status={job.status} /></div>)}{!snapshot.jobs.length && <EmptyState title="还没有任务" description="创建项目并提交第一条生成任务。" />}</div>
      </section>
      <section className="panel project-entry-panel">
        <div className="panel-heading compact"><div><span className="eyebrow">XINYING CONTEXT</span><h2>先选空间与项目</h2></div><Building2 size={20} /></div>
        <div className="project-entry-facts"><span><strong>{snapshot.platformCatalog.workspaces.length}</strong> 个空间</span><span><strong>{snapshot.platformCatalog.projects.length}</strong> 个可见项目</span><span><strong>{snapshot.platformPortraits.filter((item) => item.available).length}</strong> 个授权人像</span></div>
        <button className="button secondary full" onClick={() => onNavigate("projects")}><FolderKanban size={16} />选择或新建心影项目</button>
        <p className="fine-print">个人空间内容仅自己可见；团队空间的项目、生成记录与虚拟人像可供团队成员协作。</p>
      </section>
    </div>
  </div>;
}

function Metric({ icon: Icon, value, label, tone }: { icon: typeof Video; value: number; label: string; tone: string }) {
  return <div className={`metric-card tone-${tone}`}><div className="metric-icon"><Icon size={20} /></div><div><strong>{value}</strong><span>{label}</span></div></div>;
}

function PlatformProjectsPage({ snapshot, run, onOpen, onCreated }: { snapshot: DashboardSnapshot; run: (action: () => Promise<unknown>, success?: string) => Promise<void>; onOpen: (projectId: string) => Promise<void>; onCreated: (project: Project) => void }) {
  const catalog = snapshot.platformCatalog;
  const [workspaceId, setWorkspaceId] = useState(catalog.currentWorkspaceId || catalog.workspaces[0]?.id || "");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<PlatformProjectCreateInput>({ workspaceId, name: "", customer: catalog.customerOptions[0] ?? "", creationType: catalog.creationTypeOptions[0] ?? "" });
  useEffect(() => {
    if (!catalog.workspaces.some((workspace) => workspace.id === workspaceId)) setWorkspaceId(catalog.currentWorkspaceId || catalog.workspaces[0]?.id || "");
  }, [catalog.syncedAt, workspaceId]);
  useEffect(() => setForm((current) => ({ ...current, workspaceId })), [workspaceId]);
  const workspace = catalog.workspaces.find((item) => item.id === workspaceId);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const projects = catalog.projects.filter((project) => project.workspaceId === workspaceId && project.available && (!normalizedQuery || `${project.name} ${project.shortId}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  const openCreate = () => {
    setForm({ workspaceId, name: "", customer: workspace?.kind === "team" ? catalog.customerOptions[0] ?? "" : "", creationType: catalog.creationTypeOptions[0] ?? "" });
    setCreateOpen(true);
  };
  const create = () => run(async () => {
    const created = await window.xinying.platformProjects.create(form);
    setCreateOpen(false);
    onCreated(created);
  }, "心影项目已创建并进入生成工作台");
  return <div className="platform-projects-page">
    <div className="page-heading"><div><span className="eyebrow">XINYING WORKSPACES</span><h1>空间与项目</h1><p>个人空间仅自己可见；团队空间里的项目、生成内容和角色资产可与同事协作。</p></div><div className="heading-actions"><button className="button secondary" onClick={() => run(() => window.xinying.platformProjects.sync(), "空间与项目目录已同步")}><RefreshCw size={15} />同步心影</button><button className="button primary" disabled={!workspaceId} onClick={openCreate}><FolderPlus size={16} />在当前空间新建项目</button></div></div>
    <section className="workspace-switcher panel"><div className="workspace-tabs">{catalog.workspaces.map((item) => <button key={item.id} className={item.id === workspaceId ? "active" : ""} onClick={() => setWorkspaceId(item.id)}>{item.kind === "personal" ? <CircleUserRound size={18} /> : <UsersRound size={18} />}<span><strong>{item.name}</strong><small>{item.kind === "personal" ? "仅自己可见" : "团队成员互通"}</small></span>{item.isCurrent && <em>心影当前</em>}</button>)}</div>{!catalog.workspaces.length && <EmptyState title="尚未同步心影空间" description="保持飞书登录后点击“同步心影”，APP 会读取个人空间、团队空间和各自的项目。" action={<button className="button primary" onClick={() => run(() => window.xinying.platformProjects.sync(), "空间与项目目录已同步")}><RefreshCw size={16} />立即同步</button>} />}</section>
    {workspace && <section className="panel platform-project-list"><div className="panel-heading compact"><div><span className="eyebrow">{workspace.kind === "personal" ? "PRIVATE" : "TEAM SHARED"}</span><h2>{workspace.name}</h2><p>{workspace.description}</p></div><div className="portrait-toolbar"><input className="portrait-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称或 ID…" /><span className="library-count">{projects.length} 个项目</span></div></div><div className="platform-project-grid">{projects.map((project) => <article key={project.id} className={`platform-project-card ${project.isCurrent ? "current" : ""}`}><div className="project-card-icon"><FolderKanban size={21} /></div><div><strong>{project.name}</strong><span>ID：{project.shortId || "同步后获取"}</span><small>{workspace.kind === "personal" ? "私有项目" : "团队共享项目"}{project.isCurrent ? " · 心影当前" : ""}</small></div><button className="button secondary" onClick={() => void onOpen(project.id)}>选择并进入</button></article>)}{!projects.length && <EmptyState title={query ? "没有匹配的项目" : "当前空间暂无可见项目"} description={query ? "换一个项目名称或 ID 搜索。" : "可以直接在当前空间新建项目。"} />}</div></section>}
    {createOpen && <div className="modal-backdrop"><section className="confirm-modal platform-create-modal"><div className="modal-icon"><FolderPlus size={21} /></div><h2>在{workspace?.kind === "personal" ? "个人空间" : `团队空间「${workspace?.name}」`}新建项目</h2><p>创建成功后 APP 会自动进入该项目并建立内容生成会话。</p><div className="form-stack"><label>项目名称<input autoFocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：秋季汽车广告" /></label>{workspace?.kind === "team" && <label>所属客户<input list="platform-customer-options" value={form.customer} onChange={(event) => setForm((current) => ({ ...current, customer: event.target.value }))} placeholder="请选择心影中的客户" /><datalist id="platform-customer-options">{catalog.customerOptions.map((item) => <option value={item} key={item} />)}</datalist></label>}<label>视频创作类型<input list="platform-creation-options" value={form.creationType} onChange={(event) => setForm((current) => ({ ...current, creationType: event.target.value }))} placeholder="请选择视频创作类型" /><datalist id="platform-creation-options">{catalog.creationTypeOptions.map((item) => <option value={item} key={item} />)}</datalist></label></div><div className="modal-actions"><button className="button ghost" onClick={() => setCreateOpen(false)}>取消</button><button className="button primary" disabled={!form.name.trim() || (workspace?.kind === "team" && !form.customer.trim()) || !form.creationType.trim()} onClick={() => void create()}><FolderPlus size={16} />确认创建</button></div></section></div>}
  </div>;
}

function StudioPage({ project, projects, portraits, platformPortraits, jobs, onSelect, onNavigate, run, onOpenPlatform, onDelete }: { project: Project | null; projects: Project[]; portraits: PortraitAsset[]; platformPortraits: PlatformPortrait[]; jobs: Job[]; onSelect: (id: string) => void; onNavigate: (page: PageKey) => void; run: (action: () => Promise<unknown>, success?: string) => Promise<void>; onOpenPlatform: (url: string) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [references, setReferences] = useState<ReferenceAsset[]>([]);
  const [sharedMedia, setSharedMedia] = useState<SharedMediaAsset[]>([]);
  const [draft, setDraft] = useState<Partial<ProjectInput>>({});
  const [preview, setPreview] = useState<SubmissionPreview | null>(null);
  const [generationCount, setGenerationCount] = useState(1);
  const [authorizationTarget, setAuthorizationTarget] = useState<ReferenceAsset | null>(null);
  const [authorizationConsent, setAuthorizationConsent] = useState(false);
  const [authorizingReferenceIds, setAuthorizingReferenceIds] = useState<Set<string>>(() => new Set());
  const [referenceDeleteTarget, setReferenceDeleteTarget] = useState<ReferenceAsset | null>(null);
  const [sharedMediaDeleteTarget, setSharedMediaDeleteTarget] = useState<SharedMediaAsset | null>(null);

  useEffect(() => {
    if (!project) return;
    setDraft({ name: project.name, description: project.description, prompt: project.prompt, modelName: project.modelName, platformUrl: project.platformUrl, platformWorkspaceId: project.platformWorkspaceId, platformProjectId: project.platformProjectId, mode: project.mode, aspectRatio: project.aspectRatio, duration: project.duration, resolution: project.resolution, audioEnabled: project.audioEnabled, portraitIds: project.portraitIds, materialOrder: project.materialOrder });
    void Promise.all([window.xinying.references.list(project.id), window.xinying.sharedMedia.list()]).then(([nextReferences, nextSharedMedia]) => {
      setReferences(nextReferences);
      setSharedMedia(nextSharedMedia);
    });
  }, [project?.id, project?.updatedAt]);

  if (!project || !project.platformProjectId || !project.platformUrl) return <EmptyState title="请先选择心影空间和项目" description="生成工作台只在已选择或新建的心影项目下启用，确保团队/个人内容进入正确的位置。" action={<button className="button primary" onClick={() => onNavigate("projects")}><Building2 size={16} />选择或新建心影项目</button>} />;
  const updateDraft = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const reloadRefs = async () => {
    const [nextReferences, nextSharedMedia] = await Promise.all([window.xinying.references.list(project.id), window.xinying.sharedMedia.list()]);
    setReferences(nextReferences);
    setSharedMedia(nextSharedMedia);
    return nextReferences;
  };
  const profile = modelProfile(draft.modelName);
  const selectedPortraitIds = draft.portraitIds ?? [];
  const materialOrder = reconcileMaterialOrder(draft.materialOrder, selectedPortraitIds, references.map((reference) => reference.id));
  const availablePortraits = platformPortraits.filter((portrait) => portrait.available && (!portrait.workspaceId || portrait.workspaceId === project.platformWorkspaceId));
  const selectedPortraits = selectedPortraitIds.map((id) => availablePortraits.find((portrait) => portrait.id === id)).filter((portrait): portrait is PlatformPortrait => Boolean(portrait));
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
  const portraitsById = new Map(selectedPortraits.map((portrait) => [portrait.id, portrait]));
  const materialLabels = assignMediaLabels(materialOrder.map((key) => {
    const item = parseMaterialKey(key);
    if (item?.kind === "portrait") return portraitsById.get(item.id)?.mediaKind ?? "unknown";
    const reference = item?.kind === "reference" ? referencesById.get(item.id) : undefined;
    return reference ? mediaKindFromMime(reference.mimeType) : "unknown";
  }));
  const authorizationStates = Object.fromEntries(references.map((reference): [string, ReferenceAuthorizationState] => {
    const linkedPortraits = portraits.filter((portrait) => portrait.sourceReferenceId === reference.id);
    const linkedPortraitIds = new Set(linkedPortraits.map((portrait) => portrait.id));
    const linkedJobs = jobs.filter((job) => job.kind === "portrait-review" && job.portraitId && linkedPortraitIds.has(job.portraitId));
    const messageFor = (portraitStatuses: string[], jobStatuses: string[]) => {
      const portrait = linkedPortraits.find((item) => portraitStatuses.includes(item.platformStatus));
      const job = linkedJobs.find((item) => jobStatuses.includes(item.status));
      return portrait?.reviewNote || job?.requiresHumanReason || job?.errorMessage || undefined;
    };
    if (authorizingReferenceIds.has(reference.id)) return [reference.id, { status: "authorizing", message: "授权任务正在建立" }];
    if (linkedPortraits.some((portrait) => portrait.platformStatus === "approved") || linkedJobs.some((job) => job.status === "completed")) {
      return [reference.id, { status: "authorized", message: messageFor(["approved"], ["completed"]) || "已通过心影授权审核" }];
    }
    if (linkedPortraits.some((portrait) => ["queued", "reviewing"].includes(portrait.platformStatus)) || linkedJobs.some((job) => ["queued", "submitting", "running"].includes(job.status))) {
      return [reference.id, { status: "authorizing", message: messageFor(["queued", "reviewing"], ["queued", "submitting", "running"]) || "正在上传并等待心影审核" }];
    }
    if (linkedPortraits.some((portrait) => portrait.platformStatus === "needs-human") || linkedJobs.some((job) => ["needs-human", "needs-login"].includes(job.status))) {
      return [reference.id, { status: "needs-human", message: messageFor(["needs-human"], ["needs-human", "needs-login"]) || "请到任务队列查看需要处理的步骤" }];
    }
    if (linkedPortraits.some((portrait) => portrait.platformStatus === "rejected") || linkedJobs.some((job) => ["failed", "cancelled"].includes(job.status))) {
      return [reference.id, { status: "failed", message: messageFor(["rejected"], ["failed", "cancelled"]) || "上次授权未完成，可以重新授权" }];
    }
    return [reference.id, { status: "idle" }];
  }));
  const startReferenceAuthorization = (asset: ReferenceAsset, rememberConsent: boolean) => {
    if (rememberConsent) localStorage.setItem("xinying:portrait-compliance-v1", "confirmed");
    setAuthorizationTarget(null);
    setAuthorizingReferenceIds((current) => new Set(current).add(asset.id));
    void run(
      () => window.xinying.portraits.authorizeReference(asset.id, project.id, true),
      "已开始后台授权；卡片会自动更新状态",
    ).finally(() => setAuthorizingReferenceIds((current) => {
      const next = new Set(current);
      next.delete(asset.id);
      return next;
    }));
  };
  const chooseModel = (modelName: string) => {
    const nextProfile = modelProfile(modelName);
    setDraft((current) => {
      if (!nextProfile) return { ...current, modelName };
      const nextMode = current.mode && nextProfile.modes.includes(current.mode) ? current.mode : nextProfile.modes[0];
      const nextResolution = !current.resolution || current.resolution === "auto" || nextProfile.resolutions.includes(current.resolution)
        ? (current.resolution ?? "auto")
        : "1080p";
      const nextDuration = Math.min(nextProfile.maxDuration, Math.max(nextProfile.minDuration, current.duration ?? 5));
      return { ...current, modelName, mode: nextMode, resolution: nextResolution, duration: nextDuration };
    });
  };
  const togglePortrait = async (id: string) => {
    const removing = selectedPortraitIds.includes(id);
    const nextPortraitIds = removing ? selectedPortraitIds.filter((item) => item !== id) : [...selectedPortraitIds, id];
    let nextOrder = materialOrder.filter((key) => key !== portraitMaterialKey(id));
    if (!removing) nextOrder = [...nextOrder, portraitMaterialKey(id)];
    const portrait = availablePortraits.find((item) => item.id === id);
    await run(
      async () => {
        setDraft((current) => ({ ...current, portraitIds: nextPortraitIds, materialOrder: nextOrder }));
        await window.xinying.projects.update(project.id, { portraitIds: nextPortraitIds, materialOrder: nextOrder });
      },
      removing ? `“${portrait?.displayName ?? "虚拟人像"}”已从参考素材移除` : `“${portrait?.displayName ?? "虚拟人像"}”已加入上方参考素材`,
    );
  };
  const toggleSharedMedia = async (asset: SharedMediaAsset) => {
    const selected = references.some((reference) => reference.sourceSharedMediaId === asset.id);
    await run(async () => {
      const nextReferences = selected
        ? await window.xinying.sharedMedia.removeFromProject(project.id, asset.id)
        : await window.xinying.sharedMedia.addToProject(project.id, asset.id);
      setReferences(nextReferences);
      setDraft((current) => ({
        ...current,
        materialOrder: reconcileMaterialOrder(current.materialOrder, current.portraitIds ?? [], nextReferences.map((reference) => reference.id)),
      }));
    }, selected ? `“${asset.name}”已从当前项目移出，共享库仍保留` : `“${asset.name}”已加入当前项目创作顺序`);
  };
  const reorderMaterials = (requestedOrder: string[]) => {
    const nextOrder = requestedOrder;
    const nextPortraitIds = nextOrder
      .map(parseMaterialKey)
      .filter((item): item is { kind: "portrait"; id: string } => item?.kind === "portrait")
      .map((item) => item.id);
    void run(async () => {
      setDraft((current) => ({ ...current, portraitIds: nextPortraitIds, materialOrder: nextOrder }));
      await window.xinying.projects.update(project.id, { portraitIds: nextPortraitIds, materialOrder: nextOrder });
    }, "APP 创作顺序已保存，提交时会自动换算心影编号");
  };

  return <div className="studio-page">
    <div className="page-heading"><div><span className="eyebrow">GENERATION WORKSPACE</span><h1>{project.name}</h1><p>本地素材按 APP 顺序上传；多个虚拟角色由心影官方排序，APP 会按实际编号自动改写提示词。</p></div><div className="heading-actions">{draft.platformUrl && <button className="button ghost" onClick={() => void onOpenPlatform(draft.platformUrl!)}><ExternalLink size={16} />查看绑定会话</button>}<button className="button danger" onClick={() => confirm(`删除项目“${project.name}”及其本地素材？历史任务记录会保留，但项目关联将清空。`) && void onDelete(project.id)}><Trash2 size={16} />删除项目</button><button className="button ghost" onClick={() => run(() => window.xinying.projects.update(project.id, draft), "项目已保存")}><Save size={16} />保存草稿</button><button className="button primary" onClick={() => run(async () => { await window.xinying.projects.update(project.id, draft); setPreview(await window.xinying.jobs.preview(project.id)); })}><Send size={16} />预览提交</button></div></div>
    <ReferenceBoard assets={references} portraits={selectedPortraits} materialOrder={materialOrder} authorizationStates={authorizationStates} onAdd={() => run(async () => { const nextReferences = await window.xinying.references.pickAndAdd(project.id); setReferences(nextReferences); setSharedMedia(await window.xinying.sharedMedia.list()); setDraft((current) => ({ ...current, materialOrder: reconcileMaterialOrder(current.materialOrder, current.portraitIds ?? [], nextReferences.map((reference) => reference.id)) })); }, "参考素材已加入项目并保存到共享素材库")} onBatchReplace={() => run(async () => { setReferences(await window.xinying.references.batchReplace(project.id)); setSharedMedia(await window.xinying.sharedMedia.list()); }, "全部本地参考素材已替换，新素材已进入共享库")} onReorder={reorderMaterials} onRole={(id, role: ReferenceRole) => run(async () => { await window.xinying.references.updateRole(id, role); await reloadRefs(); })} onReplace={(id) => run(async () => { await window.xinying.references.replace(id); await reloadRefs(); }, "素材已替换并进入共享库，编号保持不变")} onAuthorize={(asset) => { if (localStorage.getItem("xinying:portrait-compliance-v1") === "confirmed") startReferenceAuthorization(asset, true); else { setAuthorizationTarget(asset); setAuthorizationConsent(false); } }} onRemove={(id) => setReferenceDeleteTarget(references.find((reference) => reference.id === id) ?? null)} onRemovePortrait={togglePortrait} />
    <SharedMaterialLibrary assets={sharedMedia} portraits={availablePortraits} references={references} materialOrder={materialOrder} materialLabels={materialLabels} onUpload={() => run(async () => setSharedMedia(await window.xinying.sharedMedia.pickAndAdd()), "共享素材已上传；点击卡片即可加入当前项目")} onSyncPortraits={() => run(() => window.xinying.portraits.sync(project.id), "当前空间虚拟人像库已同步")} onToggleAsset={toggleSharedMedia} onDeleteAsset={setSharedMediaDeleteTarget} onTogglePortrait={(portrait) => togglePortrait(portrait.id)} />
    <div className="studio-columns">
      <section className="panel prompt-panel"><div className="panel-heading compact"><div><span className="eyebrow">PROMPT</span><h2>导演提示词</h2></div><Sparkles size={19} /></div><textarea value={draft.prompt ?? ""} onChange={(event) => updateDraft("prompt", event.target.value)} placeholder="描述可见动作、镜头、光线、声音和限制…" /><div className="prompt-footer"><span>{(draft.prompt ?? "").length} 字</span><span>支持 @图1、@图一 和“参考图三”，提交时自动换算</span></div></section>
      <section className="panel parameters-panel">
        <div className="panel-heading compact"><div><span className="eyebrow">PARAMETERS</span><h2>生成参数</h2></div><Settings2 size={19} /></div>
        <div className="form-stack">
          <label>项目名称<input value={draft.name ?? ""} onChange={(event) => updateDraft("name", event.target.value)} /></label>
          <label>项目说明<textarea className="project-description" value={draft.description ?? ""} onChange={(event) => updateDraft("description", event.target.value)} placeholder="记录创作目标、版本或交付备注…" /></label>
          <label>心影项目绑定<div className="binding-row"><input readOnly value={project.platformUrl} title={project.platformUrl} /><button type="button" className="button ghost" onClick={() => onNavigate("projects")}><Building2 size={15} />切换空间/项目</button></div></label>
          <label>模型选择<div className="model-choice-grid">{XINYING_MODEL_PROFILES.map((item) => <button type="button" key={item.name} className={`model-choice ${draft.modelName === item.name ? "active" : ""}`} onClick={() => chooseModel(item.name)}><strong>{item.shortName}</strong><span>{item.description}</span>{item.resolutions.includes("4k") && <em>4K</em>}</button>)}</div></label>
        </div>
        <div className="form-grid"><label>生成模式<select value={draft.mode ?? project.mode} onChange={(event) => updateDraft("mode", event.target.value as ProjectInput["mode"])}>{(profile?.modes ?? ["text-to-video", "image-to-video", "reference-to-video", "first-last-frame"]).map((mode) => <option value={mode} key={mode}>{modeLabels[mode]}</option>)}</select></label><label>画面比例<select value={draft.aspectRatio ?? project.aspectRatio} onChange={(event) => updateDraft("aspectRatio", event.target.value)}>{(profile?.aspectRatios ?? ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "自适应"]).map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label><label>时长<input type="number" min={profile?.minDuration ?? 4} max={profile?.maxDuration ?? 30} value={draft.duration ?? project.duration} onChange={(event) => updateDraft("duration", Number(event.target.value))} /><small>{profile ? `${profile.minDuration}–${profile.maxDuration} 秒` : "4–30 秒"}</small></label><label>分辨率<select value={draft.resolution ?? project.resolution} onChange={(event) => updateDraft("resolution", event.target.value)}><option value="auto">跟随心影当前值（推荐）</option>{(profile?.resolutions ?? ["480p", "720p", "1080p", "1K", "2K", "4k"]).map((resolution) => <option value={resolution} key={resolution}>{resolutionLabel(resolution)}</option>)}</select></label></div><label className="switch-row"><div><strong>生成声音</strong><span>{profile?.audioSupported ? "当前心影模型支持音画同出" : "具体能力以当前心影页面为准"}</span></div><input type="checkbox" checked={draft.audioEnabled ?? project.audioEnabled} onChange={(event) => updateDraft("audioEnabled", event.target.checked)} /></label>
      </section>
    </div>
    {preview && <div className="modal-backdrop"><section className="confirm-modal"><div className="modal-icon"><Send size={21} /></div><h2>提交到心影任务队列？</h2><p>APP 将按下面的素材编号和参数，通过当前登录的心影页面执行。</p><div className="preview-list">{preview.orderedLabels.map((label) => <span key={label}>{label}</span>)}{!preview.orderedLabels.length && <span>无参考素材</span>}</div><label className="generation-count-control"><span><strong>生成条数</strong><small>{generationCount > 1 ? "第 1 条完整提交；后续自动使用心影“重新编辑”复用素材与参数" : "提交 1 条生成任务"}</small></span><input type="number" min={1} max={20} value={generationCount} onChange={(event) => setGenerationCount(Math.min(20, Math.max(1, Number(event.target.value) || 1)))} /></label>{preview.warnings.length > 0 && <div className="warning-box">{preview.warnings.map((warning) => <span key={warning}><ShieldAlert size={14} />{warning}</span>)}</div>}<div className="modal-actions"><button className="button ghost" onClick={() => setPreview(null)}>返回检查</button><button className="button primary" disabled={!preview.ready} onClick={() => run(async () => { await window.xinying.projects.update(project.id, draft); await window.xinying.jobs.submit(project.id, generationCount); setPreview(null); }, generationCount === 1 ? "任务已加入队列" : `${generationCount} 条任务已加入队列；后续条目将自动复用上一条`)}><Send size={16} />确认提交 {generationCount > 1 ? `${generationCount} 条` : ""}</button></div></section></div>}
    {authorizationTarget && <div className="modal-backdrop"><section className="confirm-modal portrait-authorization-modal"><div className="modal-icon"><UserRoundCheck size={21} /></div><h2>把“{authorizationTarget.name}”授权为虚拟人像</h2><p>这是首次合规确认。确认后会记住设置，以后点击卡片即可直接在后台授权，不再重复弹出本窗口。</p><label className="consent-banner"><input type="checkbox" checked={authorizationConsent} onChange={(event) => setAuthorizationConsent(event.target.checked)} /><span><strong>确认原创、合法权利与自动授权</strong>我确认该素材为原创设计的虚拟人像，享有完整合法权利，不与任何自然人的肖像或形象相同或相似，并同意心影《虚拟人像素材合规承诺与授权确认书》。</span></label><div className="modal-actions"><button className="button ghost" onClick={() => setAuthorizationTarget(null)}>取消</button><button className="button primary" disabled={!authorizationConsent} onClick={() => startReferenceAuthorization(authorizationTarget, true)}><UserRoundCheck size={16} />确认并开始后台授权</button></div></section></div>}
    {sharedMediaDeleteTarget && <div className="modal-backdrop"><section className="confirm-modal reference-delete-modal"><div className="modal-icon danger"><Trash2 size={21} /></div><h2>从共享素材库删除“{sharedMediaDeleteTarget.name}”？</h2><p>只删除共享库保存的母版；已经加入各项目的独立参考副本和已排队任务不会受影响。</p><div className="modal-actions"><button type="button" className="button ghost" onClick={() => setSharedMediaDeleteTarget(null)}>取消</button><button type="button" className="button danger" onClick={() => void run(async () => { const id = sharedMediaDeleteTarget.id; await window.xinying.sharedMedia.remove(id); setSharedMedia(await window.xinying.sharedMedia.list()); await reloadRefs(); setSharedMediaDeleteTarget(null); }, "共享素材已删除，项目中的独立副本保持不变")}><Trash2 size={16} />确认删除母版</button></div></section></div>}
    {referenceDeleteTarget && <div className="modal-backdrop"><section className="confirm-modal reference-delete-modal"><div className="modal-icon danger"><Trash2 size={21} /></div><h2>从当前项目删除 {materialLabels[materialOrder.indexOf(referenceMaterialKey(referenceDeleteTarget.id))]}？</h2><div className="reference-delete-summary"><div className="reference-delete-media">{mediaKindFromMime(referenceDeleteTarget.mimeType) === "image" ? <img src={window.xinying.references.mediaUrl(referenceDeleteTarget.filePath)} alt={referenceDeleteTarget.name} /> : mediaKindFromMime(referenceDeleteTarget.mimeType) === "video" ? <video src={window.xinying.references.mediaUrl(referenceDeleteTarget.filePath)} muted /> : <Film size={30} />}</div><div><strong>{referenceDeleteTarget.name}</strong><span>删除后，同类型素材编号会自动前移。</span></div></div><p>只删除 APP 为当前项目保存的这份参考素材，不会删除原始文件，也不会删除已经上传到心影的虚拟人像。</p><div className="modal-actions"><button type="button" className="button ghost" onClick={() => setReferenceDeleteTarget(null)}>取消</button><button type="button" className="button danger" onClick={() => void run(async () => { const id = referenceDeleteTarget.id; await window.xinying.references.remove(id); const nextReferences = await window.xinying.references.list(project.id); setReferences(nextReferences); setDraft((current) => ({ ...current, materialOrder: reconcileMaterialOrder(current.materialOrder?.filter((key) => key !== referenceMaterialKey(id)), current.portraitIds ?? [], nextReferences.map((reference) => reference.id)) })); setReferenceDeleteTarget(null); }, "素材已删除，同类型后续编号已前移")}><Trash2 size={16} />确认删除</button></div></section></div>}
  </div>;
}

function PortraitsPage({ portraits, platformPortraits, projects, selectedProject, workspaceName, onSelectProject, run, onNavigate }: { portraits: PortraitAsset[]; platformPortraits: PlatformPortrait[]; projects: Project[]; selectedProject: Project | null; workspaceName: string; onSelectProject: (id: string) => void; run: (action: () => Promise<unknown>, success?: string) => Promise<void>; onNavigate: (page: PageKey) => void }) {
  const [consent, setConsent] = useState(() => localStorage.getItem("xinying:portrait-compliance-v1") === "confirmed");
  const [portraitQuery, setPortraitQuery] = useState("");
  const [portraitSort, setPortraitSort] = useState<"newest" | "oldest">("newest");
  const [manageMode, setManageMode] = useState(false);
  const [selectedDeleteIds, setSelectedDeleteIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConsent, setDeleteConsent] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<PlatformPortraitDeleteProgress | null>(null);
  const [locallyDeletedIds, setLocallyDeletedIds] = useState<Set<string>>(() => new Set());
  const updateConsent = (confirmed: boolean) => {
    setConsent(confirmed);
    if (confirmed) localStorage.setItem("xinying:portrait-compliance-v1", "confirmed");
    else localStorage.removeItem("xinying:portrait-compliance-v1");
  };
  const availablePlatformPortraits = platformPortraits.filter((portrait) => !locallyDeletedIds.has(portrait.id) && portrait.available && (!selectedProject?.platformWorkspaceId || !portrait.workspaceId || portrait.workspaceId === selectedProject.platformWorkspaceId));
  const normalizedQuery = portraitQuery.trim().toLocaleLowerCase("zh-CN");
  const filteredPlatformPortraits = availablePlatformPortraits.filter((portrait) => !normalizedQuery || portrait.displayName.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  const managedPlatformPortraits = manageMode ? filteredPlatformPortraits.filter((portrait) => portrait.canDelete) : filteredPlatformPortraits;
  const portraitUploadOrder = (portrait: PlatformPortrait) => manageMode ? (portrait.deleteSortOrder ?? portrait.sortOrder) : portrait.sortOrder;
  const visiblePlatformPortraits = [...managedPlatformPortraits]
    .sort((left, right) => portraitSort === "newest" ? portraitUploadOrder(left) - portraitUploadOrder(right) : portraitUploadOrder(right) - portraitUploadOrder(left))
    .slice(0, 120);
  const deletableVisiblePortraits = visiblePlatformPortraits.filter((portrait) => portrait.canDelete);
  const selectedDeletePortraits = availablePlatformPortraits
    .filter((portrait) => selectedDeleteIds.has(portrait.id) && portrait.canDelete)
    .sort((left, right) => portraitSort === "newest" ? (left.deleteSortOrder ?? left.sortOrder) - (right.deleteSortOrder ?? right.sortOrder) : (right.deleteSortOrder ?? right.sortOrder) - (left.deleteSortOrder ?? left.sortOrder));
  const allVisibleSelected = deletableVisiblePortraits.length > 0 && deletableVisiblePortraits.every((portrait) => selectedDeleteIds.has(portrait.id));
  useEffect(() => {
    setManageMode(false);
    setSelectedDeleteIds(new Set());
    setDeleteConfirmOpen(false);
    setDeleteConsent(false);
    setDeleteProgress(null);
    setLocallyDeletedIds(new Set());
  }, [selectedProject?.id, selectedProject?.platformWorkspaceId]);
  useEffect(() => window.xinying.portraits.onDeleteProgress((progress) => {
    setDeleteProgress(progress);
    if (progress.deletedIds.length) {
      setLocallyDeletedIds((current) => new Set([...current, ...progress.deletedIds]));
    }
  }), []);
  useEffect(() => {
    const valid = new Set(availablePlatformPortraits.filter((portrait) => portrait.canDelete).map((portrait) => portrait.id));
    setSelectedDeleteIds((current) => new Set([...current].filter((id) => valid.has(id))));
  }, [platformPortraits, selectedProject?.platformWorkspaceId]);
  const toggleDeleteSelection = (portrait: PlatformPortrait) => {
    if (!portrait.canDelete) return;
    setSelectedDeleteIds((current) => {
      const next = new Set(current);
      if (next.has(portrait.id)) next.delete(portrait.id);
      else next.add(portrait.id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedDeleteIds((current) => {
      const next = new Set(current);
      for (const portrait of deletableVisiblePortraits) {
        if (allVisibleSelected) next.delete(portrait.id);
        else next.add(portrait.id);
      }
      return next;
    });
  };
  const addToCurrentProject = (portrait: PlatformPortrait) => {
    if (!selectedProject) return;
    const ids = selectedProject.portraitIds.includes(portrait.id) ? selectedProject.portraitIds : [...selectedProject.portraitIds, portrait.id];
    const portraitKey = portraitMaterialKey(portrait.id);
    const order = selectedProject.materialOrder.includes(portraitKey) ? selectedProject.materialOrder : [...selectedProject.materialOrder, portraitKey];
    void run(() => window.xinying.projects.update(selectedProject.id, { portraitIds: ids, materialOrder: order }), `“${portrait.displayName}”已加入当前项目参考素材`);
  };
  return <div><div className="page-heading"><div><span className="eyebrow">AUTHORIZED PORTRAITS</span><h1>虚拟人像管理</h1><p>同步当前个人/团队空间的共享角色，或上传新素材并自动完成合规授权。</p></div><div className="heading-actions"><button className="button secondary" disabled={!selectedProject} onClick={() => selectedProject && run(() => window.xinying.portraits.sync(selectedProject.id), "当前空间虚拟人像库已同步")}><RefreshCw size={15} />同步当前空间</button><button className="button primary" disabled={!consent || !selectedProject} onClick={() => run(() => window.xinying.portraits.pickAndAdd(consent), "虚拟人像素材已导入")}><Plus size={16} />导入新素材</button></div></div>
    {deleteProgress && <section className={`portrait-delete-progress progress-${deleteProgress.status}`} role="status" aria-live="polite"><div className="progress-heading"><span>{["queued", "deleting"].includes(deleteProgress.status) ? <RefreshCw size={17} className="spinning" /> : deleteProgress.status === "failed" ? <ShieldAlert size={17} /> : <CheckCircle2 size={17} />}</span><div><strong>{deleteProgress.status === "queued" ? "删除任务已排队" : deleteProgress.status === "deleting" ? "正在从心影删除" : deleteProgress.status === "failed" ? "删除在当前项目停止" : "删除已确认"}</strong><small>{deleteProgress.message}</small></div><b>{deleteProgress.current} / {deleteProgress.total}</b>{!["queued", "deleting"].includes(deleteProgress.status) && <button className="icon-button" title="关闭删除状态" onClick={() => setDeleteProgress(null)}><X size={15} /></button>}</div><div className="progress-track"><i style={{ width: `${deleteProgress.total ? Math.round((deleteProgress.current / deleteProgress.total) * 100) : 0}%` }} /></div></section>}
    <section className="portrait-project-context panel"><div><Building2 size={20} /><span><small>调用目标项目</small><strong>{selectedProject?.name ?? "尚未选择心影项目"}</strong></span></div>{projects.length > 0 && <select value={selectedProject?.id ?? ""} onChange={(event) => onSelectProject(event.target.value)}><option value="" disabled>选择项目</option>{projects.filter((project) => project.platformProjectId && project.platformUrl).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}<button className="button ghost" onClick={() => onNavigate("projects")}><FolderKanban size={15} />切换空间/项目</button></section>
    <label className="consent-banner"><input type="checkbox" checked={consent} onChange={(event) => updateConsent(event.target.checked)} /><span><strong>记住我的合规确认，并在提交时自动勾选心影承诺</strong>我确认素材为我原创设计且享有完整合法权利，不与任何自然人的肖像或形象相同或相似，并同意心影《虚拟人像素材合规承诺与授权确认书》。</span></label>
    <section className="portrait-section">
      <div className="panel-heading compact">
        <div><span className="eyebrow">SYNCED FROM XINYING</span><h2>心影共享库 · {manageMode ? "批量管理" : "可直接调用"}</h2><p>排序使用心影原始上传顺序；进入管理模式后，可选择并永久删除你有权限管理的角色。</p></div>
        <div className="portrait-toolbar">
          <input className="portrait-search" value={portraitQuery} onChange={(event) => setPortraitQuery(event.target.value)} placeholder="搜索全部角色…" />
          <select className="portrait-sort" aria-label="按上传顺序排序" data-testid="portrait-sort" value={portraitSort} onChange={(event) => setPortraitSort(event.target.value as "newest" | "oldest")}>
            <option value="newest">最新上传优先</option>
            <option value="oldest">最早上传优先</option>
          </select>
          <button className={`button ${manageMode ? "ghost" : "secondary"}`} disabled={!selectedProject || !availablePlatformPortraits.length} onClick={() => { setManageMode((current) => !current); setSelectedDeleteIds(new Set()); }}><Settings2 size={15} />{manageMode ? "退出管理" : "批量管理"}</button>
          <span className="library-count">{manageMode ? "可管理" : "显示"} {visiblePlatformPortraits.length} / {manageMode ? managedPlatformPortraits.length : availablePlatformPortraits.length}</span>
        </div>
      </div>
      {manageMode && <div className="portrait-batch-bar" data-testid="portrait-batch-bar"><div><strong>已选择 {selectedDeletePortraits.length} 项</strong><span>当前列表中 {deletableVisiblePortraits.length} 项可删除；无权限的共享角色不会被选中。</span></div><div><button className="button ghost" disabled={!deletableVisiblePortraits.length} onClick={toggleAllVisible}>{allVisibleSelected ? "取消全选当前列表" : "全选当前列表"}</button><button className="button ghost" disabled={!selectedDeletePortraits.length} onClick={() => setSelectedDeleteIds(new Set())}>清空选择</button><button className="button danger" disabled={!selectedDeletePortraits.length} onClick={() => { setDeleteConsent(false); setDeleteConfirmOpen(true); }}><Trash2 size={15} />永久删除 {selectedDeletePortraits.length || ""} 项</button></div></div>}
      <div className="portrait-grid platform-library">
        {visiblePlatformPortraits.map((portrait) => {
          const selected = selectedProject?.portraitIds.includes(portrait.id) ?? false;
          const order = selectedProject?.materialOrder.indexOf(portraitMaterialKey(portrait.id)) ?? -1;
          const selectedForDelete = selectedDeleteIds.has(portrait.id);
          return <article
            className={`portrait-card ${!manageMode && selected ? "selected-library-card" : ""} ${manageMode ? "manage-portrait-card" : ""} ${selectedForDelete ? "selected-delete-card" : ""} ${manageMode && !portrait.canDelete ? "delete-forbidden-card" : ""}`}
            key={portrait.id}
            onClick={manageMode ? () => toggleDeleteSelection(portrait) : undefined}
            onKeyDown={manageMode ? (event) => { if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggleDeleteSelection(portrait); } } : undefined}
            role={manageMode ? "checkbox" : undefined}
            aria-checked={manageMode ? selectedForDelete : undefined}
            aria-disabled={manageMode ? !portrait.canDelete : undefined}
            tabIndex={manageMode && portrait.canDelete ? 0 : undefined}
          >
            <div className="portrait-media"><img loading="lazy" src={portrait.previewUrl} alt={portrait.displayName} />{manageMode && <span className={`portrait-select-indicator ${selectedForDelete ? "checked" : ""}`}>{selectedForDelete ? "✓" : ""}</span>}<span className={`portrait-status ${manageMode && !portrait.canDelete ? "portrait-not-deletable" : "portrait-approved"}`}>{manageMode ? (portrait.canDelete ? "可删除" : "无删除权限") : selected ? (order >= 0 ? `已加入 · ${portrait.mediaKind === "video" ? "视频" : portrait.mediaKind === "unknown" ? "待校验" : "图片"}` : "已加入") : portrait.mediaKind === "video" ? "视频角色" : "已授权"}</span></div>
            <div className="portrait-body"><strong>{portrait.displayName}</strong><span>{workspaceName} · {manageMode ? "可管理上传顺序" : "心影库顺序"}：最新第 {portraitUploadOrder(portrait) + 1}</span>{!manageMode && <button className="button secondary full" disabled={!selectedProject || selected} onClick={() => addToCurrentProject(portrait)}>{selected ? "已加入当前项目参考素材" : "加入当前项目"}</button>}{manageMode && <span className={portrait.canDelete ? "delete-capability" : "delete-capability unavailable"}>{portrait.canDelete ? (selectedForDelete ? "已加入删除清单" : "点击卡片加入删除清单") : "心影未授予当前账号删除权限"}</span>}</div>
          </article>;
        })}
        {!selectedProject && <EmptyState title="请先选择调用项目" description="不同空间的虚拟人像可见范围不同，先选择项目才能准确读取并调用。" action={<button className="button primary" onClick={() => onNavigate("projects")}><Building2 size={16} />选择空间和项目</button>} />}
        {selectedProject && !availablePlatformPortraits.length && <EmptyState title="尚未同步当前空间角色" description="点击“同步当前空间”，读取你或同事已经授权的虚拟人像。" />}
        {availablePlatformPortraits.length > 0 && !visiblePlatformPortraits.length && <EmptyState title={manageMode ? "没有可删除的匹配角色" : "没有匹配角色"} description={manageMode ? "当前筛选结果中没有心影授予本账号删除权限的角色。" : "换一个名称关键词继续搜索。"} />}
      </div>
    </section>
    <section className="portrait-section"><div className="panel-heading compact"><div><span className="eyebrow">LOCAL UPLOADS</span><h2>本地待上传 / 审核</h2><p>名称自动取文件名，性别、年龄、人种默认“其他”；提交到当前项目所属空间并自动勾选承诺。</p></div></div><div className="portrait-grid">{portraits.map((portrait) => { const active = ["queued", "reviewing", "needs-human"].includes(portrait.platformStatus); const scope = portrait.applicationScope === "domestic" ? "国内版" : portrait.applicationScope === "overseas" ? "海外版" : "国内版 + 海外版"; return <article className="portrait-card" key={portrait.id}><div className="portrait-media">{portrait.mimeType.startsWith("video") ? <video src={window.xinying.references.mediaUrl(portrait.filePath)} /> : <img src={window.xinying.references.mediaUrl(portrait.filePath)} alt={portrait.displayName} />}<span className={`portrait-status portrait-${portrait.platformStatus}`}>{portrait.platformStatus}</span></div><div className="portrait-body"><strong>{portrait.displayName}</strong><span>{portrait.gender} · {portrait.ageGroup} · {portrait.ethnicity} · {scope}</span><span>{portrait.consentConfirmed ? "已记录合规确认" : "未确认合规承诺"}</span>{portrait.reviewNote && <p>{portrait.reviewNote}</p>}<div className="card-actions"><button className="button secondary" disabled={!selectedProject || !portrait.consentConfirmed || active || portrait.platformStatus === "approved"} onClick={() => selectedProject && run(() => window.xinying.portraits.submitReview(portrait.id, selectedProject.id), "上传审核任务已加入队列")}><UserRoundCheck size={15} />自动上传并授权</button><button className="icon-button danger" disabled={active} title={active ? "请先完成或取消关联审核任务" : "删除本地素材"} onClick={() => confirm("删除本地虚拟人像素材？") && run(() => window.xinying.portraits.remove(portrait.id), "素材已删除")}><Trash2 size={15} /></button></div></div></article>; })}{!portraits.length && <EmptyState title="暂无本地待上传素材" description="选择心影项目并确认合规声明后，可从这里上传图片或视频并自动授权。" />}</div></section>
    {deleteConfirmOpen && <div className="modal-backdrop"><section className="confirm-modal portrait-delete-modal"><div className="modal-icon danger-modal-icon"><Trash2 size={21} /></div><h2>永久删除 {selectedDeletePortraits.length} 个心影虚拟人像？</h2><p>目标空间：{workspaceName} · 调用项目：{selectedProject?.name ?? "未选择"}</p><div className="warning-box"><span><ShieldAlert size={14} />删除后不可恢复；这些角色会从心影个人或团队共享库中消失，并自动从本 APP 的相关项目参考素材中移除。</span></div><div className="portrait-delete-list">{selectedDeletePortraits.slice(0, 30).map((portrait, index) => <span key={portrait.id}><b>{index + 1}</b>{portrait.displayName}<small>可管理上传最新第 {(portrait.deleteSortOrder ?? portrait.sortOrder) + 1}</small></span>)}{selectedDeletePortraits.length > 30 && <em>另有 {selectedDeletePortraits.length - 30} 项，将按上方选择清单一并删除</em>}</div><label className="delete-confirm-check"><input type="checkbox" checked={deleteConsent} onChange={(event) => setDeleteConsent(event.target.checked)} /><span><strong>我确认永久删除以上虚拟人像</strong>此操作会真实修改心影共享库，无法撤销。</span></label><div className="modal-actions"><button className="button ghost" onClick={() => { setDeleteConfirmOpen(false); setDeleteConsent(false); }}>取消</button><button className="button danger" disabled={!deleteConsent || !selectedProject || !selectedDeletePortraits.length} onClick={() => { if (!selectedProject) return; const ids = selectedDeletePortraits.map((portrait) => portrait.id); setDeleteProgress({ status: "queued", requestedIds: ids, deletedIds: [], currentId: null, currentName: null, current: 0, total: ids.length, message: `已提交，等待删除 ${ids.length} 个虚拟人像` }); setDeleteConfirmOpen(false); setDeleteConsent(false); void run(async () => { await window.xinying.portraits.deletePlatform(selectedProject.id, ids); setSelectedDeleteIds(new Set()); setManageMode(false); }, `已从心影永久删除 ${ids.length} 个虚拟人像`); }}><Trash2 size={15} />确认永久删除</button></div></section></div>}
  </div>;
}

function JobsPage({ jobs, projects, portraits, run }: { jobs: Job[]; projects: Project[]; portraits: PortraitAsset[]; run: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [detail, setDetail] = useState<{ job: Job; events: JobEvent[] } | null>(null);
  return <div><div className="page-heading"><div><span className="eyebrow">ASYNCHRONOUS LEDGER</span><h1>任务队列</h1><p>完整保留提交、运行、人工接管、失败与结果状态。</p></div></div><section className="panel table-panel"><table><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>平台编号</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{jobs.map((job) => { const displayName = job.kind === "generation" ? projects.find((project) => project.id === job.projectId)?.name ?? "已删除项目" : portraits.find((portrait) => portrait.id === job.portraitId)?.name ?? "已删除人像素材"; const resumeMessage = job.platformTaskId?.startsWith("pending-chat:") || job.errorCode === "APP_RESTART_DURING_SUBMIT" ? "该任务曾在生成提交阶段中断。请先在原网页确认没有对应的新对话；确认后恢复才可能再次点击生成，是否继续？" : "请确认已经在原网页完成登录、合规、付费或页面检查等人工步骤。现在恢复任务？"; return <tr key={job.id}><td><strong>{displayName}</strong><span>任务 {job.id.slice(0, 8)}</span></td><td>{job.kind === "generation" ? "视频生成" : "人像审核"}</td><td><StatusPill status={job.status} />{job.requiresHumanReason && <small className="human-reason">{job.requiresHumanReason}</small>}</td><td className="task-id-cell">{job.platformTaskId ?? "—"}</td><td>{formatDate(job.updatedAt)}</td><td><div className="table-actions"><button className="icon-button" title="查看任务详情与事件" onClick={() => void run(async () => setDetail({ job, events: await window.xinying.jobs.events(job.id) }))}><ListTree size={15} /></button>{job.status === "completed" && job.kind === "generation" && <button className="icon-button" title="下载" onClick={() => run(() => window.xinying.jobs.download(job.id), "结果已保存")}><Download size={15} /></button>}{["needs-human", "needs-login", "failed"].includes(job.status) && <button className="icon-button" title="人工处理完成后恢复" onClick={() => confirm(resumeMessage) && void run(() => window.xinying.jobs.resume(job.id), "任务已恢复")}><RefreshCw size={15} /></button>}{["queued", "needs-human", "needs-login"].includes(job.status) && <button className="icon-button danger" title="取消" onClick={() => confirm("取消这项任务？") && run(() => window.xinying.jobs.cancel(job.id), "任务已取消")}><Trash2 size={15} /></button>}</div></td></tr>; })}</tbody></table>{!jobs.length && <EmptyState title="暂无任务" description="从生成工作台提交任务后，会出现在这里。" />}</section>
    {detail && <div className="modal-backdrop"><section className="confirm-modal job-detail-modal"><div className="panel-heading compact"><div><span className="eyebrow">TASK AUDIT</span><h2>任务详情</h2></div><StatusPill status={detail.job.status} /></div><dl className="job-facts"><div><dt>本地任务 ID</dt><dd>{detail.job.id}</dd></div><div><dt>心影定位</dt><dd>{detail.job.platformTaskId ?? "尚未生成"}</dd></div><div><dt>创建 / 更新</dt><dd>{formatDate(detail.job.createdAt)} / {formatDate(detail.job.updatedAt)}</dd></div>{detail.job.errorMessage && <div><dt>错误</dt><dd className="danger-text">{detail.job.errorCode} · {detail.job.errorMessage}</dd></div>}{detail.job.requiresHumanReason && <div><dt>人工处理</dt><dd className="warning-text">{detail.job.requiresHumanReason}</dd></div>}</dl>{detail.job.kind === "generation" && <><h3 className="detail-section-title">提交快照</h3><div className="snapshot-box"><span>{detail.job.promptSnapshot || "无提示词"}</span>{Object.entries(detail.job.parameters).map(([key, value]) => <small key={key}>{key}: {String(value)}</small>)}{detail.job.references.map((reference, index) => <small key={reference.id}>@图{index + 1} · {reference.role} · {reference.name}</small>)}</div></>}<h3 className="detail-section-title">事件记录</h3><div className="event-list">{detail.events.map((event) => <div key={event.id}><span>{formatDate(event.createdAt)}</span><strong>{event.code}</strong><p>{event.message}</p></div>)}{!detail.events.length && <span className="muted-text">暂无事件</span>}</div><div className="modal-actions"><button className="button primary" onClick={() => setDetail(null)}>关闭</button></div></section></div>}
  </div>;
}

function ResultsPage({ results, projects, selectedProject, onSelectProject, run }: { results: PlatformResult[]; projects: Project[]; selectedProject: Project | null; onSelectProject: (id: string) => void; run: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [source, setSource] = useState<PlatformResultSource>("personal");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [lastViewedId, setLastViewedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(120);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const projectResults = results.filter((result) => !selectedProject || result.projectId === selectedProject.id);
  const currentResults = projectResults.filter((result) => result.source === source);
  const visibleResults = currentResults.slice(0, visibleLimit);
  const sourceCounts = {
    personal: projectResults.filter((result) => result.source === "personal").length,
    project: projectResults.filter((result) => result.source === "project").length,
  };
  const viewerIndex = currentResults.findIndex((result) => result.id === viewerId);
  const viewer = viewerIndex >= 0 ? currentResults[viewerIndex] : null;
  const selected = currentResults.filter((result) => selectedIds.has(result.id));
  const allSelected = currentResults.length > 0 && currentResults.every((result) => selectedIds.has(result.id));

  useEffect(() => {
    setSelectedIds(new Set());
    setViewerId(null);
    setLastViewedId(null);
    setVisibleLimit(120);
  }, [selectedProject?.id, source]);

  const moveViewer = useCallback((offset: number) => {
    if (!currentResults.length || viewerIndex < 0) return;
    const next = (viewerIndex + offset + currentResults.length) % currentResults.length;
    setViewerId(currentResults[next].id);
  }, [currentResults, viewerIndex]);

  const closeViewer = useCallback(() => {
    if (!viewerId) return;
    const id = viewerId;
    setLastViewedId(id);
    setViewerId(null);
    window.setTimeout(() => cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 40);
  }, [viewerId]);

  useEffect(() => {
    if (!viewer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeViewer();
      if (event.key === "ArrowLeft") moveViewer(-1);
      if (event.key === "ArrowRight") moveViewer(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewer, closeViewer, moveViewer]);

  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const mediaUrl = (result: PlatformResult) => result.outputPath ? window.xinying.references.mediaUrl(result.outputPath) : result.outputUrl;
  const posterUrl = (result: PlatformResult) => result.previewUrl ?? undefined;

  const tabText = source === "personal" ? "我的生成" : "项目素材库（全员）";
  const syncSuccess = source === "personal" ? "我的生成已同步" : "项目全员图片与视频已同步";

  return <div className="results-page">
    <div className="page-heading">
      <div><span className="eyebrow">OUTPUT LIBRARY</span><h1>结果库</h1><p>分别查看个人账号生成记录与心影项目素材库；横屏、竖屏图片和视频均完整显示。</p></div>
      <div className="heading-actions">
        {projects.length > 0 && <select value={selectedProject?.id ?? ""} onChange={(event) => onSelectProject(event.target.value)}>{projects.filter((project) => project.platformProjectId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}
        <button className="button primary" disabled={!selectedProject} onClick={() => selectedProject && run(() => window.xinying.results.sync(selectedProject.id, source), syncSuccess)}><RefreshCw size={16} />同步{tabText}</button>
      </div>
    </div>
    <div className="result-source-tabs" role="tablist" aria-label="结果来源">
      <button role="tab" aria-selected={source === "personal"} className={source === "personal" ? "active" : ""} onClick={() => setSource("personal")}><CircleUserRound size={17} /><span>我的生成</span><strong>{sourceCounts.personal}</strong></button>
      <button role="tab" aria-selected={source === "project"} className={source === "project" ? "active" : ""} onClick={() => setSource("project")}><UsersRound size={17} /><span>项目素材库（全员）</span><strong>{sourceCounts.project}</strong></button>
    </div>
    <p className="result-source-note">{source === "personal" ? "读取当前登录账号在这个项目中的生成会话。" : "读取心影网页“素材库”中当前项目所有成员可见的图片与视频。"}</p>
    {currentResults.length > 0 && <section className="result-batch-bar panel">
      <div><button className="button ghost" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(currentResults.map((result) => result.id)))}>{allSelected ? <CheckSquare2 size={16} /> : <Square size={16} />}{allSelected ? "取消全选" : "全选"}</button><strong>已选择 {selected.length} / {currentResults.length}</strong></div>
      <div><button className="button ghost" disabled={!selected.length} onClick={() => run(() => window.xinying.results.mark(selected.map((result) => result.id), true), `已标记 ${selected.length} 个素材`)}><CheckCircle2 size={16} />标记</button><button className="button ghost" disabled={!selected.length} onClick={() => run(() => window.xinying.results.mark(selected.map((result) => result.id), false), `已取消 ${selected.length} 个标记`)}>取消标记</button><button className="button secondary" disabled={!selected.length} onClick={() => run(() => window.xinying.results.batchDownload(selected.map((result) => result.id)), `已保存 ${selected.length} 个素材`)}><Download size={16} />批量下载</button></div>
    </section>}
    <div className="result-grid">{visibleResults.map((result) => {
      const preview = mediaUrl(result);
      const projectName = projects.find((project) => project.id === result.projectId)?.name ?? "心影项目";
      const checked = selectedIds.has(result.id);
      return <article ref={(node) => { if (node) cardRefs.current.set(result.id, node); else cardRefs.current.delete(result.id); }} className={`result-card ${lastViewedId === result.id ? "last-viewed" : ""} ${checked ? "selected-result" : ""}`} key={result.id} onClick={() => setViewerId(result.id)}>
        <button className={`result-select ${checked ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); toggleSelected(result.id); }} aria-label={checked ? "取消选择" : "选择素材"}>{checked ? <CheckSquare2 size={19} /> : <Square size={19} />}</button>
        {result.marked && <span className="result-mark">已标记</span>}
        <span className={`result-kind result-kind-${result.mediaKind}`}>{result.mediaKind === "image" ? <ImageIcon size={12} /> : <Video size={12} />}{result.mediaKind === "image" ? "图片" : "视频"}</span>
        <div className="result-preview">{result.mediaKind === "image" && preview ? <img src={preview} alt={result.name || "心影图片素材"} /> : result.mediaKind === "video" && result.previewUrl ? <img src={result.previewUrl} alt={result.name || "心影视频封面"} /> : result.mediaKind === "video" && preview ? <video src={preview} muted preload="metadata" /> : <div>{result.mediaKind === "image" ? <ImageIcon size={32} /> : <Film size={32} />}<span>暂无预览</span></div>}{result.mediaKind === "video" && <span className="result-play">▶</span>}</div>
        <div className="result-body"><div><strong>{projectName}</strong><span>{formatDate(result.createdAt)}</span></div><p title={result.name}>{result.name || result.prompt || "心影历史素材"}</p><button className="button secondary full" onClick={(event) => { event.stopPropagation(); void run(() => window.xinying.results.download(result.id), "素材已保存"); }}><Download size={16} />下载</button></div>
      </article>;
    })}{!currentResults.length && <EmptyState title={selectedProject ? `${tabText}还没有同步素材` : "请先选择项目"} description={selectedProject ? `点击“同步${tabText}”，APP 会读取对应的心影素材。` : "选择一个已绑定的心影项目后同步。"} />}</div>
    {visibleResults.length < currentResults.length && <div className="result-load-more"><span>已显示 {visibleResults.length} / {currentResults.length}</span><button className="button secondary" onClick={() => setVisibleLimit((current) => current + 120)}>继续加载 120 个</button></div>}
    {viewer && <div className="modal-backdrop result-viewer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) closeViewer(); }}><section className="result-viewer">
      <header><div><strong>{viewer.name || projects.find((project) => project.id === viewer.projectId)?.name || "心影素材"}</strong><span>{viewerIndex + 1} / {currentResults.length} · {formatDate(viewer.createdAt)}</span></div><div><button className="button secondary" onClick={() => run(() => window.xinying.results.download(viewer.id), "素材已保存")}><Download size={16} />下载当前{viewer.mediaKind === "image" ? "图片" : "视频"}</button><button className="icon-button" onClick={closeViewer} title="关闭"><X size={19} /></button></div></header>
      <div className="result-viewer-stage"><button className="viewer-nav previous" onClick={() => moveViewer(-1)} title="上一个"><ChevronLeft size={30} /></button>{mediaUrl(viewer) ? viewer.mediaKind === "image" ? <img key={viewer.id} src={mediaUrl(viewer)!} alt={viewer.name || "心影图片素材"} /> : <video key={viewer.id} src={mediaUrl(viewer)!} poster={posterUrl(viewer)} controls autoPlay /> : <div className="viewer-missing"><Film size={42} /><span>请重新同步后查看</span></div>}<button className="viewer-nav next" onClick={() => moveViewer(1)} title="下一个"><ChevronRightIcon size={30} /></button></div>
      <footer><p>{viewer.prompt || viewer.name || "无提示词记录"}</p><span>{viewer.marked ? "已标记" : "未标记"}</span></footer>
    </section></div>}
  </div>;
}
