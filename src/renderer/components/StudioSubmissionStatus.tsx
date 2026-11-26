import { ChevronRight } from "lucide-react";
import type { Job } from "../../shared/contracts";

type SubmissionStatus = Pick<Job, "status" | "requiresHumanReason" | "errorMessage" | "progressLabel">;

export function StudioSubmissionStatus({ job, label, onDetails }: {
  job: SubmissionStatus; label: string; onDetails: () => void;
}) {
  if (["completed", "cancelled"].includes(job.status)) return null;
  const message = job.requiresHumanReason || job.errorMessage || job.progressLabel || "任务已进入本地队列，等待心影确认";
  const description = `${label} · ${message}`;
  return <span className="studio-submission-status" role="status" aria-live="polite" aria-atomic="true">
    <button type="button" className="studio-status-link" data-attention={["failed", "needs-login", "needs-human"].includes(job.status)} title={`${description}；点击查看任务详情`} aria-label={`查看任务详情：${description}`} onClick={onDetails}>
      <span className="studio-submission-label">{label}</span><span aria-hidden="true">·</span>
      <span className="studio-submission-message">{message}</span><ChevronRight size={12} aria-hidden="true" />
    </button>
  </span>;
}
