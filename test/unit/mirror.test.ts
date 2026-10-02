import { afterEach, describe, expect, it, vi } from "vitest";
import { PermanentError, RetryableError } from "../../src/worker/lib/errors";
import { classifyWebhookUrl, sendMirror, slackEscape, toDiscordPayload, toSlackPayload } from "../../src/worker/mirror";
import { FakeNet, status } from "../helpers/fake-net";
import { DISCORD_WEBHOOK_URL, SLACK_URL } from "../helpers/worker";

afterEach(() => vi.restoreAllMocks());

describe("classifyWebhookUrl", () => {
  it("accepts Slack and Discord webhooks and masks the secret part", () => {
    const slack = classifyWebhookUrl(SLACK_URL)!;
    expect(slack.kind).toBe("slack");
    expect(slack.hint).not.toContain("abcdefghijklmnopqrst");
    const discord = classifyWebhookUrl(DISCORD_WEBHOOK_URL)!;
    expect(discord.kind).toBe("discord");
    expect(discord.hint).toContain("600000000000000001");
    expect(discord.hint).not.toContain("very-secret");
  });

  it.each([
    "http://hooks.slack.com/services/T0/B0/x", // not https
    "https://evil.example/services/T0/B0/x", // arbitrary host → SSRF
    "https://hooks.slack.com.evil.example/services/T0/B0/x",
    "https://discord.com/api/v10/channels/1/messages", // Discord, but not a webhook
    "https://user:pass@hooks.slack.com/services/T0/B0/x",
    "https://hooks.slack.com:8443/services/T0/B0/x",
    "not a url",
  ])("rejects %s", (url) => {
    expect(classifyWebhookUrl(url)).toBeNull();
  });
});

describe("payloads", () => {
  const message = {
    title: "New report",
    facts: [["Reporter", "<!channel> & co"]] as [string, string][],
    quote: "hi <@&123> @everyone",
    color: 1,
  };

  it("escapes Slack control sequences so user text cannot ping", () => {
    expect(slackEscape("<!channel> & <@U1>")).toBe("&lt;!channel&gt; &amp; &lt;@U1&gt;");
    const text = JSON.stringify(toSlackPayload(message));
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
  });

  it("never lets a Discord mirror ping anyone", () => {
    expect(toDiscordPayload(message).allowed_mentions).toEqual({ parse: [] });
  });
});

describe("sendMirror", () => {
  const msg = { title: "t", facts: [] as [string, string][], color: 0 };

  it("posts the right payload shape per kind", async () => {
    const net = new FakeNet().install();
    await sendMirror(SLACK_URL, "slack", msg);
    await sendMirror(DISCORD_WEBHOOK_URL, "discord", msg);
    expect(net.to("hooks.slack.com")[0]!.body.blocks).toBeDefined();
    expect(net.to("discord.com/api/webhooks")[0]!.body.embeds).toBeDefined();
  });

  it("classifies failures and never leaks the URL into the error", async () => {
    const net = new FakeNet().install();
    net.fail("hooks.slack.com", status(503, "upstream"));
    const retryable = await sendMirror(SLACK_URL, "slack", msg).catch((e) => e);
    expect(retryable).toBeInstanceOf(RetryableError);
    expect(retryable.message).not.toContain("hooks.slack.com/services");

    net.fail("hooks.slack.com", status(404, "no_service"));
    const permanent = await sendMirror(SLACK_URL, "slack", msg).catch((e) => e);
    expect(permanent).toBeInstanceOf(PermanentError);
    expect(permanent.message).toContain("no_service");
  });
});
