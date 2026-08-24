import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { InteractionGate, userFacingError } from "../interaction";

export function PlatformPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const refreshGateRef = useRef(new InteractionGate());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void window.xinying.session.showPlatform().catch((cause) => {
      if (active) setError(userFacingError(cause));
    });
    const updateBounds = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      void window.xinying.platformView.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(updateBounds);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", updateBounds);
    updateBounds();
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      void window.xinying.platformView.setVisible(false);
    };
  }, []);

  const refresh = async () => {
    if (!refreshGateRef.current.tryEnter()) return;
    setRefreshing(true);
    setError("");
    try {
      await window.xinying.session.reloadPlatform();
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      refreshGateRef.current.leave();
      setRefreshing(false);
    }
  };

  return (
    <div className="platform-page">
      <div className="platform-toolbar">
        <div>
          <span className="eyebrow">OFFICIAL WEB FALLBACK</span>
          <h1>心影原网页兼容模式</h1>
        </div>
        <div className="toolbar-note"><ShieldCheck size={15} />使用独立持久登录会话</div>
        <button className="button ghost" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? "spinning" : ""} />{refreshing ? "刷新中…" : "刷新"}</button>
      </div>
      {error && <div className="platform-inline-error" role="alert">{error}</div>}
      <div className="platform-container" ref={containerRef}>
        <div className="platform-placeholder"><ExternalLink size={28} /><span>正在加载心影官方页面…</span></div>
      </div>
    </div>
  );
}
