# T-433: business customers on trade orders: pay now, a printable delivery receipt, the credit-limit warning

**Status:** DONE 2026-10-16 (merged to main; in the next release); revised same day after Opus review; Ian answered Q1/Q2)
**Model:** Sonnet tester first (commits red), then Sonnet builder, per slice (bible row 184). Money path: Sonnet, not Haiku.
**Migration:** YES, S2 only: `0203` (orchestrator to confirm the number; 0202 is reserved for POS). Adds
`trade_orders.bir_invoice_no text null` plus a partial unique index `(org_id, bir_invoice_no) where bir_invoice_no is
not null`. Hand-authored per ADR-012 §5. S1 and S3 need none (the columns and `customers.credit_limit` exist; the audit
catalogue is TypeScript).
**Order:** S1, then S3 (it shares S1's credit helper), then S2.

## Goal (plain words)
A samgyup house buys meat from us. It either pays on the spot (cash or e-wallet) or pays later on account.
Ruling (Ian, 16 Oct): such buyers are ordinary **customers** (T-129) on **trade orders** (T-132), paid through **AR
collections** (T-131/T-226/T-330). Not a sales channel. Gaps: paying at dispatch takes two screens; nothing to hand
the buyer; no warning before the credit-limit refusal; and a paid charge can be voided, leaving money stranded.

## Diagnosis (verified at `52d14ca`)
- **Dispatch bills.** `dispatchTradeOrder` (`packages/domain/src/trade/index.ts:422`) calls `recordCharge` (`:565`,
  Dr 1210 party=customer / Cr 4300, `WHOLESALE_REVENUE_CODE` `:87`, charge dated `order.orderDate`), then COGS (T-165),
  then `markDispatched` (`:633`). Re-dispatch returns early (`:439-449`). Internal orders bill nothing (`:559`).
- **The credit gate exists** (DEF-158) in `recordCharge` (`packages/domain/src/ar/index.ts:71-96`): org-wide
  `positionOf(...).controlBalance + total > creditLimit` -> refuse unless `can(override_credit_limit)` AND a reason;
  who/why land on `trade_orders`. **Missing:** no lock (two concurrent dispatches both read the old balance), no audit
  event, no warning before submit (`orders/[id]/page.tsx:112-117`), pay-now cannot reduce the exposure.
- **`voidCharge` (`ar/index.ts:175-190`) reverses a charge without checking allocations.** A paid charge voids and its
  collection stays allocated to a dead charge. `voidTradeOrder` reaches it for a dispatched sale.
- **Collections.** `recordCollection` (`ar/index.ts:229`) authorizes `record_ar_collection`, requires proof for a
  non-cash account (`:302`), allows another store's account with `transfer_funds` (`:288`), locks and checks
  allocations (`:331-357`), posts `ar_collection` (POSTING-PATTERNS `:483`). Upload-in-one-transaction precedent:
  `recordCollectionAction` (`apps/erp/src/app/customers/actions.ts:162-236`).
- **No print view.** `orders/[id]/page.tsx` gates only on a session (`:48`). `outstandingForCharge`
  (`packages/db/src/repo/ar.ts:249`) gives what is still owed on a charge. Print CSS precedent: `cutover/count/sheet/page.tsx:54`.

## Rulings
1. **One combined action, decided in the domain.** `dispatchTradeOrder` takes optional `payNow: { amount,
   moneyAccountId, receiptFileId?, referenceNo? }`. When present it calls a NEW `recordChargeWithCollection` in
   `ar/index.ts`: one transaction, the charge, then `recordCollection` with ONE allocation (this charge, `amount`),
   `collectionDate` = `toBusinessDate()` (`packages/core/src/datetime.ts:38`), the day of dispatch, NOT `orderDate`.
   No new posting pattern: `ar_charge` then `ar_collection`, as two screens would post them. Rejected: collecting in
   the app layer after dispatch (two transactions; a crash between them bills a buyer who already paid).
   `recordChargeWithCollection` authorizes `approve_buyer` itself, first statement.
2. **The credit check moves into one private helper** `creditExposure(trx, actor, customer, storeId, addedExposure)`,
   used by `recordCharge` (added = total) and `recordChargeWithCollection` (added = total - payNow). It first takes
   `SELECT ... FOR UPDATE` on the customer row (new `customersRepo.lockForCredit`), then reads open AR, so concurrent
   charges for one buyer queue. Only the function that also posts the payment may reduce the exposure.
3. **Pay-now limits.** `0 < amount <= order total` (Money helpers: `parseMoneyInput`, `compare`, `subtract`; never
   `Number()`). Over -> R1 `"Paid now cannot be more than this order's ₱{total}."` Internal order -> R2 `"A branch
   transfer is not paid for; remove the payment."` Account at another store -> R3 `"Pay into a money account at this
   order's store."` (domain refusal, same shape as T-415/T-432). Already dispatched with `payNow` -> R4 `"This order is
   already dispatched; record the payment on the customer's page."` (refuse, never a silent no-op). E-wallet proof
   stays mandatory (Ian, Q2). No fee or store credit on this form.
4. **Void after payment is refused.** `voidCharge` refuses while the charge has live (non-void) allocations: R5
   `"This charge has payments against it. Void the payment first."` This blocks `voidTradeOrder` on a paid-now order.
5. **Capabilities:** dispatch `approve_buyer`; collection `record_ar_collection`; override `override_credit_limit`;
   `previewCreditExposure` requires `approve_buyer` at the store; BIR number edit `approve_buyer`; print view
   `approve_buyer` or `record_ar_collection` at the order's store. All existing, manager+. No matrix row.
6. **Audit.** Add to `packages/db/src/audit/catalogue.ts`: `credit_limit.overridden` (money, high, store, ar_charges)
   and `trade_order.bir_invoice_set` (money, normal, store, trade_orders), both owner `T-433`.
7. **Warning before submit (S3).** `previewCreditExposure(tx, actor, { customerId, storeId, total, payNow })` uses the
   same helper (read-only, no lock). Over -> "Owes ₱X. This order takes them to ₱Y against a ₱Z limit." and the
   reason box; otherwise neither. The server still decides.
8. **BIR invoice number (Ian, Q1: yes, from the booklet).** Optional "BIR invoice no. (booklet)" on a dispatched or
   received sale (not internal). `setBirInvoiceNo(tx, actor, { orderId, value })` in `trade/index.ts`: trimmed, blank
   clears; unique per org (duplicate -> R6 `"Invoice no. {n} is already on order {ref}."`); refused once the order's
   month is closed (reuse `closedStockPeriodSentence`, `trade/index.ts:458`); audited with before/after.
   The printout shows it but stays titled "Delivery receipt" with footer "This is not an official receipt or sales
   invoice." Bible row 75: this system never issues the official invoice.

## Slices and acceptance cases (each names the mutant that must turn it red)
**S1 Pay now** (customer at store A, ₱5,000 order, A's cash drawer, A's GCash, B's safe)
1. Pay ₱5,000 cash: one charge, one collection allocated to it, `positionOf` = 0.00. **M1:** skip the allocation.
2. Pay ₱2,000: outstanding 3,000.00. **M2:** allocate `total` not `amount`.
3. Force `recordCollection` to throw -> no charge, no stock move. **M3:** collect in a separate `transaction()`.
4. ₱5,000.01 -> exactly R1; nothing posted. **M4:** drop the `<= total` check.
5. Internal order with `payNow` -> exactly R2. **M5:** ignore `payNow` on internal.
6. GCash with no proof -> the existing proof sentence. **M6:** pass a dummy `receiptFileId`.
7. Re-dispatch a dispatched order with `payNow` -> exactly R4; one collection only. **M7:** return early, ignoring `payNow`.
8. Call `recordChargeWithCollection` directly as an actor holding only `record_ar_collection` -> `approve_buyer`
   refusal, nothing posted. **M8:** delete its `authorize(approve_buyer)`.
9. Journal equals two-screen posting (Dr 1210/Cr 4300; Dr cash/Cr 1210, party=customer). **M9:** credit 4300 directly.
10. Order dated 2026-10-10, dispatched with the clock at 2026-10-16 -> charge 10-10, collection 10-16. **M10:** collection uses `orderDate`.
11. Pay into B's safe for an A order -> exactly R3. **M11:** drop the store check (falls through to `transfer_funds`).
12. Void the ₱5,000 paid-now order -> exactly R5; charge and collection unchanged. Void the payment first, then the order
    voids. **M12:** delete the allocation check in `voidCharge`.
13. Action: `payNowAmount` + `moneyAccountId` + photo -> flash "Dispatched, billed and paid ₱2,000.00; ₱3,000.00 still
    owed." **M13:** action drops `payNow`.
**S3 Credit limit** (limit ₱10,000, already owes ₱8,000)
14. ₱5,000 order, manager, no reason -> the existing refusal. **M14:** default the reason.
15. Same with pay-now ₱3,000 -> passes, no override recorded. **M15:** helper ignores `payNow`.
16. Override with reason -> `credit_override_*` set AND one `credit_limit.overridden` row. **M16:** no append.
17. No limit -> no check, no audit row, no warning. **M17:** treat null as 0.
18. The ₱8,000 is owed at store B; a ₱3,000 order at A -> preview warns and the gate refuses. **M18:** preview reads
    the store-level balance.
19. Staff actor calls `previewCreditExposure` -> `approve_buyer` refusal, no figures. **M19:** drop its `authorize`.
20. `recordCharge` alone still gated at the full total. **M20:** default `addedExposure` to 0.
21. **Race:** two connections dispatch ₱3,000 orders at once (limit 10k, owes 8k): the first posts, the second gets the
    refusal without an override. **M21:** remove the `FOR UPDATE` lock.
**S2 Delivery receipt and BIR number**
22. `/trade/orders/{id}/print`: customer, date, reference, BIR invoice no. (when set), lines (item, qty, unit, unit
    price, line total), fees, total, "Paid on this order", "Balance due on this order", account balance (org-wide 1210
    less 2140, "as of {print time}"). Partly paid ₱2,000 of ₱5,000 shows 2,000.00 / 3,000.00. **M22:** paid = total.
23. Draft or void order -> 404. **M23:** drop the status check.
24. Staff, and another store's manager, get 404. **M24:** session-only gate.
25. Footer present; no "Official Receipt" / "Sales Invoice" title. **M25:** title "Sales Invoice".
26. Set BIR no. "001234": stored, one `trade_order.bir_invoice_set` row with before/after. **M26:** no append.
27. Same number on a second order -> exactly R6. **M27:** drop the unique index (tester asserts the refusal, not the SQL error).
28. Order in a closed month -> the closed-period sentence; value unchanged. **M28:** drop the period check.
29. Draft or internal order -> refused; staff -> `approve_buyer` refusal. **M29:** allow on drafts.
30. Order page: "Print delivery receipt" link and the BIR field only when dispatched or received. **M30:** link on drafts.

## Files
**TESTER** (writes only these):
- `packages/domain/tests/integration/t433-s1-pay-now.test.ts` (1-12; copy the `trade.test.ts` harness)
- `packages/domain/tests/integration/t433-s3-credit-limit.test.ts` (14-21; case 21 opens two pool connections)
- `packages/domain/tests/integration/t433-s2-bir-invoice-no.test.ts` (26-29)
- `apps/erp/tests/integration/t433-dispatch-action.test.ts` (13)
- `apps/erp/tests/integration/t433-s2-delivery-receipt.test.ts` (22-25, 30, server render)
**BUILDER** (writes only these):
- `packages/domain/src/ar/index.ts` (helper with lock, `recordChargeWithCollection`, `previewCreditExposure`,
  `voidCharge` allocation check, audit append)
- `packages/domain/src/trade/index.ts` (`dispatchTradeOrder` `payNow`, R4; `setBirInvoiceNo`); `index.ts` already re-exports
- `packages/db/src/repo/customers.ts` (`lockForCredit`), `packages/db/src/repo/ar.ts` (live-allocation count for a
  charge), `packages/db/src/repo/trade.ts` (set/read `bir_invoice_no`)
- `packages/db/schema/trade.ts` (column + partial unique index) and `packages/db/migrations/0203_t433_bir_invoice_no.sql`
  plus its journal entry (ADR-012 §5)
- `packages/db/src/audit/catalogue.ts` (two entries; re-pin any catalogue-count test with the reason)
- `apps/erp/src/app/trade/orders/actions.ts` (`dispatchOrderAction` pay-now with upload in one transaction; `setBirInvoiceNoAction`)
- `apps/erp/src/app/trade/orders/lib.ts` (store money accounts, preview, print loader)
- `apps/erp/src/app/trade/orders/[id]/page.tsx` (pay-now fields, warning, BIR field, print link)
- `apps/erp/src/app/trade/orders/[id]/print/page.tsx` (new)
Not touched: `customers/**` app screens, `docs/POSTING-PATTERNS.md` (no new pattern).

## Done when
Cases 1-30 green; each mutant shown red in the hand-back; grep the diff for leftover mutants. Typecheck, lint,
`trade.test.ts`, `t369-s4b-trade-closed-month`, `t371-trade-*`, `t328-trade-*`, AR void/collection suites, the audit
catalogue guard, touch-target baselines green. Migration: FULL suite on a fresh gate DB (standing rule). Browser on
**9008** at **390** and **1280**: dispatch with ₱2,000 cash -> flash -> customer page shows ₱3,000.00 owed; set BIR
no. -> it prints; print preview fits A4 with no nav; over-limit warning shows and refuses without a reason; void of a
paid order shows R5. Screenshots in the hand-back.

## Not in scope
Batched (weekly) invoices (discovery 19 §2.5 stays "dispatch = billing"); multi-order statements; payment terms and
dunning; BIR booklet series control or ATP tracking (the booklet is the legal record; we only note its number).
