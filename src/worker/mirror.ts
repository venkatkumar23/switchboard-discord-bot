// The "second channel": a Slack Incoming Webhook or a Discord channel webhook.
// URLs are credentials: they are validated against an allow-list (no SSRF), encrypted at
// rest, never logged, and only ever displayed masked.
import { PermanentError, RetryableError, asRetryable } from "./lib/errors";

export type MirrorKind = "slack" | "discord";

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

export interface ClassifiedWebhook {
  kind: MirrorKind;
  url: string;
  hint: string;
}

export function classifyWebhookUrl(input: string): ClassifiedWebhook | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;

  const tail = (s: string) => `••••${s.slice(-4)}`;
  if (url.hostname === "hooks.slack.com" && /^\/services\/[\w]+\/[\w]+\/[\w]+\/?$/.test(url.pathname)) {
    return { kind: "slack", url: url.toString(), hint: `hooks.slack.com/services/…/${tail(url.pathname.replace(/\/$/, ""))}` };
  }
  const discord = /^\/api\/(?:v\d+\/)?webhooks\/(\d{17,20})\/([\w-]+)\/?$/.exec(url.pathname);
  if (DISCORD_HOSTS.has(url.hostname) && discord) {
    return { kind: "discord", url: url.toString(), hint: `discord.com/api/webhooks/${discord[1]}/${tail(discord[2]!)}` };
  }
  return null;
}

export interface MirrorMessage {
  title: string;
  /** Short "key: value" facts, rendered as a list. */
  facts: [string, string][];
  /** User-provided text (untrusted). */
  quote?: string;
  color: number;
  link?: { label: string; url: string };
}

/** Slack mrkdwn control characters; escaping them neutralises <!channel>-style injection. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toSlackPayload(m: MirrorMessage): Record<string, unknown> {
  const facts = m.facts.map(([k, v]) => `*${slackEscape(k)}:* ${slackEscape(v)}`).join("\n");
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: m.title.slice(0, 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: facts.slice(0, 2900) } },
  ];
  if (m.quote) {
    const quoted = slackEscape(m.quote.slice(0, 1500)).split("\n").map((l) => `>${l}`).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: quoted } });
  }
  if (m.link) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${m.link.url}|${slackEscape(m.link.label)}>` }],
    });
  }
  return { text: m.title, blocks };
}

export function toDiscordPayload(m: MirrorMessage): Record<string, unknown> {
  const description = [
    ...m.facts.map(([k, v]) => `**${k}:** ${v}`),
    ...(m.quote ? ["", m.quote.slice(0, 1500).split("\n").map((l) => `> ${l}`).join("\n")] : []),
    ...(m.link ? ["", `[${m.link.label}](${m.link.url})`] : []),
  ].join("\n");
  return {
    username: "Switchboard",
    embeds: [{ title: m.title.slice(0, 256), description: description.slice(0, 4000), color: m.color }],
    allowed_mentions: { parse: [] },
  };
}

export async function sendMirror(url: string, kind: MirrorKind, message: MirrorMessage): Promise<void> {
  const payload = kind === "slack" ? toSlackPayload(message) : toDiscordPayload(message);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    throw asRetryable(err, `${kind} webhook request`);
  }
  if (res.ok) return;

  // Error bodies are short codes ("no_service", "Unknown Webhook"), never the URL itself.
  const detail = (await res.text().catch(() => "")).slice(0, 120).replace(/\s+/g, " ");
  const msg = `${kind} webhook returned ${res.status}${detail ? ` (${detail})` : ""}`;
  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new RetryableError(msg, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  throw new PermanentError(`${msg} — check the webhook URL in Settings`);
}
