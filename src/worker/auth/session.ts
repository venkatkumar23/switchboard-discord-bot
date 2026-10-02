import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { Admin, AppContext } from "../app";
import { randomToken, sha256Hex } from "../lib/crypto";

export const SESSION_COOKIE = "sb_session";
const SESSION_TTL_MS = 7 * 86_400_000;

export function cookieOptions(c: AppContext, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/** The cookie holds a random token; D1 only ever sees its SHA-256. */
export async function createSession(c: AppContext, adminId: number): Promise<void> {
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), adminId, now, now + SESSION_TTL_MS)
    .run();
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c, SESSION_TTL_MS));
}

export async function sessionAdmin(c: AppContext): Promise<Admin | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  return c.env.DB.prepare(
    `SELECT a.id, a.email FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<Admin>();
}

export async function destroySession(c: AppContext): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
