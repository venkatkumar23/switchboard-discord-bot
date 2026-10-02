// Message components (buttons) and the synchronous /status command.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportRow } from "../../src/worker/db/rows";
import { OTHER_GUILD_ID, buttonClick, member, reportCommand, statusCommand } from "../helpers/discord";
import { FakeNet } from "../helpers/fake-net";
import { interact, rows, setupGuild } from "../helpers/worker";

let net: FakeNet;
beforeEach(() => {
  net = new FakeNet().install();
});
afterEach(() => vi.restoreAllMocks());

async function fileReport(text = "the server is down"): Promise<ReportRow> {
  const interaction = reportCommand(text);
  await interact(interaction);
  return (await rows<ReportRow>("SELECT * FROM reports WHERE interaction_id = ?", interaction.id))[0]!;
}

const buttonIds = (body: any) => body.data.components[0].components.map((b: { custom_id: string }) => b.custom_id);
const statusField = (body: any) => body.data.embeds[0].fields.find((f: { name: string }) => f.name === "Status").value;

describe("report buttons", () => {
  it("acknowledge → resolve → reopen update the message in place and mirror each change", async () => {
    await setupGuild();
    const report = await fileReport();
    const mirrorsBefore = net.to("hooks.slack.com").length;

    const ack = await interact(buttonClick(`rpt:ack:${report.id}`));
    expect(ack.body.type).toBe(7);
    expect(statusField(ack.body)).toContain("Acknowledged by Mod Mia");
    expect(buttonIds(ack.body)).toEqual([`rpt:resolve:${report.id}`]);

    const resolve = await interact(buttonClick(`rpt:resolve:${report.id}`));
    expect(statusField(resolve.body)).toContain("Resolved by Mod Mia");
    expect(buttonIds(resolve.body)).toEqual([`rpt:reopen:${report.id}`]);

    const reopen = await interact(buttonClick(`rpt:reopen:${report.id}`));
    expect(buttonIds(reopen.body)).toEqual([`rpt:ack:${report.id}`, `rpt:resolve:${report.id}`]);

    const mirrors = net.to("hooks.slack.com").slice(mirrorsBefore).map((c) => JSON.stringify(c.body));
    expect(mirrors).toHaveLength(3);
    expect(mirrors[0]).toContain("acknowledged by Mod Mia");
    expect(mirrors[1]).toContain("resolved by Mod Mia");
    expect((await rows<ReportRow>("SELECT * FROM reports"))[0]).toMatchObject({ status: "open", acked_by: null });
  });

  it("only moderators can press them when moderators-only is on", async () => {
    await setupGuild();
    const report = await fileReport();
    const res = await interact(buttonClick(`rpt:resolve:${report.id}`, { member: member() }));
    expect(res.body.data.content).toMatch(/Only moderators/);
    expect(res.body.data.flags).toBe(64);
    expect((await rows<ReportRow>("SELECT * FROM reports"))[0]!.status).toBe("open");
  });

  it("anyone can press them when moderators-only is off", async () => {
    await setupGuild({ moderatorsOnly: false });
    const report = await fileReport();
    const res = await interact(buttonClick(`rpt:ack:${report.id}`, { member: member() }));
    expect(res.body.type).toBe(7);
  });

  it("a double click (two interactions) changes state and mirrors exactly once", async () => {
    await setupGuild();
    const report = await fileReport();
    const mirrorsBefore = net.to("hooks.slack.com").length;
    await interact(buttonClick(`rpt:ack:${report.id}`));
    const second = await interact(buttonClick(`rpt:ack:${report.id}`));
    expect(second.body.data.content).toMatch(/already acknowledged \(by Mod Mia\)/);
    expect(net.to("hooks.slack.com").length - mirrorsBefore).toBe(1);
    expect(await rows("SELECT id FROM events WHERE name = 'report.acknowledged'")).toHaveLength(1);
  });

  it("cannot act on another server's report", async () => {
    await setupGuild();
    await setupGuild({ id: OTHER_GUILD_ID });
    const report = await fileReport();
    const res = await interact(buttonClick(`rpt:resolve:${report.id}`, { guild_id: OTHER_GUILD_ID }));
    expect(res.body.data.content).toMatch(/no longer exists/);
    expect((await rows<ReportRow>("SELECT * FROM reports"))[0]!.status).toBe("open");
  });
});

describe("/status", () => {
  it("answers synchronously with open counts and pipeline health", async () => {
    await setupGuild();
    await fileReport("the server is down");
    const res = await interact(statusCommand(undefined, { member: member({ id: "500000000000000003", name: "Cy" }) }));
    expect(res.body.type).toBe(4);
    expect(res.body.data.flags).toBe(64);
    const fields = Object.fromEntries(res.body.data.embeds[0].fields.map((f: { name: string; value: string }) => [f.name, f.value]));
    expect(fields.Open).toMatch(/^1\n🟠 1 high/);
    expect(fields.Pipeline).toContain("All deliveries healthy");
    expect(res.body.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("shows a single report, scoped to the server", async () => {
    await setupGuild();
    await setupGuild({ id: OTHER_GUILD_ID });
    const report = await fileReport();
    const mine = await interact(statusCommand(report.id, { member: member({ id: "500000000000000003" }) }));
    expect(mine.body.data.embeds[0].title).toContain(`Report #${report.id}`);
    const theirs = await interact(statusCommand(report.id, { guild_id: OTHER_GUILD_ID }));
    expect(theirs.body.data.content).toMatch(/couldn't find report/);
  });
});
