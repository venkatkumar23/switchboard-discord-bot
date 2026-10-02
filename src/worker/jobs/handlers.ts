// One handler per side effect. Each is safe to re-run: steps that already happened are
// skipped (posted_message_id, ai_status) and channel posts use Discord's enforce_nonce.
import { PRIORITY_RANK, type AiStatus, type CommandSettings } from "../../shared/types";
import { aiConfigured, triageReport, type AiTriage } from "../ai";
import { DiscordApiError, discord } from "../discord/api";
import { PRIORITY_STYLE, STATUS_STYLE, renderReportMessage, renderReporterReply, truncate } from "../discord/render";
import {
  commandConfigStatement,
  getGuild,
  getReport,
  isFaultActive,
  parseFaults,
  rulesStatement,
  toCommandSettings,
  toRule,
} from "../db/queries";
import type { CommandConfigRow, GuildRow, JobRow, ReportRow, RuleRow } from "../db/rows";
import { parseJson } from "../db/rows";
import { decryptSecret } from "../lib/crypto";
import { PermanentError, RetryableError, errorMessage } from "../lib/errors";
import { redactString } from "../lib/log";
import { sendMirror, type MirrorMessage } from "../mirror";
import { decidePriority, matchRules, maxPriority, type Rule } from "../rules";
import type { NewJob } from "./queue";
import type { JobContext, JobHandler, JobResult, Registry } from "./runner";

/** Interaction tokens live 15 minutes; leave a margin for the request itself. */
export const INTERACTION_TOKEN_TTL_MS = 15 * 60_000 - 15_000;
const AI_TIMEOUT_MS = 8_000;
/** Latency added by the "slow AI" fault switch — long enough to blow a synchronous 3 s budget. */
export const AI_SLOW_MS = 6_000;

export type MirrorPayload =
  | { kind: "report" }
  | { kind: "status"; action: "acknowledged" | "resolved" | "reopened"; actor: string }
  | { kind: "status_query"; actor: string }
  | { kind: "test"; requestedBy: string };

interface ReportContext {
  report: ReportRow;
  guild: GuildRow;
  rules: Rule[];
  settings: CommandSettings;
}

async function loadReportContext(db: D1Database, job: JobRow): Promise<ReportContext> {
  if (!job.report_id || !job.guild_id) throw new PermanentError("job is missing its report/guild reference");
  const [reportRes, guildRes, rulesRes, configRes] = await db.batch([
    db.prepare("SELECT * FROM reports WHERE id = ? AND guild_id = ?").bind(job.report_id, job.guild_id),
    db.prepare("SELECT * FROM guilds WHERE id = ?").bind(job.guild_id),
    rulesStatement(db, job.guild_id),
    commandConfigStatement(db, job.guild_id, "report"),
  ]);
  const report = reportRes?.results[0] as ReportRow | undefined;
  const guild = guildRes?.results[0] as GuildRow | undefined;
  if (!report) throw new PermanentError(`report #${job.report_id} no longer exists`);
  if (!guild) throw new PermanentError("server no longer exists");
  return {
    report,
    guild,
    rules: (rulesRes?.results as RuleRow[]).map(toRule),
    settings: toCommandSettings(configRes?.results[0] as CommandConfigRow | undefined, "report"),
  };
}

export function reportText(r: Pick<ReportRow, "title" | "body">): string {
  return r.title ? `${r.title}\n${r.body}` : r.body;
}

function aiOptions(guild: GuildRow, now: number) {
  const faults = parseFaults(guild.faults);
  return {
    timeoutMs: AI_TIMEOUT_MS,
    simulateDown: isFaultActive(faults, "aiDown", now),
    simulateDelayMs: isFaultActive(faults, "aiSlow", now) ? AI_SLOW_MS : 0,
  };
}

function aiColumns(db: D1Database, reportId: number, ai: AiTriage | null, status: AiStatus, error: string | null, now: number) {
  return db
    .prepare(
      `UPDATE reports SET ai_status = ?, ai_summary = ?, ai_category = ?, ai_severity = ?, ai_tags = ?, ai_error = ?,
              updated_at = ? WHERE id = ?`,
    )
    .bind(status, ai?.summary ?? null, ai?.category ?? null, ai?.severity ?? null, ai ? JSON.stringify(ai.tags) : null, error, now, reportId);
}

// ── triage: AI (best effort) + keyword rules → priority; fan out the deliveries ──
const triage: JobHandler = async (ctx, job) => {
  const db = ctx.env.DB;
  const { report, guild, rules, settings } = await loadReportContext(db, job);
  const now = ctx.now();
  const text = reportText(report);

  let ai: AiTriage | null = null;
  let aiStatus: AiStatus = "skipped";
  let aiError: string | null = null;
  if (guild.ai_enabled === 1 && aiConfigured(ctx.env)) {
    try {
      ai = await triageReport(ctx.env, text, aiOptions(guild, now));
      aiStatus = "done";
    } catch (err) {
      // Degrade, don't block: rules still classify the report and an enrich job retries AI.
      aiStatus = "failed";
      aiError = redactString(errorMessage(err)).slice(0, 300);
    }
  }

  const decision = decidePriority(matchRules(text, rules), ai?.severity ?? null);
  const style = PRIORITY_STYLE[decision.priority];
  const reason = decision.match
    ? `rule “${decision.match.rule.name}” matched “${decision.match.keyword}”`
    : decision.source === "ai"
      ? "escalated by AI"
      : "no rule matched";
  const aiNote =
    aiStatus === "done" && ai
      ? ` · AI: ${ai.category}/${ai.severity}`
      : aiStatus === "failed"
        ? ` · AI unavailable (${aiError}) — keyword rules only, will retry`
        : "";

  const base = { guildId: report.guild_id, reportId: report.id, interactionId: report.interaction_id };
  const enqueue: NewJob[] = [{ ...base, id: `reply:${report.id}`, type: "reply" }];
  const events: NonNullable<JobResult["events"]> = [
    {
      kind: "action",
      name: "report.triaged",
      level: aiStatus === "failed" ? "warn" : "info",
      message: `Report #${report.id} triaged: ${style.label} (${reason})${aiNote}`,
      reportId: report.id,
      data: {
        priority: decision.priority,
        source: decision.source,
        rule: decision.match?.rule.name ?? null,
        keyword: decision.match?.keyword ?? null,
        ai: ai ?? (aiError ? { error: aiError } : null),
      },
    },
  ];

  if (settings.postToChannel && guild.post_channel_id) {
    enqueue.push({ ...base, id: `post:${report.id}`, type: "post" });
  } else {
    events.push({
      kind: "action",
      name: "post.skipped",
      message: `Report #${report.id} not posted to a channel: ${settings.postToChannel ? "no report channel is configured" : "posting is turned off for /report"}`,
      reportId: report.id,
    });
  }
  if (settings.mirror && guild.mirror_url_enc) {
    enqueue.push({ ...base, id: `mirror:report:${report.id}`, type: "mirror", payload: { kind: "report" } });
  } else {
    events.push({
      kind: "action",
      name: "mirror.skipped",
      message: `Report #${report.id} not mirrored: ${settings.mirror ? "no mirror webhook is configured" : "mirroring is turned off for /report"}`,
      reportId: report.id,
    });
  }
  if (aiStatus === "failed") {
    enqueue.push({ ...base, id: `enrich:${report.id}`, type: "enrich", runAfter: now + 60_000 });
  }

  return {
    statements: [
      db
        .prepare(
          `UPDATE reports SET priority = ?, priority_source = ?, rule_id = ?, rule_name = ?, matched_keyword = ?,
                  mention_role = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          decision.priority,
          decision.source,
          decision.match?.rule.id ?? null,
          decision.match?.rule.name ?? null,
          decision.match?.keyword ?? null,
          decision.mentionRole ? 1 : 0,
          now,
          report.id,
        ),
      aiColumns(db, report.id, ai, aiStatus, aiError, now),
    ],
    events,
    enqueue,
  };
};

// ── reply: complete the reporter's deferred response ────────────────────────
const reply: JobHandler = async (ctx, job) => {
  const db = ctx.env.DB;
  const { report, guild, settings } = await loadReportContext(db, job);
  const interaction = await db
    .prepare("SELECT token, created_at FROM interactions WHERE id = ?")
    .bind(report.interaction_id)
    .first<{ token: string | null; created_at: number }>();
  if (!interaction?.token || ctx.now() - interaction.created_at > INTERACTION_TOKEN_TTL_MS) {
    throw new PermanentError("interaction token expired (Discord allows 15 minutes); the reporter can't be updated");
  }
  const notifyChannel = settings.postToChannel ? guild.post_channel_id : null;
  await discord(ctx.env).editOriginalResponse(interaction.token, renderReporterReply(report, notifyChannel));
  return {
    events: [
      {
        kind: "action",
        name: "reply.sent",
        message: `Replied to ${report.user_name} in Discord (report #${report.id})`,
        reportId: report.id,
        interactionId: report.interaction_id,
      },
    ],
  };
};

function explainChannelError(err: unknown): unknown {
  if (err instanceof DiscordApiError) {
    if (err.code === 50001 || err.code === 50013) {
      return new PermanentError(
        `the bot can't post in the report channel (${err.code === 50001 ? "Missing Access" : "Missing Permissions"}); grant it View Channel, Send Messages and Embed Links there`,
      );
    }
    if (err.code === 10003) return new PermanentError("the report channel no longer exists; pick another one in Settings");
  }
  return err;
}

// ── post: report + buttons into the moderators' channel ─────────────────────
const post: JobHandler = async (ctx, job) => {
  const db = ctx.env.DB;
  const { report, guild } = await loadReportContext(db, job);
  if (report.posted_message_id) return {}; // already done on an earlier attempt
  if (!guild.post_channel_id) throw new PermanentError("no report channel is configured");

  let message: { id: string; channel_id: string };
  try {
    message = await discord(ctx.env).createMessage(guild.post_channel_id, {
      ...renderReportMessage(report, guild.alert_role_id),
      // Discord returns the original message instead of posting twice if a retry races a success.
      nonce: `rpt-${report.id}`,
      enforce_nonce: true,
    });
  } catch (err) {
    throw explainChannelError(err);
  }
  const pinged = Boolean(guild.alert_role_id && report.mention_role === 1);
  return {
    statements: [
      db
        .prepare("UPDATE reports SET posted_channel_id = ?, posted_message_id = ?, updated_at = ? WHERE id = ?")
        .bind(message.channel_id, message.id, ctx.now(), report.id),
    ],
    events: [
      {
        kind: "action",
        name: "post.sent",
        message: `Posted report #${report.id} to the report channel${pinged ? " and pinged the alert role" : ""}`,
        reportId: report.id,
        data: { channelId: message.channel_id, messageId: message.id },
      },
    ],
  };
};

// ── mirror: Slack / Discord webhook ─────────────────────────────────────────
export function buildMirrorMessage(
  payload: MirrorPayload,
  guild: GuildRow,
  report: ReportRow | null,
  appUrl: string | null,
): MirrorMessage {
  const server = guild.name || `server ${guild.id}`;
  const link =
    appUrl && report ? { label: `Open report #${report.id} in Switchboard`, url: `${appUrl}/g/${guild.id}/reports?report=${report.id}` } : undefined;
  const style = report?.priority ? PRIORITY_STYLE[report.priority] : null;

  switch (payload.kind) {
    case "report": {
      if (!report) throw new PermanentError("report no longer exists");
      const facts: [string, string][] = [
        ["Server", server],
        ["Reporter", report.user_name],
        ["Priority", `${style?.label ?? "Pending"}${report.rule_name ? ` (rule “${report.rule_name}”)` : report.priority_source === "ai" ? " (AI escalated)" : ""}`],
      ];
      if (report.ai_status === "done" && report.ai_summary) facts.push(["AI summary", `${report.ai_summary} [${report.ai_category}]`]);
      return {
        title: truncate(`${style?.emoji ?? "📝"} New ${style?.label.toLowerCase() ?? ""} report #${report.id}${report.title ? `: ${report.title}` : ""}`, 150),
        facts,
        quote: report.body,
        color: style?.color ?? 0x5865f2,
        link,
      };
    }
    case "status": {
      if (!report) throw new PermanentError("report no longer exists");
      const s = STATUS_STYLE[report.status];
      return {
        title: truncate(`${s.emoji} Report #${report.id} ${payload.action} by ${payload.actor}`, 150),
        facts: [
          ["Server", server],
          ["Report", truncate(report.title ?? report.body, 120)],
          ["Priority", style?.label ?? "Pending"],
        ],
        color: payload.action === "resolved" ? 0x57f287 : 0x5865f2,
        link,
      };
    }
    case "status_query":
      return { title: `🔎 ${payload.actor} ran /status`, facts: [["Server", server]], color: 0x5865f2 };
    case "test":
      return {
        title: "🔔 Switchboard mirror test",
        facts: [
          ["Server", server],
          ["Requested by", payload.requestedBy],
        ],
        color: 0x5865f2,
      };
  }
}

function describeMirror(payload: MirrorPayload, reportId: number | null): string {
  switch (payload.kind) {
    case "report":
      return `report #${reportId}`;
    case "status":
      return `status change of report #${reportId} (${payload.action})`;
    case "status_query":
      return "a /status query";
    case "test":
      return "a test message";
  }
}

const mirror: JobHandler = async (ctx, job) => {
  const db = ctx.env.DB;
  const now = ctx.now();
  const payload = parseJson<MirrorPayload>(job.payload, { kind: "test", requestedBy: "unknown" });
  const guild = job.guild_id ? await getGuild(db, job.guild_id) : null;
  if (!guild) throw new PermanentError("server no longer exists");
  if (!guild.mirror_url_enc || !guild.mirror_kind) throw new PermanentError("no mirror webhook is configured");
  if (isFaultActive(parseFaults(guild.faults), "mirrorDown", now)) {
    throw new RetryableError("simulated mirror outage (fault injection is on)");
  }
  const report = job.report_id ? await getReport(db, job.report_id, guild.id) : null;
  const message = buildMirrorMessage(payload, guild, report, ctx.appUrl);

  let url: string;
  try {
    url = await decryptSecret(guild.mirror_url_enc, ctx.env.ENCRYPTION_KEY);
  } catch {
    throw new PermanentError("could not decrypt the mirror webhook URL (was ENCRYPTION_KEY changed?); re-enter it in Settings");
  }
  await sendMirror(url, guild.mirror_kind, message);
  return {
    events: [
      {
        kind: "action",
        name: "mirror.sent",
        message: `Mirrored ${describeMirror(payload, job.report_id)} to ${guild.mirror_kind === "slack" ? "Slack" : "the Discord mirror channel"}`,
        reportId: job.report_id,
      },
    ],
  };
};

// ── enrich: retry AI later; on success update the record and the posted message ─
const enrich: JobHandler = async (ctx, job) => {
  const db = ctx.env.DB;
  const { report, guild, rules } = await loadReportContext(db, job);
  const now = ctx.now();
  if (report.ai_status === "done") return {};
  if (guild.ai_enabled !== 1 || !aiConfigured(ctx.env)) {
    return {
      statements: [aiColumns(db, report.id, null, "skipped", null, now)],
      events: [{ kind: "action", name: "ai.skipped", message: `AI retry for report #${report.id} skipped: AI triage is turned off`, reportId: report.id }],
    };
  }

  const ai = await triageReport(ctx.env, reportText(report), aiOptions(guild, now)); // throws → backoff
  const decision = decidePriority(matchRules(reportText(report), rules), ai.severity);
  const priority = maxPriority(report.priority, decision.priority); // never downgrade after the fact
  const escalated = report.priority !== null && PRIORITY_RANK[priority] > PRIORITY_RANK[report.priority];
  const updated: ReportRow = {
    ...report,
    ai_status: "done",
    ai_summary: ai.summary,
    ai_category: ai.category,
    ai_severity: ai.severity,
    ai_tags: JSON.stringify(ai.tags),
    ai_error: null,
    priority,
    priority_source: escalated ? "ai" : report.priority_source,
    updated_at: now,
  };

  if (report.posted_channel_id && report.posted_message_id) {
    try {
      await discord(ctx.env).editMessage(
        report.posted_channel_id,
        report.posted_message_id,
        renderReportMessage(updated, guild.alert_role_id),
      );
    } catch (err) {
      // A deleted message is not worth failing the enrichment over.
      if (!(err instanceof DiscordApiError && err.status === 404)) throw err;
    }
  }

  return {
    statements: [
      aiColumns(db, report.id, ai, "done", null, now),
      db
        .prepare("UPDATE reports SET priority = ?, priority_source = ?, updated_at = ? WHERE id = ?")
        .bind(priority, updated.priority_source, now, report.id),
    ],
    events: [
      {
        kind: "action",
        name: "ai.recovered",
        message: `AI triage recovered for report #${report.id}: ${ai.category}/${ai.severity}${escalated ? ` — priority raised to ${PRIORITY_STYLE[priority].label}` : ""}`,
        reportId: report.id,
        data: { ...ai },
      },
    ],
  };
};

export const registry: Registry = {
  handlers: { triage, reply, post, mirror, enrich },
  onDead: {
    // If triage can't finish, still answer the reporter instead of leaving "thinking…" forever.
    triage: (_ctx: JobContext, job: JobRow): NewJob[] =>
      job.report_id
        ? [{ id: `reply:${job.report_id}`, type: "reply", guildId: job.guild_id, reportId: job.report_id, interactionId: job.interaction_id }]
        : [],
  },
};
