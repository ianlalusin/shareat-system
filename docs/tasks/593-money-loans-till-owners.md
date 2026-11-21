# T-593 — Money guards: loan payment replay, till charge replay, owner locks, month close, reversal binding

Status: SPEC (Opus), 2026-11-18. Fixes DEF-869..DEF-874 and DEF-896 (not yet rows in `docs/DEFECTS-REGISTER.md` on main 9892641;
if still absent at commit, add them in the DEF-866 format, line 1064, marked `fixed - T-593`). Risk: **high** (money).
Builder: Sonnet. No migration, no schema, no new capability, no bible change. Every line number below is main 9892641.

## Start from the stopped builder's work (judged)

Worktree `C:\Users\ianla\webapps\shareat-system\.claude\worktrees\agent-a267528354f6cdc30`, branch
`worktree-agent-a267528354f6cdc30`, base 9892641, 9 files uncommitted, no tests written. Work there. Verdict per file:

| File | Keep / redo |
|---|---|
| `loans/[id]/page.tsx`, `loans/actions.ts` | **Keep** (hidden `requestId` in the payment form; action passes it) |
| `loans.test.ts`, `t369-s8b-...loans.test.ts`, `t431-unpaid-liabilities.test.ts` | **Keep** (every call now passes `requestId: crypto.randomUUID()`) |
| `domain/src/loans/index.ts` | **Keep, then fix the order** (see DEF-869) |
| `domain/src/till/index.ts` | **Keep the person check; delete the hand-written replay block** (see DEF-870) |
| `domain/src/owners/index.ts` | **Keep** locks, month checks, retired-account checks. **Redo** `reverseOwnerEntry` gate order (DEF-873) |
| `db/src/repo/owners.ts` | **Keep**; it missed `agedReceivables` line 607 (DEF-874) |

## DEF-869 — loan payment keyed on a fresh uuid (double click posts twice)

Main `packages/domain/src/loans/index.ts:315-321`:
```ts
const paymentId = crypto.randomUUID();
const result = await postEntry(trx, { ...
  idempotencyKey: `loan:${loan.id}:payment:${paymentId}`,
```
Change: `recordLoanPayment` input gains required `requestId: string` (signature line 210). After `assertFieldRules`
(line 228): `const requestId = requireRequestId('recordLoanPayment', input.requestId);` (`../ledger/replay`, already
imported line 22). Key `loan:${loan.id}:payment:${requestId}`; post with `postEntryOnce`; drop the `postEntry` import.

**Why the builder's early replay check is right, and must stay:** after the first payment commits, a retry re-reads a
moved balance (interest since = today, so the split differs) and `postEntryOnce` would refuse a genuine double click as
"different figures", or `nothing outstanding` if it cleared the loan. So a known key is answered BEFORE `positionOf`,
like `expenses/reimbursement.ts:111-125`. **Fix its position:** move the block to just after the cross-store
`authorize` (main line 240), so the account is loaded and gated first, and add the account to the comparison: the
entry must hold a credit line on `account.glAccountCode` (and `partyId === account.id` when the code is `1140`) equal to
`amount`, as well as the same date and `principal + interest === amount`. Mismatch: `refuse(..., 'This payment was
already recorded with different figures. Reload the page and try again.')` (builder's sentence, keep).
Lock order unchanged: `getById` → `authorize` → `lockForPayment` → field rules → request id → account → replay check.

Callers (all already updated in the worktree): `apps/erp/src/app/loans/actions.ts:87`, `apps/erp/src/app/loans/[id]/page.tsx:160`
(page already mints `requestId` at line 42, shared with the draw form; keys differ, so that is fine);
`loans.test.ts` 189, 214, 252, 282, 311, 316, 423, 441, 470, 493, 505, 531, 538; `t369-s8b-...loans.test.ts:219`;
`t431-unpaid-liabilities.test.ts` 498, 504, 518. No other caller (`git grep recordLoanPayment` checked).

Tests, `packages/domain/tests/integration/loans.test.ts`, new `describe('DEF-869 - one request id, one payment')`:
1. same input twice (sequential, the first committed) → second returns the first `entryId`; exactly one `loan_payment`
   entry; outstanding moved once. **Mutant:** restore `crypto.randomUUID()` key → two entries, red.
2. a clearing payment twice → second returns `paidOff: true`, not "nothing outstanding". **Mutant:** move the replay
   block below `positionOf` → red.
3. same id, different amount → refused with the sentence; one entry. Same id, other money account → refused.
4. missing `requestId` → `This form is out of date. Reload the page and try again.`; zero entries.
Web, `apps/erp/tests/integration/t343-s5-5v-followups.test.ts` (fixture near line 442): a valid `recordPaymentAction`
FormData submitted twice → one `loan_payment` entry. **Mutant:** delete `requestId:` in `loans/actions.ts` → red.

## DEF-896 (slice S6) — interest a short payment leaves unpaid is never charged

Ian's ruling, 18 Nov 2026 (via BOSS): **"3 A"**, meaning carry the unpaid interest forward and collect it from later payments.
Main `loans/index.ts:249`: `const since = (await loansRepo.lastPaymentDate(...)) ?? loan.startDate;`. Any payment,
even ₱100 against ₱133.33 accrued, resets `since`, so the ₱33.33 is never charged.

**Where the unpaid interest lives: nowhere new. It is derived; no migration.** Key fact: interest is taken first, so a
payment that retired ANY principal paid all interest due at that moment. Unpaid interest can therefore only build up
since the last standing payment that retired principal. Rule:
- `runStart` = date of the latest standing `loan_payment` entry (not draft, not reversed, not a reversal; same filter
  as `lastPaymentDate`, `repo/loans.ts:295-304`) holding a `2400` debit on this loan's party, else `loan.startDate`.
- `paidSince` = sum of `7200` debits on standing `loan_payment` entries for this loan dated **after** `runStart`.
- `interest due` = `accruedInterest({ ..., since: runStart, until: on })` − `paidSince`, floored at zero.
A loan whose last payment retired principal gets exactly today's figure (`paidSince` = 0). One rounding over the whole
span (not per payment), so ₱133.33 + ₱133.33 days give ₱266.67, the exact figure.
Why not a new account (accrued interest payable) or a column: either needs migration 0262, a chart row, party rules and a
posting-pattern change, and moves loans from cash-basis to accrual. Not needed to carry the figure. **No migration.**

**No compounding.** `loans` holds `interest_rate`, `rate_period`, `interest_method` (`straight` / `amortizing` /
`equal_principal`), `schema/loans.ts:119-121`; nothing says compound. The base stays as today: original principal
(`straight`) or the `2400` balance (the others). Unpaid interest is never posted to `2400`, so it never earns interest.

Code:
- `packages/db/src/repo/loans.ts`: new `interestRunOf(tx, orgId, loanId): Promise<{ since: string | null; paidSince: Money }>`
  (one query, `sum(...)::text` minted with `money()`). Keep `lastPaymentDate` (screen shows the last payment date).
- `packages/domain/src/loans/interest.ts`: new pure `interestDue(accrued: Money, paidSince: Money): Money` =
  `max(0, accrued − paidSince)` in centavos; export it from `@shareat/domain` beside `accruedInterest`.
- `recordLoanPayment` (main 249-264): `since = run.since ?? loan.startDate`; `splitPayment({ accrued: interestDue(accrued, run.paidSince) })`.
  `splitPayment` itself is unchanged (interest first, then principal).
- Posting unchanged, `POSTING-PATTERNS.md` 544-553 `loan_payment.with-interest`: DR `2400` principal (party loan),
  DR `7200` interest (no party), CR the money account. A short payment is all `7200`; the later one carries the larger
  `7200` line. The overpayment message (main 270) names the interest including what is carried.
- Screen `apps/erp/src/app/loans/lib.ts:77-89` uses `interestRunOf` + `interestDue` for `accruedNow`;
  `loans/[id]/page.tsx:150-152` label becomes "Interest owed since {runStart}" and, when `paidSince` > 0, adds
  "(₱X of it already paid). Unpaid interest carries to the next payment; it never earns interest itself."

Existing loans: no backfill, no posting changes. Being derived, the next payment on a loan whose recent payments were
all interest-short collects what they left. Read-only count for BOSS (candidates: interest-only payments still open):
```sql
BEGIN READ ONLY;
SELECT count(DISTINCT je.source_id) AS loans, count(*) AS payments
  FROM journal_entries je
 WHERE je.source_type = 'loan_payment' AND je.status NOT IN ('draft','reversed') AND je.reversal_of_entry_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
                    WHERE jl.entry_id = je.id AND a.code = '2400' AND jl.debit > 0);
ROLLBACK;
```
Tests, `loans.test.ts` (fixture: ₱200,000, 2%/month, straight, start 2026-05-11), new `describe('DEF-896 - unpaid interest carries')`:
1. pay ₱100 on 05-12 (interest 100, principal 0), then ₱1,000 on 05-13 → interest `166.67` (266.67 − 100), principal
   `833.33`, outstanding `199166.67`. **Mutant:** use `lastPaymentDate` again in `recordLoanPayment` → interest 133.33, red.
2. reverse the ₱100 payment, then pay ₱1,000 on 05-13 → interest 266.67 (a reversed payment paid nothing).
3. after a principal-bearing payment, the next one accrues from that date only (control: unchanged behaviour).
4. unit, `packages/domain/tests/unit/loan-interest.test.ts`: `interestDue` floors at zero.
Existing tests whose expected split may move are only those with an interest-short payment before another one; re-derive
each by hand and say which in the commit.

## DEF-870 — till charge replay with another person or amount says "posted" and writes nothing

Main `packages/domain/src/till/index.ts:309-327`: `await postStaffShortageCharge(...)` with key
`tillcount:${input.countLineId}:shortage`, then `return { posted: true }`. The helper
`packages/domain/src/shared/staff-shortage-charge.ts:50` calls plain `postEntry`, which answers a known key with
`created: false` whatever the lines. Also `personId` is never checked against the org (lines 283-288 only check blank).

Change (smallest, fixes both callers):
- `staff-shortage-charge.ts:22,50`: import and call `postEntryOnce` (`../ledger/replay`) instead of `postEntry`. A
  replay with the same person, amount and date still returns the entry; anything else is refused "This was already
  recorded with different figures. Reload the page and try again." Remittance (`remittance/index.ts:760`) gains the
  same protection; its key is per variance and it already refuses a resolved variance first.
- **Delete** the builder's `if (!posted.created) {...}` block in till and the `journalRepo` import (one comparison, not two).
- **Keep** the builder's person check after `authorize` (main line 281) and the blank check:
  `personsRepo.getPersonById(trx, actor.orgId, input.personId)`; missing → `refuse('chargeTillShortage: the person does
  not exist in this organisation.', 'That person could not be found - choose someone from the list.')` (same as
  `remittance/index.ts:632-637`).

- Screen (R1): `apps/erp/src/app/till/actions.ts` `chargeShortageAction` catch block (main ~line 143): when the error
  is a `RefusalError` whose user message starts "This was already recorded with different figures", flash that message
  followed by " Open the count to see who was charged." Every other error flashes as today.
Callers: `apps/erp/src/app/till/actions.ts:138`. Tests, `packages/domain/tests/integration/till-custody.test.ts`
(fixture line 72; add a second staff person with the file's `person()` helper, line 50):
1. charge to cashier, then same line to the second person → refused; one `tillcountshortage` entry, party = cashier.
   **Mutant:** revert line 50 of the helper to `postEntry` → second call returns `posted: true`, red.
2. same person twice → `posted: true`, one entry (positive replay).
3. `personId` = a fresh uuid not in the org → refused with the sentence, zero entries. **Mutant:** delete the check → red
   (the posting succeeds or fails with a raw FK error, not the sentence).
4. Web: call `chargeShortageAction` twice for one count line with two people (new
   `apps/erp/tests/integration/t593-till-charge-web.test.ts`) → the second flash error ends "Open the count to see who
   was charged." and contains neither person's name. **Mutant:** delete the append → red.
`t366-s2-till-charge-regression.test.ts` must stay green unchanged (lines byte-identical).

## DEF-871 — owner settlements read the receivable without the owner lock

Main `packages/domain/src/owners/index.ts`: `repayFromOwner` 412-414, `recoverFromPay` 486-488, `writeOffReceivable`
572-582 call `assertWithinReceivable` with no lock; `recordDrawing:319` does lock. Change (builder's, keep):
`await ownersRepo.lockOwnerForUpdate(trx, actor.orgId, owner.id);` right after `requireRequestId` in all three.
Order: `getById` → `authorize` → `requireRequestId` → **lock** → parse → `assertWithinReceivable`.
Tests, `packages/domain/tests/integration/owners.test.ts`, new `describe('DEF-871 - one receivable, settled once')`,
modelled on `t370-owner-cap-payroll-recovery.test.ts:438` (`Promise.allSettled`, two transactions):
two concurrent `repayFromOwner` for the full receivable → one fulfilled, one rejected with "more than the ₱";
receivable `0.00`, not negative. Same for `writeOffReceivable`. **Mutant:** delete the lock line in each → both commit, red.

## DEF-872 — repayment and pay recovery skip the month close

Same file: `repayFromOwner` and `recoverFromPay` never call `assertMonthOpen` (defined line 286; `writeOffReceivable:589`
does). Change (builder's, keep): `await assertMonthOpen(trx, actor.orgId, owner.id, input.on, '<fn>');` after
`assertWithinReceivable`. Tests in `owners.test.ts` beside `'⛔ respects the monthly close'` (line 643): close a month
with `closeDrawingMonth`, then repay / recover dated in it → refused "is closed for this owner"; zero new entries; a
date in the next month succeeds (positive). **Mutant:** delete each new call → red.

## DEF-873 — `reverseOwnerEntry` reverses any entry in the system

Main `owners/index.ts:791-810`: gate `transfer_funds` at the owner's store, then `reverseEntry({ entryId })`, which finds
the entry by id alone. No binding to the owner, no month check. No screen calls it today (`tests/unit/domain-actions-have-callers.test.ts:245`
lists it UNWIRED), so the risk is latent; the domain is still the boundary.
Change (redo the builder's order so nothing is read before the gate):
1. `authorize(..., 'transfer_funds', { storeId: owner.storeId })` first (unchanged line 799).
2. `journalRepo.findEntryById(trx, input.entryId)`; refuse unless `entry.orgId === actor.orgId`,
   `OWNER_ENTRY_SOURCE_TYPES.has(entry.sourceType)` and `entry.sourceId === owner.id`:
   `refuse('reverseOwnerEntry: entry <id> is not an owner posting for owner <id>.', 'That entry does not belong to this owner.')`.
   Set = the six source types this file posts: `capital_contribution`, `drawing`, `owner_repayment`,
   `owner_pay_recovery`, `owner_writeoff`, `drawing_close_adjustment` (builder's constant, keep).
3. If the type is `owner_pay_recovery`, `owner_writeoff` or `drawing_close_adjustment`: also
   `authorize(..., 'approve_expense', ...)` (what posting it needed; reversing is never easier than posting).
4. `assertMonthOpen(trx, actor.orgId, owner.id, String(entry.entryDate).slice(0, 10), 'reverseOwnerEntry')`.
5. reason check and `reverseEntry` unchanged.
Tests in `owners.test.ts` (existing positive: `'a reversal nets out'`, line 202, stays green):
another owner's drawing → refused; a non-owner entry (e.g. a contribution's entry passed for a different owner, and a
loan or transfer entry id) → refused; zero reversal rows. A `staff` person given only `transfer_funds` through a
`person_grants` row (pattern: `cash-requests.test.ts`) reverses a drawing (positive) but not a write-off
(AuthorizationError). A drawing in a closed month → refused. **Mutants:** delete step 2, step 3, step 4 → each red.

## DEF-874 — retired accounts accepted; float money in the owners repo

Domain (builder's, keep): `recordContribution` after line 181 and `recordDrawing` after line 333 refuse
`!account.isActive`: `'"<name>" is retired. Choose an account that is still in use.'` (as
`money-transfers/prepare.ts:30`). **R2: add the same check to `repayFromOwner`** after its account load (main line 417). Repo `packages/db/src/repo/owners.ts`: `toPosition` 167-173 and `receivableOf` 562 use
`money(...)` / `subtract` from `@shareat/core/money` (builder's, keep). **Add** line 607
`outstanding: Number(r.outstanding ?? 0).toFixed(2)` → `money(r.outstanding ?? '0')` (`daysOutstanding` stays a number).
Tests: `owners.test.ts` `'the refusals'` (line 687): set the fixture till `is_active = false` by SQL → contribution and
drawing and repayment refused with the sentence, zero entries; active account posts (positive). **Mutant:** delete each check → red.
Float: no behaviour test can tell (toFixed rounds the drift away), so a source scan, new `tests/unit/t593-owners-repo-money.test.ts`:
`codeOnly` (`tests/unit/lib/document-facts`) of `packages/db/src/repo/owners.ts` has no `toFixed(` and no `Number(`
except the `daysOutstanding` line. **Mutant:** restore line 167 → red.

## Census and guards to re-run (re-measure, never hand-edit)
- `tests/unit/t343-throw-ratchet.test.ts` ceilings (`<=`): loans 11 (line 103), owners 24 (108), till 18 (130),
  `packages/db/src/repo` 17 (134). New refusals use `refuse()`; no new `throw new Error`. If a count drops, lower the pin.
- `tests/unit/domain-actions-have-callers.test.ts:245` — `reverseOwnerEntry` stays UNWIRED; no edit.
- `tests/unit/t371-numeric-write-guard.test.ts` — reads only; should not move.
- `apps/erp/tests/t440-s4-ap-ar-rules.test.ts:144-146` — loan payment rule keys unchanged.

## Out of scope
Wiring a reversal screen for owners; the owner lock in `closeDrawingMonth` (a close racing a drawing, separate defect);
early-replay checks for the owner settlements (a retried full repayment is refused "more than owed", not doubled - safe);
`disburseLoan`'s same retry shape; renaming refusal texts that are already pinned; retired-account checks in other modules.

## Build order (one commit each; run the listed tests after each, then the unit guards)
S1 DEF-869 loans (domain order fix + tests + action test). S6 DEF-896 carried interest (right after S1, same file;
repo + interest.ts + recordLoanPayment + loan screen + tests). S2 DEF-870 till + helper. S3 DEF-871 + DEF-872 owners locks
and month checks. S4 DEF-873 reversal. S5 DEF-874 retired accounts + repo money + source scan + register rows.
Record the mutant runs in the commit message (paste the red line). Check line endings are LF before each commit.

Commands (from the worktree root; the test DB must be a `_test` database, never a lane-pinned name):
```
npm run typecheck
npx vitest run --project integration packages/domain/tests/integration/loans.test.ts packages/domain/tests/integration/t369-s8b-cross-store-collections-loans.test.ts packages/domain/tests/integration/t431-unpaid-liabilities.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/till-custody.test.ts packages/domain/tests/integration/t366-s2-till-charge-regression.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/owners.test.ts packages/domain/tests/integration/t370-owner-cap-payroll-recovery.test.ts packages/domain/tests/integration/t371-owners-nan.test.ts --maxWorkers=2
npx vitest run --project integration apps/erp/tests/integration/t343-s5-5v-followups.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/remittance.test.ts packages/domain/tests/integration/t373-s4-reversed-remittance-variance.test.ts --maxWorkers=2
npx vitest run --project unit tests/unit/t343-throw-ratchet.test.ts tests/unit/domain-actions-have-callers.test.ts tests/unit/t593-owners-repo-money.test.ts --maxWorkers=2
```
Full suite runs in CI on the PR. Smoketest on a private port: record a loan payment, double-click Save, see one row.

## Rulings (BOSS, 18 Nov)
R1. Till replay refusal: the generic sentence from the shared helper ("This was already recorded with different
figures. Reload the page and try again."). The refusal never names the person. The till screen adds "Open the count to
see who was charged." (see DEF-870, action change).
R2. `repayFromOwner` also refuses a retired money account (see DEF-874).
R3. The `reverseOwnerEntry` month-close check applies to all six entry types, reversed contributions included (DEF-873 step 4).
R4. DEF-896: Ian, 18 Nov, "3 A": carry unpaid loan interest forward and collect it from later payments (slice S6).
The builder still adds the DEF-869..874 and DEF-896 register rows (header note).

## Open question for BOSS
Q1. A settlement payout leg (`2400` only, no interest line) can clear a loan's principal while carried interest is
still unpaid; the loan then shows paid off and `recordLoanPayment` refuses "nothing outstanding". **Recommend: out of
scope for T-593**; log it as a new DEF and decide with the settlement owner (only the carried part is at stake).
