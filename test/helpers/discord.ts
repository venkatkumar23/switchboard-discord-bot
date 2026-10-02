// Builders for signed Discord interaction requests.
import nacl from "tweetnacl";
import type { Interaction } from "../../src/worker/discord/types";
import { TEST_ENV, TEST_SEED } from "./test-env";

const keyPair = nacl.sign.keyPair.fromSeed(TEST_SEED);
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const GUILD_ID = "200000000000000001";
export const OTHER_GUILD_ID = "200000000000000002";
export const CHANNEL_ID = "300000000000000001";
export const REPORT_CHANNEL_ID = "300000000000000002";
export const ALERT_ROLE_ID = "400000000000000001";
export const MANAGE_MESSAGES = String(1n << 13n);

let seq = 0n;
/** Unique, increasing snowflake-shaped ids. */
export const nextId = () => String(1_300_000_000_000_000_000n + ++seq);

export interface SignOptions {
  timestamp?: number;
  secretKey?: Uint8Array;
  /** Mutates the body after signing. */
  tamper?: (raw: string) => string;
}

export function signedRequest(body: unknown, opts: SignOptions = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = nacl.sign.detached(new TextEncoder().encode(timestamp + raw), opts.secretKey ?? keyPair.secretKey);
  return new Request("https://switchboard.test/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": hex(signature),
      "x-signature-timestamp": timestamp,
    },
    body: opts.tamper ? opts.tamper(raw) : raw,
  });
}

export function member(opts: { id?: string; name?: string; moderator?: boolean } = {}) {
  return {
    user: { id: opts.id ?? "500000000000000001", username: opts.name ?? "alice", global_name: opts.name ?? "Alice" },
    nick: null,
    permissions: opts.moderator ? MANAGE_MESSAGES : "0",
  };
}

function base(type: number, overrides: Partial<Interaction>): Interaction {
  const id = nextId();
  return {
    id,
    application_id: TEST_ENV.DISCORD_APPLICATION_ID,
    type,
    token: `interaction-token-${id}`,
    version: 1,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: member(),
    ...overrides,
  };
}

export const ping = (): Interaction => ({ ...base(1, {}), guild_id: undefined, member: undefined });

export function reportCommand(text?: string, overrides: Partial<Interaction> = {}): Interaction {
  return base(2, {
    data: { id: "1", name: "report", type: 1, options: text === undefined ? [] : [{ name: "text", type: 3, value: text }] },
    ...overrides,
  });
}

export function statusCommand(reportId?: number, overrides: Partial<Interaction> = {}): Interaction {
  return base(2, {
    data: { id: "2", name: "status", type: 1, options: reportId === undefined ? [] : [{ name: "report", type: 4, value: reportId }] },
    ...overrides,
  });
}

export function modalSubmit(values: Record<string, string>, overrides: Partial<Interaction> = {}): Interaction {
  return base(5, {
    data: {
      custom_id: "report_modal",
      components: Object.entries(values).map(([custom_id, value]) => ({
        type: 18,
        component: { type: 4, custom_id, value },
      })),
    },
    ...overrides,
  });
}

export function buttonClick(customId: string, overrides: Partial<Interaction> = {}): Interaction {
  return base(3, {
    data: { custom_id: customId, component_type: 2 },
    message: { id: "900000000000000001", channel_id: REPORT_CHANNEL_ID },
    member: member({ id: "500000000000000009", name: "Mod Mia", moderator: true }),
    ...overrides,
  });
}
