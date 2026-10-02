// "Connect a server": the admin adds the bot through Discord's OAuth2 bot flow. We exchange the
// code server-side (client secret) and trust only the guild Discord returns — never a guild_id
// from the query string — so nobody can claim a server they didn't authorise.
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { appOrigin, SNOWFLAKE, type AppContext, type AppEnv } from "../app";
import { cookieOptions, sessionAdmin } from "../auth/session";
import { discord } from "../discord/api";
import { BOT_PERMISSIONS } from "../discord/types";
import { defaultRuleStatements, eventStatement } from "../db/queries";
import { randomToken, sha256Hex } from "../lib/crypto";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/log";

const STATE_COOKIE = "sb_oauth_state";
const STATE_TTL_MS = 10 * 60_000;

export const oauthApi = new Hono<AppEnv>();

const redirectUri = (c: AppContext) => `${appOrigin(c)}/oauth/discord/callback`;

oauthApi.get("/discord/start", async (c) => {
  const admin = await sessionAdmin(c);
  if (!admin) return c.redirect("/login?next=/connect");
  if (!c.env.DISCORD_CLIENT_SECRET) return c.redirect("/connect?error=not_configured");

  const state = randomToken(24);
  await c.env.DB.prepare("INSERT INTO oauth_states (state_hash, admin_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(state), admin.id, Date.now() + STATE_TTL_MS)
    .run();
  // Bind the state to this browser as well as to the admin account.
  setCookie(c, STATE_COOKIE, state, cookieOptions(c, STATE_TTL_MS));

  const params = new URLSearchParams({
    client_id: c.env.DISCORD_APPLICATION_ID,
    // `identify` alongside `bot` makes Discord return a code we can exchange for the guild.
    scope: "bot applications.commands identify",
    permissions: BOT_PERMISSIONS,
    response_type: "code",
    redirect_uri: redirectUri(c),
    integration_type: "0",
    state,
  });
  const hint = c.req.query("guild");
  if (hint && SNOWFLAKE.test(hint)) params.set("guild_id", hint);
  return c.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

oauthApi.get("/discord/callback", async (c) => {
  const fail = (code: string) => {
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    return c.redirect(`/connect?error=${code}`);
  };
  const { code, state, error } = c.req.query();
  if (error) return fail(error === "access_denied" ? "cancelled" : "discord_error");

  const admin = await sessionAdmin(c);
  if (!admin) return c.redirect("/login?next=/connect");
  const cookieState = getCookie(c, STATE_COOKIE);
  if (!code || !state || state !== cookieState) return fail("invalid_state");

  const db = c.env.DB;
  // Single use: the DELETE both validates and consumes the state.
  const claimed = await db
    .prepare("DELETE FROM oauth_states WHERE state_hash = ? AND admin_id = ? AND expires_at > ? RETURNING admin_id")
    .bind(await sha256Hex(state), admin.id, Date.now())
    .first();
  if (!claimed) return fail("invalid_state");

  let guild: { id: string; name: string; icon: string | null } | undefined;
  try {
    guild = (await discord(c.env).exchangeOAuthCode(code, redirectUri(c))).guild;
  } catch (err) {
    log.warn("oauth.exchange_failed", { error: errorMessage(err) });
    return fail("exchange_failed");
  }
  if (!guild || !SNOWFLAKE.test(guild.id)) return fail("no_guild");

  const now = Date.now();
  const [created] = await db.batch([
    db
      .prepare("INSERT INTO guilds (id, name, icon, connected_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(guild.id, guild.name, guild.icon, now, now, now),
    db
      .prepare("UPDATE guilds SET name = ?, icon = ?, connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE id = ?")
      .bind(guild.name, guild.icon, now, now, guild.id),
    db
      .prepare("INSERT INTO admin_guilds (admin_id, guild_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(admin.id, guild.id, now),
    eventStatement(
      db,
      { guildId: guild.id, kind: "config", name: "guild.connected", message: `Server “${guild.name}” connected by ${admin.email}` },
      now,
    ),
  ]);
  if (created?.meta.changes === 1) await db.batch(defaultRuleStatements(db, guild.id, now));

  deleteCookie(c, STATE_COOKIE, { path: "/" });
  log.info("oauth.guild_connected", { guildId: guild.id, adminId: admin.id });
  return c.redirect(`/g/${guild.id}/settings?connected=1`);
});
