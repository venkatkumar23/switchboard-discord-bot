import { Hono } from "hono";
import { z } from "zod";
import type { MeDTO } from "../../shared/types";
import type { AppEnv } from "../app";
import { requireAdmin } from "../auth/middleware";
import { createSession, destroySession } from "../auth/session";
import { verifyPassword } from "../lib/crypto";
import { log } from "../lib/log";
import { toGuildSummary } from "./dto";

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
// Verified against when the email is unknown, so both paths cost one PBKDF2 run.
const DUMMY_HASH = "pbkdf2_sha256$100000$c3dpdGNoYm9hcmQtZHVtbXk=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export const authApi = new Hono<AppEnv>();

authApi.post("/login", async (c) => {
  const parsed = LoginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { email, password } = parsed.data;
  const db = c.env.DB;
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const now = Date.now();

  const throttle = await db
    .prepare("SELECT failures, window_start FROM login_throttle WHERE key = ?")
    .bind(ip)
    .first<{ failures: number; window_start: number }>();
  if (throttle && now - throttle.window_start < WINDOW_MS && throttle.failures >= MAX_FAILURES) {
    const retryAfterSeconds = Math.ceil((throttle.window_start + WINDOW_MS - now) / 1000);
    return c.json({ error: "too_many_attempts", retryAfterSeconds }, 429);
  }

  const admin = await db
    .prepare("SELECT id, email, password_hash FROM admins WHERE email = ?")
    .bind(email)
    .first<{ id: number; email: string; password_hash: string }>();
  const valid = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH);

  if (!admin || !valid) {
    await db
      .prepare(
        `INSERT INTO login_throttle (key, failures, window_start) VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           failures = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE failures + 1 END,
           window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END`,
      )
      .bind(ip, now, WINDOW_MS)
      .run();
    log.warn("auth.login_failed", { ip });
    return c.json({ error: "invalid_credentials" }, 401);
  }

  await db.prepare("DELETE FROM login_throttle WHERE key = ?").bind(ip).run();
  await createSession(c, admin.id);
  log.info("auth.login", { adminId: admin.id });
  return c.json({ ok: true });
});

authApi.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authApi.get("/me", requireAdmin, async (c) => {
  const admin = c.get("admin");
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.icon FROM admin_guilds ag JOIN guilds g ON g.id = ag.guild_id
     WHERE ag.admin_id = ? ORDER BY g.name COLLATE NOCASE`,
  )
    .bind(admin.id)
    .all<{ id: string; name: string; icon: string | null }>();
  return c.json<MeDTO>({ email: admin.email, guilds: results.map(toGuildSummary) });
});
