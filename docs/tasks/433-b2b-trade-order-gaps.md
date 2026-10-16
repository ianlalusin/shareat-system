# T-433: business customers on trade orders: pay now, a printable delivery receipt, the credit-limit warning

**Status:** spec written 2026-10-16, not started
**Model:** Sonnet tester first (commits red), then Sonnet builder, per slice (bible row 184). Money path: Sonnet, not Haiku.
**Migration:** none. Every column exists (`trade_orders.credit_override_by/_reason`, `customers.credit_limit`,
`ar_collections`, `ar_collection_allocations`); the audit catalogue is TypeScript. Next free number unchanged (0203).
**Order:** S1, then S3 (it shares S1's credit helper), then S2.

## Goal (plain words)
A samgyup house buys meat from us. It either pays on the spot (cash or e-wallet) or pays later on account.
Ruling (Ian, 16 Oct): such buyers are ordinary **customers** (T-129) on **trade orders** (T-132), paid through **AR
collections** (T-131/T-226/T-330). Not a sales channel. Three gaps: paying at dispatch takes two screens today; there
is nothing to hand the buyer; the credit-limit check gives no warning before it refuses.

## Diagnosis (verified at `52d14ca`)
- **Dispatch bills.** `dispatchTradeOrder` (`packages/domain/src/trade/index.ts:422`) calls `recordCharge` (`:565`,
  Dr 1210 party=customer / Cr 4300, `WHOLESALE_REVENUE_CODE` `:87`), then COGS (T-165, `:576-628`), then
  `markDispatched` (`:633`). Idempotent re-dispatch returns early (`:439-449`). Internal (branch) orders bill nothing (`:559`).
- **The credit gate already exists** (DEF-158), inside `recordCharge` (`packages/domain/src/ar/index.ts:71-96`):
  org-wide `positionOf(...).controlBalance + total > creditLimit` -> refuse unless `can(override_credit_limit)` AND a
  reason. Who/why are stored on `trade_orders` (`markDispatched`). **Missing:** no audit-log event; no warning before
  submit (the page always shows a reason box when a limit is set, `orders/[id]/page.tsx:112-117`); pay-now cannot
  reduce the exposure because the gate runs before any payment.
- **Collections.** `recordCollection` (`ar/index.ts:229`) authorizes `record_ar_collection`, requires proof
  (`receiptFileId`) for a non-cash account (`:302`), locks and checks every allocation is an open item of this customer
  at this store (`:331-357`), posts `ar_collection` (POSTING-PATTERNS `:483`). The upload-in-one-transaction shape is
  `recordCollectionAction` (`apps/erp/src/app/customers/actions.ts:162-236`).
- **No print view.** `orders/[id]/page.tsx` gates only on a session (`:48`). `outstandingForCharge` (`packages/db/src/
  repo/ar.ts:249`) gives what is still owed on one charge. The print CSS precedent is `cutover/count/sheet/page.tsx:54`.

## Rulings
1. **One combined action, decided in the domain.** `dispatchTradeOrder` takes optional `payNow: { amount,
   moneyAccountId, receiptFileId?, referenceNo? }`. When present, it calls a NEW `recordChargeWithCollection` in
   `ar/index.ts` instead of `recordCharge`: one transaction, the charge, then `recordCollection` with ONE allocation
   (this charge, `amount`), `collectionDate` = the charge date. No new posting pattern: `ar_charge` then
   `ar_collection`, exactly as two screens would post them today. Rejected: dispatch then an automatic collection in
   the app layer (two transactions; a crash between them bills a buyer who already paid).
2. **The credit check moves into one private helper** `creditExposure(trx, actor, customer, storeId, addedExposure)`
   used by `recordCharge` (added = total) and `recordChargeWithCollection` (added = total - payNow). Only the function
   that also posts the payment may reduce the exposure, so no caller can claim a payment it did not make. Same
   refusal sentence, same `override_credit_limit` rule.
3. **Pay-now limits.** `0 < amount <= order total` (Money helpers: `parseMoneyInput`, `compare`, `subtract`; never
   `Number()`). Over the total -> R1 `"Paid now cannot be more than this order's ₱{total}."` (no silent store credit).
   Internal orders -> R2 `"A branch transfer is not paid for; remove the payment."` Proof for e-wallet is the existing
   rule, unchanged. Fee, store credit and cross-store accounts are not offered on this form.
4. **Capabilities:** dispatch keeps `approve_buyer`; the collection keeps `record_ar_collection` (both manager+, store).
   Override reuses `override_credit_limit`. No new capability, no matrix row.
5. **Audit (S3).** Add `def('credit_limit.overridden', 'money', 'high', 'store', 'ar_charges', 'T-433')` to
   `packages/db/src/audit/catalogue.ts`; the helper appends it (before/after = balance, charge, limit, reason) whenever
   an override lets a charge through.
6. **Warning before submit (S3).** Export `previewCreditExposure(tx, actor, { customerId, storeId, total, payNow })`
   built on the same helper. The order page shows, only when over: "Owes ₱X. This order takes them to ₱Y against a ₱Z
   limit." and the reason box; under the limit or no limit -> no box, no line. The server still decides.
7. **S2 is a non-official delivery receipt.** Bible row 75: this system is a management ledger and must never be
   labelled BIR-ready. Page title "Delivery receipt"; footer "This is not an official receipt or sales invoice."
   **Open for Ian (Q1).** No numbering scheme, no PDF library: HTML plus `@media print`.

## Slices and acceptance cases (each names the mutant that must turn it red)
**S1 Pay now** (fixtures: customer at store A, ₱5,000 order, A's cash drawer, A's GCash account)
1. Pay ₱5,000 cash: one charge, one collection allocated to it, `positionOf` = 0.00. **M1:** skip the allocation.
2. Pay ₱2,000: outstanding 3,000.00 on that charge. **M2:** allocate `total` not `amount`.
3. Both entries in one transaction: force `recordCollection` to throw -> no charge, no stock move. **M3:** dispatch
   calls `recordCharge` then collects in a separate `transaction()`.
4. ₱5,000.01 -> exactly R1; nothing posted. **M4:** drop the `<= total` check (posts surplus to 2140).
5. Internal order with `payNow` -> exactly R2. **M5:** ignore `payNow` on internal.
6. GCash with no proof -> the existing proof sentence. **M6:** pass a dummy `receiptFileId`.
7. Re-dispatch the same order with `payNow` -> no second collection. **M7:** collect before the idempotency return.
8. Staff actor -> `approve_buyer` refusal, nothing posted. **M8:** delete `authorize` in `recordChargeWithCollection`.
9. Journal shape equals two-screen posting (Dr 1210/Cr 4300; Dr cash/Cr 1210, party=customer). **M9:** credit 4300 directly.
10. Action: form `payNowAmount` + `moneyAccountId` + photo -> flash "Dispatched, billed and paid ₱2,000.00; ₱3,000.00
    still owed." **M10:** action drops `payNow`.
**S3 Credit limit** (limit ₱10,000, already owes ₱8,000)
11. ₱5,000 order, no pay-now, manager, no reason -> the existing refusal. **M11:** default the reason.
12. Same with pay-now ₱3,000 -> passes, no override recorded. **M12:** helper ignores `payNow`.
13. Override with reason -> `trade_orders.credit_override_*` set AND one `credit_limit.overridden` audit row. **M13:** no append.
14. No limit set -> no check, no audit row, no warning. **M14:** treat null as 0.
15. Preview: over -> the exact warning line; under -> none. **M15:** preview reads store-level, gate reads org-wide.
16. `recordCharge` alone (manual caller) still gated at the full total. **M16:** default `addedExposure` to 0.
**S2 Delivery receipt**
17. `/trade/orders/{id}/print` for a dispatched order: customer, date, reference, lines (item, qty, unit, unit price,
    line total), fees, total, "Paid on this order", "Balance due on this order", account balance (org-wide 1210 less
    2140 credit, labelled "as of {print time}"). **M17:** paid read from the form, not `outstandingForCharge`.
18. Draft or void order -> 404 (nothing to hand over). **M18:** drop the status check.
19. Gate: needs `approve_buyer` or `record_ar_collection` at the order's store; staff and another store's manager get
    404. **M19:** session-only gate.
20. Footer sentence present; no "Official Receipt" / "Sales Invoice" / "BIR" wording. **M20:** title "Sales Invoice".
21. Order page shows a "Print delivery receipt" link only when dispatched or received. **M21:** link on drafts.

## Files
**TESTER** (writes only these):
- `packages/domain/tests/integration/t433-s1-pay-now.test.ts` (1-9; copy the `trade.test.ts` harness)
- `packages/domain/tests/integration/t433-s3-credit-limit.test.ts` (11-16)
- `apps/erp/tests/integration/t433-dispatch-action.test.ts` (10)
- `apps/erp/tests/integration/t433-s2-delivery-receipt.test.ts` (17-21, server render)
**BUILDER** (writes only these):
- `packages/domain/src/ar/index.ts` (helper, `recordChargeWithCollection`, `previewCreditExposure`, audit append)
- `packages/domain/src/trade/index.ts` (`dispatchTradeOrder` `payNow` only; `index.ts` already re-exports `./ar`)
- `packages/db/src/audit/catalogue.ts` (one entry; re-pin any catalogue-count test with the reason)
- `apps/erp/src/app/trade/orders/actions.ts` (`dispatchOrderAction`: pay-now fields, upload in the same transaction)
- `apps/erp/src/app/trade/orders/lib.ts` (store money accounts, preview, print loader)
- `apps/erp/src/app/trade/orders/[id]/page.tsx` (pay-now fields, warning, print link)
- `apps/erp/src/app/trade/orders/[id]/print/page.tsx` (new)
Not touched: `packages/db/schema/**`, migrations, `customers/**`, `docs/POSTING-PATTERNS.md` (no new pattern).

## Done when
Cases 1-21 green; each mutant shown red in the hand-back; grep the diff for leftover mutants. Typecheck, lint,
`trade.test.ts`, `t369-s4b-trade-closed-month`, `t371-trade-*`, `t328-trade-*`, the audit catalogue guard, touch-target
baselines green. Browser on **9008** at **390** and **1280**: dispatch with ₱2,000 cash -> flash -> customer page
shows ₱3,000.00 owed; print preview fits A4 with no nav; over-limit warning shows and refuses without a reason.
Screenshots in the hand-back. Full suite on the wrap-up PR (row 296).

## Questions for Ian
- **Q1 (official invoice):** do these buyers need a BIR-registered sales invoice from us (a numbered booklet or
  registered system)? If yes, it is a legal document this system does not issue (row 75); staff would write the booklet
  number in the order's reference field, and the printout stays a delivery receipt. If no, the delivery receipt is enough.
- **Q2:** keep proof (screenshot) mandatory for e-wallet pay-now, as for every collection today? Spec assumes yes.

## Not in scope
Batched (weekly) invoices for several deliveries (discovery 19 §2.5 stays "dispatch = billing"); statements across many
orders; payment terms and dunning; voiding a paid-now order (tester pins today's `voidTradeOrder` behaviour on a charge
with a collection; if it leaves money stranded, log a DEF, do not fix here).
