// Values for the Worker under test. The Ed25519 key pair is derived from a fixed seed so the
// public key can be configured statically while tests sign requests with the private half.
import nacl from "tweetnacl";

export const TEST_SEED = new Uint8Array(32).fill(7);

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const TEST_ENV = {
  DISCORD_APPLICATION_ID: "100000000000000001",
  DISCORD_PUBLIC_KEY: toHex(nacl.sign.keyPair.fromSeed(TEST_SEED).publicKey),
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_API_BASE: "https://discord.test/api/v10",
  // 32 bytes of 0x01, base64
  ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  AI_API_KEY: "test-ai-key",
  AI_BASE_URL: "https://ai.test/v1",
  AI_MODEL: "test-model",
  APP_URL: "https://switchboard.test",
};
