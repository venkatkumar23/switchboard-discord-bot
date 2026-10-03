# Switchboard — a Discord slash-command bot with a durable pipeline

Switchboard turns `/report` in a Discord server into a tracked, triaged incident. Every report is
**recorded**, run through the server's **rules** (plus free-tier **AI triage**), **answered** in
Discord, **posted** to the moderators' channel with **Acknowledge / Resolve** buttons, and
**mirrored** to a second channel (Slack or another Discord channel). Admins sign in to a
dashboard that shows a **live log** of every command and action and lets them configure it all.

- **Live app:** https://switchboard.YOUR-SUBDOMAIN.workers.dev  _(dashboard login is in the submission form)_
- **Stack:** one Cloudflare Worker (Hono + React SPA) · Cloudflare D1 (SQLite) · Groq (OpenAI-compatible) · all free, no card
- **Tests:** 111 unit + integration tests that run inside the real Workers runtime with a real D1

```
 Discord ──POST /interactions──▶ verify Ed25519 + timestamp ──▶ dedup on interaction id ──▶ handler
                                                                                            │
          ◀── deferred "thinking…" (≤ 3 s) ◀── report + triage job committed to D1 ◀───────┘
                                                                                            │
   waitUntil / 1-min cron ──▶ triage (rules + AI) ──▶ reply (edit original) ─▶ Discord     │
                                                ├──▶ post with buttons ─────▶ #mod-reports │
                                                └──▶ mirror ────────────────▶ Slack / #mirror
```

## What it does

| Requirement | How |
| --- | --- |
| Admin signs in and connects a server | Email/password login (PBKDF2, hashed session tokens). **Connect a server** runs Discord's OAuth2 bot flow; the server is taken from Discord's token response, never from the URL. Admin picks the report channel, alert role and mirror webhook. |
| ≥ 2 slash commands | `/report [text]` and `/status [report]` (registered globally by `npm run register`). |
| Interactions endpoint that records them | `POST /interactions` → every interaction is stored with its outcome; reports, jobs and an activity log in D1. |
| Simple rule | Per-server **keyword rules** (whole-word match → low/normal/high/critical, optional role ping) and a **per-user cooldown** per command. |
| Responds in Discord | Deferred reply edited with the result; report posted to the channel with buttons; `/status` answers instantly. |
| Mirrors to a second channel | Slack Incoming Webhook **or** Discord channel webhook; new reports and every status change. |
| Dashboard behind login | Live activity feed, reports with per-step delivery status, command settings, rules editor, server settings, reliability view. |

**Stretch goals done:** configurable rules & command behaviour in the UI · buttons (MESSAGE_COMPONENT) ·
modal form (`/report` without text) · AI triage (summary, category, tags, may escalate — never
downgrade) · multi-server isolation · structured logs + visible failure/retry history + rejected
request counters · a **fault-injection lab** to watch the unhappy paths live.

## Reliability & security (the quality bar)

| Unhappy path | Behaviour | Where |
| --- | --- | --- |
| Forged / unsigned / tampered request | Ed25519 verified over `timestamp + raw body bytes` before anything else → `401`; counted per reason. | `src/worker/interactions/verify.ts` |
| Replayed request | Timestamp must be within 5 min → `401`; inside the window the interaction-id dedup catches it. | `verify.ts`, `handler.ts` |
| Same interaction delivered twice | `INSERT … ON CONFLICT(id) DO NOTHING` is the first write. A duplicate gets **the stored original response** and causes no new work. | `interactions/handler.ts` |
| Mirror / AI / Discord briefly down | Every side effect is a **durable job** committed to D1 *before* Discord is answered, run in `waitUntil`, retried with exponential backoff (30 s → 30 min, jitter) by a 1-minute cron, dead-lettered after N attempts and retryable from the dashboard. AI failures fall back to rules instantly and an enrichment job retries AI later. | `src/worker/jobs/*` |
| Our own Worker dies mid-job | Jobs hold a lease; an expired lease is reclaimed by the cron. Channel posts use Discord's `enforce_nonce`, so a re-run can't double-post. | `jobs/queue.ts`, `jobs/handlers.ts` |
| D1 unavailable at intake | The user is told explicitly that nothing was filed (never a silent loss). | `interactions/handler.ts` |
| 3-second window | Only cheap D1 work before the response; anything networked is deferred. The "slow AI (+6 s)" fault proves it. | `interactions/report.ts` |
| Secrets | Wrangler secrets only; webhook URLs AES-GCM encrypted at rest and shown masked; interaction tokens wiped after 15 min; logs pass through a redactor; no secret in client code. | `lib/crypto.ts`, `lib/log.ts` |
| Mention injection | Every message sets `allowed_mentions` (only the configured alert role can ping); Slack text is escaped. | `discord/render.ts`, `mirror.ts` |
| Tenant isolation | Every dashboard route checks the admin ↔ server link; channel/role ids are validated against the server; buttons only act on that server's reports. | `auth/middleware.ts`, `api/guilds.ts` |

## Try it (reviewers)

1. Join the test server (invite in the submission form) or add the bot to your own server from
   the dashboard (**＋ Connect another server**).
2. In Discord:
   - `/report text:the verification bot is down` → private "thinking…", then a confirmation; the
     report appears in `#mod-reports` with buttons (pinging `@Moderators`) and in `#mirror`.
   - `/report` with no text → a form opens.
   - `/status` and `/status report:1` → instant answers.
   - Press **Acknowledge** / **Resolve** → the message updates in place; the change is mirrored.
3. Dashboard → **Reliability** → turn on **Mirror webhook outage**, file another report, and watch
   the mirror job fail and retry with backoff; switch it off and it delivers on the next cron tick.
   **AI provider outage** shows the rules fallback; **Slow AI (+6 s)** shows deferral.
4. Throw junk at it: `npm run smoke -- https://switchboard.YOUR-SUBDOMAIN.workers.dev` (or any
   `curl -X POST …/interactions`) → every bad request is a `401` and shows up under
   *Rejected requests*.

## Run it locally

Requires **Node 22+** (`nvm use`), then `npm install`.

### A. Offline demo — no accounts needed (2 minutes)

A mock Discord/AI API and a simulator that signs requests exactly like Discord does:

```bash
npm run demo:setup          # writes .env with a generated Ed25519 key pair (demo values)
npm run db:migrate:local    # local D1
npm run demo:admin          # admin@demo.local / demo-password, linked to the demo server
npm run demo:mock           # terminal 1: fake Discord + AI API on :8790
npm run dev                 # terminal 2: app on http://localhost:5173
npm run demo:cron           # terminal 3 (optional): fire the cron every minute, so retries run
```

Then in another terminal:

```bash
npm run simulate -- report "the verification bot is down"
npm run simulate -- form "Phishing links" "A new account keeps posting scam links"
npm run simulate -- status
npm run simulate -- ack 1        # or resolve 1 / reopen 1
npm run simulate -- replay report "delivered twice"   # duplicate delivery → identical answer, no new work
npm run simulate -- forged                             # bad signature → 401
```

Open http://localhost:5173, sign in, and pick a report channel in **Settings** (the mock lists a
few channels). Mirror webhooks must be real Slack/Discord URLs; the outage switches work offline.

### B. Against a real Discord app

1. `cp .env.example .env` and fill in your app's values (see the table below).
2. `npm run db:migrate:local && npm run admin:create -- --email you@example.com --password <pw>`
3. `npm run dev`, then expose it: `npx cloudflared tunnel --url http://localhost:5173` (or ngrok).
4. In the Developer Portal set **Interactions Endpoint URL** to `https://<tunnel>/interactions` and
   add `http://localhost:5173/oauth/discord/callback` under **OAuth2 → Redirects**.
5. `npm run register -- --guild <your test server id>` (guild commands appear instantly).
6. Sign in at http://localhost:5173 and **Connect a server**.

## Environment variables

Local values live in `.env` (from `.env.example`); production values are Worker secrets.

| Name | Kind | Purpose |
| --- | --- | --- |
| `DISCORD_APPLICATION_ID` | secret | App id (General Information) |
| `DISCORD_PUBLIC_KEY` | secret | Verifies interaction signatures |
| `DISCORD_BOT_TOKEN` | secret | Posting/editing messages, channel & role lists |
| `DISCORD_CLIENT_SECRET` | secret | OAuth2 code exchange for **Connect a server** |
| `ENCRYPTION_KEY` | secret | 32-byte base64 key; AES-GCM for webhook URLs at rest |
| `AI_API_KEY` | secret, optional | Groq (or Gemini) key; AI triage is off without it |
| `AI_BASE_URL`, `AI_MODEL` | var | Default `https://api.groq.com/openai/v1`, `openai/gpt-oss-20b` |
| `DISCORD_API_BASE` | var | Default `https://discord.com/api/v10` (tests/demo point it at a fake) |
| `APP_URL` | var, optional | Public origin for links sent from cron jobs |

## How it's deployed

Cloudflare Workers (free plan) + D1. One Worker serves `/interactions`, `/api/*`, `/oauth/*`, the
React dashboard as static assets, and a `* * * * *` cron trigger. Steps used:

```bash
npx wrangler login
npx wrangler d1 create switchboard --location enam   # near Discord's US region; put the id in wrangler.jsonc
npm run db:migrate:remote
npm run deploy                                         # vite build + wrangler deploy
npm run secrets:push                                   # validates .env.production, uploads via `wrangler secret bulk`
npm run discord:configure -- https://switchboard.YOUR-SUBDOMAIN.workers.dev   # sets Interactions Endpoint URL
npm run register                                       # global slash commands
npm run admin:create -- --remote --email <you> --guild <server id>
npm run smoke -- https://switchboard.YOUR-SUBDOMAIN.workers.dev
```

Then in the Developer Portal → OAuth2 → Redirects add
`https://switchboard.YOUR-SUBDOMAIN.workers.dev/oauth/discord/callback`. Logs: Workers
Observability (structured JSON, secrets redacted).

## Tests

```bash
npm test          # vitest inside workerd (@cloudflare/vitest-pool-workers) with a real D1
npm run typecheck
```

- **Unit:** signature verification (valid, tampered, wrong key, malformed, stale, oversized),
  rules, AI output parsing/validation, webhook allow-list and escaping, crypto, log redaction,
  backoff, message rendering.
- **Integration (the real Worker + D1, outbound HTTP faked):** PING/forged/replayed/duplicate
  requests, the full `/report` pipeline, modal flow, cooldowns, disabled commands, mention
  injection, buttons and double clicks, `/status`, mirror/AI outages and recovery, 429s, permanent
  errors, lease recovery, exhaustion + manual retry, fault injection, tenant isolation, CSRF,
  secret masking, OAuth state handling.

## Project layout

```
src/worker/            Cloudflare Worker
  interactions/        verify.ts (Ed25519), handler.ts (dedup + dispatch), report/status/buttons
  jobs/                queue.ts (leases, backoff), runner.ts, handlers.ts (triage/reply/post/mirror/enrich)
  discord/             REST client, command definitions, message rendering
  api/                 dashboard API (auth, guild-scoped routes, OAuth connect)
  lib/                 crypto, redacting logger, errors
src/web/               React dashboard
src/shared/            types shared by both (no secrets)
migrations/            D1 schema
scripts/               register, admin, secrets, Discord config, smoke test, offline demo
test/                  unit + integration tests
```

## Trade-offs and what's next

- **Polling, not push**, for the live log (3 s cursor-based polling, paused in background tabs).
  A Durable Object with WebSockets would push instead.
- **At-least-once mirroring:** Slack webhooks have no idempotency key, so a crash between "Slack
  accepted" and "we recorded it" could repeat one notification. Discord posts are exactly-once
  via `enforce_nonce`.
- **Rejected-request counters live in D1**, one upsert per bad request; a flood could eat into
  D1's free write quota. Workers Analytics Engine would be the better sink.
- Next: per-server admin roles from Discord permissions (instead of an allow-list), DM the
  reporter when their report is resolved, and a 24 h trend sparkline per command.

## AI usage

Built with Claude Code — see [AI_NOTES.md](AI_NOTES.md) and the instruction file it worked from,
[CLAUDE.md](CLAUDE.md). Wrong turns were logged as they happened in [docs/dev-log.md](docs/dev-log.md).
