import { hexToBytes } from "../lib/crypto";

/** Discord payloads are a few KB; anything this large is not from Discord. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Signed requests older/newer than this are treated as replays. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type RejectReason =
  | "missing_headers"
  | "malformed_headers"
  | "body_too_large"
  | "bad_signature"
  | "stale_timestamp";

export type VerifyResult = { ok: true; body: string } | { ok: false; reason: RejectReason };

let cachedKey: { hex: string; key: Promise<CryptoKey> } | null = null;

function publicKey(hex: string): Promise<CryptoKey> {
  if (cachedKey?.hex !== hex) {
    const raw = hexToBytes(hex);
    if (!raw || raw.length !== 32) throw new Error("DISCORD_PUBLIC_KEY must be 64 hex characters");
    cachedKey = { hex, key: crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]) };
  }
  return cachedKey.key;
}

/**
 * Verifies Discord's Ed25519 signature over `timestamp + raw body bytes`, then checks the
 * timestamp is fresh. The signature check comes first so that "stale_timestamp" only ever
 * counts genuinely signed (i.e. replayed) requests.
 */
export async function verifyDiscordRequest(
  request: Request,
  publicKeyHex: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const signatureHex = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signatureHex || !timestamp) return { ok: false, reason: "missing_headers" };

  const signature = hexToBytes(signatureHex);
  if (!signature || signature.length !== 64 || !/^\d{1,13}$/.test(timestamp)) {
    return { ok: false, reason: "malformed_headers" };
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };

  // Sign over the exact bytes received — never a re-serialised or re-decoded copy.
  const prefix = new TextEncoder().encode(timestamp);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);

  const valid = await crypto.subtle.verify({ name: "Ed25519" }, await publicKey(publicKeyHex), signature, message);
  if (!valid) return { ok: false, reason: "bad_signature" };

  if (Math.abs(now - Number(timestamp) * 1000) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  return { ok: true, body: new TextDecoder().decode(body) };
}
