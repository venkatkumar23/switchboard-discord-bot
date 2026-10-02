// Row shapes as stored in D1 (snake_case, integers for booleans, epoch-ms timestamps).
import type { AiStatus, JobStatus, JobType, Priority, ReportStatus } from "../../shared/types";

export interface GuildRow {
  id: string;
  name: string;
  icon: string | null;
  post_channel_id: string | null;
  alert_role_id: string | null;
  mirror_url_enc: string | null;
  mirror_kind: "slack" | "discord" | null;
  mirror_hint: string | null;
  moderators_only: number;
  ai_enabled: number;
  faults: string;
  connected_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CommandConfigRow {
  guild_id: string;
  command: string;
  enabled: number;
  ephemeral: number;
  post_to_channel: number;
  mirror: number;
  cooldown_seconds: number;
  updated_at: number;
}

export interface RuleRow {
  id: number;
  guild_id: string;
  name: string;
  keywords: string;
  priority: Priority;
  mention_role: number;
  enabled: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface ReportRow {
  id: number;
  guild_id: string;
  interaction_id: string;
  source_channel_id: string | null;
  user_id: string;
  user_name: string;
  title: string | null;
  body: string;
  status: ReportStatus;
  priority: Priority | null;
  priority_source: "rule" | "ai" | "default" | null;
  rule_id: number | null;
  rule_name: string | null;
  matched_keyword: string | null;
  mention_role: number;
  ai_status: AiStatus;
  ai_summary: string | null;
  ai_category: string | null;
  ai_severity: Priority | null;
  ai_tags: string | null;
  ai_error: string | null;
  posted_channel_id: string | null;
  posted_message_id: string | null;
  acked_by: string | null;
  acked_at: number | null;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: string;
  guild_id: string | null;
  report_id: number | null;
  interaction_id: string | null;
  type: JobType;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: number;
  locked_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface EventRow {
  id: number;
  guild_id: string | null;
  interaction_id: string | null;
  report_id: number | null;
  job_id: string | null;
  kind: string;
  name: string;
  level: string;
  message: string;
  data: string | null;
  created_at: number;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
