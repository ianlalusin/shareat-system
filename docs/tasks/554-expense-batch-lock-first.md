# T-554 - the expense batch judges the invoice after it holds the lock (audit E-001)

Owner: AUDIT. Number given by BOSS 10 Nov 2026 (block T-552..T-557). No migration. Source finding:
`shareat-audits/OPEN/2026-11-09-expense-branches.md` (E-001). Base: origin/main d50a4e0.

## Defect (re-located on main d50a4e0)

`packages/domain/src/expenses/batch.ts` `recordInvoiceExpensesBatch`:

- line 75 `apRepo.getSupplierInvoiceById` reads the invoice (plain read, no lock).
- line 80 `apRepo.lockInvoiceForRecording(...)` takes `FOR NO KEY UPDATE` but its return value (the locked row, with the fresh
  `status`) is thrown away.
- lines 144 and 147 decide on the OLD `invoice.status`: `if (invoice.status === 'verified') await approveExpense(...)` and
  `status = invoice.status === 'verified' ? 'posted' : 'draft'`.

Interleaving: batch reads invoice (pending), a concurrent verification commits (status verified, it posts the drafts that existed
then), batch then acquires the lock and carries on with `pending`. Its new expenses stay draft on a verified invoice, nothing will
post them later, and the audit row says `draft`. `createExpense` (create.ts:172) deliberately allows a draft on a verified invoice
and does not repair it. No duplicate or unbalanced entry is claimed; the batch simply breaks its own documented contract (post
at once on a verified invoice, leave drafts on a pending one).

## Fix

Use the row `lockInvoiceForRecording` returns. If it returns nothing, throw the same `gone(...)` refusal as the first read. Decide
`approveExpense` and the returned/audited `status` from the LOCKED status (and re-check the store matches `input.storeId`). The
facts read at line 82 already happen after the lock, so they are fresh; keep that order. Smallest change; one variable.

Files: `packages/domain/src/expenses/batch.ts`; test `packages/domain/tests/integration/t554-batch-lock-first.test.ts` (new,
real PostgreSQL, two connections).

## Tests (write FIRST, see red on d50a4e0)

Two-connection test, style of `packages/db/tests/integration/t502-f38-service-race.test.ts` and `t515-dispose-asset-lock.test.ts`
(look at them for how to hold a lock from a second connection):
(a) connection B holds the invoice row lock (`FOR NO KEY UPDATE`, or runs the verify path and holds its transaction open); start
the batch on connection A so it passes its first read; B sets status verified and commits; A proceeds -> expect expenses
`posted` and returned status `posted` (red on main: draft); (b) mirror case: invoice stays pending -> drafts, `draft`; (c) the
invoice disappears / wrong store -> same refusal as before. Also run the existing `t502-s12-itemised-expenses.test.ts`,
`t502-s13-rulings.test.ts`, `t511-s5b-review-batch.test.ts` unchanged.

## Out of scope

`createExpense`/`approveExpense` semantics; any change to verification.
