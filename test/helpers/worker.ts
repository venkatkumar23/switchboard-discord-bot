// Drives the real Worker (same module the deploy uses) against the test D1 database.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../../src/worker/index";
import type { Interaction } from "../../src/worker/discord/types";
import { encryptSecret, hashPassword } from "../../src/worker/lib/crypto";
import { registry } from "../../src/worker/jobs/handlers";
import { runDueJobs } from "../../src/worker/jobs/runner";
import { ALERT_ROLE_ID, GUILD_ID, REPORT_CHANNEL_ID, signedRequest, type SignOptions } from "./discord";

export { env };

/** Sends a request and waits for everything it scheduled with waitUntil (the job pipeline). */
export async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function interact(interaction: Interaction | string, opts?: SignOptions) {
  const res = await call(signedRequest(interaction, opts));
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain-text error bodies
  }
  return { status: res.status, body, raw: text };
}

/** Runs the cron job runner as if `advanceMs` had passed. */
export function runCron(advanceMs = 0) {
  return runDueJobs({ env, now: () => Date.now() + advanceMs, appUrl: "https://switchboard.test" }, registry);
}

export const SLACK_URL = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnopqrstuvwx";
export const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/600000000000000001/very-secret-webhook-token";

export interface GuildSetup {
  id?: string;
  channel?: boolean;
  mirror?: "slack" | "discord" | null;
  alertRole?: boolean;
  ai?: boolean;
  moderatorsOnly?: boolean;
}

export async function setupGuild(opts: GuildSetup = {}): Promise<string> {
  const id = opts.id ?? GUILD_ID;
  const now = Date.now();
  const mirror = opts.mirror === undefined ? "slack" : opts.mirror;
  const mirrorUrl = mirror === "slack" ? SLACK_URL : mirror === "discord" ? DISCORD_WEBHOOK_URL : null;
  await env.DB.prepare(
    `INSERT INTO guilds (id, name, post_channel_id, alert_role_id, mirror_url_enc, mirror_kind, mirror_hint,
                         moderators_only, ai_enabled, created_at, updated_at)
     VALUES (?, 'Test Server', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.channel === false ? null : REPORT_CHANNEL_ID,
      opts.alertRole === false ? null : ALERT_ROLE_ID,
      mirrorUrl ? await encryptSecret(mirrorUrl, env.ENCRYPTION_KEY) : null,
      mirror,
      mirror ? "masked" : null,
      opts.moderatorsOnly === false ? 0 : 1,
      opts.ai === false ? 0 : 1,
      now,
      now,
    )
    .run();
  await env.DB.batch(
    [
      ["Security incident", ["hacked", "phishing"], "critical", 1, 0],
      ["Outage", ["down", "not working"], "high", 1, 1],
      ["Minor", ["typo"], "low", 0, 2],
    ].map(([name, keywords, priority, mention, position]) =>
      env.DB.prepare(
        `INSERT INTO rules (guild_id, name, keywords, priority, mention_role, enabled, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(id, name, JSON.stringify(keywords), priority, mention, position, now, now),
    ),
  );
  return id;
}

export async function setupAdmin(email: string, password: string, guildIds: string[]): Promise<void> {
  const now = Date.now();
  const admin = await env.DB.prepare("INSERT INTO admins (email, password_hash, created_at) VALUES (?, ?, ?) RETURNING id")
    .bind(email, await hashPassword(password), now)
    .first<{ id: number }>();
  for (const guildId of guildIds) {
    await env.DB.prepare("INSERT INTO admin_guilds (admin_id, guild_id, created_at) VALUES (?, ?, ?)").bind(admin!.id, guildId, now).run();
  }
}

/** Logs in and returns a fetch helper that carries the session cookie (same-origin). */
export async function loginAs(email: string, password: string) {
  const res = await call(
    new Request("https://switchboard.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://switchboard.test" },
      body: JSON.stringify({ email, password }),
    }),
  );
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await call(
      new Request(`https://switchboard.test${path}`, {
        method,
        headers: { cookie, origin: "https://switchboard.test", ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      }),
    );
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON
    }
    return { status: r.status, body: json, headers: r.headers };
  };
  return { status: res.status, cookie, api };
}

export async function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...params).all<T>();
  return results;
}
