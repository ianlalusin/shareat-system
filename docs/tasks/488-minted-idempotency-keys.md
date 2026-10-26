# T-488 — Nine posting paths key on a per-form request id, not on (document, date, amount)

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: audit finding F21 (Claude posting-paths
pass, `C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-26-claude-posting-paths-pass.md`), re-verified on origin/main
26605d1. Branch `audit/t488-minted-idempotency-keys`. Defect DEF-777. Numbers from the orchestrator (BOARD.md).

## Finding — DEF-777 (P2, money: a real second transaction is silently dropped)
`postEntry` treats a repeated idempotency key as a retry and returns the existing entry with `created: false`
(`packages/domain/src/ledger/post-entry.ts:159,252`). Nine paths build the key from business attributes, write no other
document row, and ignore `created`, so a genuine second identical transaction on the same day is reported as success
and never posted:

| Function | Site | Key today |
|---|---|---|
| `recordContribution` | `owners/index.ts:192` | `owner:${id}:contribution:${on}:${amount}` |
| `recordDrawing` | `owners/index.ts:341` | `owner:${id}:drawing:${on}:${parsed}` |
| `repayFromOwner` | `owners/index.ts:422` | `owner:${id}:repayment:${on}:${parsed}` |
| `recoverFromPay` | `owners/index.ts:499` | `owner:${id}:pay-recovery:${on}:${parsed}` |
| `writeOffReceivable` | `owners/index.ts:581` | `owner:${id}:writeoff:${on}:${parsed}` |
| `chargeLiability` | `liabilities/index.ts:112` | `liability:${id}:charge:${on}:${amount}:${against}` |
| `payLiability` | `liabilities/index.ts:210` | `liability:${id}:payment:${on}:${amount}` |
| `disburseLoan` | `loans/index.ts:175` | `loan:${id}:disbursement:${on}:${amount}` |
| `refundSupplierCredit` | `stock/supplier-returns.ts:431` | `supplier_credit_refund:${supplier}:${date}:${input.amount}` |

Example: an owner draws ₱3,000 twice on one day; the second is dropped, drawings are understated by ₱3,000, and the
drawing cap (`judgeDrawingLimit`, read from the same ledger) then lets a further drawing through.
`owners/index.ts:734` (`close:${month}:adjustment`) and `loans/index.ts:310` (`payment:${paymentId}`) are correct and
unchanged.

## Rulings (bible §4.2 rule 10, PROJECT_BIBLE.md:769-772: a retryable operation "carries a client-supplied key")
1. **The form mints the key.** Each page that renders one of these forms mints `crypto.randomUUID()` per render and
   puts it in a hidden input `requestId`, exactly as `apps/erp/src/app/money-transfers/page.tsx:85` +
   `SettleBetweenStoresForm.tsx:57` do. The server action reads it with `str(formData, 'requestId')` and passes it on.
   Forms: `owners/[id]/page.tsx` (contribution, drawing), `owners/[id]/SettleForm.tsx` (repay / pay-recovery /
   write-off), `liabilities/[id]/page.tsx` (charge, pay), `loans/[id]/page.tsx` (disburse),
   `inventory/returns/page.tsx` (supplier credit refund).
2. **The domain requires and uses it.** Each of the nine functions takes `requestId`; a missing or non-UUID value is
   refused with the settle path's sentence ("This form is out of date. Reload the page and try again.", via `refuse`
   as `money-transfers/settle.ts:65-71`). The key becomes `<prefix>:${requestId}` keeping each site's existing prefix
   (e.g. `owner:${ownerId}:drawing:${requestId}`). Old entries keep their old keys; nothing is rewritten.
3. **A replay with different figures is refused, never silently returned.** When `postEntry` answers
   `created: false`, compare the existing entry's lines (account code, store, party type/id, debit, credit) with the
   lines just requested; if they differ, refuse: "This was already recorded with different figures. Reload the page
   and try again." If they match, return the existing result as today (a true double-submit). Put the comparison in
   ONE helper in `packages/domain/src/ledger/` (new small module, e.g. `replay.ts`, reading lines through the existing
   journal repo) used by all nine; do not change `postEntry` itself.
4. **Other callers.** Any non-form caller of these functions (scripts, other domain code, tests) mints a fresh id per
   genuine operation; list them in the report.
5. Out of scope: the double-submit gap in plain `createMoneyTransfer` and AP `recordPayment` (they mint server-side, so
   a double click posts twice). Log it as DEF-778 (reported, not fixed) in the register.

## Tests (red first, real Postgres on a dedicated fresh *_test DB)
`packages/domain/tests/integration/t488-request-id-keys.test.ts`: for each of the nine functions — (a) two calls, same
inputs, DIFFERENT requestIds, same day → two journal entries (today: one); (b) same requestId twice, same inputs → one
entry, second call returns the first entry's id (double-submit stays safe); (c) same requestId, different amount →
refused with the Ruling 3 sentence, nothing new written; (d) missing/garbage requestId → refused, nothing written.
For `recordDrawing`, add the cap case: two ₱X drawings with different ids both count against the cap.
Update existing tests that call these functions to pass a requestId (no assertion weakened).

## Files
The nine domain files' functions (`owners/index.ts`, `liabilities/index.ts`, `loans/index.ts`,
`stock/supplier-returns.ts`), the new `ledger/replay.ts` (or similar), their server actions and the five forms named in
Ruling 1, the new test file, existing tests that call the nine functions, `docs/DEFECTS-REGISTER.md` (DEF-777 fixed,
DEF-778 reported). ⛔ Do not touch `packages/domain/src/trade/**`, `deliveries/**`, `customers/**` or
`apps/erp/src/app/{trade/orders,customers,inventory/deliveries}/**` (another lane, T-398 S5, is changing them now).

## Acceptance
New tests red on 26605d1 for the stated reasons, then green; existing owners/liabilities/loans/supplier-returns
integration tests green; root + ERP typecheck clean; guard/census unit files green (re-measure census only where the
guard says so, never by hand).
