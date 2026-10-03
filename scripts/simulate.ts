// Sends Discord-style signed interactions to a running local Worker (offline demo only; needs
// DEV_SIGNING_SEED from scripts/dev-setup.ts). Examples:
//   npm run simulate -- report "the verification bot is down"
//   npm run simulate -- form "Spam bot" "It keeps posting links in #general"
//   npm run simulate -- status [reportId]
//   npm run simulate -- ack 1 | resolve 1 | reopen 1
//   npm run simulate -- replay report "same id twice"   (duplicate delivery)
//   npm run simulate -- forged                            (bad signature → 401)
import nacl from "tweetnacl";
import { arg, hex, loadEnv, required } from "./_shared";

loadEnv();
const base = arg("url") ?? "http://localhost:5173";
const seedHex = required("DEV_SIGNING_SEED");
const appId = required("DISCORD_APPLICATION_ID");
const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(seedHex, "hex")));

const GUILD = arg("guild") ?? "200000000000000001";
const [, , action = "report", ...rest] = process.argv.filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const snowflake = () => String((BigInt(Date.now() - 1420070400000) << 22n) + BigInt(Math.floor(Math.random() * 4096)));

const member = (moderator: boolean) => ({
  user: moderator ? { id: "500000000000000009", username: "mia", global_name: "Mod Mia" } : { id: "500000000000000001", username: "alice", global_name: "Alice" },
  permissions: moderator ? String(1n << 13n) : "0",
});

function interaction(type: number, data: unknown, moderator = false) {
  const id = snowflake();
  return { id, application_id: appId, type, token: `demo-token-${id}`, version: 1, guild_id: GUILD, channel_id: "300000000000000001", member: member(moderator), data };
}

async function send(body: unknown, forge = false) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = forge ? "00".repeat(64) : hex(nacl.sign.detached(new TextEncoder().encode(timestamp + raw), keyPair.secretKey));
  const res = await fetch(`${base}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    body: raw,
  });
  console.log(`→ ${res.status} ${await res.text()}`);
}

switch (action) {
  case "report":
    await send(interaction(2, { name: "report", type: 1, options: [{ name: "text", type: 3, value: rest.join(" ") || "The server is down" }] }));
    break;
  case "form":
    await send(interaction(5, { custom_id: "report_modal", components: [
      { type: 18, component: { type: 4, custom_id: "title", value: rest[0] ?? "Something broke" } },
      { type: 18, component: { type: 4, custom_id: "details", value: rest[1] ?? "" } },
    ] }));
    break;
  case "status":
    await send(interaction(2, { name: "status", type: 1, options: rest[0] ? [{ name: "report", type: 4, value: Number(rest[0]) }] : [] }));
    break;
  case "ack":
  case "resolve":
  case "reopen":
    await send(interaction(3, { custom_id: `rpt:${action}:${rest[0] ?? 1}`, component_type: 2 }, true));
    break;
  case "replay": {
    const body = interaction(2, { name: "report", type: 1, options: [{ name: "text", type: 3, value: rest.slice(1).join(" ") || "delivered twice" }] });
    await send(body);
    await send(body);
    break;
  }
  case "forged":
    await send(interaction(2, { name: "report", type: 1, options: [] }), true);
    break;
  default:
    console.error(`Unknown action "${action}"`);
    process.exit(1);
}
