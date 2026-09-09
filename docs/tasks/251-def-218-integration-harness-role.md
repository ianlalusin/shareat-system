# T-251 — DEF-218: the integration harness must not connect as a superuser

> **Status: SPEC, awaiting orchestrator `APPROVED`. Lane E, 2026-09-09.**
> Verified against HEAD, not taken on the brief's word (per the brief's own instruction — most
> recent task briefs on this project turned out wrong on contact with the code; this one partly
> did too, in a way that changes the shape of the fix). Nothing built. SPEC ONLY.

---

## ⚠️ What I verified, and where the brief's framing breaks

The brief frames this as "the test-only form of discovery 29's Option B" — swap the integration
pool's connecting role for a non-superuser, non-`BYPASSRLS` one, and a forgotten principal starts
failing loudly. **That swap is correct and necessary. It is not sufficient by itself, and applied
alone it does something worse than nothing:** it turns every scheduled job into a *silent* no-op
instead of a *loud* refusal, which is the opposite of what DEF-218 exists to produce.

### Confirmed, read-only, at HEAD

1. **Local probe** (`packages/db` via the existing `postgres` driver, read-only, no write):
   `postgres` — `rolsuper=true`, `rolbypassrls=true`, owns every table in `shareat_test`.
   `shareat_app` — correctly `rolsuper=false`, `rolbypassrls=false`, `NOLOGIN`
   (`packages/db/migrations/0011_row_level_security.sql:57-63`). `stores` (a representative
   `org_column` table) has both `relrowsecurity` and `relforcerowsecurity` true.
2. **CI independently reproduces the same exposure** (`.github/workflows/ci.yml:20-38`): a fresh
   `postgres:18` service container, connecting as its own default `postgres` superuser — not merely
   inherited from a developer's `.env.local`.
3. **The role is one cluster-wide fact, not a per-lane one.** `it.mjs` and `make-test-dbs.mjs` both
   derive every lane database's URL by swapping only the `pathname` via `new URL()`
   (`~/.claude/skills/orchestrator/tools/it.mjs:38-40`, `make-test-dbs.mjs:50-54`); username,
   password and host come from the single `TEST_DATABASE_URL` in `.env.local`. **Fixing the role
   once fixes every lane on that Postgres instance** — no per-lane-DB role work is needed.
4. ⛔ **The census is already stale by file count.** Lane C's recount at `0e41ae1` found 107
   integration files. Today, the `packages/**/tests/integration/**/*.test.ts` glob *alone* returns
   more than 100 files (Glob's own output truncated at "first 100 files; there are more than 100
   matches"), before adding `tests/integration/**` (5) and `tests/invariants/**` (1). The true
   total today is **above** 107. Per the brief, I did not re-run the switch/non-switch
   classification on the new files — that would be the third recount it forbids — but the spec
   below does not treat "34" or "107" as current; see **Blast radius**.

### ⛔ The finding that changes the shape of the fix: `system` has no real implementation

`Principal.kind === 'system'` (`packages/db/src/rls/principal.ts:19-24,41-42`) is documented as
*"deliberately does nothing: it stays as the connecting (owner) role, for which RLS does not
apply."* That is not a principal — it is the **absence** of one, made safe today only because the
connecting role happens to bypass RLS. Concretely, this is load-bearing in places DEF-218's brief
does not mention:

- **`packages/domain/src/scheduler/index.ts`** — `runJobForOrg`'s `startRun` (`:129`), `failRun`
  (`:181`), `finishRun`, and **every one of the six job entry points'** `listOrgsToRun` calls
  (`:214, 305, 410, 602, 656, 743`) run inside a **bare `transaction()`, no principal, by design**
  — `listOrgsToRun` must see every organization, which no single org's principal can express.
  `scheduler_runs` is `org_column`-scoped (`packages/db/src/rls/registry.ts:488-494`), **not**
  `system_only`. Under a non-bypass connecting role with no other change: `startRun`/`failRun`
  are refused by RLS (their own bookkeeping write breaks), and — worse — `listOrgsToRun` queries
  `organizations`, which is `self`-scoped (`registry.ts:56-59`): with no principal it silently
  returns **zero rows**, not an error. Every scheduled job then loops over an empty list and
  reports success having done nothing. That is a **silent** failure, which RULES/bible explicitly
  rank as the wrong failure direction (default-deny is supposed to fail loudly).
- **`packages/domain/src/organizations/index.ts`** — `bootstrapOrganization` takes an
  already-open `Tx` and its own file header (`:22-40`) states plainly that its callers open "a
  plain `transaction()`, which connects as the owner role, for which RLS does not apply... the
  same posture every scheduler script already runs under." `organizations` is `self`-scoped: a
  brand-new org's id cannot be set as `app.org_id` before the row exists (chicken-and-egg), so
  first-run bootstrap **structurally requires** an owner-bypass connection today. There is no
  other mechanism in the codebase.
- ⭐ **This is not test-only.** `apps/erp/src/app/setup/actions.ts:71-84` — `createFirstRunAction`,
  a real, internet-reachable server action — calls `transaction((tx) => bootstrapOrganization(tx,
  {...}))` the same bare way. First-run bootstrap's reliance on owner-bypass is live production
  posture, not a test artifact, and T-231's own "done when" already ruled the scheduler's
  unprincipalled transactions **correct, not a target** (`docs/tasks/231-...md` slice 3's last
  bullet: *"the scheduler legitimately opens unprincipalled transactions... widening the guard
  there would forbid something correct"*).

**Measured, not assumed, beyond the register's named 34:** grepping for callers of the scheduler's
job-runner exports and of `bootstrapOrganization` finds test files that are **not** in DEF-218's
34 (i.e. they count among the 73 that "switch") but call these owner-bypass-dependent paths
directly and would go red anyway:

```
packages/domain/tests/integration/budgets.test.ts           (calls runBudgetReissue)
packages/domain/tests/integration/firestore-relay.test.ts   (calls runFirestoreRelay)
packages/domain/tests/integration/recurring-expenses-job.test.ts (calls runRecurringExpenses)
packages/domain/tests/integration/org-store-identity.test.ts (calls bootstrapOrganization)
```

So "34 files go red" already undercounts, from a mechanism DEF-218's own text never names. The
real number cannot be produced by more grepping — see **Blast radius** below.

---

## Goal

**Two connections, not one role-swap.** The pool `@shareat/db`'s `transaction()`/`getDb()` opens
for ordinary request- and job-business-logic code becomes a genuine non-superuser, non-`BYPASSRLS`,
table-non-owning role — so a job or query that forgets its principal is refused loudly, in every
suite, exactly as DEF-218 asks. Separately, the small number of call sites that legitimately need
to act **across** every organization — scheduler bookkeeping and first-run bootstrap — get an
**explicit, second connection** (`systemTransaction()`) carrying the *existing* owner/bypass
credentials, so "system principal" stops being a fiction ("do nothing, hope the connection
bypasses") and becomes a real, auditable, grep-able escape hatch that survives this change and any
future production role change (Option B proper, whenever Ian approves it).

Two observable outcomes:

1. **DEF-218 closes.** A job or repository call against an `org_column`/`self`/`derived` table
   with no principal set is refused (`42501`) in every integration suite, not just when someone
   happens to probe it by hand. Lane D's mutation (revert a job to a bare `transaction()`; all
   tests still pass) can no longer succeed once this lands, because it is now the harness, not the
   job, that arms the check.
2. **The scheduler and first-run bootstrap keep working, unchanged in behaviour**, because they
   move onto an explicit `systemTransaction()` rather than continuing to depend on an accident of
   which role happens to be connected.

---

## Scope — bigger than "test harness," flagged rather than silently widened (RULES §3.3)

⛔ **This is not a pure test-config change.** Making `systemTransaction()` real requires touching
the application source that DEF-218's own text implies is out of reach ("packages/domain/src/repo"
and the like are untouched by lane D elsewhere). I am naming this plainly per RULES §3.3 rather
than either (a) silently deciding to touch source, or (b) silently shrinking the fix to something
that does not actually work. **The orchestrator's `APPROVED` on this spec is also approval of this
file list**, not just of the role idea.

| File | Change |
|---|---|
| `packages/db/src/client.ts` | **add** `systemTransaction<T>(fn)` beside `transaction()` — opens a transaction on a **second** connection pool, built from a new `SYSTEM_DATABASE_URL` env var (falls back to `DATABASE_URL` when unset, so production is a no-op until Ian separately decides to give it a distinct credential — Option B proper, out of scope here) |
| `packages/domain/src/scheduler/index.ts` | `runJobForOrg`'s `startRun`/`failRun`/`finishRun` and every job's `listOrgsToRun` call move from `transaction()` to `systemTransaction()`. `asSystem`'s own per-org body (already `SET LOCAL ROLE` + org set) is unchanged — only the *cross-org* bookkeeping moves |
| `packages/domain/src/organizations/index.ts` | doc comment at `:22-40` updated: it currently justifies the bare `transaction()` by "connects as the owner role, for which RLS does not apply" — that becomes false the moment `DATABASE_URL` is restricted, so the comment must say the caller now uses `systemTransaction()` instead, or it becomes exactly the kind of stale doc DEF-217 warns against |
| `scripts/bootstrap-org.ts` | its one `transaction((tx) => bootstrapOrganization(...))` call becomes `systemTransaction(...)` |
| `apps/erp/src/app/setup/actions.ts:71` | same — this is the live, request-reachable caller, not only the CLI fallback |
| `tests/integration/setup.ts` | computes a **second** connection string for the restricted role (see Contract 1) and sets it as `DATABASE_URL`; leaves `TEST_DATABASE_URL` untouched so every test file's own raw fixture-seeding connection (see Contract 2) keeps its current bypass privileges |
| `packages/db/tests/integration/rls.test.ts` (or a new sibling) | the control tests — Contract 3 |
| A new provisioning step, one of: extend `~/.claude/skills/orchestrator/tools/make-test-dbs.mjs`, or a new small script it can call | creates the restricted role once per Postgres instance (Contract 1) |
| `.github/workflows/ci.yml` | one new step, after the `postgres` service is healthy and before "Apply migrations," running the same provisioning step against the CI Postgres |
| `.env.example` | documents the new `SYSTEM_DATABASE_URL` var (dev-only; empty/absent means "same as DATABASE_URL," i.e. today's behaviour, until production role work happens) |

**Out of reach, unchanged:** `packages/auth/**`, `packages/db/schema|migrations|src/repo/access.ts`
(lane D's T-248), `apps/erp/src/app/cutover|settings|staff` (lane B), `docs/DEFECTS-REGISTER.md`,
`PROJECT_BIBLE.md`, `docs/ROADMAP.html`, the status board — all per the brief.

**No migration, no schema change, no RLS policy text change.** Role creation is cluster-level
Postgres provisioning (`CREATE ROLE`), not a Drizzle migration — the same reasoning migration
0011 already applies to `shareat_app` itself.

---

## Contract

### 1. The restricted role

A new LOGIN role — proposed name `shareat_test_runner` — created once per Postgres instance
(idempotent `DO $$ ... IF NOT EXISTS ... $$`, mirroring `0011`'s own block for `shareat_app`):

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shareat_app') THEN
    CREATE ROLE "shareat_app" NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shareat_test_runner') THEN
    CREATE ROLE "shareat_test_runner" LOGIN PASSWORD '<fixed test-only constant>'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT "shareat_app" TO "shareat_test_runner";
```

- **Idempotently ensures `shareat_app` first**, because provisioning order relative to the first
  lane DB's migration is not guaranteed — whichever runs first creates it, the second is a no-op,
  matching `0011`'s own guard.
- `GRANT shareat_app TO shareat_test_runner` is a **cluster-wide role relationship**, done once —
  it is *not* re-done per lane database. Because `shareat_app`'s per-database table grants
  (`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES...`, `0011:68-72`) already run once per lane
  DB via that lane's own migration pass, `shareat_test_runner`'s inherited membership extends into
  every lane DB automatically the moment that lane's migrations have run — no additional grant
  step per lane.
- **Owns no table.** Tables stay owned by whichever role runs migrations (`postgres` today,
  unchanged) — this avoids migration 0011's own documented trap #2 ("a table's owner bypasses RLS
  by default").
- The password is a **fixed, non-secret, test-only constant**, matching the existing convention of
  `ci.yml:24` hardcoding `POSTGRES_PASSWORD: postgres` in plaintext — this is not a production
  credential and needs no rotation story.
- **Provisioning, not migration**: added to `make-test-dbs.mjs` (runs once against the server's
  `postgres` maintenance DB, which the script already connects to) and to a new CI step. Both call
  sites should share the literal SQL/constant rather than each hand-typing it — a short comment on
  each occurrence pointing at the other, in the absence of a shared module reachable from both a
  `.mjs` script and `ci.yml`'s `psql`/inline step.

### 2. Two URLs, one lane database — `tests/integration/setup.ts`

`TEST_DATABASE_URL` is **unchanged**: it stays the admin/bypass role, and every test file's own
raw `postgres(url)` fixture-seeding connection (the pattern at, e.g.,
`packages/auth/tests/integration/authorize.test.ts:56,83` — a bare `insert into organizations`
used purely to set up scenario data) keeps working exactly as today, untouched. This is
deliberate: rewriting the ~70+ files' fixture-seeding code to go through a principal is a
different, much larger task (effectively Option A) that nobody has asked for and that discovery
29 explicitly rejected for now.

`DATABASE_URL` — what `@shareat/db`'s `transaction()`/`getDb()` resolves — becomes the restricted
role's connection string, computed from `TEST_DATABASE_URL` with **only the credentials swapped**,
never by string surgery (`new URL()`, per the standing rule — the password may contain `@`):

```ts
const admin = new URL(url); // url = process.env.TEST_DATABASE_URL, validated above
const restricted = new URL(admin);
restricted.username = 'shareat_test_runner';
restricted.password = TEST_RUNNER_PASSWORD; // same fixed constant as Contract 1
process.env.DATABASE_URL = restricted.toString();
```

Same host, port and database name (the same lane DB) — only the role differs. `it.mjs` needs no
change: it sets `DATABASE_URL` too, but `setup.ts` runs first inside the spawned vitest process and
overrides it before any test file's module code observes it.

### 3. `systemTransaction()` — the real second connection

```ts
// packages/db/src/client.ts, beside transaction()

function createSystemClient(): Sql {
  const { DATABASE_URL, SYSTEM_DATABASE_URL, DATABASE_POOL_MAX, NODE_ENV } = env();
  return postgres(SYSTEM_DATABASE_URL || DATABASE_URL, { max: DATABASE_POOL_MAX, ...sameOptionsAsCreateClient });
}
// cached on globalForDb exactly like getSql()/getDb(), a distinct pool

/**
 * Runs `fn` on the SYSTEM connection — the owner/bypass role, unchanged from what `DATABASE_URL`
 * used to mean before this task. Reserved for the enumerable set of operations that must see or
 * write across every organization: scheduler cross-org bookkeeping (`listOrgsToRun`, `startRun`,
 * `failRun`, `finishRun`) and first-run organization bootstrap. ⛔ Never reachable from ordinary
 * request or job business logic — if a new call site thinks it needs this, that is a design
 * question for whoever is adding it, not a default to reach for.
 */
export async function systemTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getSystemDb().transaction(fn);
}
```

When `SYSTEM_DATABASE_URL` is unset (every environment except the lane test harness, until Ian
separately approves a production Option B), `systemTransaction()` behaves **identically** to
today's `transaction()` — same credentials, same connection — so production and local dev are
unaffected by this task. Only the test harness (Contract 1+2) actually diverges the two.

### 4. The control — proof the fix does what DEF-218 asks

New test (in `rls.test.ts` or a sibling), watched to demonstrate the CURRENT bug before the fix
lands, then to pass after:

```ts
it('a bare transaction() write to an org-scoped table with no principal is REFUSED, not silently allowed', async () => {
  const err = await transaction(async (tx) => {
    try {
      await tx.execute(dsql`insert into stores (org_id, code, name) values (${orgA}, 'CTRL', 'control')`);
      return null;
    } catch (e) { return e as { code?: string }; }
  }).catch((e: { code?: string }) => e);
  expect(err?.code, 'a no-principal write must be refused by the policy, not silently accepted').toBe('42501');
});

it('the DATABASE_URL pool is not a superuser and does not bypass RLS', async () => {
  const row = await transaction((tx) =>
    tx.execute(dsql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`),
  );
  const r = (Array.isArray(row) ? row : (row as { rows: unknown[] }).rows)[0] as { rolsuper: boolean; rolbypassrls: boolean };
  expect(r.rolsuper, 'DATABASE_URL must not connect as a superuser').toBe(false);
  expect(r.rolbypassrls, 'DATABASE_URL must not bypass RLS').toBe(false);
});
```

The first is DEF-218's actual reproduction of lane D's mutation, made permanent: it must **fail**
(no error, or a different SQLSTATE) before this task's role change, and pass after — proving the
harness, not the job, is what now arms the check. The second is a direct, cheap assertion of the
fact everything else depends on, so a future change that quietly widens `shareat_test_runner`'s
grants (e.g. `BYPASSRLS`, by habit, "just to make a test pass") is caught immediately rather than
silently reopening DEF-218.

### 5. `systemTransaction()` call sites keep their current behaviour, proven, not assumed

For each of `startRun`/`failRun`/`finishRun`/`listOrgsToRun` and `bootstrapOrganization`'s two
callers, an existing integration test that already exercises that path (e.g.
`scheduler.test.ts`, `recurring-expenses-job.test.ts`, `budgets.test.ts`, `firestore-relay.test.ts`,
`org-store-identity.test.ts`, `first-run-setup.test.ts`) is run **before and after** the
`transaction()` → `systemTransaction()` swap, on the same lane DB, with identical results. This is
the regression proof for Contract 1's file list — it is not new test-writing, it is re-running
what already exists and diffing the outcome.

---

## Invariants

1. **`DATABASE_URL`'s pool is never a superuser and never bypasses RLS**, in the integration
   harness. Enforced by Contract 4's second assertion.
2. **`TEST_DATABASE_URL` is unchanged** — every existing raw fixture-seeding connection in every
   test file keeps working with no edits. This is what keeps this task's actual file list short.
3. **`systemTransaction()` is reachable only from the six named call sites** (scheduler bookkeeping
   ×4, bootstrap ×2). No guard test enforces this yet — RULES §3.3: that guard is a reasonable
   follow-on, not manufactured here to pad this task's scope.
4. **Production is unaffected.** `SYSTEM_DATABASE_URL` unset ⇒ `systemTransaction() === transaction()`
   in every environment except the lane harness.
5. **`asOrg`/`asPerson`/`withOrgPrincipal`-based tests are unaffected in their own assertions** —
   this task changes what a *bare, unprincipalled* `transaction()` does; every test that already
   sets a principal correctly keeps seeing exactly what it sees today.
6. **No migration, no RLS policy text change.** If implementation finds either is actually needed,
   that is a spec defect — stop and report it, per RULES §3.4a, rather than adding one quietly.

---

## Blast radius — measured, not estimated, and why it can't be estimated further from here

The orchestrator asked for an honest number and how it was produced. Grepping got me the four
names above, beyond the register's 34 — but grepping cannot find every place a test's fixture
setup happens to touch an `org_column` table through something *other* than the two patterns I
checked (raw `TEST_DATABASE_URL` inserts and the named job-runner/bootstrap functions). **The only
trustworthy number comes from running the suite once, after Contract 1-4 land, against a
throwaway lane database created for exactly this purpose**, and reading vitest's own pass/fail
list. That run is this task's own proof step (Contract 4/5), not a separate exercise — it is not
additional work, it is the last thing this task does before reporting `READY`.

**What I can say now:** the register's 34, plus at minimum the 4 named above (`budgets`,
`firestore-relay`, `recurring-expenses-job`, `org-store-identity`), is the floor, not the ceiling
— and the true file count is already above the 107 the 34/73 split was computed against. **What
happens to whatever the real run finds red is a follow-on task, sequenced immediately after this
one** (working title: DEF-218-b or the next open task number), because:

- fixing 34+ files' worth of missing `withOrgPrincipal` wrapping is itself the size of T-231's
  slice 2 (33 files, ~2 hours to a day of mechanical work plus a guard) — a second unit of work,
  not a rider on this one;
- **the count and shape of what needs fixing literally cannot be known until this task's role
  change exists to reveal it** — that is DEF-218's whole point, restated as a scheduling
  constraint rather than an inconvenience;
- shipping this task with the harness fixed but the resulting reds unrepaired is explicitly
  **not** "leaving 34 files red and calling it done" — CI stays green on `main` throughout, because
  (per Contract 5) this task proves the six `systemTransaction()` call sites are unaffected, and
  the newly-red files are a **known, reported, separately-tracked** list the moment they exist,
  not a silent regression discovered later.

---

## DEF-211 interaction

`systemTransaction()` is DEF-211's "centralise the idiom" goal finished for the `system` case —
today `asSystem` in the scheduler is a fourth hand-spelled copy of the role-switch idiom
(`scheduler/index.ts:692-698`), just for `principal_kind = 'system'` instead of `'staff'`. This
task does **not** fold `asSystem` into anything, and does **not** touch the 70+3 hand-spelled test
`asOrg`/`asPerson` copies — same "deliberately out of scope" call discovery 29 already made,
restated rather than silently revisited. `asSystem`'s own per-org body already sets a real
principal (`SET LOCAL ROLE shareat_app` + org id) and is unaffected by this task; only the
*cross-org* calls around it (`listOrgsToRun`, `startRun`, `failRun`) move to
`systemTransaction()`.

---

## Tests

| Test | Must show, before this task's role change lands |
|---|---|
| Contract 4, assertion 1 (control) | the no-principal write **succeeds** (or errors with something other than `42501`) — the current bug, reproduced permanently rather than left to lane D's one-off hand probe |
| Contract 4, assertion 2 | `rolsuper`/`rolbypassrls` both **true** under `DATABASE_URL` today |
| Contract 5 re-runs | all pass today (current baseline, under bypass) |

After the role change (Contract 1-3 built): both Contract 4 assertions flip to pass; Contract 5's
re-runs must show **identical outcomes** to their pre-change baseline. Any Contract-5 test whose
outcome *changes* is either a bug in `systemTransaction()`'s wiring (stop, it's not on this task's
list) or evidence the "six call sites" enumeration missed one (stop, report it, the list in Scope
is wrong).

Then the full-suite run described in **Blast radius** — the actual proof step — on a throwaway
lane DB, never `shareat_test`.

Unit tests, typecheck and the read-only psql probes above are mine to run per the brief; the full
integration run is explicitly **not** in that list (it needs the harness built first), so it
happens only after `APPROVED` and during the build, not during this spec.

---

## Out of scope

| Not doing | Why |
|---|---|
| Fixing whichever integration files the full run finds red | Unknowable count until the harness exists (**Blast radius**); a second task, sequenced immediately after |
| Widening `no-direct-transaction-in-erp.test.ts` (T-231 contract 5) or building an equivalent guard for `systemTransaction()`'s six call sites | Reasonable, not manufactured here — invariant 3 names it as a follow-on |
| Production's own connecting role (real Option B) | Still gated on Ian's read-only droplet probe (discovery 29 §7), unanswered as far as this lane can see; this task makes the *code* ready for that answer (`SYSTEM_DATABASE_URL` exists and defaults safely) without pre-empting the decision |
| The 70+3 hand-spelled `asOrg`/`asPerson` test copies (DEF-211's other half) | Discovery 29's explicit "deliberately out of scope," unchanged |
| Re-counting or re-classifying the 34/73 split | Forbidden by the brief; superseded by the full-run measurement this task produces as a side effect |
| Any RLS policy text change, any migration | Contract holds with role/connection changes alone; if the build finds otherwise, stop and report (invariant 6) |

---

## Open questions for the orchestrator's `APPROVED`

1. **The scope expansion itself.** Is touching `scheduler/index.ts`, `organizations/index.ts`,
   `scripts/bootstrap-org.ts` and `apps/erp/src/app/setup/actions.ts` acceptable for a task titled
   "integration harness role"? I believe the alternative (restrict only test config, leave the
   scheduler/bootstrap silently broken-by-omission) is worse and not what DEF-218 actually asks
   for — but it is the orchestrator's or Ian's call, not mine to widen unilaterally.
2. **Role name** (`shareat_test_runner` proposed) — cosmetic, easy to change, naming it now so the
   build doesn't invent one mid-flight.
3. **Whether the follow-on "fix the reds" task gets its number allocated now or after this task's
   proof run reports the real count.** I'd default to *after* — allocating a number against an
   unmeasured list is exactly the kind of estimate-dressed-as-a-fact this project's rules warn
   against (bible §13 row 163, "say the number, not the adjective").

None of these block writing the spec; they block the **build**, which is sequenced later per the
brief regardless.

---

## Done when

- Contract 4's two assertions watched **failing** first (current bypass), then passing after the
  role/connection change — not written after the fact.
- Contract 5's five named tests re-run before and after with **identical** outcomes.
- The full integration suite run once on a throwaway lane DB; its red list (if any beyond Contract
  5's five) reported verbatim to the orchestrator as the **measured** blast radius, with a
  recommended follow-on task, not silently patched.
- `npm run test` (unit) green; typecheck clean.
- `.env.example` documents `SYSTEM_DATABASE_URL`.
- No file changed outside the Scope table above; any exception reported explicitly (RULES §3.3).
- Report ends with a `FOR IAN` block.
- ⛔ This lane runs no `git`, no `npm run build`, no `npm run dev`, no `npm run test:integration`
  directly — only `it.mjs` against `shareat_test_def219` and read-only psql probes, per the brief.

---

## FOR IAN

**What DEF-218 says, in plain language:** our automated tests run against a database connection
that is allowed to ignore every privacy rule we've built (Row-Level Security) — like a
building inspector who's also a master-key holder. So a scheduled job that forgets to "log in" as
a specific business before touching its records still passes every test, and only gets refused
for real once it's running live. That already happened once, for the recurring-expense job, and
was only caught because the person who wrote it double-checked their own work by hand.

**What I found that the brief didn't mention:** the fix isn't just "make tests use a weaker
login." Some of our own code — the scheduler's own bookkeeping (which businesses to run today's
jobs for, and recording whether each one succeeded) and the very first step of setting up a brand
new business — *genuinely need* the master key, because at that moment there is no single business
to log in as yet. Today that need is met only by accident (the test connection happens to be a
master key too). If we took the master key away without also giving those specific, already-known
spots an explicit, separate master key of their own, every scheduled job in every test would
silently do nothing and report success — which is worse than the bug we're fixing.

**What this spec proposes:** keep one master-key connection, reserved and clearly labelled, for
exactly those known spots (about half a dozen). Give everything else — the actual business logic
tests are meant to catch bugs in — a real, restricted login, the same shape production should
eventually use. That is a bit more code than "swap a password," but it's the version that actually
does what you asked for instead of quietly breaking something else.

**What I need from you or the orchestrator:** the "open questions" above — mainly, sign-off that
touching those handful of extra files is worth it (I believe it is; the alternative doesn't
actually fix the bug). Nothing here is built yet.
