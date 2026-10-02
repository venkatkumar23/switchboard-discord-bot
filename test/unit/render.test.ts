import { describe, expect, it } from "vitest";
import type { ReportRow } from "../../src/worker/db/rows";
import { modalValues, renderReportMessage, renderReporterReply, reportModal } from "../../src/worker/discord/render";

const report = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: 42,
  guild_id: "200000000000000001",
  interaction_id: "1",
  source_channel_id: null,
  user_id: "500000000000000001",
  user_name: "Alice",
  title: null,
  body: "@everyone the server is down <@&123>",
  status: "open",
  priority: "high",
  priority_source: "rule",
  rule_id: 1,
  rule_name: "Outage",
  matched_keyword: "down",
  mention_role: 1,
  ai_status: "done",
  ai_summary: "Server outage",
  ai_category: "outage",
  ai_severity: "high",
  ai_tags: '["server"]',
  ai_error: null,
  posted_channel_id: null,
  posted_message_id: null,
  acked_by: null,
  acked_at: null,
  resolved_by: null,
  resolved_at: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...over,
});

const buttonIds = (payload: { components?: unknown[] }) =>
  ((payload.components?.[0] as { components: { custom_id: string }[] }).components ?? []).map((b) => b.custom_id);

describe("renderReportMessage", () => {
  it("pings only the configured alert role, never what the user typed", () => {
    const msg = renderReportMessage(report(), "400000000000000001");
    expect(msg.allowed_mentions).toEqual({ parse: [], roles: ["400000000000000001"] });
    expect(msg.content).toContain("<@&400000000000000001>");
  });

  it("pings nobody when the rule doesn't ask for it", () => {
    const msg = renderReportMessage(report({ mention_role: 0 }), "400000000000000001");
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.content).toBe("");
  });

  it("shows buttons that match the report's state", () => {
    expect(buttonIds(renderReportMessage(report(), null))).toEqual(["rpt:ack:42", "rpt:resolve:42"]);
    expect(buttonIds(renderReportMessage(report({ status: "acknowledged", acked_by: "Mia", acked_at: 1 }), null))).toEqual(["rpt:resolve:42"]);
    expect(buttonIds(renderReportMessage(report({ status: "resolved", resolved_by: "Mia", resolved_at: 1 }), null))).toEqual(["rpt:reopen:42"]);
  });

  it("explains the AI fallback when triage failed", () => {
    const msg = renderReportMessage(report({ ai_status: "failed", ai_summary: null }), null);
    expect(JSON.stringify(msg.embeds)).toContain("classified by keyword rules");
  });
});

describe("renderReporterReply", () => {
  it("never pings and points at /status", () => {
    const msg = renderReporterReply(report(), "300000000000000002");
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.content).toContain("/status report:42");
    expect(msg.content).toContain("<#300000000000000002>");
  });
});

describe("modal", () => {
  it("uses Label-wrapped text inputs", () => {
    const modal = reportModal();
    expect(modal.type).toBe(9);
    const components = (modal.data as { components: { type: number; component: { custom_id: string } }[] }).components;
    expect(components.map((c) => [c.type, c.component.custom_id])).toEqual([
      [18, "title"],
      [18, "details"],
    ]);
  });

  it("reads submitted values from Label and legacy action-row layouts", () => {
    expect(
      modalValues([
        { type: 18, component: { type: 4, custom_id: "title", value: "A" } },
        { type: 1, components: [{ type: 4, custom_id: "details", value: "B" }] },
      ]),
    ).toEqual({ title: "A", details: "B" });
  });
});
