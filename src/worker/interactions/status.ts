import type { Priority } from "../../shared/types";
import { aiConfigured } from "../ai";
import { NO_MENTIONS, renderReportStatus, renderStatusOverview, type StatusOverview } from "../discord/render";
import { MessageFlags, ResponseType, type MessagePayload } from "../discord/types";
import { eventStatement, getReport } from "../db/queries";
import type { GuildRow, ReportRow } from "../db/rows";
import { enqueueStatement, type NewJob } from "../jobs/queue";
import type { HandlerResult, InteractionContext } from "./context";
import { optionValue } from "./context";

const DAY_MS = 86_400_000;

async function loadOverview(db: D1Database, guild: GuildRow, now: number, aiActive: boolean): Promise<StatusOverview> {
  const [counts, byPriority, recent, jobs] = await db.batch([
    db
      .prepare(
        `SELECT COALESCE(SUM(status = 'open'), 0) AS open,
                COALESCE(SUM(status = 'acknowledged'), 0) AS acknowledged,
                COALESCE(SUM(status = 'resolved' AND resolved_at >= ?), 0) AS resolved7d
         FROM reports WHERE guild_id = ?`,
      )
      .bind(now - 7 * DAY_MS, guild.id),
    db
      .prepare("SELECT priority, COUNT(*) AS n FROM reports WHERE guild_id = ? AND status != 'resolved' GROUP BY priority")
      .bind(guild.id),
    db
      .prepare(
        `SELECT id, priority, title, body, created_at FROM reports
         WHERE guild_id = ? AND status != 'resolved' ORDER BY id DESC LIMIT 5`,
      )
      .bind(guild.id),
    db
      .prepare(
        `SELECT COALESCE(SUM(status = 'retrying'), 0) AS retrying,
                COALESCE(SUM(status = 'dead' AND updated_at >= ?), 0) AS dead
         FROM jobs WHERE guild_id = ?`,
      )
      .bind(now - DAY_MS, guild.id),
  ]);
  const c = (counts?.results[0] ?? {}) as { open?: number; acknowledged?: number; resolved7d?: number };
  const j = (jobs?.results[0] ?? {}) as { retrying?: number; dead?: number };
  const openByPriority: Record<Priority, number> = { low: 0, normal: 0, high: 0, critical: 0 };
  for (const row of (byPriority?.results ?? []) as { priority: Priority | null; n: number }[]) {
    if (row.priority) openByPriority[row.priority] = row.n;
  }
  return {
    open: c.open ?? 0,
    acknowledged: c.acknowledged ?? 0,
    resolved7d: c.resolved7d ?? 0,
    openByPriority,
    recentOpen: (recent?.results ?? []) as StatusOverview["recentOpen"],
    jobsRetrying: j.retrying ?? 0,
    jobsDead: j.dead ?? 0,
    mirrorConfigured: Boolean(guild.mirror_url_enc),
    aiActive,
  };
}

/** Pure D1 reads: fast enough to answer synchronously, no deferral needed. */
export async function handleStatusCommand(ctx: InteractionContext): Promise<HandlerResult> {
  const { db, guild, settings, user, interaction, now } = ctx;
  const requested = optionValue(interaction, "report");
  let payload: MessagePayload;
  let summary: string;

  if (typeof requested === "number") {
    const report: ReportRow | null = await getReport(db, requested, guild.id);
    payload = report
      ? renderReportStatus(report)
      : { content: `I couldn't find report #${requested} on this server.`, allowed_mentions: NO_MENTIONS };
    summary = `${user.name} ran /status for report #${requested}${report ? "" : " (not found)"}`;
  } else {
    const aiActive = guild.ai_enabled === 1 && aiConfigured(ctx.env);
    payload = renderStatusOverview(guild.name, await loadOverview(db, guild, now, aiActive));
    summary = `${user.name} ran /status`;
  }

  const jobs: NewJob[] = [];
  if (settings.mirror && guild.mirror_url_enc) {
    jobs.push({
      id: `mirror:status-query:${interaction.id}`,
      type: "mirror",
      guildId: guild.id,
      interactionId: interaction.id,
      payload: { kind: "status_query", actor: user.name },
    });
  }
  // Log line + any mirror job are committed before we answer, like every other side effect.
  await db.batch([
    eventStatement(db, { guildId: guild.id, interactionId: interaction.id, kind: "command", name: "status.answered", message: summary }, now),
    ...jobs.map((j) => enqueueStatement(db, j, now)),
  ]);

  return {
    response: {
      type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { ...payload, ...(settings.ephemeral ? { flags: MessageFlags.EPHEMERAL } : {}) },
    },
    outcome: "replied",
    jobs: jobs.map((j) => j.id),
  };
}
