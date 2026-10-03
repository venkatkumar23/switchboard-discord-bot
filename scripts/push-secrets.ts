// Validates the production secrets in .env.production and uploads them to the deployed Worker
// with `wrangler secret bulk`. Values are never printed; the temp JSON file is deleted afterwards.
//   npm run secrets:push [-- --env-file .env.production]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arg } from "./_shared";

const file = arg("env-file") ?? ".env.production";
if (!existsSync(file)) {
  console.error(`${file} not found. Copy .env.example to ${file} and fill it in.`);
  process.exit(1);
}
process.loadEnvFile(file);

const CHECKS: Record<string, { required: boolean; valid: (v: string) => boolean; hint: string }> = {
  DISCORD_APPLICATION_ID: { required: true, valid: (v) => /^\d{17,20}$/.test(v), hint: "17-20 digits (General Information → Application ID)" },
  DISCORD_PUBLIC_KEY: { required: true, valid: (v) => /^[0-9a-f]{64}$/i.test(v), hint: "64 hex characters (General Information → Public Key)" },
  DISCORD_BOT_TOKEN: { required: true, valid: (v) => v.split(".").length === 3, hint: "three dot-separated parts (Bot → Reset Token)" },
  DISCORD_CLIENT_SECRET: { required: true, valid: (v) => /^[\w-]{20,}$/.test(v), hint: "OAuth2 → Client Secret" },
  ENCRYPTION_KEY: {
    required: true,
    valid: (v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    },
    hint: "32 random bytes, base64",
  },
  AI_API_KEY: { required: false, valid: (v) => v.length > 10, hint: "Groq/Gemini API key (optional)" },
};

const secrets: Record<string, string> = {};
let problems = 0;
for (const [name, check] of Object.entries(CHECKS)) {
  const value = process.env[name]?.trim();
  if (!value) {
    if (check.required) {
      console.error(`✗ ${name} is missing — ${check.hint}`);
      problems++;
    } else console.log(`– ${name} not set (optional; AI triage will be off)`);
    continue;
  }
  if (!check.valid(value)) {
    console.error(`✗ ${name} doesn't look right — expected ${check.hint}`);
    problems++;
    continue;
  }
  secrets[name] = value;
  console.log(`✓ ${name}`);
}
if (problems) process.exit(1);

const dir = mkdtempSync(join(tmpdir(), "switchboard-secrets-"));
const json = join(dir, "secrets.json");
writeFileSync(json, JSON.stringify(secrets), { mode: 0o600 });
try {
  execFileSync("npx", ["wrangler", "secret", "bulk", json], { stdio: ["ignore", "inherit", "inherit"] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
