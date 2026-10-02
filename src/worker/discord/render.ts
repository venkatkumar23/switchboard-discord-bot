// Builds every message the bot sends. All payloads set allowed_mentions explicitly: user text
// can contain "@everyone" or role mentions, and only the configured alert role may ever ping.
import type { Priority, ReportStatus } from "../../shared/types";
import { parseJson } from "../db/rows";
import type { ReportRow } from "../db/rows";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  ResponseType,
  TextInputStyle,
  type AllowedMentions,
  type Embed,
  type InteractionResponse,
  type MessagePayload,
  type SubmittedComponent,
} from "./types";

export const NO_MENTIONS: AllowedMentions = { parse: [] };

export const PRIORITY_STYLE: Record<Priority, { label: string; emoji: string; color: number }> = {
  low: { label: "Low", emoji: "🟢", color: 0x57f287 },
  normal: { label: "Normal", emoji: "🔵", color: 0x5865f2 },
  high: { label: "High", emoji: "🟠", color: 0xf0b232 },
  critical: { label: "Critical", emoji: "🔴", color: 0xed4245 },
};

export const STATUS_STYLE: Record<ReportStatus, { label: string; emoji: string }> = {
  open: { label: "Open", emoji: "📬" },
  acknowledged: { label: "Acknowledged", emoji: "👀" },
  resolved: { label: "Resolved", emoji: "✅" },
};

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** For names we interpolate into markdown (user text bodies keep their formatting). */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>#\-[\]()])/g, "\\$1");
}

const relative = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

export function priorityLine(r: ReportRow): string {
  if (!r.priority) return "⏳ Triage pending";
  const p = PRIORITY_STYLE[r.priority];
  let why = "";
  if (r.priority_source === "rule" && r.rule_name) {
    why = ` — rule “${escapeMarkdown(r.rule_name)}” (matched “${escapeMarkdown(r.matched_keyword ?? "")}”)`;
  } else if (r.priority_source === "ai") {
    why = " — escalated by AI triage";
  }
  return `${p.emoji} **${p.label}**${why}`;
}

function statusLine(r: ReportRow): string {
  const s = STATUS_STYLE[r.status];
  if (r.status === "resolved" && r.resolved_by && r.resolved_at) {
    return `${s.emoji} ${s.label} by ${escapeMarkdown(r.resolved_by)} ${relative(r.resolved_at)}`;
  }
  if (r.status === "acknowledged" && r.acked_by && r.acked_at) {
    return `${s.emoji} ${s.label} by ${escapeMarkdown(r.acked_by)} ${relative(r.acked_at)}`;
  }
  return `${s.emoji} ${s.label}`;
}

function aiField(r: ReportRow): Embed["fields"] {
  if (r.ai_status === "done" && r.ai_summary) {
    const tags = parseJson<string[]>(r.ai_tags, []);
    const meta = [r.ai_category, r.ai_severity, ...tags.map((t) => `#${t}`)].filter(Boolean).join(" · ");
    return [{ name: "🤖 AI triage", value: truncate(`${r.ai_summary}\n*${meta}*`, 1024) }];
  }
  if (r.ai_status === "failed") {
    return [{ name: "🤖 AI triage", value: "Unavailable right now — classified by keyword rules; retrying in the background." }];
  }
  return [];
}

export function reportButtons(r: ReportRow): unknown[] {
  const button = (action: string, label: string, style: number) => ({
    type: ComponentType.BUTTON,
    custom_id: `rpt:${action}:${r.id}`,
    label,
    style,
  });
  const buttons =
    r.status === "open"
      ? [button("ack", "Acknowledge", ButtonStyle.PRIMARY), button("resolve", "Resolve", ButtonStyle.SUCCESS)]
      : r.status === "acknowledged"
        ? [button("resolve", "Resolve", ButtonStyle.SUCCESS)]
        : [button("reopen", "Reopen", ButtonStyle.SECONDARY)];
  return [{ type: ComponentType.ACTION_ROW, components: buttons }];
}

/** The report as posted to the moderators' channel, with Acknowledge/Resolve buttons. */
export function renderReportMessage(r: ReportRow, alertRoleId: string | null): MessagePayload {
  const style = r.priority ? PRIORITY_STYLE[r.priority] : null;
  const pingRole = alertRoleId && r.mention_role === 1 ? alertRoleId : null;
  return {
    content: pingRole ? `<@&${pingRole}> ${style?.emoji ?? ""} new **${style?.label ?? ""}** priority report` : "",
    embeds: [
      {
        title: truncate(`${style?.emoji ?? "📝"} Report #${r.id}${r.title ? ` — ${r.title}` : ""}`, 256),
        description: truncate(r.body, 3000),
        color: r.status === "resolved" ? 0x80848e : (style?.color ?? 0x5865f2),
        fields: [
          { name: "Priority", value: priorityLine(r) },
          { name: "Status", value: statusLine(r), inline: true },
          { name: "Reporter", value: `<@${r.user_id}>`, inline: true },
          ...(aiField(r) ?? []),
        ],
        footer: { text: `Switchboard · report #${r.id}` },
        timestamp: new Date(r.created_at).toISOString(),
      },
    ],
    components: reportButtons(r),
    allowed_mentions: pingRole ? { parse: [], roles: [pingRole] } : NO_MENTIONS,
  };
}

/** Follow-up that completes the reporter's deferred "thinking…" response. */
export function renderReporterReply(r: ReportRow, notifyChannelId: string | null): MessagePayload {
  const lines = [`✅ Thanks, report **#${r.id}** is filed.`, `**Priority:** ${priorityLine(r)}`];
  if (r.ai_status === "done" && r.ai_summary) lines.push(`**AI summary:** ${r.ai_summary}`);
  lines.push(
    notifyChannelId
      ? `Moderators are being notified in <#${notifyChannelId}>.`
      : "Moderators will see it on the Switchboard dashboard.",
  );
  lines.push(`-# Track it any time with \`/status report:${r.id}\``);
  return { content: truncate(lines.join("\n"), 2000), allowed_mentions: NO_MENTIONS };
}

export function renderReportStatus(r: ReportRow): MessagePayload {
  const style = r.priority ? PRIORITY_STYLE[r.priority] : null;
  return {
    embeds: [
      {
        title: truncate(`Report #${r.id}${r.title ? ` — ${r.title}` : ""}`, 256),
        description: truncate(r.body, 1000),
        color: style?.color ?? 0x5865f2,
        fields: [
          { name: "Priority", value: priorityLine(r) },
          { name: "Status", value: statusLine(r), inline: true },
          { name: "Filed", value: relative(r.created_at), inline: true },
          ...(aiField(r) ?? []),
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

export interface StatusOverview {
  open: number;
  acknowledged: number;
  resolved7d: number;
  openByPriority: Record<Priority, number>;
  recentOpen: Pick<ReportRow, "id" | "priority" | "title" | "body" | "created_at">[];
  jobsRetrying: number;
  jobsDead: number;
  mirrorConfigured: boolean;
  aiActive: boolean;
}

export function renderStatusOverview(guildName: string, s: StatusOverview): MessagePayload {
  const byPriority = (["critical", "high", "normal", "low"] as const)
    .filter((p) => s.openByPriority[p] > 0)
    .map((p) => `${PRIORITY_STYLE[p].emoji} ${s.openByPriority[p]} ${PRIORITY_STYLE[p].label.toLowerCase()}`)
    .join(" · ");
  const recent = s.recentOpen.length
    ? s.recentOpen
        .map((r) => {
          const emoji = r.priority ? PRIORITY_STYLE[r.priority].emoji : "⏳";
          return `${emoji} **#${r.id}** ${truncate(r.title ?? r.body, 60)} · ${relative(r.created_at)}`;
        })
        .join("\n")
    : "Nothing open. 🎉";
  const health =
    s.jobsDead > 0
      ? `⚠️ ${s.jobsDead} delivery job(s) failed permanently — see the dashboard`
      : s.jobsRetrying > 0
        ? `🔁 ${s.jobsRetrying} delivery job(s) retrying`
        : "✅ All deliveries healthy";
  return {
    embeds: [
      {
        title: truncate(`Switchboard status${guildName ? ` — ${guildName}` : ""}`, 256),
        color: s.jobsDead > 0 ? 0xed4245 : 0x57f287,
        fields: [
          { name: "Open", value: `${s.open}${byPriority ? `\n${byPriority}` : ""}`, inline: true },
          { name: "Acknowledged", value: String(s.acknowledged), inline: true },
          { name: "Resolved (7d)", value: String(s.resolved7d), inline: true },
          { name: "Latest open reports", value: truncate(recent, 1024) },
          {
            name: "Pipeline",
            value: `${health}\nMirror: ${s.mirrorConfigured ? "on" : "not configured"} · AI triage: ${s.aiActive ? "on" : "off"}`,
          },
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

// ── Interaction responses ───────────────────────────────────────────
export function ephemeral(content: string): InteractionResponse {
  return {
    type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: MessageFlags.EPHEMERAL, allowed_mentions: NO_MENTIONS },
  };
}

export const REPORT_MODAL_ID = "report_modal";

/** /report without text opens this form (Label-wrapped text inputs, the current modal layout). */
export function reportModal(): InteractionResponse {
  return {
    type: ResponseType.MODAL,
    data: {
      custom_id: REPORT_MODAL_ID,
      title: "Report a problem",
      components: [
        {
          type: ComponentType.LABEL,
          label: "Summary",
          description: "One line: what is wrong?",
          component: {
            type: ComponentType.TEXT_INPUT,
            custom_id: "title",
            style: TextInputStyle.SHORT,
            min_length: 3,
            max_length: 100,
            required: true,
            placeholder: "e.g. Verification bot is down",
          },
        },
        {
          type: ComponentType.LABEL,
          label: "Details",
          description: "What happened, where and when? Links and usernames help.",
          component: {
            type: ComponentType.TEXT_INPUT,
            custom_id: "details",
            style: TextInputStyle.PARAGRAPH,
            max_length: 1500,
            required: false,
          },
        },
      ],
    },
  };
}

/** Reads text-input values from a modal submission (Label layout or legacy action rows). */
export function modalValues(components: SubmittedComponent[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  const visit = (c: SubmittedComponent) => {
    if (c.custom_id && typeof c.value === "string") values[c.custom_id] = c.value;
    if (c.component) visit(c.component);
    c.components?.forEach(visit);
  };
  components.forEach(visit);
  return values;
}
