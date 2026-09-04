# T-111 — property-based invariant tests, closing DEF-080 and DEF-081

Status: done — 2026-09-05. Gates: typecheck clean · unit 1013/1014 (1 pre-existing skip, unrelated)
· full integration suite, 83 files / 2258 tests, green · `npm run build` exit 0 (dev server
confirmed stopped first). Two divergences from this spec's own Contract, found while implementing
— see the note after the Contract section below.

## Goal

Give Phase 1 the **standing, continuous** invariant check its exit gate was signed off on but
never got (`docs/DEFECTS-REGISTER.md` DEF-080, DEF-081). Two defects, one fix, because DEF-081's
finding (the directory a property suite would live in is unreachable) is a precondition for
DEF-080's finding (the suite was never written) rather than an independent gap.

## Scope

- `vitest.config.mts` — `tests/invariants/**/*.test.ts` currently sits in the **unit** project's
  include glob. A test that posts through the real `postEntry` needs real Postgres, so it belongs
  under the **integration** project instead (same reasoning the file's own comment already gives
  for every other DB-touching suite: "CI runs the unit project BEFORE migrations are applied").
  `tests/golden/` stays in `unit` — its one occupant (T-157's adjudication replay) is a pure-function
  test and correctly reachable today; this task does not touch it.
- `package.json` — add `fast-check` as a root devDependency. Named explicitly in DEF-080's own
  disposition; no generator library exists anywhere in the tree today.
- `tests/invariants/accounting-equation.test.ts` — new. The property suite itself.

## Contract

Generate random valid transaction sets and post them through the **real** `postEntry` against
real Postgres, then assert, after **every** posted entry (not just at the end of a run):

1. **Invariant 10** — `getTrialBalance(db, {...}).ties === true`.
2. **Invariant 9** — the extended accounting equation holds to the centavo:
   `Σassets + Σexpenses = Σliabilities + Σequity + Σincome`, using each line's normal-balance-signed
   `balance` from `getTrialBalance`'s own output (never a second, hand-rolled query) — this is the
   general form of Assets = Liabilities + Equity once income/expense are accounted for, and it is
   what invariant 1 (every entry balances) implies is true for *any* balanced posting, across
   *any* account selection. That generality is the point: a fixed fixture corpus (T-108's worked
   examples) only ever exercises the ~15 accounts someone thought to write a fixture for; this
   exercises the other ~65+ leaf accounts nobody has posted to yet, and would have caught a
   normal-balance seeding typo (bible §13 row 39's own failure mode) that a fixed fixture set
   cannot reach because it never selects that account.

**Generator shape**, per fast-check property:
- A random total amount (1 centavo – ₱50,000), split via the existing `allocate()` helper
  (`packages/core/src/money.ts`) into 1–3 debit-side shares and 1–3 credit-side shares — reusing
  the project's own penny-exact splitter rather than inventing a second one.
- Each share lands on a distinct account code drawn from the **eligible pool**: every leaf
  (`isPostable`) account in `CHART_OF_ACCOUNTS`, excluding `RESERVED_CODES` (the DB's own
  eligibility trigger rejects a reserved account as a posting target — T-103) and
  `REQUIRES_PARTY_CODES` (out of scope here; party wiring is T-118's own contract, exercised
  elsewhere).
- Posted via `postEntry(null, { orgId, entryDate, sourceType: 'test:invariant-property',
  sourceId: <random>, idempotencyKey: randomUUID(), lines })` against one shared, wide-open fiscal
  period (2020-01-01..2030-12-31), one shared seeded org — same seeding shape as
  `tests/integration/posting-patterns.test.ts`'s `beforeAll`.

⚠️ **Two corrections found while implementing, not while planning — this spec was wrong on both,
per §3.4a ("report a spec defect; never work around it silently"):**

1. **"One shared seeded org" is wrong — each fast-check run needs its OWN fresh org.** fast-check's
   shrinking re-invokes the property function directly with a smaller input; it cannot undo the
   real Postgres writes a larger, now-discarded attempt already made. A shared org across runs
   made a shrunk "counterexample" describe only the last entry tried, while the imbalance it
   reported came from an earlier run's leftover state in the same org — reproduced and confirmed
   live before the fix. Each run now creates and seeds its own org.
2. **Invariant 9 cannot be computed from `getTrialBalance`'s per-row `normalBalance`-signed
   `balance`, grouped by type.** Three seeded accounts are contra accounts whose `normalBalance`
   deliberately disagrees with their type (1590 accumulated depreciation: type=asset/
   normalBalance=credit; 4900/4950: type=income/normalBalance=debit) — grouping by type but
   signing by each row's own normal balance breaks the equation for exactly those three,
   reproduced live (a two-line entry touching 4900 failed an equation that was never actually
   wrong). Fixed by computing each type bucket from RAW debit/credit totals with one fixed sign
   convention per type, matching how `v_income_statement`'s own type-based (not normal-balance-
   based) convention already treats income accounts.

## Invariants

Bible §16.1 invariants 1 (every entry balances — enforced by construction, and the DB's own CHECK/
trigger stack would refuse the property's own generator if it were ever wrong), 9 (the accounting
equation holds continuously), and 10 (the trial balance always ties at any moment) — "continuously"
and "at any moment" are the words this task exists to make literal: the assertion runs after each
posted entry, not once at the end.

## Tests

The property suite **is** the test — there is no separate production code to cover. Verification
(bible §9's "confirm they fail for the right reason first," applied to a test-only deliverable):
run once with the equation's two sides deliberately swapped to confirm a real failure, then correct
it and get a clean run — recorded in this task's own report rather than left in the tree.

## Out of scope

- Party-required (control) accounts and reserved accounts — excluded from the generator's pool,
  not exercised by this suite.
- `tests/golden/` — already reachable (DEF-081 only ever named it as unproven-empty; T-157 gave it
  real content since).
- Extending `getTrialBalance`/`v_account_balance` with a dedicated balance-sheet view — that is
  Phase 6's T-209, not this task.

## Done when

- [x] `vitest.config.mts` routes `tests/invariants/**/*.test.ts` to the integration project only.
- [x] `fast-check` added as a root devDependency.
- [x] `tests/invariants/accounting-equation.test.ts` written, green, and shown to fail for the
  right reason once before being fixed.
- [x] typecheck clean · unit tests pass · full integration suite green · `npm run build` exit 0
  (dev server stopped first).
- [x] `docs/DEFECTS-REGISTER.md`'s DEF-080/DEF-081 rows updated to `fixed` with their closing
  disposition.
- [x] `docs/plans/phase-1-accounting-spine.md`'s task table (T-111 row) and `docs/ROADMAP.html`'s
  Phase 1 card (currently "2 gaps") brought current.
