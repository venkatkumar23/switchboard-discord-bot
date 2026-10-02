import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from "../../src/worker/lib/crypto";
import { redact, redactString } from "../../src/worker/lib/log";
import { backoffMs } from "../../src/worker/jobs/queue";
import { TEST_ENV } from "../helpers/test-env";

describe("passwords", () => {
  it("hashes with a random salt and verifies", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a.startsWith("pbkdf2_sha256$100000$")).toBe(true);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
  });

  it("refuses malformed or out-of-range stored hashes", async () => {
    expect(await verifyPassword("x", "md5$abc")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2_sha256$9999999$AAAA$AAAA")).toBe(false);
  });
});

describe("secrets at rest", () => {
  const key = TEST_ENV.ENCRYPTION_KEY;

  it("round-trips with a fresh IV each time", async () => {
    const a = await encryptSecret("https://hooks.slack.com/services/T/B/x", key);
    const b = await encryptSecret("https://hooks.slack.com/services/T/B/x", key);
    expect(a).not.toBe(b);
    expect(a).not.toContain("hooks.slack.com");
    expect(await decryptSecret(a, key)).toBe("https://hooks.slack.com/services/T/B/x");
  });

  it("detects tampering", async () => {
    const sealed = await encryptSecret("secret", key);
    const [v, iv, ct] = sealed.split(".");
    const flipped = `${v}.${iv}.${ct!.slice(0, -4)}AAA=`;
    await expect(decryptSecret(flipped, key)).rejects.toThrow();
  });
});

describe("log redaction", () => {
  it("masks secret-named fields at any depth", () => {
    expect(redact({ token: "abc", nested: { botToken: "x", ok: 1 }, list: [{ password: "p" }] })).toEqual({
      token: "[redacted]",
      nested: { botToken: "[redacted]", ok: 1 },
      list: [{ password: "[redacted]" }],
    });
  });

  it("masks credentials embedded in strings", () => {
    // Fake credentials are assembled at runtime so secret scanners don't flag the test file.
    const fakeBotToken = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GabcDE", "abcdefghijklmnopqrstuvwxyz0123"].join(".");
    const fakeGroqKey = ["gsk", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const out = redactString(
      "PATCH https://discord.com/api/v10/webhooks/123/aW50ZXJhY3Rpb24tdG9rZW4/messages/@original " +
        `and https://hooks.slack.com/services/T1/B2/xyz and Bot ${fakeBotToken} and Bearer ${fakeGroqKey}`,
    );
    expect(out).not.toContain("aW50ZXJhY3Rpb24tdG9rZW4");
    expect(out).not.toContain("T1/B2/xyz");
    expect(out).not.toContain("GabcDE");
    expect(out).not.toContain("gsk_abcdefghijklmnop");
  });
});

describe("backoff", () => {
  it("grows exponentially, is capped, and jitters within ±20%", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(4, mid)).toBe(240_000);
    expect(backoffMs(20, mid)).toBe(30 * 60_000);
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
  });
});
