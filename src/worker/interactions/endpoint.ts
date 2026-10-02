import { appOrigin, type AppContext } from "../app";
import type { Interaction } from "../discord/types";
import { recordSecurity } from "../db/queries";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/log";
import { handleInteraction } from "./handler";
import { verifyDiscordRequest, type VerifyResult } from "./verify";

/** POST /interactions — nothing runs before the Ed25519 signature check passes. */
export async function interactionsEndpoint(c: AppContext): Promise<Response> {
  const env = c.env;
  const now = Date.now();

  let verified: VerifyResult;
  try {
    verified = await verifyDiscordRequest(c.req.raw, env.DISCORD_PUBLIC_KEY, now);
  } catch (err) {
    // Misconfigured key: fail closed, loudly.
    log.error("interaction.verify_error", { error: errorMessage(err) });
    return c.text("invalid request signature", 401);
  }

  if (!verified.ok) {
    c.executionCtx.waitUntil(recordSecurity(env.DB, verified.reason, now));
    log.warn("interaction.rejected", {
      reason: verified.reason,
      ip: c.req.header("cf-connecting-ip") ?? null,
      userAgent: c.req.header("user-agent")?.slice(0, 100) ?? null,
    });
    return verified.reason === "body_too_large"
      ? c.text("payload too large", 413)
      : c.text("invalid request signature", 401);
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(verified.body) as Interaction;
    if (typeof interaction?.id !== "string" || typeof interaction.type !== "number") throw new Error("unexpected shape");
  } catch {
    c.executionCtx.waitUntil(recordSecurity(env.DB, "malformed_body", now));
    return c.text("bad request", 400);
  }

  if (env.DISCORD_APPLICATION_ID && interaction.application_id !== env.DISCORD_APPLICATION_ID) {
    log.warn("interaction.wrong_application", { applicationId: interaction.application_id });
    return c.text("unknown application", 400);
  }

  return handleInteraction(env, c.executionCtx, interaction, appOrigin(c));
}
