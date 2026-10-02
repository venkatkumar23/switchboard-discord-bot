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
