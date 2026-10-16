# T-415: every move of money OUT of a cash request locks the request first and checks its live balance

**Status:** spec written 2026-10-16, not started
**Closes:** DEF-657, DEF-658, DEF-659 (all found in the T-414 audit; bible row 347 names them as its follow-ups).
**Model:** Sonnet tester first (commits red), then Sonnet builder (bible row 184). Money path: Sonnet, not Haiku.
**Migration:** none. `ap_payments.cash_request_id` exists; 1120 is already `requires_party` (0035); the lock is a row lock
(`FOR UPDATE`) on `cash_requests`, which needs no schema. Next free migration number unchanged.

## Goal (plain words)
A cash request is money in one person's hands. Today three things can take money out of it: an expense approval (safe
since T-414), a supplier (AP) payment, and a settle (cash returned or a shortage). Only the first waits its turn. If two
happen at once, both can read "₱1,000 left" and both go through, so the books show the person holding minus money.
After this task, all three wait on the same lock and re-read the balance after it, so the second one is refused cleanly.

## Diagnosis (verified at `9c1704b`)
- **The pattern to copy (T-414).** `cashRequestsRepo.lockForSpend(tx, orgId, ids)` at
  `packages/db/src/repo/cash-requests.ts:233-243` (`SELECT ... FOR UPDATE`, de-duplicated, id order). Caller:
  `approveExpense`, `packages/domain/src/expenses/approve.ts:131-171` - lock at `:143-145`, then status `'released'` and
  store checks (`:153-164`), THEN `floatPositionOf` (`:165`) and `compare(drawn, outstanding) > 0` -> `refuse` (`:166-170`).
- **DEF-657 is worse than the register says.** `recordPayment` (`packages/domain/src/ap/index.ts:1087`; the register's
  "recordApPayment") never reads `input.cashRequestId` except to store it (`:1308`; doc comment `:1071-1073` "attribution
  only"). The money-account credit leg (`:1275-1287`) adds a party ONLY for 1140. A staff cash account is 1120
  (`packages/db/src/repo/money-accounts.ts:142`), and 1120 is party-requiring (migration 0035), so a supplier payment
  from a staff float has no party and **the DB trigger `journal_lines_party_requirement` (0007) refuses it with a raw
  Postgres error**. So today: no overdraw, because AP cannot draw a float at all; and if it could, nothing would lock or
  check the balance. The supplier page offers every store money account, staff cash included
  (`apps/erp/src/app/ap/lib.ts:136-143`, `apps/erp/src/app/ap/suppliers/[id]/AutoAllocatePaymentForm.tsx:321`), and sends no
  `cashRequestId`. Expense routing already does this right (`packages/domain/src/expenses/routing.ts:211-233`).
  (The bill page pays through the expense path, `apps/erp/src/app/ap/invoices/[id]/page.tsx:492`, already covered by T-414.)
- **DEF-658.** `settleCashRequest`, `packages/domain/src/cash-requests/index.ts:333-480`: `getById` (`:346`), status check
  (`:348-350`), `floatPositionOf` (`:352`), "more than still held" (`:380-386`), posts, re-reads and may mark `liquidated`
  (`:469-474`). No lock: a settle racing an approve, an AP payment, or a second settle can over-account the float.
- **DEF-659.** `ensureStaffCashAccount` (`packages/db/src/repo/money-accounts.ts:102-149`) returns `null` when the insert hits
  `onConflictDoNothing` (`:146-148`; a same-name, non-staff account exists) or the store is missing (`:133`). The caller,
  `releaseCashRequest` (`cash-requests/index.ts:260-271`), ignores `null`. **In scope: cheap** - one branch in the caller and
  the existing `warning` return (`:310`) surfaces it to the releaser; no repo change, no new table.

## Rulings
1. **AP draws a float the way an expense does.** In `recordPayment`, after the expense locks (`lockExpensesForAllocation`,
   ~`:1131`) and the money-account lookup, before `checkDraw`:
   - account is 1120 and no `cashRequestId` -> refuse (R-sentence S1). `cashRequestId` given and account is not 1120 -> refuse (S2).
   - otherwise `lockForSpend(trx, orgId, [cashRequestId])`; missing -> `gone(..., 'cash request')`; status not `released` ->
     S3; `req.storeId !== account.storeId` -> S4; then `floatPositionOf` AFTER the lock; `cashPortion > outstanding` -> S5.
   - the 1120 credit leg carries `partyType: 'cash_request', partyId: cashRequestId` (mirror `routing.ts:232-233`).
   - `checkDraw` is skipped for a float leg (T-414 ruling 6: the per-request check replaces it, no double refusal).
   - Lock order stays "documents first, request last", the same as `approveExpense`, so the two cannot deadlock.
2. **Settle locks before it reads.** `settleCashRequest` replaces `getById` with `lockForSpend(trx, orgId, [requestId])` (first
   row or `gone`), keeps the `authorize` call, then the status check, then `floatPositionOf`. Nothing else moves.
3. **Release warns on a skipped account.** If `ensureStaffCashAccount` returns `null`, `releaseCashRequest` logs
   (`logger.warn`, with store id and request id) and adds to its `warning`: "No staff cash account was made for this store:
   another money account already uses the name "Staff cash — {store}". Rename it, then the next release makes one." The
   release still posts (it debits 1120 directly and never needed the account).
4. **Error helpers:** `refuse(raw, sentence)` / `gone(raw, what)` from `../shared/refusal` (already imported in both files).
   The T-343 ratchet (`tests/unit/t343-throw-ratchet.test.ts:72,76`): `ap` must stay **0**; every raw `throw new Error(`
   this task TOUCHES in `cash-requests` (the status check `:349` and "more than still held" `:381`) becomes `refuse`, and the
   ceiling drops from 19 to the measured count. No new raw throw anywhere.

**Sentences** (`{holder}` = requested-for person's display name, as `approve.ts:152`):
S1 `"This is a staff cash account. Pick the cash request the money comes from."` ·
S2 `"A cash request can only be paid from its store's staff cash account."` ·
S3 `"{holder}'s cash request is no longer open ({status}). Pick another source."` (T-414 text) ·
S4 `"{holder}'s cash request belongs to another store, so this payment cannot draw from it."` ·
S5 `"{holder}'s cash request has {₱outstanding} left — this payment draws {₱drawn} from it. Lower the amount or pay the rest another way."` ·
Settle over-hold (existing meaning, now `refuse`): `"Only {₱outstanding} is still held on this cash request. Anything spent is recorded as an expense, not settled here."`

## Acceptance cases (each names the mutant that must turn it red)
1. AP payment ₱600 from the staff cash account naming a released ₱1,000 request posts: 1120 credit with party
   `cash_request` = the request; `floatPositionOf` outstanding 400.00. **M1:** drop the party on the 1120 leg (DB trigger refuses).
2. AP payment from the staff cash account with no request -> S1, nothing posted. **M2:** delete the S1 check (raw trigger error, not S1).
3. AP payment naming a request but paid from the office safe -> S2. **M3:** delete the S2 check.
4. AP payment ₱1,200 on a ₱1,000 float -> S5, nothing posted. **M4:** delete the outstanding compare.
5. AP payment on a liquidated / cancelled request -> S3. **M5:** drop the status check.
6. AP payment on another store's request -> S4. **M6:** drop the store check.
7. A float AP payment over the money account's draw warning threshold returns no `checkDraw` warning (single check).
   **M7:** run `checkDraw` on float legs too.
8. **Concurrent: expense approve ₱600 (held open) vs AP payment ₱600, same ₱1,000 float** - AP blocked, then S5;
   outstanding 400.00, one posting. **M8:** remove `lockForSpend` from `recordPayment`.
9. **Concurrent: expense approve ₱600 (held open) vs settle return ₱1,000** - settle blocked, then the over-hold sentence;
   outstanding 400.00. **M9:** restore `getById` in settle (no lock).
10. **Concurrent: two settles of return ₱600 on ₱1,000** (different `toMoneyAccountId` or amounts so idempotency keys
    differ) - exactly one posts; outstanding 400.00, status `released`. **M10:** read `floatPositionOf` BEFORE the lock.
11. Settle on a request liquidated by a concurrent settle -> S3 after the wait. **M11:** do the status check before the lock.
12. Release at a store holding a same-name non-staff account: release posts, `warning` contains the ruling-3 sentence,
    no money account created. **M12:** delete the `null` branch (no warning).
13. Ratchet: `ap` = 0, `cash-requests` ceiling equals the new count. **M13:** reintroduce a raw `throw new Error(` in settle.

## Concurrency test design (copy T-414 I8, `packages/domain/tests/integration/t414-s1-cash-request-approve.test.ts:380-424`)
Real Postgres, two real transactions via `asPerson`. Transaction A runs `approveExpense` (or the first settle), resolves an
`aHasApproved` promise, then awaits a `gate` promise so it holds its lock uncommitted. Start B. `Promise.race(B, 2500 ms
timer)` must be `'blocked'`; if B finished early, release A before failing so no transaction hangs. Release A, await both,
assert B's `userMessage`, posting counts, and `floatPositionOf`. A sequential test cannot kill M8-M11. Use DIFFERENT
invoices/suppliers for A and B so no other lock (`lockInvoiceForRecording`, `lockExpensesForAllocation`) is what serialises
them. Treat a Postgres `40P01` (deadlock) in any case as a failure of ruling 1's lock order.

## Files
**TESTER** (writes only these):
- `packages/domain/tests/integration/t415-ap-payment-float.test.ts` (cases 1-8)
- `packages/domain/tests/integration/t415-settle-lock.test.ts` (cases 9-11)
- `packages/domain/tests/integration/t415-release-staff-account-warning.test.ts` (case 12)

**BUILDER** (writes only these):
- `packages/domain/src/ap/index.ts` (`recordPayment`, doc comment `:1071-1073` rewritten: no longer "attribution only")
- `packages/domain/src/cash-requests/index.ts` (`settleCashRequest`, `releaseCashRequest`)
- `tests/unit/t343-throw-ratchet.test.ts` (ceiling only; case 13 is the existing test going green at the new number)
- `docs/DEFECTS-REGISTER.md` (close DEF-657/658/659; correct DEF-657's text: AP could not draw a float at all)
- `docs/POSTING-PATTERNS.md`: add `ap_payment.from_float` under AP payment (`:536`): DR 2110 supplier / CR 1120 party
  `cash_request`. It is the expense pattern's AP twin; no other pattern changes.
`packages/db/src/repo/cash-requests.ts` is NOT touched: `lockForSpend` is reused as is.

## Done when
Cases 1-13 green, each mutant shown red in the hand-back; grep the diff for leftover mutants. `npm run typecheck`, lint,
the census/guard files and `cash-requests.test.ts`, `ap.test.ts`, `t414-s1-*` green. Full suite on the wrap-up PR (row 296).
No UI change, so no browser check; S1 must read sensibly as the flash on `/ap/suppliers/[id]`.

## Not in scope
A cash-request picker on the supplier payment form (see open question). Release's own double-release race (status
`approved` read without a lock) - log it as a new DEF if the tester can reproduce it; do not fix here.

## Open question for Ian
The supplier page payment form has no "which cash request" picker, so after this task picking the staff cash account
there gives S1 instead of a raw error. Recommend: leave it; pay a supplier from a float on the bill page (expense path),
which already works. Adding the picker is a small follow-up if staff need it on the supplier page.
