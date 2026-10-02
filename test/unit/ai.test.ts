import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTriage, triageReport } from "../../src/worker/ai";
import { PermanentError, RetryableError } from "../../src/worker/lib/errors";
import { FakeNet, status } from "../helpers/fake-net";

afterEach(() => vi.restoreAllMocks());

describe("parseTriage", () => {
  it("parses a clean JSON object", () => {
    expect(parseTriage('{"summary":"Login broken","category":"outage","severity":"high","tags":["login"]}')).toEqual({
      summary: "Login broken",
      category: "outage",
      severity: "high",
      tags: ["login"],
    });
  });

  it("tolerates prose and code fences around the JSON", () => {
    const out = parseTriage('Sure!\n```json\n{"summary":"x","category":"bug","severity":"low","tags":[]}\n```');
    expect(out.category).toBe("bug");
  });

  it("normalises severity aliases, unknown categories and messy tags", () => {
    const out = parseTriage('{"summary":"x","category":"weird","severity":"Medium","tags":["Log In!", "", "a b c", "x", "y", "z"]}');
    expect(out).toMatchObject({ category: "other", severity: "normal", tags: ["log-in", "a-b-c", "x", "y"] });
  });

  it("defuses mentions in the summary", () => {
    expect(parseTriage('{"summary":"ping @everyone now","category":"abuse","severity":"high","tags":[]}').summary).not.toContain("@everyone");
  });

  it("rejects output that is not usable as retryable", () => {
    expect(() => parseTriage("no json here")).toThrow(RetryableError);
    expect(() => parseTriage('{"summary":"x","severity":"apocalyptic"}')).toThrow(RetryableError);
  });
});

describe("triageReport", () => {
  const opts = { timeoutMs: 1000 };

  it("calls the OpenAI-compatible endpoint in JSON mode", async () => {
    const net = new FakeNet().install();
    const out = await triageReport(env, "login is down", opts);
    expect(out.severity).toBe("high");
    const [req] = net.to("ai.test");
    expect(req!.headers.authorization).toBe("Bearer test-ai-key");
    expect(req!.body.response_format).toEqual({ type: "json_object" });
    expect(req!.body.messages[1].content).toContain("<report>\nlogin is down\n</report>");
  });

  it("maps 429/5xx to retryable (honouring Retry-After) and 4xx to permanent", async () => {
    const net = new FakeNet().install();
    net.fail("ai.test", () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }));
    const err = await triageReport(env, "x", opts).catch((e) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.retryAfterMs).toBe(7000);

    net.fail("ai.test", status(503));
    await expect(triageReport(env, "x", opts)).rejects.toBeInstanceOf(RetryableError);

    net.fail("ai.test", status(401, "bad key"));
    await expect(triageReport(env, "x", opts)).rejects.toBeInstanceOf(PermanentError);
  });

  it("treats network failures as retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await expect(triageReport(env, "x", opts)).rejects.toBeInstanceOf(RetryableError);
  });

  it("honours the simulated-outage switch without calling the provider", async () => {
    const net = new FakeNet().install();
    await expect(triageReport(env, "x", { ...opts, simulateDown: true })).rejects.toThrow(/Simulated AI outage/);
    expect(net.calls).toHaveLength(0);
  });
});
