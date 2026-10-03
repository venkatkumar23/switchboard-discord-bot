export {};

// Black-box checks against a deployed instance — the "throw junk at it" part of the review.
//   npm run smoke -- https://switchboard.<you>.workers.dev
// Only Discord can sign valid requests, so this checks everything that must be REJECTED, plus
// health and the auth wall.
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("Usage: npm run smoke -- https://your-app.workers.dev");
  process.exit(1);
}

const body = JSON.stringify({ id: "1", type: 1, application_id: "1", token: "x", version: 1 });
const now = Math.floor(Date.now() / 1000);
const checks: [string, () => Promise<Response>, number][] = [
  ["health endpoint is up", () => fetch(`${base}/api/health`), 200],
  ["unsigned interaction → 401", () => fetch(`${base}/interactions`, { method: "POST", body }), 401],
  [
    "forged signature → 401",
    () =>
      fetch(`${base}/interactions`, {
        method: "POST",
        headers: { "x-signature-ed25519": "ab".repeat(64), "x-signature-timestamp": String(now) },
        body,
      }),
    401,
  ],
  [
    "malformed signature header → 401",
    () =>
      fetch(`${base}/interactions`, {
        method: "POST",
        headers: { "x-signature-ed25519": "not-hex", "x-signature-timestamp": "yesterday" },
        body,
      }),
    401,
  ],
  [
    "old timestamp with junk signature → 401",
    () =>
      fetch(`${base}/interactions`, {
        method: "POST",
        headers: { "x-signature-ed25519": "cd".repeat(64), "x-signature-timestamp": String(now - 3600) },
        body,
      }),
    401,
  ],
  ["GET /interactions → 405", () => fetch(`${base}/interactions`), 405],
  ["dashboard API requires login → 401", () => fetch(`${base}/api/auth/me`), 401],
  ["guild API requires login → 401", () => fetch(`${base}/api/guilds/123456789012345678/events`), 401],
];

let failed = 0;
for (const [name, run, expected] of checks) {
  const res = await run();
  const ok = res.status === expected;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` (got ${res.status})`}`);
}

const page = await fetch(`${base}/`);
const csp = page.headers.get("content-security-policy");
console.log(`${csp ? "✓" : "✗"} dashboard served with a Content-Security-Policy`);
if (!csp) failed++;

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
