// Dashboard API: auth, tenant isolation, CSRF, secret handling, config → behaviour, OAuth.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUILD_ID, OTHER_GUILD_ID, REPORT_CHANNEL_ID, reportCommand } from "../helpers/discord";
import { FakeNet } from "../helpers/fake-net";
import { SLACK_URL, call, env, interact, loginAs, rows, setupAdmin, setupGuild } from "../helpers/worker";

let net: FakeNet;
beforeEach(async () => {
  net = new FakeNet().install();
  await setupGuild();
  await setupGuild({ id: OTHER_GUILD_ID });
  await setupAdmin("alice@test.dev", "alice-password", [GUILD_ID]);
  await setupAdmin("bob@test.dev", "bob-password", [OTHER_GUILD_ID]);
});
afterEach(() => vi.restoreAllMocks());

const G = `/api/guilds/${GUILD_ID}`;

describe("authentication", () => {
  it("rejects bad credentials and throttles repeated failures", async () => {
    for (let i = 0; i < 5; i++) expect((await loginAs("alice@test.dev", "nope")).status).toBe(401);
    expect((await loginAs("alice@test.dev", "alice-password")).status).toBe(429);
  });

  it("sets a hardened session cookie and serves /me", async () => {
    const res = await call(
      new Request("https://switchboard.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://switchboard.test" },
        body: JSON.stringify({ email: "ALICE@test.dev", password: "alice-password" }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // the DB stores only a hash of the session token
    const token = cookie.split(";")[0]!.split("=")[1]!;
    expect(await rows("SELECT token_hash FROM sessions WHERE token_hash = ?", token)).toHaveLength(0);

    const { api } = await loginAs("alice@test.dev", "alice-password");
    const me = await api("GET", "/api/auth/me");
    expect(me.body).toEqual({ email: "alice@test.dev", guilds: [{ id: GUILD_ID, name: "Test Server", iconUrl: null }] });
  });

  it("requires a session for every guild endpoint and ends it on logout", async () => {
    expect((await call(new Request(`https://switchboard.test${G}/events`))).status).toBe(401);
    const { api } = await loginAs("alice@test.dev", "alice-password");
    expect((await api("GET", `${G}/events`)).status).toBe(200);
    await api("POST", "/api/auth/logout");
    expect((await api("GET", `${G}/events`)).status).toBe(401);
  });
});

describe("tenant isolation", () => {
  it("an admin cannot read or change another tenant's server", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    expect((await api("GET", `/api/guilds/${OTHER_GUILD_ID}`)).status).toBe(404);
    expect((await api("GET", `/api/guilds/${OTHER_GUILD_ID}/events`)).status).toBe(404);
    expect((await api("PUT", `/api/guilds/${OTHER_GUILD_ID}/mirror`, { url: SLACK_URL })).status).toBe(404);
  });

  it("refuses a report channel that belongs to a different server", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    const res = await api("PATCH", `${G}/settings`, { postChannelId: "399999999999999999" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not in this server/);
    const ok = await api("PATCH", `${G}/settings`, { postChannelId: REPORT_CHANNEL_ID });
    expect(ok.body.postChannelId).toBe(REPORT_CHANNEL_ID);
  });
});

describe("CSRF", () => {
  it("rejects cross-site state-changing requests", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    expect((await api("PUT", `${G}/faults`, { fault: "mirrorDown", enabled: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await api("PUT", `${G}/faults`, { fault: "mirrorDown", enabled: true }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });
});

describe("mirror webhook secrecy", () => {
  it("validates, encrypts at rest, and only ever returns a masked hint", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    expect((await api("PUT", `${G}/mirror`, { url: "https://attacker.example/hook" })).status).toBe(400);

    const res = await api("PUT", `${G}/mirror`, { url: SLACK_URL });
    expect(res.status).toBe(200);
    expect(res.body.mirror).toMatchObject({ configured: true, kind: "slack" });
    const everything = JSON.stringify((await api("GET", G)).body) + JSON.stringify((await api("GET", `${G}/events`)).body);
    expect(everything).not.toContain("abcdefghijklmnopqrstuvwx");

    const [row] = await rows<{ mirror_url_enc: string }>("SELECT mirror_url_enc FROM guilds WHERE id = ?", GUILD_ID);
    expect(row!.mirror_url_enc.startsWith("v1.")).toBe(true);
    expect(row!.mirror_url_enc).not.toContain("hooks.slack.com");
  });

  it("sends a test message through the real job pipeline", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    const res = await api("POST", `${G}/mirror/test`);
    expect(res.body.job).toMatchObject({ type: "mirror", status: "succeeded", attempts: 1 });
    expect(JSON.stringify(net.to("hooks.slack.com")[0]!.body)).toContain("alice@test.dev");
  });
});

describe("configuration drives behaviour", () => {
  it("command settings change how /report answers", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    const res = await api("PUT", `${G}/commands/report`, {
      enabled: true,
      ephemeral: false,
      postToChannel: false,
      mirror: false,
      cooldownSeconds: 0,
    });
    expect(res.status).toBe(200);
    expect((await api("GET", `${G}/commands`)).body[0]).toMatchObject({ command: "report", ephemeral: false, mirror: false });

    const reply = await interact(reportCommand("server down"));
    expect(reply.body).toEqual({ type: 5, data: {} });
    expect(net.to("/channels/")).toHaveLength(0);
    expect(net.to("hooks.slack.com")).toHaveLength(0);
  });

  it("rules can be created, tested, reordered and deleted", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    const created = await api("POST", `${G}/rules`, {
      name: "Payments",
      keywords: ["Refund", "charged twice", "refund"],
      priority: "critical",
      mentionRole: true,
      enabled: true,
    });
    expect(created.status).toBe(201);
    const rule = created.body.find((r: { name: string }) => r.name === "Payments");
    expect(rule.keywords).toEqual(["refund", "charged twice"]);

    const test = await api("POST", `${G}/rules/test`, { text: "I was CHARGED   twice" });
    expect(test.body).toEqual({ matched: { ruleId: rule.id, ruleName: "Payments", keyword: "charged twice" }, priority: "critical", mentionRole: true });

    const ids = created.body.map((r: { id: number }) => r.id).reverse();
    expect((await api("POST", `${G}/rules/reorder`, { ids })).body.map((r: { id: number }) => r.id)).toEqual(ids);

    expect((await api("DELETE", `${G}/rules/${rule.id}`)).status).toBe(200);
    expect((await api("POST", `${G}/rules/test`, { text: "refund please" })).body.matched).toBeNull();
    expect((await api("POST", `${G}/rules`, { name: "", keywords: [], priority: "urgent" })).status).toBe(400);
  });

  it("fault switches expire on their own and are logged", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    const on = await api("PUT", `${G}/faults`, { fault: "aiDown", enabled: true, minutes: 5 });
    expect(on.body.faults.aiDown).toBeGreaterThan(Date.now());
    const off = await api("PUT", `${G}/faults`, { fault: "aiDown", enabled: false });
    expect(off.body.faults).toEqual({});
    expect(await rows("SELECT level FROM events WHERE name = 'fault.toggled'")).toHaveLength(2);
  });
});

describe("activity feed, reports and jobs", () => {
  it("polls new events after a cursor and exposes report pipeline steps", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    const before = (await api("GET", `${G}/events`)).body;
    const cursor = before[0]?.id ?? 0;

    await interact(reportCommand("server down"));
    const fresh = (await api("GET", `${G}/events?after=${cursor}`)).body as { name: string; id: number }[];
    expect(fresh.map((e) => e.name)).toEqual(expect.arrayContaining(["report.filed", "post.sent", "mirror.sent"]));
    expect(fresh[0]!.id).toBeGreaterThan(fresh[fresh.length - 1]!.id); // newest first

    const [report] = (await api("GET", `${G}/reports`)).body;
    expect(report.steps).toEqual({ triage: "succeeded", reply: "succeeded", post: "succeeded", mirror: "succeeded" });
    const detail = (await api("GET", `${G}/reports/${report.id}`)).body;
    expect(detail.jobs).toHaveLength(4);
    expect(detail.report.postedMessageUrl).toMatch(/^https:\/\/discord\.com\/channels\//);

    const stats = (await api("GET", `${G}/stats`)).body;
    expect(stats).toMatchObject({ commands24h: 1, reports24h: 1, openReports: 1, jobs: { dead: 0, retrying: 0 } });
  });

  it("never exposes interaction tokens", async () => {
    const { api } = await loginAs("alice@test.dev", "alice-password");
    const interaction = reportCommand("server down");
    await interact(interaction);
    const dump = JSON.stringify([
      (await api("GET", `${G}/events`)).body,
      (await api("GET", `${G}/reports`)).body,
      (await api("GET", `${G}/jobs?view=all`)).body,
    ]);
    expect(dump).not.toContain(interaction.token);
  });
});

describe("connect a server (OAuth2)", () => {
  async function startFlow() {
    const { cookie } = await loginAs("alice@test.dev", "alice-password");
    const res = await call(new Request("https://switchboard.test/oauth/discord/start", { headers: { cookie } }));
    const location = new URL(res.headers.get("location")!);
    const stateCookie = res.headers.getSetCookie().find((c) => c.startsWith("sb_oauth_state="))!.split(";")[0]!;
    return { cookie: `${cookie}; ${stateCookie}`, location, state: location.searchParams.get("state")! };
  }

  const callback = (cookie: string, query: string) =>
    call(new Request(`https://switchboard.test/oauth/discord/callback?${query}`, { headers: { cookie } }));

  it("redirects to Discord with a CSRF state and our callback", async () => {
    const { location, state } = await startFlow();
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("https://switchboard.test/oauth/discord/callback");
    expect(location.searchParams.get("scope")).toContain("bot");
    expect(state.length).toBeGreaterThan(20);
  });

  it("links the server Discord reports back — and only with a valid, single-use state", async () => {
    const { cookie, state } = await startFlow();
    const forged = await callback(cookie, `code=abc&state=forged`);
    expect(forged.headers.get("location")).toBe("/connect?error=invalid_state");

    const ok = await callback(cookie, `code=abc&state=${state}&guild_id=200000000000000001`);
    expect(ok.headers.get("location")).toBe("/g/200000000000000099/settings?connected=1");
    const [exchange] = net.to("/oauth2/token");
    expect(exchange!.headers.authorization).toBe(`Basic ${btoa(`${env.DISCORD_APPLICATION_ID}:test-client-secret`)}`);
    // the guild comes from Discord's token response, not the guild_id query hint
    expect(await rows("SELECT guild_id FROM admin_guilds WHERE guild_id = '200000000000000099'")).toHaveLength(1);
    expect(await rows("SELECT id FROM rules WHERE guild_id = '200000000000000099'")).toHaveLength(3);

    const replay = await callback(cookie, `code=abc&state=${state}`);
    expect(replay.headers.get("location")).toBe("/connect?error=invalid_state");
  });

  it("reports a cancelled authorisation", async () => {
    const { cookie } = await startFlow();
    const res = await callback(cookie, "error=access_denied");
    expect(res.headers.get("location")).toBe("/connect?error=cancelled");
  });
});

describe("health", () => {
  it("reports database health without auth", async () => {
    const res = await call(new Request("https://switchboard.test/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: "ok" });
  });
});
