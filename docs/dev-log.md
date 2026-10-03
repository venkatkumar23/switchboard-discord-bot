# Dev log — wrong turns and surprises

Kept while building (see CLAUDE.md → "Working style"). Raw material for AI_NOTES.md.

## 2026-10-03

- **Node 20 is too old for today's toolchain.** Latest wrangler needs Node ≥ 22, vitest 5 needs
  ≥ 22.12. Installed Node 22 via nvm and pinned `.nvmrc`/`engines`.
- **npm 10 crashes resolving vitest 4.1** (`Cannot read properties of null (reading 'edgesOut')`).
  Cause: vitest 4.1's optional peers (`@vitest/browser-*`) declare `vitest@*`, which resolves to
  vitest 5 and forms a peer cycle that arborist can't handle. vitest 5 isn't usable because
  `@cloudflare/vitest-pool-workers` peers on `vitest ^4.1`. Fix: `.npmrc` with
  `legacy-peer-deps=true` (all real peers are installed explicitly).
- **Discord docs moved** to docs.discord.com, and **modals changed**: Text Inputs now go inside a
  Label component (type 18); action rows in modals are deprecated. The from-memory version of
  the modal would have used the deprecated layout. Parser accepts both shapes.
- **Test pool runtime is older than the deploy runtime** (workerd 2026-08-15 vs 2026-10-01).
  Pinned `compatibility_date` to 2026-08-15 so tests and production behave the same.
- **`fetchMock` is gone from `cloudflare:test`.** The main Worker runs in the test isolate, so
  outbound calls are faked by spying on `globalThis.fetch` (test/helpers/fake-net.ts).
- **Assumed per-test storage isolation — wrong.** 40 integration tests failed with
  `UNIQUE constraint failed: guilds.id`: in this pool version D1 data persists across tests in a
  file. Fixed with `reset()` + re-applying migrations in a `beforeEach` (test/helpers/setup.ts).
- **Hono's `ExecutionContext` type ≠ workers-types v5's** (missing `tracing`/`abort`). The
  interaction handler now takes a minimal `{ waitUntil }` interface, which also simplifies tests.
- **My own test bug:** asserted `posted_message_id` was still null on a row read *after*
  awaiting the whole waitUntil pipeline. The app was right; the test was wrong.
- **A verification step that lied.** An automated edit (a Python string slice) split
  `DEFAULT_RULES` in the middle of its type annotation — the slice ended at the first `];`, which
  was inside `string[];`. The follow-up check printed `ALL TYPECHECKS PASS` anyway, because it was
  written as `tsc … | head && echo PASS`: a pipeline's exit status is the *last* command's
  (`head`), so tsc's failure was swallowed. Caught only because the tsc errors were printed right
  above the "PASS" line. Fixed the file by hand and ran every later check with `set -o pipefail`.
- **Live feed stuck on "Loading activity…" (found by looking, not by tests).** The feed skipped
  polls while `document.visibilityState !== "visible"` — including the very first load, so a tab
  opened in the background never loaded. Unit/integration tests can't see this; the visual check
  in Chrome did. The first load is now unconditional; later polls still pause in hidden tabs.
- **"Deliverys" / "Securitys".** Filter labels were built by appending "s". Replaced with an
  explicit label map. Small, but exactly the kind of thing a reviewer notices first.
- **Overdue retries rendered as "next 2m ago"** when no cron was running (local dev). Now "due now".
- **Cron doesn't fire under `vite dev`.** Added `npm run demo:cron`, which calls the plugin's
  `/cdn-cgi/handler/scheduled` endpoint every minute so retries happen in the offline demo.
- **GitHub push protection blocked the first push** — correctly. The log-redaction unit test
  contained a *fake* Discord-bot-token-shaped string, and GitHub flagged it as a "Discord Bot
  Token". Fix: assemble fake credentials at runtime in the test, and fold that fix into the
  (not yet pushed) commit that introduced the string, so no reachable commit contains it.
- **The same false-pass trap, twice.** A chained command `tests | grep … && git grep … || echo
  "scan clean"` printed "scan clean" without scanning: under `pipefail` the first pipeline exited
  141 (SIGPIPE), which skipped `git grep` and fell through to the `||`. Re-ran the scan on its own
  (exit 1 = no matches). Rule adopted: verification commands run standalone, and their raw exit
  code is reported — no `&& … || echo OK` chains.
