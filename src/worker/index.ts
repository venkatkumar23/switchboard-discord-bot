import { Hono } from "hono";
import type { HealthDTO, SecurityCounterDTO } from "../shared/types";
import { authApi } from "./api/auth";
import { guildApi } from "./api/guilds";
import { oauthApi } from "./api/oauth";
import type { AppEnv } from "./app";
import { requireAdmin, sameOriginWrites } from "./auth/middleware";
import { BOT_PERMISSIONS } from "./discord/types";
import type { Env } from "./env";
import { interactionsEndpoint } from "./interactions/endpoint";
import { errorMessage } from "./lib/errors";
import { log } from "./lib/log";
import { runScheduled } from "./scheduled";

const app = new Hono<AppEnv>();

// ── Discord ──────────────────────────────────────────────────────────
app.post("/interactions", interactionsEndpoint);
app.all("/interactions", (c) => c.text("Method Not Allowed", 405, { Allow: "POST" }));

// ── Dashboard API ────────────────────────────────────────────────────
const api = new Hono<AppEnv>();
api.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});
api.use("*", sameOriginWrites);

api.get("/health", async (c) => {
  const db = await c.env.DB.prepare("SELECT 1 AS ok")
    .first()
    .then(() => "ok" as const)
    .catch(() => "error" as const);
  return c.json<HealthDTO>({ ok: db === "ok", db, time: Date.now() }, db === "ok" ? 200 : 503);
});

/** Non-secret facts the login page shows (the application id is public). */
api.get("/public", (c) => {
  const appId = c.env.DISCORD_APPLICATION_ID;
  const inviteUrl = appId
    ? `https://discord.com/oauth2/authorize?${new URLSearchParams({
        client_id: appId,
        scope: "bot applications.commands",
        permissions: BOT_PERMISSIONS,
        integration_type: "0",
      })}`
    : null;
  return c.json({ inviteUrl });
});

api.route("/auth", authApi);

api.get("/security", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT reason, SUM(count) AS count, MAX(last_seen) AS lastSeen FROM security_counters
     WHERE bucket >= ? GROUP BY reason ORDER BY count DESC`,
  )
    .bind(Date.now() - 86_400_000)
    .all<SecurityCounterDTO>();
  return c.json(results);
});

api.use("/guilds/*", requireAdmin);
api.route("/guilds/:guildId", guildApi);

app.route("/api", api);
app.route("/oauth", oauthApi);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  log.error("http.unhandled", { method: c.req.method, path: c.req.path, error: errorMessage(err) });
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
