# T-251a — make the "system" principal real: `systemTransaction()`

> **Status: ✅ BUILT AND SHIPPED 2026-09-10 (lane E, Sonnet). Gates re-run independently by the
> orchestrator on the shared database: typecheck 0, unit 83 files/1191 passed, six integration
> suites 77/77 on `shareat_test`, build 0.** Spec written in plan mode 2026-09-09. Split off T-251 (DEF-218) after the
> orchestrator agreed the naive harness-role swap would silently break the scheduler and
> organisation bootstrap. See `docs/tasks/251b-integration-harness-role.md` for the sequel (the
> actual harness role flip) and the full DEF-218 analysis this task's motivation comes from — not
> restated here beyond what this task needs.
>
> **On today's connecting role this task changes no runtime behaviour.** It is a rename: the same
> connection, the same authority, given a name and an enumerable caller list instead of being
> wherever someone happened to write a bare `transaction()`. Say so plainly rather than writing a
> test that would pass vacuously — see **Tests**.

---

## ⚠️ The constraint this task must not violate: bible §13 row 185

`PROJECT_BIBLE.md:1490`, read in full before writing this spec. Quoted precisely because the
exact wording is load-bearing:

> **FIRST-RUN SETUP IS THE ONE REQUEST PATH THAT OPENS AN OWNER-ROLE TRANSACTION WITHOUT A
> PRINCIPAL — deliberately, because there is no principal before the first organisation exists.**
> ... ⛔ **Not a precedent. Any other request path wanting owner role is DEF-215's door
> reopening**; this one closes forever after the first organisation, so on every production
> request after day one the path is dead.

Two things follow:

1. **Row 185 speaks to request paths** — HTTP-reachable server actions. The scheduler's
   bookkeeping and `scripts/bootstrap-org.ts` are a cron-driven job runner and a hand-run CLI
   script respectively, not request paths — a different category row 185 doesn't police directly.
   `apps/erp/src/app/setup/actions.ts` *is* the one path row 185 already named.
2. **This task does not ask row 185 to cover new ground.** It gives the *existing* sanctioned
   exception (and the scheduler/script code that already relies on the same underlying mechanism,
   unpoliced by row 185 because it isn't a request path) one real, named, auditable
   implementation instead of five independent inline `transaction()` calls. The risk row 185
   guards against — a *future, different* request path reaching for owner authority — is what
   this task's design (closed caller list, doc comment citing the row, a mechanical guard test)
   exists to keep from getting easier by accident.

⛔ **I do not amend the bible.** Whether row 185's text itself should now mention
`systemTransaction()` by name (since the mechanism it describes is being centralised) is a
recommendation for my READY report, for the orchestrator to write and Ian to rule on — not a line
I add here.

---

## Goal

Every place in the codebase that currently reaches cross-organisation authority by opening a bare,
unprincipalled `transaction()` and relying on the connecting role happening to bypass RLS does so
through one named, documented, enumerable function instead: `systemTransaction()`. Nothing about
*which* connection is used changes in this task — only that the intent is now explicit and
grep-able, which is what makes T-251b (an actual role change) safe to attempt at all: it can point
at a closed list of five call sites and ask "does breaking owner-bypass break exactly these, and
nothing else?" instead of discovering the answer under a red suite.

---

## Scope — exact files

| File | Change |
|---|---|
| `packages/db/src/client.ts` | **add** `systemTransaction<T>(fn)`, a second lazily-created connection/pool, alongside the existing `transaction()`/`getSql()`/`getDb()` |
| `packages/core/src/env.ts` | **add** `SYSTEM_DATABASE_URL` — optional, same shape as `DATABASE_URL`'s postgres:// validation, using the existing `blankAsAbsent()` helper |
| `.env.example` | document the new var: optional, "same as `DATABASE_URL` unless explicitly split — reserved for the enumerable system-authority call sites named in `client.ts`'s `systemTransaction` doc comment" |
| `packages/domain/src/scheduler/index.ts` | (a) `runJobForOrg`'s `startRun` (`:129`) and `finishRun` (`:157`) move to `systemTransaction`; (b) `closeFailedRun`'s `failRun` (`:181`) moves to `systemTransaction`; (c) **new** module-level `listOrgsToRun(orgId?: string)` helper wrapping `systemTransaction(tx => schedulerRepo.listOrgsToRun(tx, orgId))`; (d) the 6 existing hand-rolled call sites (`:214,305,410,602,656,743`) call the new helper instead |
| `packages/domain/src/recurring-expenses/job.ts` | its one hand-rolled `listOrgsToRun` call (`:101`) calls the new scheduler-module helper instead of hand-rolling its own `transaction()` |
| `packages/domain/src/organizations/index.ts` | update the file header (`:22-40`) — it currently justifies the bare `transaction()` by "connects as the owner role, for which RLS does not apply"; that becomes a stale description of the mechanism the moment this task lands, so it is rewritten to name `systemTransaction()` and cite row 185, rather than left to rot (the DEF-217 lesson) |
| `scripts/bootstrap-org.ts` | its one `transaction((tx) => bootstrapOrganization(...))` call becomes `systemTransaction(...)` |
| `apps/erp/src/app/setup/actions.ts:71` | same — the row-185-sanctioned request path |
| `tests/unit/system-transaction-callers.test.ts` | **new** — the mechanical guard, Contract 2 |

**Not touched**: `packages/db/src/rls/principal.ts` (the `system` `Principal` kind stays exactly
as documented — this task gives the *scheduler's and bootstrap's* implicit system authority an
explicit connection, it does not change what `applyPrincipal({kind:'system'})` does, which
already has no source callers per T-231's own audit); any migration; any RLS policy;
`packages/auth/**`; `packages/db/schema|migrations|src/repo/access.ts` (lane D's T-248);
`apps/erp/src/app/cutover|settings|staff` (lane B); `docs/DEFECTS-REGISTER.md`;
`PROJECT_BIBLE.md`; `docs/ROADMAP.html`; the status board.

**No migration slot needed or requested.** If the build finds one is actually required, that is a
spec defect — stop and report, per RULES §3.4a, rather than adding one quietly.

---

## Contract

### 1. `systemTransaction()` — one connection, one name, one comment naming every caller

```ts
// packages/db/src/client.ts

function createSystemClient(): Sql {
  const { SYSTEM_DATABASE_URL, DATABASE_URL, DATABASE_POOL_MAX, NODE_ENV } = env();
  return postgres(SYSTEM_DATABASE_URL ?? DATABASE_URL, {
    max: DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: NODE_ENV === 'production' ? 'require' : false,
    onnotice: () => {},
  });
}

export function getSystemSql(): Sql {
  if (!globalForDb.__shareat_system_sql) {
    globalForDb.__shareat_system_sql = createSystemClient();
  }
  return globalForDb.__shareat_system_sql;
}

export function getSystemDb() {
  if (!globalForDb.__shareat_system_db) {
    globalForDb.__shareat_system_db = drizzle(getSystemSql(), { schema });
  }
  return globalForDb.__shareat_system_db;
}

/**
 * Runs `fn` on the SYSTEM connection — bible §13 row 185. Reserved for the enumerable set of
 * operations that must see or act across every organisation, because no single org's principal
 * can express them:
 *
 *   - `runJobForOrg` / `closeFailedRun` (scheduler bookkeeping — a run row exists before any
 *     per-org principal is meaningful to it)
 *   - `listOrgsToRun` (the scheduler must enumerate every org before it can scope to one)
 *   - `bootstrapOrganization`'s two callers: `scripts/bootstrap-org.ts` and
 *     `apps/erp/src/app/setup/actions.ts` (row 185's named exception — there is no principal
 *     before the first organisation exists)
 *
 * ⛔ **Not a general escape hatch, and not a precedent for a sixth caller.** If new code thinks
 * it needs this, that is a design question for whoever is adding it — raise it, don't reach for
 * this function by analogy. `tests/unit/system-transaction-callers.test.ts` fails the build if
 * any file outside the five above calls it.
 *
 * ⚠️ With `SYSTEM_DATABASE_URL` unset, this is byte-for-byte `transaction()` — same connection,
 * same credentials. It diverges only where something explicitly sets that variable (the
 * integration test harness, per `docs/tasks/251b-...md` — not production, not local dev, until a
 * separate, later decision says otherwise).
 */
export async function systemTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getSystemDb().transaction(fn);
}

/** Scripts and tests only, mirrors closeDb(). */
export async function closeSystemDb(): Promise<void> {
  if (globalForDb.__shareat_system_sql) {
    await globalForDb.__shareat_system_sql.end({ timeout: 5 });
    globalForDb.__shareat_system_sql = undefined;
    globalForDb.__shareat_system_db = undefined;
  }
}
```

### 2. The mechanical guard — proof where a behavioural test would pass vacuously

`tests/unit/system-transaction-callers.test.ts` — reads the five files as text (comments stripped
first, matching the convention `DEF-221`'s guard already established, so a file *documenting*
`systemTransaction` in prose isn't reported as a caller):

1. **Each of the five known files contains at least one `systemTransaction(` call.** Named
   individually, not as a count, so a future refactor that empties one silently is caught by name:
   `packages/domain/src/scheduler/index.ts`, `packages/domain/src/organizations/index.ts` (via the
   `Tx` it's handed — see note below), `scripts/bootstrap-org.ts`,
   `apps/erp/src/app/setup/actions.ts`.
   ⚠️ **`organizations/index.ts` does not itself call `systemTransaction`** — `bootstrapOrganization`
   takes an already-open `Tx` from its caller (Contract 1's design, unchanged). The guard's list is
   therefore the **callers**, i.e. `scripts/bootstrap-org.ts` and `setup/actions.ts` — four files,
   not five, once `organizations/index.ts` is correctly excluded. Written this way rather than
   padding the count to match the doc comment's five-item *bullet* list, which names four call
   *sites* (bookkeeping, `listOrgsToRun`, and the two `bootstrapOrganization` callers) across
   **two source files plus one script** — the comment enumerates responsibilities, the guard
   enumerates files, and they are not the same shape. State this explicitly rather than let the
   numbers quietly disagree.
2. **No file outside that set, anywhere under `apps/**` or `packages/domain/src/**`, calls
   `systemTransaction(`.** Import-site AND re-export matched, mirroring T-231 contract 5's finding
   (b) — a re-export is a hole straight through an import-only guard.
3. **A non-vacuous control**: assert the scan covers more than some known-small floor of files
   before asserting anything about offenders (T-231 contract 5's standing pattern) — this project
   has been bitten twice by a sweep that silently scanned nothing and reported success.

Watched failing first (the function/import doesn't exist yet — a collection or module-resolution
error is an acceptable first failure), then passing once Contract 1 and the call-site moves land.

### 3. `listOrgsToRun` — one helper, not seven copies

```ts
// packages/domain/src/scheduler/index.ts, near the top-level job functions

/**
 * The scheduler's one way to enumerate organisations to run a job for. Centralised so
 * `systemTransaction` has exactly one call site to reach through here, not seven independently
 * editable ones — DEF-211's "centralise the idiom" instinct, applied to keep Contract 1's closed
 * caller list actually closed rather than aspirational.
 */
async function listOrgsToRun(orgId?: string) {
  return systemTransaction((tx) => schedulerRepo.listOrgsToRun(tx, orgId));
}
```

All 6 in-module call sites (`runMonthEnd`, `runAttendanceSweep`, `runFirestoreRelay`,
`runOrderWastageBackstopSweep`, `runFindingObservation`, `runBudgetReissue`) and the 1 in
`recurring-expenses/job.ts` (imported) call this instead of hand-rolling
`transaction((tx) => schedulerRepo.listOrgsToRun(tx, ...))`.

---

## Invariants

1. **Zero behaviour change while `SYSTEM_DATABASE_URL` is unset** — which is every environment
   this task touches (local dev, CI, every lane DB). Enforced by Contract 1's fallback to
   `DATABASE_URL` and proven by Contract 4's before/after re-runs.
2. **The caller list is closed and named**, not open-ended. Enforced by Contract 2.
3. **`applyPrincipal({kind:'system'})` in `principal.ts` is unchanged** — this task does not touch
   it, does not give it callers, and does not conflate it with `systemTransaction()`. They solve
   the same *shaped* problem (cross-org / pre-principal authority) at different layers and this
   task does not merge them.
4. **`asSystem`'s per-org body in the scheduler is unchanged** — only the *cross-org* bookkeeping
   around it moves. `asSystem` already sets a real principal (`SET LOCAL ROLE` + org id) and stays
   exactly as it is.
5. **No migration, no schema change, no RLS policy text change.**

---

## Tests

Per the orchestrator's own framing: on today's role, this task changes nothing observable, so an
ordinary behavioural test cannot prove it worked — writing one that passes anyway would be
DEF-218's own lesson applied to its own fix. What actually proves the work:

| Test | Must show |
|---|---|
| Contract 2 (the caller-list guard) | fails first (no `systemTransaction` exists / wrong caller set), passes after Contract 1 + 3 land |
| Contract 2's non-vacuous control | passes immediately — if it doesn't, the scan is broken and nothing else in the file means anything |
| Existing integration suites already covering the moved call sites — `packages/domain/tests/integration/scheduler.test.ts`, `recurring-expenses-job.test.ts`, `budgets.test.ts`, `firestore-relay.test.ts`, `packages/domain/tests/integration/org-store-identity.test.ts`, `first-run-setup.test.ts` | **identical outcomes** run before and after this task's changes, on the same lane DB (`shareat_test_def219`). This is the regression proof for invariant 1 — it is re-running what already exists, not new test-writing |
| `npm run typecheck` | clean |
| `npm run test` (unit) | green |

Run via `node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_def219 <files>`. Never
`npm run test:integration` (shared `shareat_test`, truncates a peer's fixtures) — per the brief,
this lane runs no `git`, `build`, `dev`, or `test:integration` directly.

---

## Out of scope

| Not doing | Why |
|---|---|
| Actually changing which role/connection the harness uses | T-251b, not approved yet, sequenced after this task |
| A guard forbidding `applyPrincipal({kind:'system'})` from gaining callers | Unrelated to this task; it already has none (T-231's audit) and nothing here changes that |
| Touching `packages/db/src/rls/principal.ts` | Its shape is unaffected — `systemTransaction` is a client-layer concern, `principal.ts` is the RLS-arming layer |
| Widening `no-direct-transaction-in-erp.test.ts` (T-231 contract 5) to also forbid `systemTransaction` calls outside its own five files | Reasonable, but a distinct guard from Contract 2 above and not manufactured here to pad scope — Contract 2 already does this job for the new function specifically |

---

## Done when

- Contract 2's guard watched failing first, then passing, naming the four caller files precisely
  (not a count) and excluding `organizations/index.ts` explicitly per the note in Contract 2.
- The six re-run integration suites show **identical** pass/fail outcomes before and after.
- `npm run typecheck` clean, `npm run test` green.
- No file changed outside the Scope table; any exception reported explicitly (RULES §3.3).
- `.env.example` documents `SYSTEM_DATABASE_URL`.
- Report ends with a `FOR IAN` block, and separately reports to the orchestrator (not written by
  this lane):
  1. the latent-landmine defect (a restricted `DATABASE_URL`, applied naively, would make every
     scheduled job silently process zero organisations and report success) as a register row;
     > ⛔ **THE PARENTHESIS IS WRONG, AND IT WAS WRONG WHEN IT WAS WRITTEN — T-300, 2026-09-13.**
     > A restricted `DATABASE_URL` does **not** make scheduled jobs report success. **All eight
     > exit 1 on an empty run**, loudly, into the host's mailer — `attendance-sweep:55`,
     > `budget-reissue:65`, `finding-observation:64`, `firestore-relay:74`, `month-end:67`,
     > `order-wastage-backstop:68`, `orphan-file-sweep:74`, `recurring-expense-draft:72`, each
     > carrying the same comment about *"a configuration problem wearing the costume of a quiet
     > night"*, and each `.service` file stating the exit code is load-bearing so the mailer speaks.
     >
     > ⚠️ **Dated rather than asserted:** the guard landed in `91397aa` (2026-09-06, T-214); DEF-250,
     > the row this bullet is describing, was filed in `245c102` (2026-09-09) — **three days
     > later**. And `docs/ROADMAP.html` already recorded the correct behaviour from a real run:
     > *"exit 1 with no organisations, exit 0 with one."*
     >
     > ⭐ **This matters beyond a wording fix, and it matters in the reassuring direction.** The
     > sentence made the role tightening read as a silent-data risk. It never was: the failure
     > direction of the whole change is an **availability wall** — jobs that stop and say so,
     > screens that return zero rows, a `/setup` INSERT refused by its own `WITH CHECK`. That is
     > what `docs/ops/README.md` §"Status as of 2026-09-12" means by *"it fails CLOSED… the only
     > reason this was recoverable rather than a data incident."* **The landmine was always loud.**
     >
     > ⚠️ The *underlying* defect this bullet asked to be filed is real and unaffected: a restricted
     > `DATABASE_URL` with `SYSTEM_DATABASE_URL` unset does break every cross-org enumerate path.
     > Only the described symptom was wrong.
  2. the bible amendment I believe row 185 needs now that its exception has a shared, named
     implementation — recommendation only, not written by this lane.
- ⛔ This lane runs no `git`. The orchestrator commits.
