// Replaces globalThis.fetch for the Worker under test (it runs in the same isolate as the
// tests) with a scripted fake of Discord, Slack and the AI provider. Every call is recorded.
import { vi } from "vitest";

export interface Call {
  method: string;
  url: string;
  path: string;
  host: string;
  headers: Record<string, string>;
  body: any;
}

type Matcher = string | RegExp | ((call: Call) => boolean);

interface Override {
  match: (call: Call) => boolean;
  respond: (call: Call) => Response | Promise<Response>;
  remaining: number; // -1 = forever
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeNet {
  readonly calls: Call[] = [];
  private overrides: Override[] = [];
  private nextMessageId = 900000000000000001n;

  aiReply: Record<string, unknown> = {
    summary: "Members cannot log in to the game server",
    category: "outage",
    severity: "high",
    tags: ["login", "server"],
  };
  channels = [
    { id: "300000000000000001", name: "general", type: 0, position: 0, parent_id: null },
    { id: "300000000000000002", name: "reports", type: 0, position: 1, parent_id: null },
    { id: "300000000000000003", name: "voice", type: 2, position: 2, parent_id: null },
  ];
  roles = [
    { id: "200000000000000001", name: "@everyone", color: 0, position: 0, mentionable: false, managed: false },
    { id: "400000000000000001", name: "Moderators", color: 0xff0000, position: 2, mentionable: true, managed: false },
  ];
  oauthGuild: { id: string; name: string; icon: string | null } | null = {
    id: "200000000000000099",
    name: "Connected Server",
    icon: null,
  };

  install(): this {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(new Request(input, init)),
    );
    return this;
  }

  /** Make matching requests fail with `response` (`times` = -1 for "until removed"). */
  fail(match: Matcher, response: () => Response, times = 1): this {
    this.overrides.push({ match: toPredicate(match), respond: response, remaining: times });
    return this;
  }

  heal(): this {
    this.overrides = [];
    return this;
  }

  to(match: Matcher): Call[] {
    const predicate = toPredicate(match);
    return this.calls.filter(predicate);
  }

  private async handle(req: Request): Promise<Response> {
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay as text
    }
    const url = new URL(req.url);
    const call: Call = {
      method: req.method,
      url: req.url,
      path: url.pathname,
      host: url.host,
      headers: Object.fromEntries(req.headers),
      body,
    };
    this.calls.push(call);

    const override = this.overrides.find((o) => o.remaining !== 0 && o.match(call));
    if (override) {
      if (override.remaining > 0) override.remaining--;
      return override.respond(call);
    }
    return this.respond(call);
  }

  private respond(call: Call): Response {
    if (call.host === "ai.test") {
      return json({ choices: [{ message: { content: JSON.stringify(this.aiReply) } }] });
    }
    if (call.host === "discord.test") {
      if (/\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(call.path)) return json({ id: "1" });
      const post = /\/channels\/(\d+)\/messages$/.exec(call.path);
      if (post && call.method === "POST") return json({ id: String(this.nextMessageId++), channel_id: post[1] });
      if (/\/channels\/\d+\/messages\/\d+$/.test(call.path)) return json({ id: "1" });
      if (/\/guilds\/\d+\/channels$/.test(call.path)) return json(this.channels);
      if (/\/guilds\/\d+\/roles$/.test(call.path)) return json(this.roles);
      if (call.path.endsWith("/oauth2/token")) {
        return json({ access_token: "user-token", scope: "bot applications.commands identify", guild: this.oauthGuild });
      }
    }
    if (call.host === "hooks.slack.com") return new Response("ok");
    if (call.host === "discord.com" && call.path.startsWith("/api/webhooks/")) return new Response(null, { status: 204 });
    return new Response(`unexpected request in test: ${call.method} ${call.url}`, { status: 599 });
  }
}

function toPredicate(match: Matcher): (call: Call) => boolean {
  if (typeof match === "function") return match;
  if (typeof match === "string") return (c) => c.url.includes(match);
  return (c) => match.test(c.url);
}

export const status = (code: number, body = "") => () => new Response(body, { status: code });
export const discordError = (status: number, code: number, message: string) => () =>
  json({ code, message }, status);
