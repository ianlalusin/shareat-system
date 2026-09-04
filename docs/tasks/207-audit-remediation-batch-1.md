# T-207 — accounting-foundation audit remediation, batch 1

Status: done — 2026-09-04. All six defects closed; see `docs/DEFECTS-REGISTER.md`'s
DEF-156/158/160/161/162/163 rows for closing detail and closing tests.

## Goal

Close six of the eight defects logged 2026-09-04 during an accounting-foundation audit
(`DEF-156`, `DEF-158`, `DEF-160`, `DEF-161`, `DEF-162`, `DEF-163`) — each a small, independent
correction with no design ambiguity left after Ian's decisions on DEF-160/161/162. `DEF-157` and
`DEF-159` are deliberately **out of scope here**: both need `packages/domain/src/findings/index.ts`
and `packages/db/src/repo/findings.ts`, which are mid-edit by a concurrent session (T-176/T-178,
uncommitted) — see `docs/tasks/208-audit-remediation-batch-2.md`.

## Scope

Files this task may create or modify:

- `packages/domain/src/loans/index.ts` (+ its integration test)
- `packages/domain/src/ar/index.ts` (+ its integration test)
- `packages/domain/src/expenses/void.ts` (+ its integration test)
- `packages/domain/src/fixed-assets/*.ts` — read-only, reference only, unless a shared helper is
  genuinely needed
- `packages/db/seed/chart-of-accounts.ts` (2900's default `status`)
- `packages/db/src/repo/liabilities.ts` (the `RESERVED_LIABILITY_CODES['2300']` message only)
- `packages/domain/src/prepaid/index.ts` (+ its integration test)

Explicitly **out of bounds**: `findings/index.ts`, `repo/findings.ts`, `nav.tsx`, anything under
`packages/domain/src/production/` or `packages/domain/src/wastage/` (a peer's live WIP), any
migration file.

## Contract

### DEF-156 — `reverseLoanEntry` must refuse an entry that isn't the loan's own

`packages/domain/src/loans/index.ts`'s `reverseLoanEntry(tx, actor, { loanId, entryId, reason })`
currently reverses whatever `entryId` it's given. It must instead verify the entry it is about to
reverse actually belongs to `loanId` — via the entry's `sourceType`/`sourceId` (which every loan
posting sets to `loan_disbursement`/`loan_payment` + this loan's id, per `POSTING-PATTERNS.md`) —
and throw a named error if it doesn't, before calling `reverseEntry`.

### DEF-158 — `recordCharge` must enforce the customer credit limit itself

`packages/domain/src/ar/index.ts`'s `recordCharge` must check `customer.creditLimit` the same way
`trade/index.ts`'s `dispatchTradeOrder` does today (refuse over-limit unless the actor holds
`override_credit_limit`) — then `dispatchTradeOrder` should call `recordCharge`'s check rather
than keep a duplicate copy, per bible §16.10 ("one pattern per event type").

### DEF-160 — voiding a CAPEX expense retires the asset it capitalised

`voidExpense` (`packages/domain/src/expenses/void.ts`) must, after reversing the expense's journal
entry, look up any `fixed_assets` row by `sourceExpenseId`. If found:
- **no depreciation has posted yet** (no `depreciation` journal entries reference the asset) —
  retire it directly: mark the row voided/removed, no new journal entry (the expense reversal
  already unwound the capitalisation's `1510` debit).
- **depreciation has posted** — reverse every posted depreciation entry for that asset first (via
  `reverseEntry`), then retire the row.

This is a **new function** (not a reuse of `dispose()`, which books a real loss-on-disposal for an
asset that genuinely existed) — name it `retireAssetFromVoidedExpense` or similar, in
`fixed-assets/capitalize.ts` beside `capitalizeApprovedExpense`, called from `voidExpense`.

### DEF-161 — `2900 Suspense — void cash` seeds `reserved`, not `active`

One-line change in `packages/db/seed/chart-of-accounts.ts` — the `leaf('2900', ...)` call's
`status` becomes `'reserved'`. Confirmed acceptable to leave any already-seeded org's existing
`2900` row unchanged for now (idempotent seed, no migration) — note this explicitly in the task
report; it only affects the seed default for new orgs.

### DEF-162 — fix the `2300` reservation message, no behaviour change

`packages/db/src/repo/liabilities.ts`'s `RESERVED_LIABILITY_CODES['2300']` message ("wages —
payroll owns them") is corrected to state the real behaviour: payroll recognises and disburses pay
in one entry, with no separate accrual leg, so `2300` is not currently posted to by anything. No
posting logic changes.

### DEF-163 — `undoWriteOff` for a wrongly written-off prepaid item

`packages/domain/src/prepaid/index.ts` gains an `undoWriteOff` function, mirroring
`reverseAmortisation`'s shape: reverses the write-off's journal entry via `reverseEntry` and moves
`prepaid_items.status` back to what it was before the write-off (active, with its remaining
schedule intact).

## Invariants

- Bible §16.1 invariant 5 — posted entries are immutable; every correction here is a reversal, not
  an edit.
- Bible §16.10 — "one pattern per event type"; DEF-158's fix must leave exactly one credit-limit
  check, not two.
- No change here may touch `findings/index.ts` or `repo/findings.ts` (peer collision).

## Tests

Each fix gets a failing-first integration test in its module's existing test file:

1. `loans.test.ts` — reversing an entry that belongs to a *different* loan (or a non-loan entry)
   is refused; reversing the loan's own entry still works exactly as before.
2. `ar.test.ts` — `recordCharge` over a customer's credit limit is refused without
   `override_credit_limit`, succeeds with it; existing `trade.test.ts` credit-limit cases still
   pass unchanged (now exercising the shared check via `recordCharge`).
3. `expenses.test.ts` (or a new `expense-capex-void.test.ts`) — voiding a CAPEX expense with no
   depreciation posted retires the asset; voiding one with depreciation posted reverses the
   depreciation entries too; a non-CAPEX void is unaffected.
4. `chart-of-accounts.test.ts` — a freshly seeded org's `2900` reads `status = 'reserved'`.
5. `liabilities.test.ts` (or wherever `RESERVED_LIABILITY_CODES` is asserted) — message content
   updated to match; no behavioural test needed since nothing changes.
6. `prepaid.test.ts` — `undoWriteOff` reverses the entry and restores `status`; a second call on an
   already-active item is refused.

## Out of scope

- DEF-157, DEF-159 (batch 2 — findings.ts collision).
- The EWT capability gap (deferred, per Ian).
- Building the full void-cash-retained mechanic for `2900` (deferred — reserved only).
- Any account-lifecycle admin screen/function (`setAccountStatus` generically) — this task only
  flips one seed default, it does not build lifecycle tooling.

## Done when

- [x] All six tests above written first, confirmed failing for the right reason, then made to pass.
- [x] `npm run typecheck` clean.
- [x] `npm test` (unit) green — 996 passed, 1 pre-existing skip.
- [x] Integration tests green against an isolated lane DB (`shareat_test_207`) — full suite, 81
  files / 2213 tests, all green.
- [x] `npm run build` succeeds — exit 0, dev server on 9008 confirmed stopped (by its owning
  session) first.
- [x] Self-reviewed line by line.
- [x] `docs/DEFECTS-REGISTER.md`'s six rows updated with their closing disposition.
- [x] Committed with a message explaining why, listing exactly the files this task touched.
