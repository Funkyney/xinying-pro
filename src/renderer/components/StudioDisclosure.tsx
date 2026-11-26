import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function useStudioDisclosure(name: string) {
  const key = `xinying:studio-disclosure:v1:${name}`;
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(key) === "open"; } catch { return false; }
  });
  return [expanded, (next: boolean) => {
    setExpanded(next);
    try { localStorage.setItem(key, next ? "open" : "closed"); } catch { /* Layout preferences are optional. */ }
  }] as const;
}

export function StudioDisclosure({ title, summary, expanded, onExpandedChange, actions, className = "", children }: {
  title: string; summary?: string; expanded: boolean; onExpandedChange: (next: boolean) => void;
  actions?: ReactNode; className?: string; children: ReactNode;
}) {
  const contentId = useId();
  return <section className={`studio-disclosure ${className}`} aria-label={title} data-expanded={expanded}>
    <header className="studio-disclosure-heading">
      <h2 aria-label={title}><button type="button" className="studio-disclosure-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => onExpandedChange(!expanded)}>
        <ChevronRight size={16} aria-hidden="true" /><span>{title}</span><small>{expanded ? "收起" : "展开"}</small>
      </button></h2>
      {summary && <span className="studio-disclosure-summary">{summary}</span>}
      {expanded && actions && <div className="studio-disclosure-actions">{actions}</div>}
    </header>
    <div id={contentId} className="studio-disclosure-body" hidden={!expanded}>{expanded ? children : null}</div>
  </section>;
}
