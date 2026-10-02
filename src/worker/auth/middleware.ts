import { createMiddleware } from "hono/factory";
import { SNOWFLAKE, type AppEnv } from "../app";
import { sessionAdmin } from "./session";

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const admin = await sessionAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  c.set("admin", admin);
  await next();
});

/** Tenant isolation: the admin must be linked to the server named in the URL. */
export const requireGuildAccess = createMiddleware<AppEnv>(async (c, next) => {
  const guildId = c.req.param("guildId");
  if (!guildId || !SNOWFLAKE.test(guildId)) return c.json({ error: "not_found" }, 404);
  const link = await c.env.DB.prepare("SELECT 1 AS ok FROM admin_guilds WHERE admin_id = ? AND guild_id = ?")
    .bind(c.get("admin").id, guildId)
    .first();
  // 404 rather than 403: don't confirm that another tenant's server exists.
  if (!link) return c.json({ error: "not_found" }, 404);
  c.set("guildId", guildId);
  await next();
});

/**
 * CSRF defence in depth. Session cookies are SameSite=Lax already; on top of that, refuse
 * state-changing requests that a browser marks as cross-site.
 */
export const sameOriginWrites = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (c.req.header("sec-fetch-site") === "cross-site" || (origin && origin !== new URL(c.req.url).origin)) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  await next();
});
