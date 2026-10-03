import { Hono } from "hono";
import { z } from "zod";
import {
  COMMAND_NAMES,
  FAULT_NAMES,
  PRIORITIES,
  type ChannelDTO,
  type CommandConfigDTO,
  type CommandName,
  type FaultName,
  type JobStatus,
  type JobType,
  type Priority,
  type ReportDetailDTO,
  type RoleDTO,
  type RuleDTO,
  type RuleTestResultDTO,
  type StatsDTO,
} from "../../shared/types";
import { aiConfigured } from "../ai";
import { appOrigin, SNOWFLAKE, type AppContext, type AppEnv } from "../app";
import { requireGuildAccess } from "../auth/middleware";
import { COMMAND_DESCRIPTIONS } from "../discord/commands";
import { NO_MENTIONS } from "../discord/render";
import { discord } from "../discord/api";
import {
  commandConfigStatement,
  eventStatement,
  getGuild,
  parseFaults,
  refreshGuildInfo,
  rulesStatement,
  toCommandSettings,
  toRule,
} from "../db/queries";
import type { CommandConfigRow, EventRow, GuildRow, JobRow, ReportRow, RuleRow } from "../db/rows";
import { registry } from "../jobs/handlers";
import { enqueueStatement, requeueStatement } from "../jobs/queue";
import { Budget, runJob } from "../jobs/runner";
import { encryptSecret, randomToken } from "../lib/crypto";
import { errorMessage } from "../lib/errors";
import { classifyWebhookUrl } from "../mirror";
import { decidePriority, matchRules } from "../rules";
import { stepOf, toEventDTO, toGuildSettings, toJobDTO, toReportDTO } from "./dto";

export const guildApi = new Hono<AppEnv>();
guildApi.use("*", requireGuildAccess);

const DAY_MS = 86_400_000;
const snowflake = z.string().regex(SNOWFLAKE);

async function body<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

const badRequest = (c: AppContext, message = "Invalid request") => c.json({ error: "invalid_request", message }, 400);

function logConfig(c: AppContext, name: string, message: string, data?: Record<string, unknown>) {
  return eventStatement(
    c.env.DB,
    { guildId: c.get("guildId"), kind: "config", name, message: `${message} (by ${c.get("admin").email})`, data },
    Date.now(),
  );
}

async function loadGuild(c: AppContext): Promise<GuildRow> {
  const guild = await getGuild(c.env.DB, c.get("guildId"));
  if (!guild) throw new Error("guild row missing for linked admin");
  return guild;
}

// ── Server settings ──────────────────────────────────────────────────
guildApi.get("/", async (c) => {
  let guild = await loadGuild(c);
  if (!guild.name) {
    await refreshGuildInfo(c.env, guild.id);
    guild = await loadGuild(c);
  }
  return c.json(toGuildSettings(guild, aiConfigured(c.env), Date.now()));
});

const SettingsSchema = z
  .object({
    postChannelId: snowflake.nullable(),
    alertRoleId: snowflake.nullable(),
    moderatorsOnly: z.boolean(),
    aiEnabled: z.boolean(),
  })
  .partial()
  .strict();

guildApi.patch("/settings", async (c) => {
  const input = await body(c, SettingsSchema);
  if (!input) return badRequest(c);
  const guildId = c.get("guildId");
  const api = discord(c.env);

  // A channel/role id must belong to *this* server — otherwise an admin could make the bot post
  // one tenant's reports into another tenant's channel.
  try {
    if (input.postChannelId) {
      const channels = await api.getGuildChannels(guildId);
      if (!channels.some((ch) => ch.id === input.postChannelId)) return badRequest(c, "That channel is not in this server");
    }
    if (input.alertRoleId) {
      const roles = await api.getGuildRoles(guildId);
      if (!roles.some((r) => r.id === input.alertRoleId)) return badRequest(c, "That role is not in this server");
    }
  } catch (err) {
    return c.json({ error: "discord_unavailable", message: errorMessage(err) }, 502);
  }

  const columns: [string, unknown][] = [];
  if (input.postChannelId !== undefined) columns.push(["post_channel_id", input.postChannelId]);
  if (input.alertRoleId !== undefined) columns.push(["alert_role_id", input.alertRoleId]);
  if (input.moderatorsOnly !== undefined) columns.push(["moderators_only", input.moderatorsOnly ? 1 : 0]);
  if (input.aiEnabled !== undefined) columns.push(["ai_enabled", input.aiEnabled ? 1 : 0]);
  if (!columns.length) return badRequest(c, "Nothing to update");

  const db = c.env.DB;
  await db.batch([
    db
      .prepare(`UPDATE guilds SET ${columns.map(([col]) => `${col} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...columns.map(([, v]) => v), Date.now(), guildId),
    logConfig(c, "settings.updated", `Updated server settings: ${Object.keys(input).join(", ")}`, input),
  ]);
  return c.json(toGuildSettings(await loadGuild(c), aiConfigured(c.env), Date.now()));
});

// ── Mirror webhook ───────────────────────────────────────────────────
guildApi.put("/mirror", async (c) => {
  const input = await body(c, z.object({ url: z.string().max(500) }));
  const hook = input && classifyWebhookUrl(input.url);
  if (!hook) {
    return badRequest(
      c,
      "Paste a Slack Incoming Webhook (https://hooks.slack.com/services/…) or a Discord webhook URL (https://discord.com/api/webhooks/…)",
    );
  }
  const sealed = await encryptSecret(hook.url, c.env.ENCRYPTION_KEY);
  const db = c.env.DB;
  await db.batch([
    db
      .prepare("UPDATE guilds SET mirror_url_enc = ?, mirror_kind = ?, mirror_hint = ?, updated_at = ? WHERE id = ?")
      .bind(sealed, hook.kind, hook.hint, Date.now(), c.get("guildId")),
    logConfig(c, "mirror.updated", `Mirror set to a ${hook.kind === "slack" ? "Slack" : "Discord"} webhook (${hook.hint})`),
  ]);
  return c.json(toGuildSettings(await loadGuild(c), aiConfigured(c.env), Date.now()));
});

guildApi.delete("/mirror", async (c) => {
  const db = c.env.DB;
  await db.batch([
    db
      .prepare("UPDATE guilds SET mirror_url_enc = NULL, mirror_kind = NULL, mirror_hint = NULL, updated_at = ? WHERE id = ?")
      .bind(Date.now(), c.get("guildId")),
    logConfig(c, "mirror.removed", "Mirror webhook removed"),
  ]);
  return c.json(toGuildSettings(await loadGuild(c), aiConfigured(c.env), Date.now()));
});

/** Goes through the real job pipeline, so a test under fault injection shows a retry too. */
guildApi.post("/mirror/test", async (c) => {
  const guild = await loadGuild(c);
  if (!guild.mirror_url_enc) return badRequest(c, "Configure a mirror webhook first");
  const db = c.env.DB;
  const now = Date.now();
  const id = `mirror:test:${randomToken(6)}`;
  await db.batch([
    enqueueStatement(db, { id, type: "mirror", guildId: guild.id, payload: { kind: "test", requestedBy: c.get("admin").email } }, now),
    logConfig(c, "mirror.test_requested", "Mirror test requested"),
  ]);
  await runJob({ env: c.env, now: Date.now, appUrl: appOrigin(c) }, registry, id, new Budget(1));
  const job = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  return c.json({ job: job ? toJobDTO(job) : null });
});

guildApi.post("/channel/test", async (c) => {
  const guild = await loadGuild(c);
  if (!guild.post_channel_id) return badRequest(c, "Pick a report channel first");
  try {
    await discord(c.env).createMessage(guild.post_channel_id, {
      content: "👋 Switchboard test message: reports filed with `/report` will be posted in this channel.",
      allowed_mentions: NO_MENTIONS,
    });
    await logConfig(c, "channel.test_sent", "Sent a test message to the report channel").run();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, message: errorMessage(err) });
  }
});

// ── Discord lookups for the pickers ──────────────────────────────────
guildApi.get("/discord/channels", async (c) => {
  try {
    const all = await discord(c.env).getGuildChannels(c.get("guildId"));
    const categories = new Map(all.filter((ch) => ch.type === 4).map((ch) => [ch.id, ch]));
    const order = (ch: (typeof all)[number]) => [categories.get(ch.parent_id ?? "")?.position ?? -1, ch.position];
    const channels: ChannelDTO[] = all
      .filter((ch) => ch.type === 0 || ch.type === 5) // text + announcement
      .sort((a, b) => {
        const [ca, pa] = order(a);
        const [cb, pb] = order(b);
        return ca! - cb! || pa! - pb!;
      })
      .map((ch) => ({ id: ch.id, name: ch.name, category: categories.get(ch.parent_id ?? "")?.name ?? null }));
    return c.json(channels);
  } catch (err) {
    return c.json({ error: "discord_unavailable", message: errorMessage(err) }, 502);
  }
});

guildApi.get("/discord/roles", async (c) => {
  const guildId = c.get("guildId");
  try {
    const roles = await discord(c.env).getGuildRoles(guildId);
    const result: RoleDTO[] = roles
      .filter((r) => r.id !== guildId && !r.managed) // skip @everyone and bot-managed roles
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.color, mentionable: r.mentionable }));
    return c.json(result);
  } catch (err) {
    return c.json({ error: "discord_unavailable", message: errorMessage(err) }, 502);
  }
});

// ── Command behaviour ────────────────────────────────────────────────
guildApi.get("/commands", async (c) => {
  const db = c.env.DB;
  const rows = await db.batch(COMMAND_NAMES.map((name) => commandConfigStatement(db, c.get("guildId"), name)));
  const configs: CommandConfigDTO[] = COMMAND_NAMES.map((command, i) => ({
    command,
    description: COMMAND_DESCRIPTIONS[command],
    ...toCommandSettings(rows[i]?.results[0] as CommandConfigRow | undefined, command),
  }));
  return c.json(configs);
});

const CommandSettingsSchema = z
  .object({
    enabled: z.boolean(),
    ephemeral: z.boolean(),
    postToChannel: z.boolean(),
    mirror: z.boolean(),
    cooldownSeconds: z.number().int().min(0).max(3600),
  })
  .strict();

guildApi.put("/commands/:command", async (c) => {
  const command = c.req.param("command") as CommandName;
  if (!COMMAND_NAMES.includes(command)) return c.json({ error: "not_found" }, 404);
  const s = await body(c, CommandSettingsSchema);
  if (!s) return badRequest(c);
  const db = c.env.DB;
  const now = Date.now();
  const summary = `enabled ${s.enabled ? "on" : "off"}, ${s.ephemeral ? "private" : "public"} replies, mirror ${s.mirror ? "on" : "off"}, cooldown ${s.cooldownSeconds}s${command === "report" ? `, post to channel ${s.postToChannel ? "on" : "off"}` : ""}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO command_configs (guild_id, command, enabled, ephemeral, post_to_channel, mirror, cooldown_seconds, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, command) DO UPDATE SET enabled = excluded.enabled, ephemeral = excluded.ephemeral,
           post_to_channel = excluded.post_to_channel, mirror = excluded.mirror,
           cooldown_seconds = excluded.cooldown_seconds, updated_at = excluded.updated_at`,
      )
      .bind(c.get("guildId"), command, +s.enabled, +s.ephemeral, +s.postToChannel, +s.mirror, s.cooldownSeconds, now),
    logConfig(c, "command.updated", `Updated /${command}: ${summary}`, s),
  ]);
  return c.json({ command, description: COMMAND_DESCRIPTIONS[command], ...s } satisfies CommandConfigDTO);
});

// ── Rules ────────────────────────────────────────────────────────────
const RuleSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    keywords: z
      .array(z.string().trim().toLowerCase().min(1).max(40))
      .min(1)
      .max(30)
      .transform((k) => [...new Set(k)]),
    priority: z.enum(PRIORITIES),
    mentionRole: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();

async function listRules(db: D1Database, guildId: string): Promise<RuleDTO[]> {
  const { results } = await rulesStatement(db, guildId).all<RuleRow>();
  return results.map(toRule);
}

guildApi.get("/rules", async (c) => c.json(await listRules(c.env.DB, c.get("guildId"))));

guildApi.post("/rules", async (c) => {
  const r = await body(c, RuleSchema);
  if (!r) return badRequest(c);
  const db = c.env.DB;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO rules (guild_id, name, keywords, priority, mention_role, enabled, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(position), -1) + 1 FROM rules WHERE guild_id = ?1), ?7, ?7)`,
      )
      .bind(c.get("guildId"), r.name, JSON.stringify(r.keywords), r.priority, +r.mentionRole, +r.enabled, now),
    logConfig(c, "rule.created", `Created rule “${r.name}” → ${r.priority}`, r),
  ]);
  return c.json(await listRules(db, c.get("guildId")), 201);
});

guildApi.put("/rules/:ruleId", async (c) => {
  const r = await body(c, RuleSchema);
  if (!r) return badRequest(c);
  const db = c.env.DB;
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE rules SET name = ?, keywords = ?, priority = ?, mention_role = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND guild_id = ?`,
      )
      .bind(r.name, JSON.stringify(r.keywords), r.priority, +r.mentionRole, +r.enabled, Date.now(), Number(c.req.param("ruleId")), c.get("guildId")),
    logConfig(c, "rule.updated", `Updated rule “${r.name}” → ${r.priority}${r.enabled ? "" : " (disabled)"}`, r),
  ]);
  if (!updated?.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json(await listRules(db, c.get("guildId")));
});

guildApi.delete("/rules/:ruleId", async (c) => {
  const db = c.env.DB;
  const rule = await db
    .prepare("DELETE FROM rules WHERE id = ? AND guild_id = ? RETURNING name")
    .bind(Number(c.req.param("ruleId")), c.get("guildId"))
    .first<{ name: string }>();
  if (!rule) return c.json({ error: "not_found" }, 404);
  await logConfig(c, "rule.deleted", `Deleted rule “${rule.name}”`).run();
  return c.json(await listRules(db, c.get("guildId")));
});

guildApi.post("/rules/reorder", async (c) => {
  const input = await body(c, z.object({ ids: z.array(z.number().int().positive()).max(100) }));
  if (!input) return badRequest(c);
  const db = c.env.DB;
  const guildId = c.get("guildId");
  await db.batch(
    input.ids.map((id, position) =>
      db.prepare("UPDATE rules SET position = ?, updated_at = ? WHERE id = ? AND guild_id = ?").bind(position, Date.now(), id, guildId),
    ),
  );
  return c.json(await listRules(db, guildId));
});

guildApi.post("/rules/test", async (c) => {
  const input = await body(c, z.object({ text: z.string().max(4000) }));
  if (!input) return badRequest(c);
  const rules = await listRules(c.env.DB, c.get("guildId"));
  const decision = decidePriority(matchRules(input.text, rules), null);
  return c.json<RuleTestResultDTO>({
    matched: decision.match
      ? { ruleId: decision.match.rule.id, ruleName: decision.match.rule.name, keyword: decision.match.keyword }
      : null,
    priority: decision.priority,
    mentionRole: decision.mentionRole,
  });
});

// ── Activity log (live view polls with ?after=<last id>) ─────────────
guildApi.get("/events", async (c) => {
  const after = Number(c.req.query("after") ?? 0);
  const before = Number(c.req.query("before") ?? 0);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const db = c.env.DB;
  const guildId = c.get("guildId");
  const { results } =
    after > 0
      ? await db
          .prepare("SELECT * FROM (SELECT * FROM events WHERE guild_id = ? AND id > ? ORDER BY id ASC LIMIT ?) ORDER BY id DESC")
          .bind(guildId, after, limit)
          .all<EventRow>()
      : await db
          .prepare(`SELECT * FROM events WHERE guild_id = ? ${before > 0 ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`)
          .bind(...(before > 0 ? [guildId, before, limit] : [guildId, limit]))
          .all<EventRow>();
  return c.json(results.map(toEventDTO));
});

// ── Reports ──────────────────────────────────────────────────────────
async function stepsFor(db: D1Database, reportIds: number[]) {
  const steps = new Map<number, Partial<Record<JobType, JobStatus>>>();
  if (!reportIds.length) return steps;
  const { results } = await db
    .prepare(`SELECT id, report_id, status FROM jobs WHERE report_id IN (${reportIds.map(() => "?").join(",")})`)
    .bind(...reportIds)
    .all<{ id: string; report_id: number; status: JobStatus }>();
  for (const job of results) {
    const step = stepOf(job.id);
    if (!step) continue;
    steps.set(job.report_id, { ...steps.get(job.report_id), [step]: job.status });
  }
  return steps;
}

guildApi.get("/reports", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 50);
  const db = c.env.DB;
  const filter = status === "open" || status === "acknowledged" || status === "resolved" ? "AND status = ?" : "";
  const { results } = await db
    .prepare(`SELECT * FROM reports WHERE guild_id = ? ${filter} ORDER BY id DESC LIMIT ?`)
    .bind(...(filter ? [c.get("guildId"), status, limit] : [c.get("guildId"), limit]))
    .all<ReportRow>();
  const steps = await stepsFor(db, results.map((r) => r.id));
  return c.json(results.map((r) => toReportDTO(r, steps.get(r.id))));
});

guildApi.get("/reports/:reportId", async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("reportId"));
  const [report, jobs, events] = await db.batch([
    db.prepare("SELECT * FROM reports WHERE id = ? AND guild_id = ?").bind(id, c.get("guildId")),
    db.prepare("SELECT * FROM jobs WHERE report_id = ? AND guild_id = ? ORDER BY created_at").bind(id, c.get("guildId")),
    db.prepare("SELECT * FROM events WHERE report_id = ? AND guild_id = ? ORDER BY id").bind(id, c.get("guildId")),
  ]);
  const row = report?.results[0] as ReportRow | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  const jobRows = (jobs?.results ?? []) as JobRow[];
  const steps = await stepsFor(db, [id]);
  return c.json<ReportDetailDTO>({
    report: toReportDTO(row, steps.get(id)),
    jobs: jobRows.map(toJobDTO),
    events: ((events?.results ?? []) as EventRow[]).map(toEventDTO),
  });
});

// ── Jobs: failures, retries, manual retry ────────────────────────────
guildApi.get("/jobs", async (c) => {
  const problemsOnly = c.req.query("view") !== "all";
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM jobs WHERE guild_id = ?
     ${problemsOnly ? "AND (status IN ('retrying', 'dead') OR attempts > 1)" : ""}
     ORDER BY updated_at DESC LIMIT 100`,
  )
    .bind(c.get("guildId"))
    .all<JobRow>();
  return c.json(results.map(toJobDTO));
});

guildApi.post("/jobs/:jobId/retry", async (c) => {
  const db = c.env.DB;
  const jobId = c.req.param("jobId");
  const job = await requeueStatement(db, jobId, c.get("guildId"), Date.now()).first<JobRow>();
  if (!job) return c.json({ error: "not_found", message: "Only failed or retrying jobs can be retried" }, 404);
  await logConfig(c, "job.manual_retry", `Manual retry requested for job ${jobId}`).run();
  c.executionCtx.waitUntil(runJob({ env: c.env, now: Date.now, appUrl: appOrigin(c) }, registry, jobId, new Budget(4)));
  return c.json(toJobDTO(job));
});

// ── Stats for the overview tiles ─────────────────────────────────────
guildApi.get("/stats", async (c) => {
  const db = c.env.DB;
  const guildId = c.get("guildId");
  const since = Date.now() - DAY_MS;
  const [commands, reports, open, jobs, dups] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE guild_id = ? AND created_at >= ?").bind(guildId, since),
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE guild_id = ? AND created_at >= ?").bind(guildId, since),
    db.prepare("SELECT priority, COUNT(*) AS n FROM reports WHERE guild_id = ? AND status != 'resolved' GROUP BY priority").bind(guildId),
    db
      .prepare(
        `SELECT COALESCE(SUM(status IN ('pending', 'running')), 0) AS pending, COALESCE(SUM(status = 'retrying'), 0) AS retrying,
                COALESCE(SUM(status = 'dead'), 0) AS dead, COALESCE(SUM(status = 'succeeded' AND finished_at >= ?), 0) AS succeeded
         FROM jobs WHERE guild_id = ?`,
      )
      .bind(since, guildId),
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE guild_id = ? AND name = 'interaction.duplicate' AND created_at >= ?")
      .bind(guildId, since),
  ]);
  const openByPriority: Record<Priority, number> = { low: 0, normal: 0, high: 0, critical: 0 };
  for (const row of (open?.results ?? []) as { priority: Priority | null; n: number }[]) {
    if (row.priority) openByPriority[row.priority] += row.n;
    else openByPriority.normal += row.n; // still being triaged
  }
  const j = (jobs?.results[0] ?? {}) as Record<string, number>;
  const n = (r: D1Result | undefined) => (r?.results[0] as { n: number } | undefined)?.n ?? 0;
  return c.json<StatsDTO>({
    commands24h: n(commands),
    reports24h: n(reports),
    openReports: Object.values(openByPriority).reduce((a, b) => a + b, 0),
    openByPriority,
    jobs: { pending: j.pending ?? 0, retrying: j.retrying ?? 0, dead: j.dead ?? 0, succeeded24h: j.succeeded ?? 0 },
    duplicates24h: n(dups),
  });
});

// ── Fault injection: lets reviewers watch retries/backoff happen ─────
const FAULT_LABELS: Record<FaultName, string> = {
  mirrorDown: "mirror webhook outage",
  aiDown: "AI provider outage",
  aiSlow: "slow AI (+6 s)",
};

guildApi.put("/faults", async (c) => {
  const input = await body(
    c,
    z.object({ fault: z.enum(FAULT_NAMES), enabled: z.boolean(), minutes: z.number().int().min(1).max(30).default(10) }).strict(),
  );
  if (!input) return badRequest(c);
  const db = c.env.DB;
  const now = Date.now();
  const guild = await loadGuild(c);
  const faults = parseFaults(guild.faults);
  if (input.enabled) faults[input.fault] = now + input.minutes * 60_000;
  else delete faults[input.fault];
  await db.batch([
    db.prepare("UPDATE guilds SET faults = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(faults), now, guild.id),
    eventStatement(
      db,
      {
        guildId: guild.id,
        kind: "config",
        name: "fault.toggled",
        level: "warn",
        message: `Fault injection: ${FAULT_LABELS[input.fault]} ${input.enabled ? `ON for ${input.minutes} min` : "OFF"} (by ${c.get("admin").email})`,
      },
      now,
    ),
  ]);
  return c.json(toGuildSettings(await loadGuild(c), aiConfigured(c.env), Date.now()));
});
