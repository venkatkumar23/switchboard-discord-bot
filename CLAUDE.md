# CLAUDE.md — working agreement for AI agents on this repo

Switchboard is a Discord slash-command bot + admin dashboard (Abstrabit SDE-1 assessment).
Users run `/report` and `/status`; Discord POSTs signed interactions to `/interactions`;
we record them, apply rules (+ optional AI triage), reply in Discord, post to a channel with
buttons, and mirror a notification to Slack or a second Discord channel. Admins see a live
log and configure behaviour in a dashboard behind login.

## Stack (do not swap without asking)
- One **Cloudflare Worker** (free plan) serves everything: `POST /interactions`, `/api/*`,
  `/oauth/*`, the cron job runner (`scheduled`), and the React SPA as static assets.
- **Hono** for routing, **zod** for input validation, **D1** (SQLite) for data.
- **React 19 + Vite** SPA in `src/web`, built by `@cloudflare/vite-plugin`. Plain CSS, no UI kit.
- Tests: **vitest** with `@cloudflare/vitest-pool-workers` (tests run inside workerd with a
  real D1). Outbound HTTP is faked in tests; never hit real Discord/Slack/Groq from tests.
- Node 22+ (`.nvmrc`). Run commands with Node 22 on PATH.

## Commands
- `npm run dev` — local dev (Vite + Worker in workerd, local D1)
- `npm run db:migrate:local` / `db:migrate:remote` — apply `migrations/*.sql`
- `npm test` — all tests; `npm run typecheck` — tsc for worker + web
- `npm run register` — register slash commands (reads `.env`)
- `npm run deploy` — build + `wrangler deploy`

## Layout
- `src/worker/interactions/` — signature verification, dispatch, one file per command/component
- `src/worker/jobs/` — durable outbox: enqueue/claim/complete + per-type handlers
- `src/worker/discord/` — REST client, command definitions, message rendering
- `src/worker/api/` — dashboard JSON API (session-authenticated, guild-scoped)
- `src/worker/lib/` — logging (with redaction), crypto, errors, time helpers
- `src/shared/` — DTO types + constants shared by worker and web (no runtime secrets!)
- `migrations/` — D1 SQL migrations; never edit an applied migration, add a new one

## Non-negotiable invariants (the grading bar — check every change against these)
1. **Every** request to `/interactions` is Ed25519-verified over `timestamp + raw body bytes`
   before anything else. Bad/missing signature → `401`. Stale timestamp (>5 min) → `401`.
   PING → PONG only after verification.
2. **Idempotency:** the interaction id is inserted with `ON CONFLICT DO NOTHING` before any
   side effect. A duplicate delivery returns the stored response and causes no new work.
3. **Durability before ACK:** the report row and its first job are written to D1 *before* we
   answer Discord. All side effects (reply edit, channel post, mirror, AI) are jobs with
   retry + exponential backoff, executed in `waitUntil` and re-driven by the cron runner.
   Job ids are deterministic (`post:42`) so enqueueing is idempotent.
4. **3-second rule:** anything that touches the network beyond D1 happens after the response
   (deferred type 5 + follow-up edit). Only cheap D1 reads/writes on the hot path.
5. **No secrets leak:** bot token, public key, client secret, AI key, webhook URLs never go
   to the client, the repo, or logs. Use `log.*` (it redacts) — never `console.log` raw
   objects that might contain headers/tokens. Webhook URLs are AES-GCM encrypted at rest and
   only shown masked. Interaction tokens are wiped from D1 after they expire.
6. **No mention injection:** every message we send sets `allowed_mentions` explicitly
   (`parse: []`). Slack text is escaped (`&`, `<`, `>`).
7. **Tenant isolation:** every dashboard query is scoped by `guild_id` AND checked against
   `admin_guilds` for the current admin.

## Conventions
- TypeScript strict. No `any` unless crossing an untyped boundary (then narrow with zod).
- Times are epoch **milliseconds** (`INTEGER`) everywhere in D1.
- Errors: throw `RetryableError` / `PermanentError` from `lib/errors.ts` in job handlers so the
  runner can decide retry vs dead-letter. Respect Discord `retry_after` on 429.
- Keep D1 queries per invocation well under 50 (free-plan limit): batch with `db.batch`.
- Free-plan CPU budget is ~10 ms: no heavy JS crypto on hot paths (WebCrypto only).
- Comments explain *why*, not what. Match the surrounding style.
- Write/extend tests for every bug fix and for every invariant above.

## Working style
- Make small, reviewable commits with conventional-commit messages.
- When unsure about a Discord/Cloudflare API detail, check the current docs
  (docs.discord.com, developers.cloudflare.com) rather than guessing — both changed in 2025.
- Record genuine wrong turns/bugs in `docs/dev-log.md` as they happen (feeds AI_NOTES.md).
