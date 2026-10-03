import type { EventKind, JobStatus, JobType, Priority, ReportStatus } from "../../shared/types";

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  let text: string;
  if (s < 5) return diff > 0 ? "now" : "just now";
  if (s < 60) text = `${s}s`;
  else if (s < 3600) text = `${Math.round(s / 60)}m`;
  else if (s < 86_400) text = `${Math.round(s / 3600)}h`;
  else text = `${Math.round(s / 86_400)}d`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** When a retrying job runs next ("in 40s"), or "due now" once the cron tick is pending. */
export function nextAttempt(runAfter: number, now = Date.now()): string {
  return runAfter <= now ? "due now" : `next ${relativeTime(runAfter, now)}`;
}

export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function countdown(untilMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((untilMs - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const compact = (n: number) => (n < 10_000 ? n.toLocaleString() : compactFormat.format(n));

// Status colors are only ever shown beside their label (never color alone).
export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  critical: { label: "Critical", color: "var(--critical)" },
  high: { label: "High", color: "var(--serious)" },
  normal: { label: "Normal", color: "var(--info)" },
  low: { label: "Low", color: "var(--neutral-dot)" },
};

export const REPORT_STATUS_META: Record<ReportStatus, { label: string; color: string }> = {
  open: { label: "Open", color: "var(--info)" },
  acknowledged: { label: "Acknowledged", color: "var(--warning)" },
  resolved: { label: "Resolved", color: "var(--good)" },
};

export const JOB_STATUS_META: Record<JobStatus, { label: string; color: string }> = {
  pending: { label: "Pending", color: "var(--info)" },
  running: { label: "Running", color: "var(--info)" },
  retrying: { label: "Retrying", color: "var(--warning)" },
  succeeded: { label: "Delivered", color: "var(--good)" },
  dead: { label: "Failed", color: "var(--critical)" },
};

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  triage: "Triage",
  reply: "Reply",
  post: "Channel post",
  mirror: "Mirror",
  enrich: "AI retry",
};

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  command: "Command",
  action: "Action",
  job: "Delivery",
  config: "Config",
  security: "Security",
};

export const SECURITY_REASONS: Record<string, string> = {
  bad_signature: "Invalid Ed25519 signature (forged or tampered request)",
  stale_timestamp: "Valid signature, but older than 5 minutes (replay)",
  missing_headers: "No signature headers at all",
  malformed_headers: "Malformed signature or timestamp header",
  body_too_large: "Body larger than 256 KB",
  malformed_body: "Signed body that isn't an interaction",
  duplicate_interaction: "Same interaction delivered again (ignored, no side effects)",
};
