// The quality bar's first line: nothing gets past /interactions without a valid, fresh signature.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextId, ping, reportCommand, signedRequest } from "../helpers/discord";
import { FakeNet } from "../helpers/fake-net";
import { call, interact, rows } from "../helpers/worker";

let net: FakeNet;
beforeEach(() => {
  net = new FakeNet().install();
});
afterEach(() => vi.restoreAllMocks());

const counters = () => rows<{ reason: string; count: number }>("SELECT reason, SUM(count) AS count FROM security_counters GROUP BY reason ORDER BY reason");

describe("POST /interactions authentication", () => {
  it("answers a signed PING with PONG", async () => {
    const res = await interact(ping());
    expect(res).toMatchObject({ status: 200, body: { type: 1 } });
  });

  it("rejects an unsigned request with 401", async () => {
    const res = await call(new Request("https://switchboard.test/interactions", { method: "POST", body: JSON.stringify(ping()) }));
    expect(res.status).toBe(401);
  });

  it("rejects a request signed with someone else's key", async () => {
    const forged = signedRequest(reportCommand("hi"), { secretKey: new Uint8Array(64).fill(1) });
    expect((await call(forged)).status).toBe(401);
  });

  it("rejects a body modified in transit", async () => {
    const req = signedRequest(reportCommand("harmless"), { tamper: (raw) => raw.replace("harmless", "malicious") });
    expect((await call(req)).status).toBe(401);
  });

  it("rejects a captured request replayed after the 5 minute window", async () => {
    const res = await interact(reportCommand("replay me"), { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(res.status).toBe(401);
  });

  it("does no work at all for rejected requests, but counts them", async () => {
    await call(new Request("https://switchboard.test/interactions", { method: "POST", body: "{}" }));
    await call(signedRequest(reportCommand("x"), { tamper: (raw) => `${raw} ` }));
    await interact(reportCommand("old"), { timestamp: 1_600_000_000 });

    expect(await rows("SELECT id FROM interactions")).toHaveLength(0);
    expect(await rows("SELECT id FROM reports")).toHaveLength(0);
    expect(net.calls).toHaveLength(0);
    expect(await counters()).toEqual([
      { reason: "bad_signature", count: 1 },
      { reason: "missing_headers", count: 1 },
      { reason: "stale_timestamp", count: 1 },
    ]);
  });

  it("returns 400 for a validly signed body that isn't an interaction", async () => {
    const res = await interact("this is not json");
    expect(res.status).toBe(400);
    expect(await counters()).toEqual([{ reason: "malformed_body", count: 1 }]);
  });

  it("refuses interactions addressed to another application", async () => {
    const res = await interact({ ...reportCommand("x"), application_id: "999999999999999999" });
    expect(res.status).toBe(400);
  });

  it("only accepts POST", async () => {
    const res = await call(new Request("https://switchboard.test/interactions"));
    expect(res.status).toBe(405);
  });

  it("answers unknown commands without recording them", async () => {
    const res = await interact({ ...reportCommand("x"), data: { id: "9", name: "launch-missiles", type: 1 } });
    expect(res.body.data.content).toMatch(/don't know/);
    expect(await rows("SELECT id FROM interactions")).toHaveLength(0);
  });

  it("refuses to run commands outside a server", async () => {
    const res = await interact({ ...reportCommand("x"), id: nextId(), guild_id: undefined, member: undefined });
    expect(res.body.data.content).toMatch(/inside a server/);
  });
});
