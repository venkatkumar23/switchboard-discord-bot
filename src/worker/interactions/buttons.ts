import type { ReportStatus } from "../../shared/types";
import { STATUS_STYLE, ephemeral, renderReportMessage } from "../discord/render";
import { Permission, ResponseType } from "../discord/types";
import { getReport } from "../db/queries";
import type { ReportRow } from "../db/rows";
import { MAX_ATTEMPTS } from "../jobs/queue";
import type { HandlerResult, InteractionContext } from "./context";

const TRANSITIONS = {
  ack: { from: ["open"], to: "acknowledged", verb: "acknowledged", set: "acked_by = ?, acked_at = ?" },
  resolve: { from: ["open", "acknowledged"], to: "resolved", verb: "resolved", set: "resolved_by = ?, resolved_at = ?" },
  reopen: {
    from: ["resolved"],
    to: "open",
    verb: "reopened",
    set: "acked_by = NULL, acked_at = NULL, resolved_by = NULL, resolved_at = NULL",
  },
} as const satisfies Record<string, { from: ReportStatus[]; to: ReportStatus; verb: string; set: string }>;

export type ButtonAction = keyof typeof TRANSITIONS;

export function parseButton(customId: string | undefined): { action: ButtonAction; reportId: number } | null {
  const m = /^rpt:(ack|resolve|reopen):(\d{1,12})$/.exec(customId ?? "");
  return m ? { action: m[1] as ButtonAction, reportId: Number(m[2]) } : null;
}

const MODERATOR = Permission.ADMINISTRATOR | Permission.MANAGE_GUILD | Permission.MANAGE_MESSAGES;

/**
 * Acknowledge / Resolve / Reopen buttons on posted reports (MESSAGE_COMPONENT interactions).
 * The state change, its log line and the status mirror job commit atomically; the message is
 * then updated in place via the interaction response (type 7).
 */
export async function handleReportButton(ctx: InteractionContext): Promise<HandlerResult> {
  const parsed = parseButton(ctx.interaction.data?.custom_id);
  if (!parsed) return { response: ephemeral("That button is no longer valid."), outcome: "rejected:unknown" };
  const { db, guild, user, now, interaction } = ctx;
  const t = TRANSITIONS[parsed.action];

  if (guild.moderators_only === 1 && (user.permissions & MODERATOR) === 0n) {
    return {
      response: ephemeral("Only moderators (Manage Messages) can update reports on this server."),
      outcome: "rejected:permission",
      events: [
        {
          kind: "action",
          name: "report.action_denied",
          level: "warn",
          message: `${user.name} tried to ${parsed.action} report #${parsed.reportId} without moderator permission`,
          reportId: parsed.reportId,
        },
      ],
    };
  }

  // Follow-up rows are inserted only if the guarded UPDATE actually happened (same status +
  // our timestamp), so a double-click or a stale button can't log or mirror a second time.
  const after = "FROM reports WHERE id = ? AND guild_id = ? AND status = ? AND updated_at = ?";
  const guardArgs = [parsed.reportId, guild.id, t.to, now] as const;
  const mirrorJobId = `mirror:status:${interaction.id}`;
  const statements = [
    db
      .prepare(
        `UPDATE reports SET status = ?, ${t.set}, updated_at = ?
         WHERE id = ? AND guild_id = ? AND status IN (${t.from.map(() => "?").join(", ")})
         RETURNING *`,
      )
      .bind(t.to, ...(parsed.action === "reopen" ? [] : [user.name, now]), now, parsed.reportId, guild.id, ...t.from),
    db
      .prepare(
        `INSERT INTO events (guild_id, interaction_id, report_id, kind, name, level, message, created_at)
         SELECT guild_id, ?, id, 'action', ?, 'info', ?, ? ${after}`,
      )
      .bind(interaction.id, `report.${t.to}`, `${user.name} ${t.verb} report #${parsed.reportId}`, now, ...guardArgs),
  ];
  const mirror = ctx.settings.mirror && Boolean(guild.mirror_url_enc);
  if (mirror) {
    statements.push(
      db
        .prepare(
          `INSERT INTO jobs (id, guild_id, report_id, interaction_id, type, payload, status, attempts, max_attempts,
                             run_after, created_at, updated_at)
           SELECT ?, guild_id, id, ?, 'mirror', ?, 'pending', 0, ?, ?, ?, ? ${after}`,
        )
        .bind(
          mirrorJobId,
          interaction.id,
          JSON.stringify({ kind: "status", action: t.verb, actor: user.name }),
          MAX_ATTEMPTS.mirror,
          now,
          now,
          now,
          ...guardArgs,
        ),
    );
  }

  const [updatedRes] = await db.batch(statements);
  const updated = updatedRes?.results[0] as ReportRow | undefined;
  if (!updated) {
    const current = await getReport(db, parsed.reportId, guild.id);
    const by = current?.status === "resolved" ? current.resolved_by : current?.acked_by;
    return {
      response: ephemeral(
        current
          ? `Report #${current.id} is already ${STATUS_STYLE[current.status].label.toLowerCase()}${by ? ` (by ${by})` : ""}.`
          : `Report #${parsed.reportId} no longer exists.`,
      ),
      outcome: "rejected:stale",
    };
  }

  return {
    response: { type: ResponseType.UPDATE_MESSAGE, data: { ...renderReportMessage(updated, guild.alert_role_id) } },
    outcome: "updated",
    jobs: mirror ? [mirrorJobId] : [],
  };
}
