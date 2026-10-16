# T-432: the supplier payment form can pay a booked bill from a cash request

**Status:** spec written 2026-10-16, not started (revised same day after Opus review; Ian approved the bill-page link)
**Closes:** DEF-662 (found in the T-415 spec review; T-415's "Recommended follow-up").
**Model:** Sonnet tester first (commits red), then Sonnet builder (bible row 184). Money path: Sonnet, not Haiku.
**Migration:** none. `ap_payments.cash_request_id` exists; the domain side shipped in T-415. Next free number unchanged.

## Goal (plain words)
A manager holding a released cash request (a float) at a store cannot use it to pay a supplier bill already booked:
the supplier page's payment form has no way to say "this cash came from Ana's cash request", and picking the staff cash
account is refused (T-415 S1). After this task the form's money list also shows each open cash request at the store
with its live balance, the same way New expense does (T-414), and the bill page gets a "Pay this bill" link to it.

## Diagnosis (verified at `fe44a7c`)
- **Domain is ready.** `recordPayment` (`packages/domain/src/ap/index.ts:1244-1292`): when cash leaves a 1120 account,
  S1 no request, S2 account at another store, `lockForSpend` (`:1258`, org-scoped, so another org's id is `gone`), S3 not
  released, S4 request's store != the OWING store, S5 over the live balance read after the lock (`:1275`); 1120 leg
  carries party `cash_request` (`:1340`). `authorize(record_ap_payment)` runs first. Every allocation must be an open
  item of THIS supplier at THIS store (`:1147-1162`).
- **Action.** `recordPaymentAction` (`apps/erp/src/app/ap/actions.ts:366-405`) forwards a posted `cashRequestId`
  (`:393`); nothing posts it. Flash: error `:402`, ok `:404`. `UUID_SHAPE` at `:407`.
- **Form.** `AutoAllocatePaymentForm.tsx:320-327` lists every store account from `moneyAccountsFor`
  (`apps/erp/src/app/ap/lib.ts:136-143`), staff cash included, so the one float route today ends in S1.
- **Page has no capability gate.** `suppliers/[id]/page.tsx:34` only requires a session; the form renders for anyone
  (`:297`); the `?store=` chips reach every store. Anything this task adds to the page must be gated (ruling 4).
- **Floats loader exists.** `openFloatsFor` (`apps/erp/src/lib/money-lines/load.ts:60-94`, not exported): released,
  this store, outstanding > 0 (`:92`), holder A-Z, `moneyAccountId` = the store's staff cash or `null`.
- **Bill page has no pay-from-AP path.** `ap/invoices/[id]/page.tsx:492` posts the expense path, which invoice capacity
  refuses once the bill is booked. Its void panel already probes `can(record_ap_payment, store)` (`:97-112`).

## Rulings
1. **One "Pay from" list, store first.** The store is chosen by the `?store=` chips (`page.tsx:55-60`).
   `<Select name="source">`: money accounts (value = account id), then one option per open float, value
   `float:<cashRequestId>`, label **`"{holder} · cash request — Balance ₱{outstanding}"`** (T-414 ruling 4). Holder A-Z.
   The balance shown is a snapshot at page load; S5 re-checks it under the lock (`index.ts:1258` then `:1275`). There
   is no client-side balance check and no coverage grouping.
2. **Staff cash is reached only through a request.** Accounts with custodian `staff` and instrument `cash` are left out
   of the plain account options. S1 stays as the server's backstop.
3. **The server picks the account, never the form.** For `float:<id>` the action: checks `<id>` against `UUID_SHAPE`
   else R1; resolves the staff cash account of the POSTED `storeId` (`listMoneyAccounts(..., { storeId, custodian:
   'staff', instrument: 'cash' })[0]`), none -> R2; calls `recordPayment` with that account and `cashRequestId`. Posted
   `moneyAccountId` / `cashRequestId` fields are ignored on this path. Plain id: `moneyAccountId` = it, `cashRequestId`
   = null. **`source` absent** (older callers, raw posts): fall back to the posted `moneyAccountId` AND keep forwarding a
   posted `cashRequestId` as today (`:393`); the domain judges both. Store, status, balance, org and capability are
   judged only by the domain.
4. **Floats are shown only to someone who could spend them there.** Export `openFloatsForStore(orgId, storeId, actor)`
   from `load.ts`: it returns `[]` unless `can(tx, actor, 'record_ap_payment', { storeId })`, else `openFloatsFor` (no
   filter of its own). A float with `moneyAccountId === null` (released before T-414 R-AUTO) is NOT offered; for a
   holder only, the form shows: "A cash request at this store has no staff cash account yet; it can be spent on a new expense."
5. **Refusals shown plainly** through the existing flash; domain sentences pass through `errorMessage` unchanged. New:
   R1 `"That cash request could not be found. Refresh the page and pick it again."` ·
   R2 `"This store has no staff cash account, so a cash request cannot pay a supplier here yet."`
6. **Capability:** reuse `record_ap_payment` (manager+, store-scoped). No new capability, no matrix row.
7. **"Pay this bill" (Ian, 16 Oct: yes).** The bill page shows a link to
   `/ap/suppliers/{supplierId}?store={invoice.storeId}&bill={invoiceId}` only when the bill is booked (`verified`), has
   open items (`apRepo.openItems` for that supplier and store, filtered by `supplier_invoice_id`, outstanding > 0) and
   the viewer passes `can(record_ap_payment, invoice.storeId)`. On the supplier page, a uuid-shaped `bill` pre-fills
   ONLY the open items (already this supplier's, this store's) whose `supplierInvoiceId === bill`; every other box
   starts blank; nothing is `touched`. A `bill` matching none of them is ignored. No new money logic: the existing
   form, action and the domain's open-item check (`:1147-1162`) do the work.

## Acceptance cases (each names the mutant that must turn it red)
1. Loader (manager of A) at store A lists A's released ₱1,000 float, not B's. **M1:** drop the `storeId` filter.
2. A drained float (0.00) is not offered. **M2:** `> 0` -> `>= 0` at `load.ts:92` in `openFloatsFor` (the wrapper has no filter).
3. A float whose store has no staff account is not offered; the note renders. **M3:** offer `moneyAccountId: null` floats.
4. Render: option value `float:<id>`, label exact (ruling 1). **M4:** label `· float`.
5. Render: A's staff cash account is not a plain option; the office safe is. **M5:** remove the staff filter.
6. **Gate:** a staff session at `?store=A`, and a manager of A only at `?store=B`, render no float option and no holder
   name. **M6:** drop the `can` check in `openFloatsForStore`.
7. Post `source=float:<A req>`, ₱600 of ₱1,000, store A: one payment, `cash_request_id` = it, `money_account_id` = A's
   staff cash, outstanding 400.00, flash starts "Paid.". **M7:** action passes `cashRequestId: null`.
8. Same plus a forged `moneyAccountId` = A's office safe: still pays from A's staff cash; safe unchanged. **M8:** posted id wins.
9. **Forged request, other store:** store A posts `float:<B req>` -> exactly S4, nothing posted, B unchanged. **M9:**
   action takes `storeId` (or the staff account) from the request's store.
10. **Forged request, other org:** `float:<org-2 req>` -> the `gone` sentence, nothing posted. **M10:** action pre-reads
    the request without the org filter and resolves the account at its store.
11. `float:not-a-uuid` -> exactly R1; no `invalid input syntax` in the flash. **M11:** delete the shape check.
12. ₱1,200 on the ₱1,000 float -> exactly S5 (₱1,000.00 / ₱1,200.00). **M12:** replace the error with a generic message.
13. Store with no staff account, forged `float:<id>` -> exactly R2. **M13:** pass `moneyAccountId: ''`.
14. Store A HAS a staff cash account (so R1/R2 cannot fire first); a staff-role actor posts `float:<A req>` -> the
    `record_ap_payment` refusal, outstanding unchanged. **M14:** delete the `authorize(record_ap_payment)` call in
    `recordPayment` (tester-applied mutant; domain is not a builder file).
15. Plain `source=<office safe id>` posts with `cash_request_id` null. **M15:** action always sets `cashRequestId`.
16. No `source`; `moneyAccountId` = A's staff cash + `cashRequestId` = A req: posts from the float. **M16:** fallback drops `cashRequestId` (S1).
17. Page at `?store=B` (manager of B) lists B's floats; the action for B accepts the same id. **M17:** floats for `storeOptions[0]`.
18. **Link shown only when payable:** a verified bill with open items shows "Pay this bill" with the bill's store and id;
    a fully paid bill, a pending bill and a voided bill show none. **M18:** drop the open-items condition.
19. **Link gated:** a staff session, and a manager of another store, see no link on a payable bill. **M19:** drop the `can` probe.
20. `?store=A&bill=<X>`: X's open items pre-filled at outstanding, the supplier's other items blank. **M20:** pre-fill every item.
21. **Forged pre-select:** `bill=<another supplier's bill>` pre-fills nothing; posting that bill's expense id with this
    supplier -> the domain's "not an open item for this supplier at this store" sentence, nothing posted. **M21:**
    page pre-fills by `bill` without restricting to this supplier's open items (render shows a foreign row).

## Files
**TESTER** (writes only these):
- `apps/erp/tests/integration/t432-ap-pay-from-float.test.ts` (cases 1-3, 6-17; real Postgres, copy the
  `t414-s2-money-lines-floats.test.ts` / `t414-s3-expense-store-first.test.ts` harness)
- `apps/erp/tests/t432-ap-payment-form-render.test.ts` (cases 4-5, server render of `AutoAllocatePaymentForm`)
- `apps/erp/tests/integration/t432-bill-pay-link.test.ts` (cases 18-21)

**BUILDER** (writes only these):
- `apps/erp/src/app/ap/suppliers/[id]/AutoAllocatePaymentForm.tsx` (`floats` prop; `source` select; staff filter; note; `bill` pre-fill)
- `apps/erp/src/app/ap/suppliers/[id]/page.tsx` (gated floats for the chosen store; read `bill`)
- `apps/erp/src/app/ap/actions.ts` (`recordPaymentAction` only: ruling 3, R1, R2)
- `apps/erp/src/app/ap/lib.ts` (`listOpenItems` carries `supplierInvoiceId`, only if it does not already)
- `apps/erp/src/app/ap/invoices/[id]/page.tsx` (the gated "Pay this bill" link only)
- `apps/erp/src/lib/money-lines/load.ts` (export `openFloatsForStore`; `openFloatsFor` body unchanged)
- `docs/DEFECTS-REGISTER.md` (close DEF-662 with this task)
Not touched: `packages/domain/**`, `packages/db/**` (T-415 reused as is), `MoneyLines.tsx`.

## Done when
Cases 1-21 green; each mutant shown red in the hand-back; grep the diff for leftover mutants. `npm run typecheck`, lint,
`t415-*`, `t414-s2/s3`, `t343-s5-5v-followups`, `t406-account-code-guard`, `t411-row-link*`, touch-target and
editable-record baselines green (re-pin only with a reason). Browser check on **9008** at **390** and **1280**: payable
bill -> "Pay this bill" -> supplier form at the bill's store with the bill ticked -> Pay from shows "Name · cash request
— Balance ₱1,000.00" -> pay ₱600 -> "Paid.", float ₱400.00 on reload; ₱1,200 -> S5 flash; a staff login sees no link
and no float. Screenshots in the hand-back; no horizontal scroll at 390. Full suite on the wrap-up PR (row 296).

## Not in scope
Applying supplier credit from this form; a client-side "covers / short" hint; legacy floats with no staff account (they
stay spendable through New expense); gating the rest of the supplier page (log a DEF if the builder sees a real leak).
