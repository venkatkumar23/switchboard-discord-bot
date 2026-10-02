// Unhappy paths: downstream outages, permanent errors, rate limits, crashes, exhaustion.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow, ReportRow } from "../../src/worker/db/rows";
import { claimJob } from "../../src/worker/jobs/queue";
import { GUILD_ID, reportCommand } from "../helpers/discord";
import { FakeNet, discordError, status } from "../helpers/fake-net";
import { env, interact, loginAs, rows, runCron, setupAdmin, setupGuild } from "../helpers/worker";

let net: FakeNet;
beforeEach(() => {
  net = new FakeNet().install();
});
afterEach(() => vi.restoreAllMocks());

const job = async (id: string) => (await rows<JobRow>("SELECT * FROM jobs WHERE id = ?", id))[0]!;
const onlyReport = async () => (await rows<ReportRow>("SELECT * FROM reports"))[0]!;
const MIN = 60_000;

describe("downstream outages", () => {
  it("mirror down: the user is still answered; the mirror retries with backoff until it recovers", async () => {
    await setupGuild();
    net.fail("hooks.slack.com", status(503, "upstream unavailable"), -1);
    await interact(reportCommand("server is down"));
    const report = await onlyReport();

    expect((await job(`reply:${report.id}`)).status).toBe("succeeded");
    expect((await job(`post:${report.id}`)).status).toBe("succeeded");
    let mirror = await job(`mirror:report:${report.id}`);
    expect(mirror).toMatchObject({ status: "retrying", attempts: 1 });
    expect(mirror.last_error).toContain("503");
    expect(mirror.run_after).toBeGreaterThan(Date.now() + 20_000);
    expect(await rows("SELECT message FROM events WHERE name = 'mirror.retrying'")).toHaveLength(1);

    await runCron(1 * MIN); // still down
    mirror = await job(`mirror:report:${report.id}`);
    expect(mirror).toMatchObject({ status: "retrying", attempts: 2 });

    net.heal();
    await runCron(10 * MIN);
    mirror = await job(`mirror:report:${report.id}`);
    expect(mirror).toMatchObject({ status: "succeeded", attempts: 3, last_error: null });
    expect(await rows("SELECT id FROM events WHERE name = 'mirror.sent'")).toHaveLength(1);
  });

  it("AI down: falls back to keyword rules at once, then enriches when the AI is back", async () => {
    await setupGuild();
    net.fail("ai.test", status(500, "model overloaded"), -1);
    await interact(reportCommand("login is not working"));
    let report = await onlyReport();
    expect(report).toMatchObject({ ai_status: "failed", priority: "high", priority_source: "rule" });
    expect(report.ai_error).toContain("500");
    expect((await job(`reply:${report.id}`)).status).toBe("succeeded");
    expect((await job(`post:${report.id}`)).status).toBe("succeeded");
    expect((await job(`enrich:${report.id}`)).status).toBe("pending");

    net.heal();
    net.aiReply = { summary: "Login outage", category: "outage", severity: "critical", tags: [] };
    await runCron(2 * MIN);
    report = await onlyReport();
    expect(report).toMatchObject({ ai_status: "done", ai_summary: "Login outage", priority: "critical", priority_source: "ai" });
    const [edit] = net.to(new RegExp(`/channels/\\d+/messages/${report.posted_message_id}$`));
    expect(edit!.method).toBe("PATCH");
    expect(JSON.stringify(edit!.body.embeds)).toContain("Login outage");
  });

  it("Discord rate limit: the reply is retried no sooner than retry_after", async () => {
    await setupGuild();
    net.fail(
      /@original$/,
      () => new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 120 }), { status: 429 }),
    );
    await interact(reportCommand("rate limit me"));
    const reply = await job(`reply:${(await onlyReport()).id}`);
    expect(reply.status).toBe("retrying");
    expect(reply.run_after).toBeGreaterThanOrEqual(Date.now() + 115_000);
  });

  it("missing channel permissions dead-letter at once with an actionable message", async () => {
    await setupGuild();
    net.fail("/channels/", discordError(403, 50001, "Missing Access"), -1);
    await interact(reportCommand("cannot post this"));
    const report = await onlyReport();
    const post = await job(`post:${report.id}`);
    expect(post).toMatchObject({ status: "dead", attempts: 1 });
    expect(post.last_error).toMatch(/Missing Access.*View Channel/);
    expect((await job(`reply:${report.id}`)).status).toBe("succeeded");
    expect(await rows("SELECT level FROM events WHERE name = 'post.dead'")).toEqual([{ level: "error" }]);
  });

  it("a job whose Worker died mid-run is reclaimed after its lease and re-posts idempotently", async () => {
    await setupGuild();
    // Simulate a crash during the post: the job is stuck in "running" and the message id never got saved.
    await interact(reportCommand("server down"));
    const report = await onlyReport();
    await env.DB.prepare("UPDATE jobs SET status = 'running', locked_until = ? WHERE id = ?")
      .bind(Date.now() - 1, `post:${report.id}`)
      .run();
    await env.DB.prepare("UPDATE reports SET posted_message_id = NULL WHERE id = ?").bind(report.id).run();
    const before = net.to("/channels/").length;

    await runCron(); // lease expired → reclaimed
    expect((await job(`post:${report.id}`)).status).toBe("succeeded");
    const [, retried] = net.to("/channels/").slice(before - 1);
    expect(retried!.body.nonce).toBe(`rpt-${report.id}`); // Discord dedups via enforce_nonce
  });
});

describe("job queue mechanics", () => {
  it("only one runner can hold a job's lease", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs (id, guild_id, type, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES ('mirror:test:x', ?, 'mirror', '{"kind":"test","requestedBy":"t"}', 'pending', 0, 8, ?, ?, ?)`,
    )
      .bind(GUILD_ID, now, now, now)
      .run();
    const [a, b] = await Promise.all([claimJob(env.DB, "mirror:test:x", now), claimJob(env.DB, "mirror:test:x", now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("exhausted jobs are dead-lettered and an admin can retry them from the dashboard", async () => {
    await setupGuild();
    await setupAdmin("admin@test.dev", "pw-123456", [GUILD_ID]);
    net.fail("hooks.slack.com", status(502), -1);
    await interact(reportCommand("server down"));
    const id = `mirror:report:${(await onlyReport()).id}`;

    for (let i = 1; i <= 10 && (await job(id)).status !== "dead"; i++) await runCron(i * 40 * MIN);
    const dead = await job(id);
    expect(dead).toMatchObject({ status: "dead", attempts: 8 });
    expect(await rows("SELECT level FROM events WHERE name = 'mirror.dead'")).toEqual([{ level: "error" }]);

    net.heal();
    const { api } = await loginAs("admin@test.dev", "pw-123456");
    const res = await api("POST", `/api/guilds/${GUILD_ID}/jobs/${encodeURIComponent(id)}/retry`);
    expect(res.status).toBe(200);
    expect(await job(id)).toMatchObject({ status: "succeeded", attempts: 9, max_attempts: 11 });
  });

  it("fault injection simulates a mirror outage without calling the webhook", async () => {
    await setupGuild();
    await env.DB.prepare("UPDATE guilds SET faults = ? WHERE id = ?")
      .bind(JSON.stringify({ mirrorDown: Date.now() + 10 * MIN }), GUILD_ID)
      .run();
    await interact(reportCommand("server down"));
    const id = `mirror:report:${(await onlyReport()).id}`;
    expect(await job(id)).toMatchObject({ status: "retrying" });
    expect((await job(id)).last_error).toMatch(/simulated mirror outage/);
    expect(net.to("hooks.slack.com")).toHaveLength(0);

    await env.DB.prepare("UPDATE guilds SET faults = '{}' WHERE id = ?").bind(GUILD_ID).run();
    await runCron(2 * MIN);
    expect(await job(id)).toMatchObject({ status: "succeeded" });
  });

  it("tells the user nothing was filed if the database is unavailable at intake", async () => {
    await setupGuild();
    vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("D1_ERROR: storage unavailable"));
    const res = await interact(reportCommand("server down"));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ flags: 64 });
    expect(res.body.data.content).toMatch(/couldn't record that/);
    expect(net.calls).toHaveLength(0);
  });
});
