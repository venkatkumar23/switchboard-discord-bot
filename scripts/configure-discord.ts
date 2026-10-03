// Points the Discord application at the deployed Worker and sets its default install link.
//   npm run discord:configure -- https://switchboard.<you>.workers.dev
// Discord validates the endpoint on the spot (a signed PING plus requests with bad signatures),
// so this only succeeds once the Worker is deployed with the right DISCORD_PUBLIC_KEY.
import { BOT_PERMISSIONS } from "../src/worker/discord/types";
import { loadEnv, required } from "./_shared";

loadEnv(process.argv.includes("--env-file") ? undefined : ".env.production");
const base = (process.argv.find((a) => /^https:\/\//.test(a)) ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Usage: npm run discord:configure -- https://your-app.workers.dev");
  process.exit(1);
}
const token = required("DISCORD_BOT_TOKEN");

const res = await fetch("https://discord.com/api/v10/applications/@me", {
  method: "PATCH",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "DiscordBot (switchboard configure script, 1.0)",
  },
  body: JSON.stringify({
    interactions_endpoint_url: `${base}/interactions`,
    // "Add App" in Discord installs to servers with exactly the permissions the bot needs.
    integration_types_config: {
      "0": { oauth2_install_params: { scopes: ["bot", "applications.commands"], permissions: BOT_PERMISSIONS } },
    },
  }),
});

if (!res.ok) {
  console.error(`Discord answered ${res.status}: ${await res.text()}`);
  console.error("If it mentions the interactions endpoint, check the Worker is deployed and DISCORD_PUBLIC_KEY matches.");
  process.exit(1);
}
const app = (await res.json()) as { name: string; interactions_endpoint_url: string };
console.log(`✓ ${app.name}: interactions endpoint set to ${app.interactions_endpoint_url}`);
console.log(`\nOne manual step left in the Developer Portal → OAuth2 → Redirects, add:\n  ${base}/oauth/discord/callback`);
