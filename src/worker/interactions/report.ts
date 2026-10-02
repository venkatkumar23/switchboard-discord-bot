import { REPORT_TEXT_MAX } from "../discord/commands";
import { ephemeral, modalValues, reportModal, truncate } from "../discord/render";
import { MessageFlags, ResponseType } from "../discord/types";
import { MAX_ATTEMPTS } from "../jobs/queue";
import type { HandlerResult, InteractionContext } from "./context";
import { optionValue } from "./context";

/** /report text:… files straight away; /report with no text opens the form. */
export async function handleReportCommand(ctx: InteractionContext): Promise<HandlerResult> {
  const text = String(optionValue(ctx.interaction, "text") ?? "").trim();
  if (!text) {
    return {
      response: reportModal(),
      outcome: "modal",
      events: [{ kind: "command", name: "report.form_opened", message: `${ctx.user.name} ran /report and opened the report form` }],
    };
  }
  return fileReport(ctx, { title: null, body: text.slice(0, REPORT_TEXT_MAX), via: "/report" });
}

export async function handleReportModal(ctx: InteractionContext): Promise<HandlerResult> {
  const values = modalValues(ctx.interaction.data?.components);
  const title = values.title?.trim().slice(0, 100) || null;
  const details = values.details?.trim().slice(0, REPORT_TEXT_MAX) || "";
  if (!title && !details) {
    return { response: ephemeral("That report was empty, so nothing was filed."), outcome: "rejected:empty" };
  }
  return fileReport(ctx, details ? { title, body: details, via: "the report form" } : { title: null, body: title!, via: "the report form" });
}

/**
 * The durability point: report row + triage job + log line commit in ONE transaction before
 * Discord gets its (deferred) answer. Whatever happens next — Worker evicted, AI down, Slack
 * down — the cron runner will find the job and finish the work.
 */
async function fileReport(
  ctx: InteractionContext,
  input: { title: string | null; body: string; via: string },
): Promise<HandlerResult> {
  const { db, interaction, guild, user, now } = ctx;
  const fromReport = "FROM reports WHERE interaction_id = ?";
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO reports (guild_id, interaction_id, source_channel_id, user_id, user_name, title, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(guild.id, interaction.id, interaction.channel_id ?? null, user.id, user.name, input.title, input.body, now, now),
    db
      .prepare(
        `INSERT INTO jobs (id, guild_id, report_id, interaction_id, type, payload, status, attempts, max_attempts,
                           run_after, created_at, updated_at)
         SELECT 'triage:' || id, guild_id, id, interaction_id, 'triage', '{}', 'pending', 0, ?, ?, ?, ? ${fromReport}`,
      )
      .bind(MAX_ATTEMPTS.triage, now, now, now, interaction.id),
    db
      .prepare(
        `INSERT INTO events (guild_id, interaction_id, report_id, kind, name, level, message, data, created_at)
         SELECT guild_id, interaction_id, id, 'command', 'report.filed', 'info', ?1 || id || ?2, ?3, ?4 ${fromReport.replace("?", "?5")}`,
      )
      .bind(
        `${user.name} filed report #`,
        ` via ${input.via}: “${truncate(input.title ?? input.body, 80)}”`,
        JSON.stringify({ via: input.via, length: input.body.length }),
        now,
        interaction.id,
      ),
  ]);
  const reportId = (inserted?.results[0] as { id: number } | undefined)?.id;
  if (!reportId) throw new Error("report insert returned no id");

  return {
    response: {
      type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: ctx.settings.ephemeral ? { flags: MessageFlags.EPHEMERAL } : {},
    },
    outcome: "deferred",
    jobs: [`triage:${reportId}`],
  };
}
