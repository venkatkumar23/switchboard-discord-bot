# AI notes

## Tools and how the work was split

- **Claude Code** (model: **Claude Opus 5.5**) running as an agent in VS Code, with terminal access
  and the Claude-in-Chrome extension (used to look at the dashboard, not to test Discord).
- The agent worked from the assessment brief plus [CLAUDE.md](CLAUDE.md), which it wrote first and
  then followed: the stack, the commands, and the non-negotiable invariants (verify every request,
  dedup before side effects, durable before ACK, no secrets in logs/client, explicit
  `allowed_mentions`, tenant isolation).
- **Claude Code:** architecture, all code, the 111 tests, the offline demo, and the docs. It ran
  builds, tests and a local end-to-end simulation, and checked every dashboard page in Chrome.
- **Me:** the accounts and secrets (Discord application and test server, Cloudflare, Groq), the
  publishing decisions (public repo, deployment), reviewing the result, and testing the live bot
  in Discord. Secrets never went through the chat: the agent wrote scripts that validate and
  upload them without printing them.

## Key decisions

Claude proposed these up front. These are the three I reviewed and would defend:

1. **One Cloudflare Worker + D1 instead of Render/Vercel + Neon.** Render's free tier sleeps,
   and a cold start blows Discord's 3-second window. Workers have no cold start, `waitUntil`
   runs work after the response, and a free cron trigger re-drives retries. D1 sits next to the
   compute, so the hot path is two quick queries. Trade-off: SQLite instead of Postgres, plus the
   free plan's 10 ms CPU / 50-queries-per-request limits, which shaped the code.
2. **A durable outbox, not fire-and-forget.** The report row and its first job are committed in
   one transaction *before* Discord gets its deferred ACK. Every side effect (reply edit, channel
   post, mirror, AI) is a job with a deterministic id, a lease, exponential backoff and a dead
   letter you can retry from the dashboard. That one pattern answers "don't lose it", "don't do
   it twice" and "be slow without timing out" together.
3. **AI may escalate, never downgrade.** Admin keyword rules set the floor and AI output is
   schema-validated, so a prompt-injected or wrong model can't hide a report the server's own
   rules call urgent. If the AI is down, rules apply instantly and an enrichment job retries.

## The hardest wrong turn: a check that said "pass" when the code was broken

While moving the default rules into their own module, the agent edited the file with a Python
string slice that ended at the first `];`. That turned out to be inside the type annotation
`keywords: string[];`, so the edit cut the declaration in half. It then ran
`npm run typecheck | head && echo "ALL TYPECHECKS PASS"`. The pipeline's exit status is that of
`head`, not `tsc`, so the type errors were printed and then immediately followed by "ALL
TYPECHECKS PASS". If I had read only the agent's summary line, I'd have believed it.

**How it was noticed:** the tsc errors were visible right above the "PASS" line in the same
output, and the agent caught the contradiction on its next step.

**Fix:** the file was repaired by hand, and every later verification command runs with
`set -o pipefail`. The general lesson for working with an agent: trust exit codes and raw
output, not success messages the agent composes itself.

Two other real misses, both logged in [docs/dev-log.md](docs/dev-log.md):
- **Wrong assumption about the test pool.** The agent assumed per-test D1 isolation, which
  newer versions of the pool dropped. That broke 40 tests with `UNIQUE constraint failed`; the
  fix is a reset plus migrations before each test.
- **A UI bug no test could catch.** The live activity feed stayed on "Loading…" in a background
  tab. It was only found by actually opening the dashboard in Chrome.

## With more time

- Push instead of poll for the live log (a Durable Object with WebSockets).
- Sign in with Discord, and derive dashboard access from the member's Manage Server permission
  instead of an admin list.
- Move the rejected-request counters to Workers Analytics Engine, so a flood can't consume D1's
  free write quota.
- DM the reporter when their report is resolved; add Slack interactivity, so moderators can
  acknowledge from the mirror.
- Run an end-to-end test against a real Discord sandbox server in CI.
