// Row → DTO mapping. This is the only place rows leave the Worker, so it is also where secrets
// (encrypted webhook URL, interaction tokens) are guaranteed not to be copied out.
import {
  FAULT_NAMES,
  type EventDTO,
  type EventKind,
  type EventLevel,
  type Faults,
  type GuildSettingsDTO,
  type GuildSummaryDTO,
  type JobDTO,
  type JobStatus,
  type JobType,
  type ReportDTO,
} from "../../shared/types";
import type { EventRow, GuildRow, JobRow, ReportRow } from "../db/rows";
import { parseJson } from "../db/rows";
import { parseFaults } from "../db/queries";

export function iconUrl(guildId: string, icon: string | null): string | null {
  return icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=96` : null;
}

export function toGuildSummary(g: { id: string; name: string; icon: string | null }): GuildSummaryDTO {
  return { id: g.id, name: g.name || `Server ${g.id}`, iconUrl: iconUrl(g.id, g.icon) };
}

export function activeFaults(faults: Faults, now: number): Faults {
  const active: Faults = {};
  for (const name of FAULT_NAMES) {
    const until = faults[name];
    if (typeof until === "number" && until > now) active[name] = until;
  }
  return active;
}

export function toGuildSettings(g: GuildRow, aiAvailable: boolean, now: number): GuildSettingsDTO {
  return {
    ...toGuildSummary(g),
    postChannelId: g.post_channel_id,
    alertRoleId: g.alert_role_id,
    mirror: { configured: Boolean(g.mirror_url_enc), kind: g.mirror_kind, hint: g.mirror_hint },
    moderatorsOnly: g.moderators_only === 1,
    aiEnabled: g.ai_enabled === 1,
    aiAvailable,
    faults: activeFaults(parseFaults(g.faults), now),
    connectedAt: g.connected_at,
  };
}

export function toEventDTO(e: EventRow): EventDTO {
  return {
    id: e.id,
    kind: e.kind as EventKind,
    name: e.name,
    level: e.level as EventLevel,
    message: e.message,
    reportId: e.report_id,
    interactionId: e.interaction_id,
    jobId: e.job_id,
    data: parseJson<Record<string, unknown> | null>(e.data, null),
    createdAt: e.created_at,
  };
}

export function toJobDTO(j: JobRow): JobDTO {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    runAfter: j.run_after,
    lastError: j.last_error,
    reportId: j.report_id,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    finishedAt: j.finished_at,
  };
}

/** The pipeline step a job id represents for its report (status-change mirrors excluded). */
export function stepOf(jobId: string): JobType | null {
  const m = /^(triage|reply|post|enrich):\d+$/.exec(jobId) ?? /^(mirror):report:\d+$/.exec(jobId);
  return (m?.[1] as JobType | undefined) ?? null;
}

export function toReportDTO(r: ReportRow, steps: Partial<Record<JobType, JobStatus>> = {}): ReportDTO {
  return {
    id: r.id,
    status: r.status,
    priority: r.priority,
    prioritySource: r.priority_source,
    ruleName: r.rule_name,
    matchedKeyword: r.matched_keyword,
    title: r.title,
    body: r.body,
    userId: r.user_id,
    userName: r.user_name,
    ai: {
      status: r.ai_status,
      summary: r.ai_summary,
      category: r.ai_category,
      severity: r.ai_severity,
      tags: parseJson<string[]>(r.ai_tags, []),
      error: r.ai_error,
    },
    postedMessageUrl:
      r.posted_channel_id && r.posted_message_id
        ? `https://discord.com/channels/${r.guild_id}/${r.posted_channel_id}/${r.posted_message_id}`
        : null,
    ackedBy: r.acked_by,
    ackedAt: r.acked_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    steps,
  };
}
