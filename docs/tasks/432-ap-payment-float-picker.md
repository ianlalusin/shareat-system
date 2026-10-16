# T-432: the supplier payment form can pay a booked bill from a cash request

**Status:** spec written 2026-10-16, not started
**Closes:** DEF-662 (found in the T-415 spec review; T-415's "Recommended follow-up").
**Model:** Sonnet tester first (commits red), then Sonnet builder (bible row 184). Money path: Sonnet, not Haiku.
**Migration:** none. `ap_payments.cash_request_id` exists; the domain side shipped in T-415. Next free number unchanged.

## Goal (plain words)
A manager holding a released cash request (a float) at a store cannot use it to pay a supplier bill already booked:
the supplier page's payment form has no way to say "this cash came from Ana's cash request", and picking the staff cash
account is refused (T-415 S1). After this task the form's money list also shows each open cash request at the store
with its live balance, the same way New expense does (T-414), and the payment draws from it.

## Diagnosis (verified at `fe44a7c`)
- **Domain is ready.** `recordPayment` (`packages/domain/src/ap/index.ts:1244-1285`) takes `cashRequestId`, and when
  cash leaves a 1120 account: S1 no request, S2 account at another store, `lockForSpend` (org-scoped, so another org's
  id is `gone`), S3 not released, S4 request's store != the OWING store, S5 over the live balance; 1120 leg carries party
  `cash_request` (`:1340`). `authorize(record_ap_payment)` runs first, at the payment's store.
- **Action is half-ready.** `recordPaymentAction` (`apps/erp/src/app/ap/actions.ts:366-403`) already forwards
  `cashRequestId` from the form (`:393`); nothing posts it. It trusts both posted ids as sent.
- **Form.** `AutoAllocatePaymentForm.tsx:320-327` "From account" lists every store account from `moneyAccountsFor`
  (`apps/erp/src/app/ap/lib.ts:136-143`), staff cash included, so the one float route today ends in S1.
- **Floats loader exists.** `openFloatsFor` (`apps/erp/src/lib/money-lines/load.ts:60-102`, not exported): released,
  this store, outstanding > 0 from the ledger, holder A-Z, `moneyAccountId` = the store's staff cash or `null`.
- **Bill page has no pay-from-AP path.** `ap/invoices/[id]/page.tsx:492` posts `recordExpenseForInvoiceAction`, the
  expense path that invoice capacity refuses once the bill is booked. Not touched here (question 1).

## Rulings
1. **One "Pay from" list, store first.** The store is already chosen by the `?store=` chips on the supplier page
   (`page.tsx:55-60`), so the list is that store's. `<Select name="source">`: money accounts (value = account id), then
   one option per open float, value `float:<cashRequestId>`, label **`"{holder} · cash request — Balance ₱{outstanding}"`**
   (T-414 ruling 4, exact text). Holder A-Z. No coverage grouping: the amount is typed after the choice; S5 is the check.
2. **Staff cash is reached only through a request.** Accounts with custodian `staff` and instrument `cash` are left out
   of the plain account options (picking one could only end in S1). S1 stays as the server's backstop.
3. **The server picks the account, never the form.** For `float:<id>` the action: checks `<id>` is uuid-shaped
   (reuse `UUID_SHAPE`, `actions.ts:405`) else refuses R1; resolves the staff cash account of the POSTED `storeId`
   (`listMoneyAccounts(..., { storeId, custodian: 'staff', instrument: 'cash' })[0]`), none -> R2; calls `recordPayment`
   with that account and `cashRequestId`. Any posted `moneyAccountId` or `cashRequestId` field is ignored on this path.
   For a plain id: `moneyAccountId` = it, `cashRequestId` = null. If `source` is absent, fall back to `moneyAccountId`
   (existing callers and tests). Store, status, balance, org and capability are judged only by the domain.
4. **Loader:** export a thin `openFloatsForStore(orgId, storeId)` from `load.ts` wrapping `openFloatsFor` (one source of
   truth with New expense). A float with `moneyAccountId === null` (released before T-414 R-AUTO, store has no staff
   account) is NOT offered here; the form shows one line: "A cash request at this store has no staff cash account yet;
   it can be spent on a new expense."
5. **Refusals shown plainly** through the existing flash (`redirectWithFlash`, `actions.ts:399`); the domain's S-sentences
   pass through `errorMessage` unchanged. New sentences: R1 `"That cash request could not be found. Refresh the page and pick it again."` ·
   R2 `"This store has no staff cash account, so a cash request cannot pay a supplier here yet."`
6. **Capability:** reuse `record_ap_payment` (manager+, store-scoped). No new capability, no matrix row.

## Acceptance cases (each names the mutant that must turn it red)
1. Loader at store A lists A's released float (₱1,000) and not B's. **M1:** drop the `storeId` filter.
2. A drained float (outstanding 0.00) and a liquidated one are not offered. **M2:** `> 0` -> `>= 0` in the wrapper path.
3. A float whose store has no staff account is not offered and the note line renders. **M3:** offer `moneyAccountId: null` floats.
4. Render: float option value `float:<id>`, label exact text from ruling 1. **M4:** label `· float`.
5. Render: the store's staff cash account is not a plain option; the office safe is. **M5:** remove the staff filter.
6. Post `source=float:<A request>`, ₱600 against a ₱1,000 float, store A: one payment posted, `cash_request_id` = the
   request, `money_account_id` = A's staff cash, outstanding 400.00, flash starts "Paid.". **M6:** action passes `cashRequestId: null`.
7. Same post plus a forged `moneyAccountId` = A's office safe: still pays from A's staff cash; safe balance unchanged.
   **M7:** action uses the posted `moneyAccountId` when present.
8. **Forged request from another store:** store A form posts `float:<B request>` -> flash is exactly S4, nothing posted,
   B outstanding unchanged. **M8:** action takes `storeId` (or the staff account) from the request's store, not the form's.
9. **Forged request from another org:** `float:<org-2 request>` -> the `gone` sentence, nothing posted. **M9:** action
   pre-reads the request without the org filter and skips straight to an account lookup at its store.
10. `float:not-a-uuid` -> exactly R1; flash contains no `invalid input syntax`. **M10:** delete the shape check.
11. ₱1,200 on the ₱1,000 float -> exactly S5 (₱1,000.00 / ₱1,200.00), nothing posted. **M11:** wrap the error in a generic message.
12. Store with no staff account, forged `float:<id>` post -> exactly R2, no raw error. **M12:** pass `moneyAccountId: ''`.
13. Liquidated request posted directly -> exactly S3. **M13:** action filters by its own status read and returns a different sentence.
14. A staff-role actor (no `record_ap_payment`) posts a float source -> authorize refusal, outstanding unchanged.
    **M14:** action resolves the account in a `withOrgPrincipal` system context and calls the domain as it.
15. Plain `source=<office safe id>` posts with `cash_request_id` null (no regression). **M15:** action always sets `cashRequestId`.
16. Page at `?store=B` lists B's floats; the action for B accepts the same id (page list === action list). **M16:** page
    loads floats for `storeOptions[0]`.

## Files
**TESTER** (writes only these):
- `apps/erp/tests/integration/t432-ap-pay-from-float.test.ts` (cases 1-3, 6-16; real Postgres, copy the
  `t414-s2-money-lines-floats.test.ts` / `t414-s3-expense-store-first.test.ts` harness)
- `apps/erp/tests/t432-ap-payment-form-render.test.ts` (cases 4-5, server render of `AutoAllocatePaymentForm`)

**BUILDER** (writes only these):
- `apps/erp/src/app/ap/suppliers/[id]/AutoAllocatePaymentForm.tsx` (`floats` prop; `source` select; staff filter; note line)
- `apps/erp/src/app/ap/suppliers/[id]/page.tsx` (load floats for the chosen store, pass them)
- `apps/erp/src/app/ap/actions.ts` (`recordPaymentAction` only: ruling 3, R1, R2)
- `apps/erp/src/lib/money-lines/load.ts` (export `openFloatsForStore`; `openFloatsFor` body unchanged)
- `docs/DEFECTS-REGISTER.md` (close DEF-662 with this task)
Not touched: `packages/domain/**`, `packages/db/**` (T-415 is reused as is), the bill page, `MoneyLines.tsx`.

## Done when
Cases 1-16 green; each mutant shown red in the hand-back; grep the diff for leftover mutants. `npm run typecheck`, lint,
`t415-*`, `t414-s2/s3`, `t343-s5-5v-followups`, `t406-account-code-guard`, the touch-target and editable-record
baselines green (re-pin only with a reason). Browser check on **9008** at **390** and **1280**: supplier with an open
bill, store with a released ₱1,000 float -> Pay from shows "Name · cash request — Balance ₱1,000.00" -> pay ₱600 ->
"Paid." and the float shows ₱400.00 on the next load; pay ₱1,200 -> S5 flash. Screenshots in the hand-back; no
horizontal scroll at 390. Full suite on the wrap-up PR (row 296).

## Not in scope
Paying from a float on the bill page (question 1); applying supplier credit from this form; a client-side
"covers / short" hint; legacy floats with no staff account (they stay spendable through New expense).

## Questions for Ian
1. The bill page has no "pay this booked bill" button at all, only "record an expense". Add a link there to this
   supplier form (opened at the bill's store), as a small follow-up? Recommended: yes, one link, separate task.
