import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, verifyDiscordRequest } from "../../src/worker/interactions/verify";
import { signedRequest } from "../helpers/discord";
import { TEST_ENV } from "../helpers/test-env";

const KEY = TEST_ENV.DISCORD_PUBLIC_KEY;
const body = { type: 1, id: "1" };

describe("verifyDiscordRequest", () => {
  it("accepts a correctly signed, fresh request and returns the exact body", async () => {
    const result = await verifyDiscordRequest(signedRequest(body), KEY);
    expect(result).toEqual({ ok: true, body: JSON.stringify(body) });
  });

  it("verifies the raw bytes, not a re-serialised copy", async () => {
    const raw = '{ "type":1,   "id":"1", "note":"héllo ✓" }';
    const result = await verifyDiscordRequest(signedRequest(raw), KEY);
    expect(result).toEqual({ ok: true, body: raw });
  });

  it("rejects a body modified after signing", async () => {
    const req = signedRequest(body, { tamper: (raw) => raw.replace('"1"', '"2"') });
    expect(await verifyDiscordRequest(req, KEY)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with a different key", async () => {
    const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const req = signedRequest(body, { secretKey: other.secretKey });
    expect(await verifyDiscordRequest(req, KEY)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects requests without signature headers", async () => {
    const req = new Request("https://x.test/interactions", { method: "POST", body: JSON.stringify(body) });
    expect(await verifyDiscordRequest(req, KEY)).toEqual({ ok: false, reason: "missing_headers" });
  });

  it.each([
    ["not hex", "zz".repeat(64), "1700000000"],
    ["wrong length", "ab".repeat(10), "1700000000"],
    ["non-numeric timestamp", "ab".repeat(64), "yesterday"],
  ])("rejects malformed headers (%s) without throwing", async (_, sig, ts) => {
    const req = new Request("https://x.test/interactions", {
      method: "POST",
      headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts },
      body: "{}",
    });
    expect(await verifyDiscordRequest(req, KEY)).toEqual({ ok: false, reason: "malformed_headers" });
  });

  it("rejects a validly signed but replayed (stale) request", async () => {
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    const req = signedRequest(body, { timestamp: sixMinutesAgo });
    expect(await verifyDiscordRequest(req, KEY)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects timestamps too far in the future", async () => {
    const req = signedRequest(body, { timestamp: Math.floor(Date.now() / 1000) + 10 * 60 });
    expect(await verifyDiscordRequest(req, KEY)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects oversized bodies before verifying", async () => {
    const big = JSON.stringify({ type: 2, padding: "x".repeat(MAX_BODY_BYTES) });
    expect(await verifyDiscordRequest(signedRequest(big), KEY)).toEqual({ ok: false, reason: "body_too_large" });
  });
});
