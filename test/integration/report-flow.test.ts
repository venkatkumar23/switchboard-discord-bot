// /report end to end: durable intake, deferral, idempotency, rules, form, and the deliveries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportRow } from "../../src/worker/db/rows";
import { ALERT_ROLE_ID, GUILD_ID, REPORT_CHANNEL_ID, member, modalSubmit, reportCommand } from "../helpers/discord";
import { FakeNet } from "../helpers/fake-net";
import { env, interact, rows, setupGuild } from "../helpers/worker";

let net: FakeNet;
beforeEach(() => {
  net = new FakeNet().install();
});
afterEach(() => vi.restoreAllMocks());

const reportFor = async (interactionId: string) =>
  (await rows<ReportRow>("SELECT * FROM reports WHERE interaction_id = ?", interactionId))[0]!;
const jobsFor = (reportId: number) =>
  rows<{ id: string; status: string; attempts: number }>("SELECT id, status, attempts FROM jobs WHERE report_id = ? ORDER BY id", reportId);
const eventNames = async (reportId: number) =>
  (await rows<{ name: string }>("SELECT name FROM events WHERE report_id = ? ORDER BY id", reportId)).map((e) => e.name);

describe("/report", () => {
  it("defers, records durably, then replies, posts with buttons and mirrors", async () => {
    await setupGuild();
    const interaction = reportCommand("The game server is down for everyone");

    const res = await interact(interaction);
    expect(res.body).toEqual({ type: 5, data: { flags: 64 } }); // deferred + ephemeral

    const report = await reportFor(interaction.id);
    expect(report).toMatchObject({
      status: "open",
      priority: "high",
      priority_source: "rule",
      rule_name: "Outage",
      matched_keyword: "down",
      ai_status: "done",
      ai_category: "outage",
      user_name: "Alice",
    });
    expect(await jobsFor(report.id)).toEqual([
      { id: `mirror:report:${report.id}`, status: "succeeded", attempts: 1 },
      { id: `post:${report.id}`, status: "succeeded", attempts: 1 },
      { id: `reply:${report.id}`, status: "succeeded", attempts: 1 },
      { id: `triage:${report.id}`, status: "succeeded", attempts: 1 },
    ]);

    const [reply] = net.to(/messages\/@original$/);
    expect(reply).toMatchObject({ method: "PATCH" });
    expect(reply!.url).toContain(interaction.token);
    expect(reply!.body.content).toContain(`report **#${report.id}**`);
    expect(reply!.body.allowed_mentions).toEqual({ parse: [] });

    const [post] = net.to(`/channels/${REPORT_CHANNEL_ID}/messages`);
    expect(post!.headers.authorization).toBe("Bot test-bot-token");
    expect(post!.body).toMatchObject({
      nonce: `rpt-${report.id}`,
      enforce_nonce: true,
      allowed_mentions: { parse: [], roles: [ALERT_ROLE_ID] },
    });
    expect(post!.body.components[0].components.map((b: { custom_id: string }) => b.custom_id)).toEqual([
      `rpt:ack:${report.id}`,
      `rpt:resolve:${report.id}`,
    ]);
    expect(report).toMatchObject({ posted_channel_id: REPORT_CHANNEL_ID, posted_message_id: "900000000000000001" });

    const [mirror] = net.to("hooks.slack.com");
    expect(JSON.stringify(mirror!.body)).toContain("down for everyone");

    expect(await eventNames(report.id)).toEqual(
      expect.arrayContaining(["report.filed", "report.triaged", "reply.sent", "post.sent", "mirror.sent"]),
    );
  });

  it("answers a redelivered interaction identically and does nothing twice", async () => {
    await setupGuild();
    const interaction = reportCommand("server down again");
    const first = await interact(interaction);
    const callsAfterFirst = net.calls.length;

    const second = await interact(interaction); // same id, freshly signed
    expect(second.status).toBe(200);
    expect(second.raw).toBe(first.raw);
    expect(net.calls).toHaveLength(callsAfterFirst);
    expect(await rows("SELECT id FROM reports")).toHaveLength(1);
    expect(await rows("SELECT id FROM jobs")).toHaveLength(4);
    expect(await rows("SELECT reason, count FROM security_counters")).toEqual([{ reason: "duplicate_interaction", count: 1 }]);
    expect(await rows("SELECT name FROM events WHERE name = 'interaction.duplicate'")).toHaveLength(1);
  });

  it("opens a form when no text is given, and files the submitted form", async () => {
    await setupGuild();
    const open = await interact(reportCommand());
    expect(open.body.type).toBe(9);
    expect(open.body.data.custom_id).toBe("report_modal");
    expect(await rows("SELECT id FROM reports")).toHaveLength(0);

    const submit = modalSubmit({ title: "Verification bot not working", details: "Since 10am nobody can verify." });
    const res = await interact(submit);
    expect(res.body.type).toBe(5);
    const report = await reportFor(submit.id);
    expect(report).toMatchObject({ title: "Verification bot not working", body: "Since 10am nobody can verify.", priority: "high" });
    expect(net.to(/messages\/@original$/)).toHaveLength(1);
  });

  it("enforces the per-user cooldown, but not across users", async () => {
    await setupGuild();
    await interact(reportCommand("first report"));
    const again = await interact(reportCommand("second report"));
    expect(again.body.data.content).toMatch(/Slow down/);
    expect(again.body.data.flags).toBe(64);

    const otherUser = await interact(reportCommand("someone else", { member: member({ id: "500000000000000002", name: "Bob" }) }));
    expect(otherUser.body.type).toBe(5);
    expect(await rows("SELECT id FROM reports")).toHaveLength(2);
    expect(await rows("SELECT outcome FROM interactions WHERE outcome = 'rejected:cooldown'")).toHaveLength(1);
  });

  it("refuses a command an admin disabled", async () => {
    await setupGuild();
    await env.DB.prepare(
      `INSERT INTO command_configs (guild_id, command, enabled, ephemeral, post_to_channel, mirror, cooldown_seconds, updated_at)
       VALUES (?, 'report', 0, 1, 1, 1, 0, 0)`,
    )
      .bind(GUILD_ID)
      .run();
    const res = await interact(reportCommand("anything"));
    expect(res.body.data.content).toMatch(/turned off/);
    expect(await rows("SELECT id FROM reports")).toHaveLength(0);
  });

  it("replies publicly when the command is configured that way", async () => {
    await setupGuild();
    await env.DB.prepare(
      `INSERT INTO command_configs (guild_id, command, enabled, ephemeral, post_to_channel, mirror, cooldown_seconds, updated_at)
       VALUES (?, 'report', 1, 0, 1, 0, 0, 0)`,
    )
      .bind(GUILD_ID)
      .run();
    const res = await interact(reportCommand("public please"));
    expect(res.body).toEqual({ type: 5, data: {} });
    expect(net.to("hooks.slack.com")).toHaveLength(0); // mirror turned off for /report
  });

  it("keeps user-typed mentions inert everywhere", async () => {
    await setupGuild();
    await interact(reportCommand("@everyone <@&400000000000000001> <!channel> typo on the rules page"));
    const [post] = net.to("/channels/");
    expect(post!.body.allowed_mentions).toEqual({ parse: [] }); // "Minor" rule doesn't ping
    const [mirror] = net.to("hooks.slack.com");
    expect(JSON.stringify(mirror!.body)).not.toContain("<!channel>");
    const [reply] = net.to(/@original$/);
    expect(reply!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("works in a server nobody configured yet: seeds rules, replies, and says why it skipped", async () => {
    const res = await interact(reportCommand("our site is down", { guild_id: "200000000000000077" }));
    expect(res.body.type).toBe(5);
    const report = (await rows<ReportRow>("SELECT * FROM reports"))[0]!;
    expect(report.priority).toBe("high"); // default "Outage" rule was seeded
    expect(await rows("SELECT id FROM rules WHERE guild_id = '200000000000000077'")).toHaveLength(3);
    expect(net.to(/@original$/)).toHaveLength(1);
    expect(net.to("/channels/")).toHaveLength(0);
    expect(await eventNames(report.id)).toEqual(expect.arrayContaining(["post.skipped", "mirror.skipped"]));
  });

  it("escalates to critical and pings when the AI says so, even without a keyword match", async () => {
    await setupGuild();
    net.aiReply = { summary: "Possible account takeover", category: "security", severity: "critical", tags: ["account"] };
    const interaction = reportCommand("someone logged into my account from another country");
    await interact(interaction);
    const report = await reportFor(interaction.id);
    expect(report).toMatchObject({ priority: "critical", priority_source: "ai", mention_role: 1 });
    expect(net.to("/channels/")[0]!.body.allowed_mentions).toEqual({ parse: [], roles: [ALERT_ROLE_ID] });
  });
});
