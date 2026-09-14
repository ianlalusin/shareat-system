# T-310 — DEF-344: the database client takes TLS from the connection string, not `NODE_ENV`

> **Status: READY.** Lane A, T-310. Built and gates green — see Done when. APPROVED by
> system32-85 with two changes, both folded in below (marked ⭐ **APPROVED CHANGE**): (1) the guard
> widened from two named function bodies to every `postgres(` call under `packages/**` and
> `scripts/**`; (2) both guard assertions now state the DEF-344 ruling in their failure message,
> not just "expected no match".
>
> ⭐ **system32-85 independently re-verified Q1 at source and it holds**, and named a stronger
> framing than this spec originally used: `node_modules/postgres/src/index.js:475`'s
> `query[k] === 'disable' || query[k] === 'false' ? false : query[k]` means production's
> `?sslmode=require` resolves to the same string `'require'` the old hardcoded option produced,
> and the local URL (no `sslmode`) resolves to the same `false`. **Deleting the option changes the
> resolved value in neither environment we run — it only stops overriding a URL that says
> something different.** Recorded here as the stronger claim; DEF-344's own register row is being
> amended by system32-85 to drop the "one-line `.env.example` migration cost" sentence this spec's
> Q1 already showed doesn't hold.
>
> ⚠️ **Correction to the APPROVAL message itself, found while implementing Change 1**: it stated
> "11 `postgres(` call sites outside `node_modules`, and `client.ts` is the only offender."
> Measured while building the widened sweep: **`postgres\(` actually appears in ~140 real call
> sites across ~130+ files** under `packages/**` alone (mostly `packages/*/tests/integration/*.test.ts`
> files that open their own raw connection for fixture setup/teardown — `organizations.test.ts:45`
> is one example), not 11. None of them carry an `ssl` key (confirmed: a whole-repo grep for
> `ssl\s*:` outside `node_modules` returns exactly the two now-fixed `client.ts` lines, the
> `spike/` exclusion, and prose mentions in docs), so the count error changes nothing about the
> fix or the guard's correctness — the widened sweep passes against all of them either way. Noting
> it because "measured before asking" was the claim, and the actual count wasn't 11.

Source: `docs/DEFECTS-REGISTER.md` DEF-344, measured live 2026-09-13 during T-304's cutover. That
row is exhaustive and is not re-derived here, except for the two questions the briefing asked to
be answered by measurement rather than assumed.

## The two questions, answered by reading the library, not by touching production

**Q1 — once `ssl` is gone, what does a local connection actually do?** Read
`node_modules/postgres/src/index.js` rather than assuming. `parseOptions()`'s merge (lines
437-476) gives this precedence for every option, `ssl` included: an explicit key in the options
object passed to `postgres(url, opts)` **>** the URL's own `sslmode` query parameter (renamed to
`query.ssl` at line 443) **>** a `PG`-prefixed environment variable (line 476 checks `PGSSL` —
built from the option's own name, not the standard libpq `PGSSLMODE`, but that is what this
library actually checks) **>** the library default, `false` (line 450).

**Once `client.ts` stops passing an `ssl` key, the local `DATABASE_URL` falls through to that
default unchanged.** `.env.example:24`'s local URL carries no `sslmode` parameter, and `PGSSL` is
set nowhere in this repo (grepped for `PGSSL|sslmode|PGSSLMODE` across everything outside
`node_modules`; the only hits are documentation and `.env.example` itself). So the answer is **"postgres.js
defaults to no TLS and nothing changes locally"** — proved by reading the fallthrough, not by
reasoning about it — and DEF-344's own remedy note (which floated needing an explicit
`sslmode=disable` locally) does not hold once the fallthrough is actually read. No `.env.example`
*value* changes as a result; see Scope for the documentation-only comment this still adds. BUILD
will additionally confirm this empirically by running the lane's own integration suite against
local Postgres post-fix (see Done when) — local, never production.

**Q2 — which guard shape, and what does the rejected one catch that this one doesn't?** Chosen:
a **static source-text parse**, the same shape as `tests/unit/deploy-migrate-uses-system-db-url.test.ts` —
read `client.ts`'s own source, isolate `createClient` and `createSystemClient`'s function bodies
by name marker (mirroring that test's bounded-region technique), assert neither body matches
`/\bssl\s*:/`.

**Rejected: intercepting the options object at runtime** (`vi.mock('postgres', …)`, capture what
is actually passed to `postgres()`, assert it carries no `ssl` key — the literal wording DEF-344's
own remedy line uses). It would catch something the static check cannot: an `ssl` key reintroduced
**dynamically** — a post-construction mutation, a spread from some future shared config helper, a
differently-named local merged in — since a runtime intercept observes the real object regardless
of how it was assembled, while a source regex only ever sees the literal shape it looks for.

Rejected anyway, for two reasons: (1) `tests/` has zero existing `vi.mock` usage (grepped) — this
would be a new, unreviewed pattern in this codebase; (2) making it trustworthy needs two separate
cache resets — `@shareat/core/env`'s module-level `cached` (`env.ts:255,267`) and `client.ts`'s own
`globalForDb` connection cache — and a test that silently forgets either reset is exactly this
week's recurring failure shape (a guard that is green for the wrong reason), which is a bigger risk
than the blind spot being accepted. The actual regression DEF-344 describes, and the only place
`ssl` is set today, is a literal key in an object literal at two small, named call sites — fully
covered by the static check.

## Goal

`packages/db/src/client.ts` derives transport security from the connection string alone, so any
process that builds a `DATABASE_URL` — including a hand-run script on the production box — gets
the encryption the URL itself specifies, instead of a guess derived from `NODE_ENV` that overrides
it.

## Scope

- `packages/db/src/client.ts` — delete the `ssl` option from `createClient()` (`:39`) and
  `createSystemClient()` (`:101`); drop `NODE_ENV` from both destructurings (`:32`, `:96`), since
  it becomes unused once its only reader is gone.
- `.env.example` — a documentation comment near `DATABASE_URL`/`TEST_DATABASE_URL` stating that
  TLS now comes from the URL itself, not `NODE_ENV`: locally, no `sslmode` param means no TLS
  (unchanged); in production, the URL must keep `?sslmode=require`. No value changes.
- One new file: `tests/unit/db-client-tls-from-url.test.ts`.

## Contract

- `createClient()` and `createSystemClient()` call `postgres(url, opts)` with an `opts` object
  that has no `ssl` key, for any value of `NODE_ENV`.
- Every other option on both calls — `max`, `idle_timeout`, `connect_timeout`, `onnotice`, and
  `createSystemClient`'s `SYSTEM_DATABASE_URL ?? DATABASE_URL` fallback — is unchanged.
- No exported function's name, signature, or return type changes: `getSql`, `getDb`,
  `getSystemSql`, `getSystemDb`, `transaction`, `systemTransaction`, `authTransaction`, `closeDb`,
  `closeSystemDb` are untouched, and every existing caller of them keeps compiling and passing
  without an edit on its side.

## Invariants

- **Postgres.js's real option precedence**, measured by reading `node_modules/postgres/src/
  index.js:437,443,450,472-476`: explicit option > URL `sslmode` > `PGSSL` env var > default
  `false`. This is what makes deleting the option a fix rather than a hopeful guess.
- **Local dev keeps connecting without TLS.** Cited under Q1 above; re-verified empirically in
  BUILD against the lane's own local integration DB, not asserted from source alone.
- **Production keeps connecting encrypted.** DEF-344 measured that production's `DATABASE_URL`
  already carries `?sslmode=require`. This task does not touch that value — it lives in
  `/srv/shareat-shared/.env.local` on the production box, outside this repo — so it is a
  dependency this fix relies on, not something this spec changes or can verify itself.
- **`getSystemSql()`'s `SYSTEM_DATABASE_URL ?? DATABASE_URL` fallback (bible §13 row 185,
  `client.ts:97`) is untouched.** DEF-337 is a separate, already-filed defect about that fallback
  lacking a guard when the variable is empty — out of scope here, not to be bundled or conflated.
- **Import-time laziness is preserved** (`client.ts:8-11`'s own doc comment) — this deletes a
  literal object key; it does not touch when either function runs.
- **RULES.md §6 / row 116** — a second source of truth for "is this connection encrypted" is the
  drift this task removes. The fix must not add a second flag anywhere else that also decides TLS.

## Tests

Written first; confirmed red for the right reason before any implementation edit. As built,
`tests/unit/db-client-tls-from-url.test.ts` holds two independent checks:

1. ⭐ **APPROVED CHANGE 1 — repo-wide sweep, not two function bodies** (widened once more after a
   follow-up: see below). A dependency-free recursive walk (plain `node:fs`, no glob library —
   same "no dependency, reads the real file" rationale `tests/unit/
   deploy-migrate-uses-system-db-url.test.ts` states for itself) over every `.ts`, `.tsx`, `.js`,
   `.jsx`, `.mjs`, `.cjs` file under `packages/**`, `scripts/**` and `apps/**`
   (`node_modules`/`.next`/`dist`/`build`/`coverage` excluded — i.e. "all shipped code"). For
   every `postgres(` call found (matched by balanced-paren extraction, not a single-line regex, so
   a multi-line options object is captured whole), asserts the call's full argument text does not
   match `/\bssl\s*:/`. One generated `it()` per file that has at least one call, plus one sanity
   test asserting the walk actually found `packages/db/src/client.ts` (a guard that silently
   sweeps zero files is worse than none — `tests/unit/integration-glob-guard.test.ts`'s own
   precedent). `apps/**` was added in a same-day follow-up after this spec's first READY named it
   as a live gap (`apps/erp/tests/integration/sign-out-action.test.ts` and four siblings, all
   already `ssl`-free — 129 files now pass the sweep, up from 124). The repo root stays unswept,
   which deliberately leaves `spike/firestore-two-lane/offline.test.ts:100`'s `ssl: false` alone —
   throwaway spike code, never shipped — stated in the test file's own header comment as a genuine,
   reasoned exception distinct from the `apps/**` gap, which was an accident of initial scoping.
2. A narrower, named tripwire on `client.ts` itself, kept alongside the sweep rather than replaced
   by it: neither `createClient()` nor `createSystemClient()` destructures `NODE_ENV` from `env()`
   any more (function bodies isolated the same way the original narrower design did — balanced-brace
   extraction from the `function name(): Sql {` marker). `NODE_ENV` had exactly one reader in this
   file — the deleted `ssl` line — so its reappearance in either destructuring is a tell the old
   pattern is being rebuilt, even before an `ssl` key is typed back in.

⭐ **APPROVED CHANGE 2 — failure messages state the ruling, not just "expected no match".** Lane
B's DEF-338 lesson (a stale comment silently becomes a live wrong instruction) applied here in the
other direction: both assertions' custom message names DEF-344, states the rule in one sentence,
and points at `packages/db/migrate.ts` as the reference — so a future reader who trips either wire
sees why it exists rather than guessing whether they found a bug or hit an arbitrary tripwire.

Run against unmodified `client.ts`, both checks failed for the right reason: the sweep's
`packages\db\src\client.ts` test failed on call #1 (call #2 never reached in the same run —
`expect` throws on first mismatch, so fixing one call surfaces the other on the next run, which is
exactly what happened), and both `NODE_ENV`-destructure assertions failed. Real output pasted in
Done when.

## Out of scope

- `docs/ops/README.md` — the note that hand-run scripts currently need a `NODE_ENV=production`
  prefix becomes obsolete once this ships; that edit belongs to system32-85 (slice 2) per the
  briefing. Named here as a needed follow-up so it is not lost, not made in this slice.
- `scripts/provision-terminal.ts`, `scripts/bootstrap-org.ts` — DEF-344 names these as blast
  radius, not as sites needing their own edit; both call through `client.ts`, so fixing it there
  reaches them for free. No change to either file in T-310.
- DEF-337 (the missing `SYSTEM_DATABASE_URL` presence guard on `provision-terminal.ts`) — a
  different, already-filed defect. Not touched or bundled here.
- Runtime/mocked interception of the `postgres()` call — considered and rejected under Q2 above.
- Production's actual `DATABASE_URL` value — this fix depends on it already carrying
  `?sslmode=require` (DEF-344's own measurement) but neither changes nor can verify it from this
  repo.
- ~~Named gap: `apps/**` outside the sweep~~ — **closed.** system32-85's follow-up widened the
  sweep to `apps/**` too (the rule is "all shipped code", not the two directories the original
  spec happened to name); done in this same slice, see Tests below.

## Done when

- [x] `npm run typecheck` — clean (no output, exit 0).
- [x] `tests/unit/db-client-tls-from-url.test.ts` watched RED against unmodified `client.ts` —
      `Tests 3 failed | 121 passed (124)`: the sweep's `client.ts` test (call #1), and both
      `NODE_ENV`-destructure assertions. GREEN after the fix — `Test Files 1 passed (1)`,
      `Tests 124 passed (124)`.
- [x] Full unit project green: `npx vitest run --project unit` → `Test Files 112 passed (112)`,
      `Tests 1596 passed | 1 skipped (1597)` — the 1 skip is the pre-existing one, not new.
- [x] Integration tests run green against `shareat_test_lanea` post-fix — ran
      `packages/db/tests/integration/*.test.ts` (11 files, the package this task actually
      changed): `Test Files 11 passed (11)`, `Tests 239 passed (239)`, exit 0. Empirical
      confirmation of Q1's local-TLS answer against real local Postgres, not just the
      source-reading proof. Did **not** run the full integration suite (every package) — this
      subset is the direct blast radius of the edit; the rest is unchanged by this diff and
      wasn't re-run.
- [x] `client.ts`'s two `postgres()` calls carry no `ssl` key; `NODE_ENV` removed from both
      destructurings; no other line in either function changed (each function gained one
      3-line/1-line explanatory comment in place of the deleted `ssl` line — see diff in READY).
- [x] `.env.example` carries the new comment; no existing value changed.
- [x] Diff self-reviewed line by line for anything outside this list.
- [x] `npm run build` and a port-9008 smoketest — correctly flagged as system32-85's gates, not
      the worker's, per bible §9/rule 10 (a worker never builds or runs a dev server in a shared
      tree). system32-85 runs and reports both separately; not this lane's Done-when item.
- [x] Sweep widened to `apps/**` on system32-85's follow-up (the rule is "all shipped code", not
      the two directories the spec happened to name first) — 129 files pass, up from 124.
- [x] Reported to system32-85 with the real output of every gate (bible §3.4a / §3.5).
