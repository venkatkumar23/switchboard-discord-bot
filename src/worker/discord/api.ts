// Minimal Discord REST client. Maps failures onto RetryableError (429/5xx/network) and
// DiscordApiError (4xx, permanent) so the job runner can decide what to do.
import type { Env } from "../env";
import { PermanentError, RetryableError, asRetryable } from "../lib/errors";
import type { MessagePayload } from "./types";

const USER_AGENT = "DiscordBot (https://github.com/venkatkumar23/switchboard-discord-bot, 1.0)";
const SNOWFLAKE = /^\d{17,20}$/;

export class DiscordApiError extends PermanentError {
  override name = "DiscordApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Never let an interaction token / webhook token reach an error message or log line. */
function describe(method: string, path: string): string {
  return `${method} ${path.replace(/(\/webhooks\/\d+\/)[^/?]+/, "$1***")}`;
}

function snowflake(id: string): string {
  if (!SNOWFLAKE.test(id)) throw new PermanentError(`invalid Discord id: ${id.slice(0, 32)}`);
  return id;
}

interface CallOptions {
  body?: unknown;
  form?: URLSearchParams;
  auth?: "bot" | { basic: string };
  timeoutMs?: number;
}

async function call<T>(env: Env, method: string, path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  let body: string | undefined;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = opts.form.toString();
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (opts.auth === "bot") headers.Authorization = `Bot ${env.DISCORD_BOT_TOKEN}`;
  else if (opts.auth) headers.Authorization = `Basic ${opts.auth.basic}`;

  let res: Response;
  try {
    res = await fetch(`${env.DISCORD_API_BASE}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch (err) {
    throw asRetryable(err, describe(method, path));
  }

  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

  const info = (await res.json().catch(() => ({}))) as { message?: string; code?: number; retry_after?: number };
  const detail = `${describe(method, path)} → ${res.status}${info.message ? ` ${info.message}` : ""}${info.code ? ` (code ${info.code})` : ""}`;
  if (res.status === 429) {
    const seconds = info.retry_after ?? Number(res.headers.get("retry-after") ?? 1);
    throw new RetryableError(detail, Math.ceil(seconds * 1000));
  }
  if (res.status >= 500) throw new RetryableError(detail);
  throw new DiscordApiError(detail, res.status, info.code);
}

export interface RawChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id?: string | null;
}

export interface RawRole {
  id: string;
  name: string;
  color: number;
  position: number;
  mentionable: boolean;
  managed: boolean;
}

export interface OAuthTokenResponse {
  access_token: string;
  scope: string;
  guild?: { id: string; name: string; icon: string | null };
}

export function discord(env: Env) {
  return {
    createMessage: (channelId: string, payload: MessagePayload & { nonce?: string; enforce_nonce?: boolean }) =>
      call<{ id: string; channel_id: string }>(env, "POST", `/channels/${snowflake(channelId)}/messages`, {
        auth: "bot",
        body: payload,
      }),

    editMessage: (channelId: string, messageId: string, payload: MessagePayload) =>
      call<{ id: string }>(env, "PATCH", `/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}`, {
        auth: "bot",
        body: payload,
      }),

    /** Completes a deferred interaction response. Authenticated by the interaction token itself. */
    editOriginalResponse: (interactionToken: string, payload: MessagePayload) =>
      call<{ id: string }>(
        env,
        "PATCH",
        `/webhooks/${snowflake(env.DISCORD_APPLICATION_ID)}/${encodeURIComponent(interactionToken)}/messages/@original`,
        { body: payload },
      ),

    getGuild: (guildId: string) =>
      call<{ id: string; name: string; icon: string | null }>(env, "GET", `/guilds/${snowflake(guildId)}`, { auth: "bot" }),

    getGuildChannels: (guildId: string) =>
      call<RawChannel[]>(env, "GET", `/guilds/${snowflake(guildId)}/channels`, { auth: "bot" }),

    getGuildRoles: (guildId: string) =>
      call<RawRole[]>(env, "GET", `/guilds/${snowflake(guildId)}/roles`, { auth: "bot" }),

    exchangeOAuthCode: (code: string, redirectUri: string) =>
      call<OAuthTokenResponse>(env, "POST", "/oauth2/token", {
        form: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
        auth: { basic: btoa(`${env.DISCORD_APPLICATION_ID}:${env.DISCORD_CLIENT_SECRET ?? ""}`) },
      }),
  };
}

export type DiscordClient = ReturnType<typeof discord>;
