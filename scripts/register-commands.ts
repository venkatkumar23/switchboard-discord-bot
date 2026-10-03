// Registers /report and /status with Discord (bulk overwrite, so it is idempotent).
//   npm run register                      → global commands (all servers)
//   npm run register -- --guild <id>      → one server only, appears instantly (handy while developing)
import { COMMANDS } from "../src/worker/discord/commands";
import { arg, loadEnv, required } from "./_shared";

loadEnv();
const appId = required("DISCORD_APPLICATION_ID");
const token = required("DISCORD_BOT_TOKEN");
const guild = arg("guild");

const url = guild
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guild}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "DiscordBot (switchboard register script, 1.0)",
  },
  body: JSON.stringify(COMMANDS),
});

if (!res.ok) {
  console.error(`Discord answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const registered = (await res.json()) as { name: string }[];
console.log(`Registered ${registered.map((c) => `/${c.name}`).join(", ")} ${guild ? `in server ${guild}` : "globally"}.`);
