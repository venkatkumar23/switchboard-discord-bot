// Creates (or resets the password of) a dashboard admin, optionally linking a Discord server.
//   npm run admin:create -- --email you@example.com [--password …] [--guild <server id>] [--remote]
// Without --password a strong random one is generated and printed once.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES } from "../src/worker/defaults";
import { hashPassword, randomToken } from "../src/worker/lib/crypto";
import { arg, flag } from "./_shared";

const email = arg("email")?.trim().toLowerCase();
const guild = arg("guild");
const remote = flag("remote");
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: npm run admin:create -- --email you@example.com [--password …] [--guild <id>] [--remote]");
  process.exit(1);
}
if (guild && !/^\d{17,20}$/.test(guild)) {
  console.error("--guild must be a Discord server id (17-20 digits)");
  process.exit(1);
}

const password = arg("password") ?? process.env.ADMIN_PASSWORD ?? randomToken(12);
if (password.length < 8) {
  console.error("Use a password of at least 8 characters.");
  process.exit(1);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const now = Date.now();
const statements = [
  `INSERT INTO admins (email, password_hash, created_at) VALUES (${q(email)}, ${q(await hashPassword(password))}, ${now})
   ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash;`,
];
if (guild) {
  statements.push(
    `INSERT INTO guilds (id, created_at, updated_at) VALUES (${q(guild)}, ${now}, ${now}) ON CONFLICT(id) DO NOTHING;`,
    `INSERT INTO admin_guilds (admin_id, guild_id, created_at)
     SELECT id, ${q(guild)}, ${now} FROM admins WHERE email = ${q(email)} ON CONFLICT DO NOTHING;`,
    ...DEFAULT_RULES.map(
      (r, i) =>
        `INSERT INTO rules (guild_id, name, keywords, priority, mention_role, enabled, position, created_at, updated_at)
         SELECT ${q(guild)}, ${q(r.name)}, ${q(JSON.stringify(r.keywords))}, ${q(r.priority)}, ${r.mentionRole ? 1 : 0}, 1, ${i}, ${now}, ${now}
         WHERE NOT EXISTS (SELECT 1 FROM rules WHERE guild_id = ${q(guild)} AND name = ${q(r.name)});`,
    ),
  );
}

// A temp file keeps the SQL (and hash) out of the shell history and process list.
const dir = mkdtempSync(join(tmpdir(), "switchboard-"));
const file = join(dir, "admin.sql");
writeFileSync(file, statements.join("\n"));
try {
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", remote ? "--remote" : "--local", `--file=${file}`, "--yes"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`Admin ${email} ready (${remote ? "remote" : "local"} database)${guild ? `, linked to server ${guild}` : ""}.`);
if (!arg("password") && !process.env.ADMIN_PASSWORD) console.log(`Generated password: ${password}`);
