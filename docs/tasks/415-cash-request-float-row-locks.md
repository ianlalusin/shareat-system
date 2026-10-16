# T-415: every move of money in or out of a cash request locks the request first and checks its live state

**Status:** DONE 2026-10-16 (merged to main); revised same day after Opus review
**Closes:** DEF-657, DEF-658, DEF-659 (all found in the T-414 audit; bible row 347 names them as its follow-ups), plus the
void gap found in review (ruling 4; DEF-661).
**Model:** Sonnet tester first (commits red), then Sonnet builder (bible row 184). Money path: Sonnet, not Haiku.
**Migration:** none. `ap_payments.cash_request_id` exists; 1120 is already `requires_party` (0035); the lock is a row lock
(`FOR UPDATE`) on `cash_requests`, which needs no schema. Next free migration number unchanged.

## Goal (plain words)
A cash request is money in one person's hands. Expense approvals (safe since T-414), supplier (AP) payments, settles
(cash returned or a shortage) and voids of earlier spending all change what that person holds. Only the first waits its
turn today. Two at once can both read "₱1,000 left" and both go through, and a void can put money back on a request that
is already closed. After this task every one of them waits on the same lock and re-reads the request after it.

## Diagnosis (verified at `9c1704b`)
- **The pattern to copy (T-414).** `cashRequestsRepo.lockForSpend(tx, orgId, ids)` at
  `packages/db/src/repo/cash-requests.ts:233-243` (`SELECT ... FOR UPDATE`, de-duplicated, id order). Caller:
  `approveExpense`, `packages/domain/src/expenses/approve.ts:131-171`: lock `:143-145`, status and store checks `:152-163`
  (store compared with `expense.storeId`, the OWING store, `:158`), balance read `:164`, compare and `refuse` `:165-170`.
- **DEF-657 is worse than the register says.** `recordPayment` (`packages/domain/src/ap/index.ts:1087`; the register's
  "recordApPayment") only stores `input.cashRequestId` (`:1308`; doc comment `:1071-1073` "attribution only"). The
  money-account credit leg (`:1275-1287`) adds a party ONLY for 1140. A staff cash account is 1120
  (`packages/db/src/repo/money-accounts.ts:142`) and 1120 is party-requiring (migration 0035), so a supplier payment from a
  float has no party and the DB trigger `journal_lines_party_requirement` (0007) refuses it with a raw Postgres error. No
  overdraw today because AP cannot draw a float at all; if it could, nothing would lock or check. The supplier page offers
  every store money account, staff cash included (`apps/erp/src/app/ap/lib.ts:136-143`,
  `apps/erp/src/app/ap/suppliers/[id]/AutoAllocatePaymentForm.tsx:321`), and sends no `cashRequestId`.
- **DEF-658.** `settleCashRequest`, `packages/domain/src/cash-requests/index.ts:333-480`: `getById` `:346`, status `:348-350`,
  balance read `:353`, "more than still held" `:380-386`, liquidate `:470-476`. No lock.
- **Void gap (review).** `voidPayment` (`ap/index.ts:1355-1463`) locks the supplier credit (`:1383`) and reverses the entry,
  1120 leg included, without touching the request. Scenario: pay ₱600 from a ₱1,000 float, settle returns ₱400 and the
  request is `liquidated`, then the void puts ₱600 back on a liquidated request. `voidExpense`
  (`packages/domain/src/expenses/void.ts:39-142`) has the SAME gap: it locks the expense (`:73`) and reverses (`:110`), never
  reading `cashRequestId`. Cheap to fix in the same way, so it is IN this task. ⚠️ `voidInvoice`'s cascade calls
  `voidExpense`, so it inherits the refusal: a bill whose float payment's request is closed cannot be voided until the
  request is reopened. That is the intended effect, not a regression.
- **DEF-659.** `ensureStaffCashAccount` (`money-accounts.ts:102-149`) returns `null` when the insert hits
  `onConflictDoNothing` (`:146-148`; a same-name, non-staff account exists) or the store is missing (`:133`).
  `releaseCashRequest` (`cash-requests/index.ts:260-271`) ignores `null`. In scope because it is cheap: one branch, and
  the existing `warning` return (`:310`) carries it to the releaser.

## Rulings
1. **AP draws a float the way an expense does, only when cash leaves.** In `recordPayment`, and ONLY when
   `cashPortion > 0` (a payment fully covered by `creditApplied` draws nothing and gets no float check):
   - account is 1120 and no `cashRequestId` -> S1. `cashRequestId` given and account is not 1120 -> S2.
   - `lockForSpend(trx, orgId, [cashRequestId])`; missing -> `gone(..., 'cash request')`; status not `released` -> S3;
     `req.storeId !== input.storeId` (the OWING store, the one rule T-414 uses at `approve.ts:158`) -> S4; then
     `floatPositionOf` AFTER the lock; `cashPortion > outstanding` -> S5.
   - the 1120 credit leg carries `partyType: 'cash_request', partyId: cashRequestId` (mirror `routing.ts:232-233`).
   - `checkDraw` is skipped for a float leg (T-414 ruling 6: the per-request check replaces it).
2. **Lock order (pinned).** In `recordPayment`: `lockExpensesForAllocation` (`:1131`) -> `lockSupplierCredit` (`:1220`, when
   credit is applied) -> request `lockForSpend` -> balance read. In `voidPayment`: `lockSupplierCredit` (`:1383`) -> request
   lock. Documents first, request last, as `approveExpense` (invoice `:79` -> request `:143`). `ap/index.ts` must import
   `cashRequestsRepo` and `personsRepo` from `@shareat/db` (neither is imported today, `:31-43`).
3. **Settle locks before it reads.** `settleCashRequest` replaces `getById` with `lockForSpend(trx, orgId, [requestId])` (first
   row or `gone`), keeps `authorize`, then the status check (sentence S6), then `floatPositionOf`.
4. **A void of float spending needs the request still open.** `voidPayment` (when the payment has a `cashRequestId`) and
   `voidExpense` (for each payment row with a `cashRequestId`, ids de-duplicated) call `lockForSpend` after their existing
   locks and before `reverseEntry`; any request not `released` -> S7. Nothing else in either void changes.
5. **Release warns on a skipped account.** If `ensureStaffCashAccount` returns `null`, `releaseCashRequest` logs
   (`logger.warn`, store id and request id) and adds S8 to its `warning`. The release still posts (it debits 1120 directly).
6. **Error helpers:** `refuse(raw, sentence)` / `gone(raw, what)` from `../shared/refusal`. T-343 ratchet
   (`tests/unit/t343-throw-ratchet.test.ts:72,76`): `ap` and `expenses` stay **0**. Settle's three touched raw throws
   (`:347` -> `gone`, `:350` -> `refuse` S6, `:381` -> `refuse`) take `cash-requests` from **19 to 16**; the builder lowers
   the ceiling to 16. No new raw throw anywhere.

**Sentences** (`{holder}` = requested-for person's display name, looked up as `approve.ts:151`):
S1 `"This is a staff cash account. Pick the cash request the money comes from."` ·
S2 `"A cash request can only be paid from its store's staff cash account."` ·
S3 `"{holder}'s cash request is no longer open ({status}). Pick another source."` (T-414 text) ·
S4 `"{holder}'s cash request belongs to another store, so this payment cannot draw from it. Pick another source."` ·
S5 `"{holder}'s cash request has {₱outstanding} left — this payment draws {₱drawn} from it. Lower the amount or pay the rest another way."` ·
S6 (settle) `"{holder}'s cash request is already {status}, so there is nothing left to settle."` ·
S7 (void) `"{holder}'s cash request is {status}, so this cannot be voided. The request must still be released."` ·
S8 (release warning) `"No staff cash account was made for this store: another money account already uses the name "Staff cash — {store}". Rename it, then the next release makes one."` ·
Settle over-hold (meaning unchanged, now `refuse`): `"Only {₱outstanding} is still held on this cash request. Anything spent is recorded as an expense, not settled here."`

## Acceptance cases (each names the mutant that must turn it red)
1. AP ₱600 from the staff cash account naming a released ₱1,000 request posts: 1120 credit, party `cash_request` = the
   request; outstanding 400.00. **M1:** drop the party on the 1120 leg (trigger refuses).
2. AP from the staff cash account with no request -> S1, nothing posted. **M2:** delete the S1 check.
3. AP naming a request but paid from the office safe -> S2. **M3:** delete the S2 check.
4. AP ₱1,200 on a ₱1,000 float -> S5. **M4:** delete the outstanding compare.
5. AP on a liquidated / cancelled request -> S3. **M5:** drop the status check.
6. AP at store A on a request released at store B, account A's staff cash -> S4. **M6:** compare with `account.storeId`.
7. A float AP payment over the account's draw-warning threshold returns no `checkDraw` warning. **M7:** run `checkDraw` on float legs.
8. `creditApplied` covers the whole ₱600 with a `cashRequestId` on a liquidated request: posts, no refusal, no 1120 leg.
   **M8:** run the float checks when `cashPortion` is 0.
9. **Concurrent: approve ₱600 (held open) vs AP ₱600, same ₱1,000 float**: AP blocked, then S5; outstanding 400.00, one
   posting. **M9:** remove `lockForSpend` from `recordPayment`.
10. **Concurrent: approve ₱600 (held open) vs settle return ₱1,000**: settle blocked, then the over-hold sentence;
    outstanding 400.00. **M10:** restore `getById` in settle (no lock).
11. **Concurrent: two settles of return ₱600 on ₱1,000** (different `toMoneyAccountId`, so idempotency keys differ): one
    posts; outstanding 400.00, status `released`. **M11:** read `floatPositionOf` BEFORE the lock.
12. Settle (held open) returns the full ₱1,000 and liquidates; a second settle waits, then gets exactly S6.
    **M12:** do the status check before the lock.
13. AP ₱600 from a float, settle returns ₱400 (liquidated), `voidPayment` -> S7; payment still `posted`, status
    `liquidated`, outstanding 0.00. **M13:** drop the request lock/check from `voidPayment`.
14. Same as 13 through an expense paid from the float and `voidExpense` -> S7. **M14:** drop it from `voidExpense`.
15. **Concurrent: settle return ₱400 (held open, will liquidate) vs `voidPayment` of the ₱600 AP payment**: void blocked,
    then S7. **M15:** take the request lock in `voidPayment` AFTER `reverseEntry`.
16. Release at a store holding a same-name non-staff account: posts, `warning` contains S8, no account created.
    **M16:** delete the `null` branch.
17. Ratchet: `ap` = 0, `expenses` = 0, `cash-requests` = 16. **M17:** reintroduce a raw `throw new Error(` in settle.

## Concurrency test design (copy T-414 I8, `packages/domain/tests/integration/t414-s1-cash-request-approve.test.ts:380-424`)
Real Postgres, two real transactions via `asPerson`. A runs its call, resolves an `aDone` promise, then awaits a `gate`
promise so it holds its lock uncommitted. Start B. `Promise.race(B, 2500 ms timer)` must be `'blocked'`; if B finished
early, release A before failing so nothing hangs. Release A, await both, assert B's `userMessage`, posting counts,
status and `floatPositionOf`. A sequential test cannot kill M9-M12 or M15. Use DIFFERENT invoices/suppliers for A and B so
no other lock (`lockInvoiceForRecording`, `lockExpensesForAllocation`, `lockSupplierCredit`) is what serialises them. A
Postgres `40P01` (deadlock) in any case is a failure of ruling 2.

## Files
**TESTER** (writes only these):
- `packages/domain/tests/integration/t415-ap-payment-float.test.ts` (cases 1-9)
- `packages/domain/tests/integration/t415-settle-lock.test.ts` (cases 10-12)
- `packages/domain/tests/integration/t415-void-float.test.ts` (cases 13-15)
- `packages/domain/tests/integration/t415-release-staff-account-warning.test.ts` (case 16)

**BUILDER** (writes only these):
- `packages/domain/src/ap/index.ts` (`recordPayment`, `voidPayment`, imports; doc comment `:1071-1073` no longer "attribution only")
- `packages/domain/src/expenses/void.ts` (`voidExpense`)
- `packages/domain/src/cash-requests/index.ts` (`settleCashRequest`, `releaseCashRequest`)
- `tests/unit/t343-throw-ratchet.test.ts` (`cash-requests` ceiling 19 -> 16 only; case 17 is this existing test at 16)
- `docs/DEFECTS-REGISTER.md` (close DEF-657/658/659 and DEF-661; correct DEF-657: AP could not draw a float at all)
- `docs/POSTING-PATTERNS.md`: add `ap_payment.from_float` under AP payment (`:536`): DR 2110 supplier / CR 1120 party
  `cash_request`, citing the 1120-party rule at `:697-705`. No other pattern changes.
`packages/db/src/repo/cash-requests.ts` is NOT touched: `lockForSpend` is reused as is.

## Done when
Cases 1-17 green, each mutant shown red in the hand-back; grep the diff for leftover mutants. `npm run typecheck`, lint,
the census/guard files and `cash-requests.test.ts`, `ap.test.ts`, the expense-void and `voidInvoice` tests, `t414-s1-*`
green. Full suite on the wrap-up PR (row 296). No UI change, so no browser check; S1 must read sensibly as the flash on
`/ap/suppliers/[id]`.

## Not in scope
Release's own double-release race (status `approved` read without a lock): log a new DEF if the tester can reproduce it.
Reopening a liquidated request so a void can proceed.

## Recommended follow-up (not this task)
**DEF-662 — a cash-request picker on the AP payment form** (`AutoAllocatePaymentForm.tsx`). After T-415 nothing in the app can pay
an already-booked supplier bill from a float: the supplier form sends no `cashRequestId` (picking staff cash gives S1),
and the bill page's `recordExpenseForInvoiceAction` (`invoices/[id]/page.tsx:492`) cannot pay a bill already booked (the
invoice-capacity check refuses it). The domain this task builds is ready for the picker; it is a small UI task.
