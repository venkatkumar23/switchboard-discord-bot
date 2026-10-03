import { REPORT_MODAL_ID, ephemeral } from "../discord/render";
import { InteractionType, MessageFlags, ResponseType, type Interaction } from "../discord/types";
import {
  commandConfigStatement,
  defaultRuleStatements,
  ensureGuildStatement,
  eventStatement,
  recordSecurity,
  refreshGuildInfo,
  toCommandSettings,
} from "../db/queries";
import type { CommandConfigRow, GuildRow } from "../db/rows";
import type { Env } from "../env";
import { registry } from "../jobs/handlers";
import { Budget, runJobs } from "../jobs/runner";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/log";
import { handleReportButton, parseButton } from "./buttons";
import { actorFrom, optionValue, type Actor, type HandlerResult, type InteractionContext, type Route } from "./context";
import { handleReportCommand, handleReportModal } from "./report";
import { handleStatusCommand } from "./status";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

export function routeOf(interaction: Interaction): Route | null {
  const data = interaction.data;
  switch (interaction.type) {
    case InteractionType.APPLICATION_COMMAND:
      if (data?.name === "report") {
        const hasText = String(optionValue(interaction, "text") ?? "").trim().length > 0;
        return { name: "report", command: "report", gated: true, storeToken: hasText, handle: handleReportCommand };
      }
      if (data?.name === "status") {
        return { name: "status", command: "status", gated: true, storeToken: false, handle: handleStatusCommand };
      }
      return null;
    case InteractionType.MODAL_SUBMIT:
      return data?.custom_id === REPORT_MODAL_ID
        ? { name: "report", command: "report", gated: true, storeToken: true, handle: handleReportModal }
        : null;
    case InteractionType.MESSAGE_COMPONENT: {
      const button = parseButton(data?.custom_id);
      return button
        ? { name: `button:${button.action}`, command: "report", gated: false, storeToken: false, handle: handleReportButton }
        : null;
    }
    default:
      return null;
  }
}

function userInput(interaction: Interaction): string | null {
  const data = interaction.data;
  const input = data?.options ?? data?.components ?? (data?.custom_id ? { custom_id: data.custom_id } : null);
  return input ? JSON.stringify(input).slice(0, 4000) : null;
}

/** Enabled flag + per-user cooldown: the rules every command goes through. */
function gate(ctx: InteractionContext, route: Route, lastUse: number | null): HandlerResult | null {
  if (!route.gated) return null;
  const { settings, user, now } = ctx;
  if (!settings.enabled) {
    return {
      response: ephemeral(`🚫 \`/${route.command}\` is turned off on this server.`),
      outcome: "rejected:disabled",
      events: [{ kind: "command", name: "command.disabled", level: "warn", message: `${user.name} ran /${route.command}, which is disabled` }],
    };
  }
  const cooldownMs = settings.cooldownSeconds * 1000;
  if (cooldownMs > 0 && lastUse !== null && now - lastUse < cooldownMs) {
    const wait = Math.ceil((cooldownMs - (now - lastUse)) / 1000);
    return {
      response: ephemeral(`⏳ Slow down — you can use \`/${route.command}\` again in ${wait}s.`),
      outcome: "rejected:cooldown",
      events: [
        {
          kind: "command",
          name: "command.rate_limited",
          level: "warn",
          message: `${user.name} hit the /${route.command} cooldown (${settings.cooldownSeconds}s) — rejected`,
        },
      ],
    };
  }
  return null;
}

/**
 * Everything that happens between "signature verified" and "response sent". Only D1 work runs
 * here (well inside Discord's 3 s window); network side effects run after the response.
 */
/** Only waitUntil is needed; keeps this callable from Hono and from tests alike. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export async function handleInteraction(
  env: Env,
  exec: WaitUntil,
  interaction: Interaction,
  appUrl: string | null,
): Promise<Response> {
  if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });

  const route = routeOf(interaction);
  if (!route) return json(ephemeral("Sorry, I don't know that command or button."));
  if (!interaction.guild_id || !interaction.member) {
    return json(ephemeral("Switchboard commands only work inside a server."));
  }

  const db = env.DB;
  const now = Date.now();
  const guildId = interaction.guild_id;
  const user: Actor = actorFrom(interaction.member);

  // One round trip: dedup gate, tenant bootstrap, config + cooldown prefetch.
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO interactions (id, guild_id, channel_id, user_id, user_name, type, name, input, token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          interaction.id,
          guildId,
          interaction.channel_id ?? null,
          user.id,
          user.name,
          interaction.type,
          route.name,
          userInput(interaction),
          route.storeToken ? interaction.token : null,
          now,
        ),
      ensureGuildStatement(db, guildId, now),
      db.prepare("SELECT * FROM guilds WHERE id = ?").bind(guildId),
      commandConfigStatement(db, guildId, route.command),
      route.gated
        ? db
            .prepare(
              `SELECT MAX(created_at) AS last FROM interactions
               WHERE guild_id = ? AND user_id = ? AND name = ? AND created_at < ?
                 AND (outcome IS NULL OR outcome IN ('deferred', 'replied'))`,
            )
            .bind(guildId, user.id, route.name, now)
        : db.prepare("SELECT NULL AS last"),
    ]);
  } catch (err) {
    // Not silent: the user is told nothing was recorded, and it's logged for us.
    log.error("interaction.persist_failed", { interactionId: interaction.id, error: errorMessage(err) });
    return json(ephemeral("⚠️ I couldn't record that just now (temporary storage problem), so nothing was filed. Please try again in a minute."));
  }

  if (results[0]?.meta.changes === 0) return duplicate(env, exec, interaction, guildId, now);

  if (results[1]?.meta.changes === 1) {
    await db.batch(defaultRuleStatements(db, guildId, now)).catch((err) => {
      log.warn("guild.seed_rules_failed", { guildId, error: errorMessage(err) });
    });
    exec.waitUntil(refreshGuildInfo(env, guildId));
  }

  const ctx: InteractionContext = {
    env,
    db,
    interaction,
    now,
    guild: results[2]?.results[0] as GuildRow,
    settings: toCommandSettings(results[3]?.results[0] as CommandConfigRow | undefined, route.command),
    user,
  };
  const lastUse = (results[4]?.results[0] as { last: number | null } | undefined)?.last ?? null;

  let result: HandlerResult;
  try {
    result = gate(ctx, route, lastUse) ?? (await route.handle(ctx));
  } catch (err) {
    log.error("interaction.handler_failed", { interactionId: interaction.id, route: route.name, error: errorMessage(err) });
    result = {
      response: ephemeral("⚠️ Something went wrong while handling that, so nothing was filed. Please try again."),
      outcome: "error",
      events: [
        {
          kind: "command",
          name: "interaction.error",
          level: "error",
          message: `Failed to handle ${route.name} from ${user.name}: ${errorMessage(err)}`,
        },
      ],
    };
  }

  exec.waitUntil(afterResponse(env, appUrl, interaction.id, guildId, result));
  return json(result.response);
}

async function afterResponse(env: Env, appUrl: string | null, interactionId: string, guildId: string, result: HandlerResult) {
  const db = env.DB;
  const now = Date.now();
  try {
    await db.batch([
      db
        .prepare("UPDATE interactions SET response = ?, outcome = ? WHERE id = ?")
        .bind(JSON.stringify(result.response), result.outcome, interactionId),
      ...(result.events ?? []).map((e) => eventStatement(db, { ...e, guildId, interactionId }, now)),
    ]);
  } catch (err) {
    log.error("interaction.finalize_failed", { interactionId, error: errorMessage(err) });
  }
  if (result.jobs?.length) {
    await runJobs({ env, now: Date.now, appUrl }, registry, result.jobs, new Budget(12));
  }
}

/**
 * Same interaction id seen again (Discord retry or a replayed capture): do nothing new, answer
 * with exactly what we answered the first time.
 */
async function duplicate(env: Env, exec: WaitUntil, interaction: Interaction, guildId: string, now: number) {
  const db = env.DB;
  const prior = await db
    .prepare("SELECT response FROM interactions WHERE id = ?")
    .bind(interaction.id)
    .first<{ response: string | null }>()
    .catch(() => null);
  log.warn("interaction.duplicate", { interactionId: interaction.id, guildId });
  exec.waitUntil(
    Promise.allSettled([
      recordSecurity(db, "duplicate_interaction", now),
      eventStatement(
        db,
        {
          guildId,
          interactionId: interaction.id,
          kind: "security",
          name: "interaction.duplicate",
          level: "warn",
          message: `Ignored a duplicate delivery of interaction ${interaction.id} (no side effects)`,
        },
        now,
      ).run(),
    ]),
  );
  if (prior?.response) return new Response(prior.response, { headers: { "content-type": "application/json" } });
  return json(
    interaction.type === InteractionType.MESSAGE_COMPONENT
      ? { type: ResponseType.DEFERRED_UPDATE_MESSAGE }
      : { type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: MessageFlags.EPHEMERAL } },
  );
}
