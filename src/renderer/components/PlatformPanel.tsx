import { useEffect, useRef } from "react";
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";

export function PlatformPanel() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.xinying.session.showPlatform();
    void window.xinying.platformView.setVisible(true);
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
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      void window.xinying.platformView.setVisible(false);
    };
  }, []);

  return (
    <div className="platform-page">
      <div className="platform-toolbar">
        <div>
          <span className="eyebrow">OFFICIAL WEB FALLBACK</span>
          <h1>心影原网页兼容模式</h1>
        </div>
        <div className="toolbar-note"><ShieldCheck size={15} />使用独立持久登录会话</div>
        <button className="button ghost" onClick={() => window.xinying.session.reloadPlatform()}><RefreshCw size={16} />刷新</button>
      </div>
      <div className="platform-container" ref={containerRef}>
        <div className="platform-placeholder"><ExternalLink size={28} /><span>正在加载心影官方页面…</span></div>
      </div>
    </div>
  );
}

