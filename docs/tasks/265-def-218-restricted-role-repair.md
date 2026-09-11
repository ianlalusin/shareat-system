# T-265 — DEF-218 repair: the 43 files that only pass because the connection bypasses RLS

> **Status: MEASURED, not started. Created by the orchestrator 2026-09-11 from a real census run,
> not from an estimate.** T-251 (Contracts 1, 2 and 4) shipped the mechanism at `3253d13`; this is
> the repair it revealed. ⛔ **DEF-218 does not close until this lands and the default flips.**

## How to reproduce the list, exactly

```
INTEGRATION_RESTRICTED_ROLE=1 npx vitest run --project integration
```

The role is provisioned by `npm run provision-test-role` (idempotent; CI does it automatically).

## The measurement — vitest's own summary, not a grep

| | With the bypass (today's default) | With the restricted role |
|---|---|---|
| Test files | **112 passed** | **69 passed, 43 FAILED** |
| Tests | **2717 passed** | **2094 passed, 623 FAILED** |
| Duration | ~1397s | 1386s |

⛔ **Two counts in this document were wrong before they were right, and the method is the lesson.**
Running greps over the log mid-run reported *25 files / 319 tests*. Vitest's own summary says
**43 / 623** — nearly double. The grep missed files that fail wholesale at import (no per-test `×`
line is printed for those) and used `FAIL +<path>` when the reporter emits `FAIL  |integration| <path>`.
**Take the number from the tool's summary line. A hand-rolled count off a log is a hypothesis.**

## ⭐ What is actually failing, and it is NOT what it looks like

| Count | Signature | What it really is |
|---|---|---|
| **344** | `no fiscal period covers …` | ⛔ **NOT missing data — a SILENT READ.** Proven below |
| **230** | `new row violates row-level security policy for table "…"` | A write with no principal, refused loudly (`42501`). This is DEF-218 working |
| **~60** | `AuthorizationError` | Authorisation paths that read `persons`/grants with no principal and therefore see nobody |
| 18 | `expected <n> to be <m>` | Cascades — a job "succeeded" having posted nothing |
| 6 | `expected [] to deeply equal …`, `Cannot read properties` | Cascades |

### ⛔ The 344 are the important ones, and they are a misleading error message

**Proven by executed probe, not inferred:**

```
period seeded via ADMIN, exists:                1
restricted, NO principal, periods visible:      0   <- exists, but invisible
restricted, WITH principal, periods visible:    1
```

The fiscal period **exists**. Most test files seed it through a raw admin connection
(`TEST_DATABASE_URL`), which Contract 2 deliberately left bypassing. What fails is the *read* —
`findPeriodForDate` runs on the app's connection, which under the restricted role has no principal,
so it sees zero rows and `postEntry` reports *"no fiscal period covers entry date …"*.

⭐ **So the largest failure category is not a missing row. It is the silent-read half of the
asymmetry** that `packages/db/tests/integration/restricted-role.test.ts` (Contract 4, test 3) pins
down: **a write with no principal fails loudly; a read with no principal returns nothing and lies
about why.**

⚠️ **This is the single most important thing to carry into the production role switch.** If
`DATABASE_URL` is tightened in production before the null-principal call sites are fixed, users do
not get permission errors — they get *"no fiscal period covers"* on a screen where the period
plainly exists, and *"not found"* for records that are right there. **Diagnosing that cold, in
production, would be brutal.** DEF-282's ordering says fix the call sites first; this is the
evidence for why that ordering is not negotiable.

## The 43 files

⚠️ **Do not treat this list as the work unit.** Most files fail for one shared reason; fixing a
common fixture helper may clear a dozen at once. **Re-run the census after each batch** rather than
working down the list.

```
apps/erp/tests/integration/constraint-refusals.test.ts
apps/erp/tests/integration/sign-out-action.test.ts
packages/auth/tests/integration/authorize.test.ts
packages/domain/tests/integration/{organizations,post-entry-party,recurring-expenses}.test.ts
packages/etl/tests/integration/etl-run.test.ts
packages/etl-firestore/tests/integration/capture.test.ts
packages/domain/tests/integration/
  balance-sheet · budgets · cash-flow · commissary-discrepancy · commissary-transfer
  consumption-posting · count-sessions · count-workflow · customer-returns · files
  firestore-relay · first-run-setup · fiscal-periods-seeding · legacy-adapter · low-stock
  org-store-identity · pos-usage-pull · post-entry · production · receipt-posting
  receive-delivery · recurring-expenses-job · reverse-entry · scheduler
  stock-locations-service · stock-transfers · stock-usage · store-comparison · stores
  supplier-returns · usage-records
tests/integration/{commissary-kpis,email-sign-in,posting-patterns}.test.ts
tests/invariants/accounting-equation.test.ts
```

⚠️ **THREE OF THESE ARE ALREADY OUT OF DATE — DEF-287 was fixed 2026-09-11 while this task was running.** `fixed-assets` and `prepaid` are now **fully green under the restricted role** (61 tests, measured on `shareat_test_qa`), and `scheduler.test.ts` went from 12 failing to 6. ⭐ **The one that proves it:** the assertion this document cited as the cascade — `expect(dep1.posted).toBe(1)`, reported as `expected +0 to be 1` — now passes. Two of the 43 are gone and one is half gone; **re-measure before trusting any count in this file.**

The authoritative list regenerates with:

```
grep -oE "FAIL +\|integration\| [^ ]+\.test\.ts" <log> | sed 's/.*|integration| //' | sort -u
```

## ⭐ `systemTransaction()` is NOT broken — checked, because it looked like it was

`scheduler.test.ts` is in the failing list, which would normally suggest Contract 2's
`SYSTEM_DATABASE_URL` wiring failed. **It did not**, and the failure shape proves it: the assertion
is `expected +0 to be 1` on `outcomes.find(x => x.job === 'depreciation')!`. For `dep1` to exist at
all, `listOrgsToRun` must have returned the org — which only happens through the system connection.
⛔ **Had the wiring failed, `outcomes` would be empty and the test would have thrown a TypeError on
the `!`, not an assertion mismatch.**

### ⛔ CORRECTION — the zero is NOT a cascade. It is DEF-287, and here is the line

**This section originally closed "the zero is a cascade: the depreciation run found nothing to post
because the rows it needed were invisible." The first half of that sentence is wrong and the second
half is the defect.** Ruling out `systemTransaction()` was correct; treating "not that" as "not
real" was not. Found 2026-09-11 by the orchestrator re-deriving DEF-282's caller count.

`packages/domain/src/fixed-assets/depreciate.ts:221` — `runDepreciationAsSystem` calls
`runDepreciationCore(null, …)`, which opens **three or more bare `transaction()`s with no
principal**: `authorize` (`:202`), `loadDepreciable` (`:233`), `postPeriodsFor` **per asset**
(`:243`). Under the restricted role `loadDepreciable` sees zero assets, the job posts nothing and
exits **0**. `packages/domain/src/prepaid/index.ts:526`'s `runAmortisationAsSystem` is the same
shape (`:530`, `:540`).

⭐ **The name is why nobody caught it:** neither function sets `role`, `app.org_id` or
`app.principal_kind` anywhere — they are called `…AsSystem` for a principal they never set. The
same file proves it is an oversight: `scheduler/index.ts:710` has an `asSystem(orgId, fn)` that
sets all three, `budget_reissue` uses it, `mirror_publish` uses `withOrgPrincipal`.

⛔ **So `scheduler.test.ts` is a type (b) — report it, do NOT make it green.** Patching the
fixture would hide a month-end cron that silently posts nothing.

⛔ **And do not fix DEF-287 inside T-265.** It needs a per-transaction principal inside two
loops plus a rename, and `scheduler/index.ts:506`'s cross-org read needs a `systemTransaction()`
caller-list amendment that is Ian's call. See DEF-287.

## Done when

- `INTEGRATION_RESTRICTED_ROLE=1 npx vitest run --project integration` is **green**.
- The default in `tests/integration/setup.ts` flips to on, and CI sets it.
- ⭐ `packages/db/tests/integration/restricted-role.test.ts` still passes **both** ways — it opens
  its own restricted connection deliberately so it never depends on the flag.
- **DEF-218 closes**, and its `reported` status changes with it.
- ⚠️ Report whether any production call site was found to need the same fix — this suite is the
  best census we will ever get of null-principal paths, and DEF-282's six is a syntactic count of
  one shape, not a semantic count of this population.

## Out of scope

- ⛔ The production role switch (DEF-282/DEF-250). Different environment, different risk, Ian's
  sequencing. This task makes it *safe* by proving the codebase works without a bypass.
- ⛔ Rewriting the ~70 test files' raw admin fixture-seeding to go through principals. Contract 2
  deliberately left `TEST_DATABASE_URL` bypassing; changing that is a much larger task nobody has
  asked for.

See `docs/tasks/251-def-218-integration-harness-role.md` (lane E's original spec),
`DEFECTS-REGISTER.md` DEF-218, DEF-282, DEF-250, and commit `3253d13`.
