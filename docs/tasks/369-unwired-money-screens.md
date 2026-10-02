# T-369: Unwired money screens — DEF-198, DEF-314, DEF-302, DEF-479, DEF-291

**Status:** **S0, S1, S2, S3, S4, S5a, S6a, S7 DONE 2026-10-01/02 (c3c0458…5b8aeb7); S4 follow-up DONE 2026-10-02 (void sentence, one `now` per void, DEF-560, refusals reach the returns pages); S8 DONE 2026-10-02 (DEF-551; plus DEF-571, the T-367 S3 recurring due-date regression); S8b, S9 specced (Ian ruled); S5b, S6b after T-367** — was: **Not started — Q1–Q4 answered 2026-09-30 (row 260; Q1 re-entry manager-only); S0 added 2026-10-01 for DEF-550** — APPROVED 2026-09-30 (orchestrator, after independent Opus review; Q1–Q4 defaults ship). Review changes
1–7 and both minors applied (marked ✎R). Written 2026-09-30 by the Opus planner at HEAD `594f600`. Batch D of
the money-defect push (Ian, 2026-09-30: *"close all open money defects in v2"*), `docs/plans/money-defects-2026-09-30.md`.
DEF-302 is included under Ian's ruling **(a)** of 2026-09-30.
**Model:** Sonnet for each slice, tester first, then builder. Any spec amendment is written in plan mode (Opus).
**Migration:** none by default. S7 needs one only if Ian answers Q1 (a): **next free index at build** (0172–0174 are
taken by T-366/T-367/T-368).
**Line numbers** were checked at `594f600`. Dirty at that HEAD and NOT touched here: `ap/actions.ts`, `ap/index.ts`
(T-365), `expenses/actions.ts`, `attendance/adjustments.ts` (T-364).

## Goal
Every money capability that the domain already has, and that Ian ratified, can be used from a screen, and every
screen refuses in words a person can act on:
- a manager pays a staff member back for what they spent out of pocket;
- anyone who may see a record can open the photo attached to it;
- an unverified sales day that was entered wrong can be corrected or withdrawn;
- an admin can post one late entry into a closed month, recorded against their name;
- receiving, producing or returning stock in a closed month is refused with a plain sentence about the closed
  month, not a stock error;
- a money-account list offers what the person can actually use.

## v1 as requirements (§1.2d: the goal first, then v2 beats it)
| Screen | v1 at source | v1's GOAL | v2 bar |
|---|---|---|---|
| Reimbursement payout | `src/app/accounting/reimbursement/page.tsx` (lists staff by owed balance, pay dialog defaulting to the full balance); `src/lib/actions/reimbursement.actions.ts:51` (manager+, store access, day-lock, 2 legs) and `:152` (void) | Clear what the store owes a person, from the store's own money, by a manager | Same list and dialog. Balance derived from the ledger per store; overpayment and cross-store draws refused; concurrent payouts serialised |
| Receipt photo | v1 stores permanent `getDownloadURL()` links and renders them (`financial/receipts/[id]`, `inventory/deliveries/[id]`) | Whoever checks a record can look at its evidence | A short-lived signed URL minted per click, gated by the same capability that governs the record; nothing stored or logged |
| Sales-day draft | `src/lib/actions/sales-report-draft.actions.ts:94` (save = edit a draft); `sales-day.actions.ts:167` (void any status, manager+; only posted days reverse; the doc is archived, freeing the date) | A wrong report can be fixed before it counts, or withdrawn | Edit with create's validation; void of an unverified day posts nothing; segregation kept |
| Closed-period override | `src/lib/financial/lockedDay.guard.server.ts` — admin silently bypasses every day lock | An admin can still record a genuinely late document | Explicit, per entry, typed reason, audit row, admin-only; never for stock (Ian (a)) |
| Money-account picker | `cashier-guard.ts:84` `isPaymentAccountSelectableByRole` — staff see cashier accounts only; v1 posts on save (`expense.actions.ts:286`), so the list was v1's only control | A person is offered only money they may use | Store-scoped, capability-aware; the approval gate stays the control (v2 has a draft→approve step v1 lacked) |

## Census, verified at source (corrections marked ✎)
- **DEF-198.** `payReimbursement` (`packages/domain/src/expenses/reimbursement.ts:36`) and `readFileUrl`
  (`packages/domain/src/files/index.ts:195`) have zero callers under `apps/`. Confirmed. Both are rows in
  `tests/unit/domain-actions-have-callers.test.ts:123-128` and in `docs/production-caller-baseline.txt:62,75`.
  ✎ Three new defects in `payReimbursement` (the orchestrator files them):
  - **N1.** It credits any money account in the org without the cross-store gate. `:50-51` loads the account;
    `:94-99` credits it at `input.storeId`. The siblings gate this: `approve.ts:127-128` and `ap/index.ts:974-976`
    authorise `transfer_funds` on the account's store.
  - **N2.** The cap is org-wide (`repo/expenses.ts:33-47`, no store filter), but the debit lands on `input.storeId`.
    So Malvar can "pay" Lipa's liability, and both stores' 2130 read wrong.
  - **N3.** Two payouts in flight can both pass the cap. There is no lock, and the idempotency key is random
    (`:77,:83`).
  - ✎ v1 has a payout void (`reimbursement.actions.ts:152`); v2 has none. → Q4.
  - ✎ `readFileUrl` authorises by the capability that governs UPLOADING the purpose (`files/index.ts:70-80,207`).
    AR collection proofs and delivery proofs are uploaded as `receipt_photo` (`customers/actions.ts:201`,
    `inventory/deliveries/actions.ts:161`; DEF-320), so viewing them needs `record_supplier_invoice`. That is
    accepted here, not fixed (Out of scope).
  - ✎ The dev default driver returns `memory://` URLs (`files/driver.ts:49-53`), and a browser cannot open them.
- **DEF-314.** `periodOverride` has no caller outside `post-entry.ts` and its test. Confirmed (grep). The reasons are
  `late_supplier_invoice`, `regulatory_correction`, `data_entry_error` and `other` (`schema/period-overrides.ts:39-46`,
  with a DB CHECK at `:79`). The capability `override_period_lock` exists (CAPABILITY-MATRIX `:130`, org, admin+).
  ✎ `docs/GLOSSARY.md:152` still says *"no posting into a closed period by any path, including … admin tools"*,
  which contradicts bible row 193. The orchestrator corrects the glossary.
- **DEF-302.** ✎ The register row records ruling (b) and T-281 as shipped (`0145`, the honest trigger sentence).
  Ian's 2026-09-30 ruling (a) adds: closed months' stock stays fixed, and the flows refuse with a plain closed-month
  sentence BEFORE any write. ✎ The line numbers have drifted, and **the census names three flows but there are six
  of this shape** (a stock movement plus a ledger post in one transaction, dated by the document):
  - `confirmReceipt`: movement `transfer.ts:385`, post `:503`; dated `receivedOn` (`trade/index.ts:822`).
  - `dispatchOrder`: `consume` at `transfer.ts:188`, post `:217`. ✎ It is dated `order.orderDate`
    (`trade/index.ts:506`), not the day of dispatch.
  - `runProductionPosting`: `consume` at `production/index.ts:421`, movements `:460,:519`, post `:563`; dated
    `producedOn`. Reached from `postProduction:604` and `editPostedProduction:665`; `voidProduction:803` reverses
    at `producedOn` (`:854`).
  - `recordInternalReturn`: `consume` at `returns.ts:435`, movement `:447`, post `:485`. ✎ `recordExternalReturn`
    (`:231`, movement `:274`/`consume :294`, post `:358`) is the same shape. Both are reached only through
    `recordCustomerReturn:165`.
  - ✎R And four more that POST (DEF-528, logged by the orchestrator 2026-09-30): delivery receipt
    (`deliveries/receive.ts:182`, `postReceiptValue` in the movement's tx), usage/wastage (`stock/usage.ts:156`),
    and supplier returns (`stock/supplier-returns.ts:164` moves at `now`, `:228` posts at `returnedOn`). S4a takes
    them.
  - Today, a closed date surfaces the trigger's P0001 text *"cannot move stock into a closed period (moved_at =
    …)"* (`0145:52-55`) through `errorMessage` step 2 (`constraint-messages.ts:311`). `receiveTradeOrder` wraps it
    as a bare `Error` (`trade/index.ts:908`).
- **DEF-479.** Confirmed. `editSalesDay` is named at `sales-days/create.ts:15,239` and does not exist.
  `voidSalesDay` refuses anything not `verified` (`verify.ts:188-193`). The repo halves already exist:
  `updateDraft` (`repo/sales-days.ts:431`, open/submitted only), `replaceChannels :551`, `replaceTenders :596`;
  `markVoided :492` is verified-only.
  ✎ The unique index `sales_days_org_id_store_id_business_date_unique` (`0016:84`) includes voided rows. So a voided
  day's date can never be entered again, for a verified day as much as a draft; v1 freed it by archiving. → Q1.
- **DEF-291.** ✎ The census line is partly stale. T-266 fixed the expense screen: `<MoneyLines>` loads through
  `lib/money-lines/load.ts:99` with `{ storeId }`. `listMoneyAccountsForPicker` (`expenses/lib.ts:183-195`, the
  `{}` at `:187`) now has ONE consumer, `sales-days/new/page.tsx:35`, which filters to the store after fetching
  every account. The other unscoped reads:
  - `money-transfers/lib.ts:34`: both selects offer every store's accounts. `transfer_funds` is checked on both
    ends only at submit (`money-transfers/*.ts:135,151`).
  - `channel-settlements/lib.ts:82`: the page filters per channel store (`page.tsx:255`) and the domain refuses a
    cross-store destination (`channel-settlements/index.ts:696`). Acceptable, left alone.
  - `settings/sales-channels/lib.ts:36`: a name lookup, not a picker.
  - ✎ T-266 §6.4's "another store" group was never built; `load.ts` drops other stores. A cross-store-paid expense
    (which `approve.ts:127` supports) therefore cannot be entered from the screen. → Q2.
  - ✎ The register's *"the other ~20 pickers are T-267"* mis-cites: T-267 is the `systemTransaction` routing task.

## Collisions and order
| Slice | Collides with | Rule |
|---|---|---|
| S0 | `packages/domain/src/ap/index.ts` is a T-367 S3 BUILDER path (`recordInvoice`, `setInvoiceLines`); `advisory-locks.ts` is also S1's; `ap/invoices/[id]/page.tsx` is S2's and S6b's; T-371 runs last over `ap/index.ts` | **Not in parallel with T-367 S3, S1 or S2** — one lane at a time on those files; whichever commits second rebases. S0 takes lock namespace `369002`. May run now (T-366 S1 has committed `advisory-locks.ts`) |
| S1, S2, S3, S4a, S6a | none among themselves (file-disjoint) | **May run in parallel**, one lane DB each (§3.4 row 94); ✎R S1 only once T-366 S1 has committed |
| S1 + S2 | ✎R both TESTERs delete ADJACENT rows of `tests/unit/domain-actions-have-callers.test.ts` (`payReimbursement` `:123-125`, `readFileUrl` `:126-128`) | Use Edit on the exact row, never a whole-file write; the second to commit rebases |
| S1 | ✎R `packages/db/src/repo/advisory-locks.ts` and `packages/db/src/index.ts` are T-366 S1's (uncommitted at HEAD) | **S1 waits for T-366 S1 to commit** |
| S2 | ✎R `ap/invoices/[id]/page.tsx` and `customers/[customerId]/page.tsx` are NOT T-367 BUILDER paths (T-367 S1 edits `customers/actions.ts`, S3 `ap/page.tsx`, S5 `expenses/[id]/page.tsx`) | None |
| S4a | ✎R `deliveries/receive.ts`, `stock/usage.ts`, `stock/supplier-returns.ts` — no other money-push task lists them | None |
| S4b | `packages/domain/src/trade/index.ts` is a T-372 S3 BUILDER path. The check lives in `trade/index.ts`, not `commissary/transfer.ts`, but it still collides | **After T-372 S3 commits** |
| S5a | S1's files | After S1, same lane |
| S5b | `expenses/approve.ts` (T-367 S2), `expenses/actions.ts` (T-364 dirty, T-367 S2/S5), `expenses/[id]/page.tsx` (T-367 S5) | **After T-367 S2 and S5 commit** |
| S6b | `lib/money-lines/load.ts` callers include `expenses/actions.ts:169` and `ap/invoices/[id]/page.tsx:46` | After T-367; only if Q2 = (a) |
| S3 | T-370 edits `sales-days/create.ts:44`. S3 imports from `create.ts` and never edits it | None |
| S7 | S3's files plus a migration | After S3; only if Q1 = (a) |
| S8 | `expenses/reimbursement.ts` (S1/S5a's), `expenses/approve.ts` (T-367 S2, S5b), `ap/index.ts` (S0, T-367 S3, T-371), `expenses/routing.ts`, `tests/worked-examples/fixtures.ts`, `docs/POSTING-PATTERNS.md` (+ TOC regen) | **After S5a, S0 and T-367 S2/S3 commit; before S5b or after it, same lane** (both edit `approve.ts`). One lane; no migration (0178 stays T-372 S6's) |
| S8b | S8's `ledger/inter-store.ts` and `tests/unit/inter-store-legs.test.ts` (S8b flips S8·T7's debit leg); `ar/index.ts` (T-367 S1 committed; T-371 last); `loans/index.ts`; `fixtures.ts` and `POSTING-PATTERNS.md` (S8, S9) | **After S8 commits, same lane as S8.** No migration |
| S9 | `money-transfers/index.ts` (the `prepareTransfer` move; T-371 later), `repo/money-transfers.ts`, `advisory-locks.ts` (S0/S1's, committed), `app/money-transfers/*`; `fixtures.ts` and `POSTING-PATTERNS.md` (S8, S8b) | Code-independent of S8/S8b: may build in its own lane and lane DB now, but **commits after S8b**, rebasing `fixtures.ts` / `POSTING-PATTERNS.md` and re-running `npm run toc`. Lock namespace `369003`. No migration (0179 not taken) |
| All | T-368 edits `repo/fiscal-periods.ts` and `fiscal-periods/*`. Nothing here edits them (S5 reads `schema.fiscalPeriods` from the app) | None |
| All | T-371 (NaN sweep) runs last and will touch these files | T-369 first |

## Invariants (every slice)
- I1. Every write runs through a domain function that calls `authorize()` first (bible §7.1, RULES §1 row 7). A page or
  button hidden from someone is presentation only. The ✗ is proven in the domain AND in the action.
- I2. No new capability. Every control uses an existing CAPABILITY-MATRIX row (listed per slice). The orchestrator adds
  the "used by" notes to the matrix at wrap-up; the lanes never edit it.
- I3. The database enforces balance, period and immutability (RULES §6.3). S4's check does not replace the trigger:
  it only chooses the sentence and refuses before the first write. A mutant proves the trigger still refuses without
  it.
- I4. An override's actor is always the domain function's own `actor`. The form supplies only `reason` and `note`
  (bible row 193, landmine 17).
- I5. The override never reaches a stock flow (Ian (a), 2026-09-30). The override control is never rendered on a stock
  screen.
- I6. Screens reuse the pattern set (RULES §1.2c): `Page`, `PageDescription`, `FilterRow`, `components/ui`, `back()` +
  `?error=` / `?ok=` banners as on `/inventory/production/[id]`. `requirePageAccess` is used for gated routes.
  ✎R Inline forms and `back()` banners only — **no `alert()` / `confirm()`** anywhere. A disclosure is the native
  `<details>` pattern already used at `channel-settlements/page.tsx:271` (`components/ui` has only Button, Card,
  Input and no disclosure primitive); do not build a new one. Every new screen works at 375px and in dark mode.
- I7. User-facing refusals carry no ids and no raw column names (T-343, `errorMessage` step 0). Each refusal is a
  `refuse(raw, userSentence)` or an Outcome with `userReason`.
- I8. Money arithmetic uses `@shareat/core/money`, never `Number` (bible §2.5). New code adds no `Number()`
  comparisons; the existing ones are T-371's.

---

## S0: DEF-550 — void a supplier payment from a screen (+S0·N1, N2, N3, N4)
Added 2026-10-01 by the Opus planner at HEAD `5ac8435`. S0's N-numbers are its own (written `S0·N1`…) and never
mean S1's N1–N3. Also closes DEF-262's `voidPaymentAction` leg (the orphaned export).

**Why now.** Since T-367 S2 (Ian Q4), `voidExpense` refuses a paid bill with *"… Void that payment first, then void
the bill."* (`packages/domain/src/expenses/void.ts:75`). No page renders `voidPaymentAction`
(`apps/erp/src/app/ap/actions.ts:359`), and no page even LISTS an `ap_payment`: `repo/ap.ts` has no list read
(`getApPaymentById :928`, `getAllocationsForPayment :995` only). A paid bill is therefore permanent.

**v1 as requirements (§1.2d).** `ERP-rebuild/src/lib/actions/payment.actions.ts:793` `voidPaymentTransaction`: refuses
an already-voided payment, checks the day lock (admin bypasses it silently), re-opens every allocated expense's
balance, mirrors a commissary payment. The screen is a payment-detail page
(`src/app/financial/payments/[supplierId]/[paymentId]/payment-details-client.tsx:224-246`) with a Void button behind an
`AlertDialog`, **no reason**. GOAL: *a payment that should not stand (bounced cheque, wrong supplier, double entry) is
taken back, and the bills it paid are owed again.* v2 bar: the same, from the bill where the refusal sends you, with a
typed reason, a reversal (never a delete), a dated reversal for a closed month instead of a silent admin bypass, and a
refusal instead of a negative supplier credit.

**Capability:** `record_ap_payment` (store, manager+, staff ✗; CAPABILITY-MATRIX `:105`), which `voidPayment` already
checks at the payment's store (`packages/domain/src/ap/index.ts:1137`). For a payment funded from another store's
account, also `transfer_funds` on the account's store (S0·N4) — the same rule `recordPayment` applies when posting
(`:978-981`). No new capability (I2).

**Where the control lives.** The bill page `apps/erp/src/app/ap/invoices/[id]/page.tsx` — the refusal is shown there,
and every payment names at least one open item (`recordPayment :906-912`), so every posted payment appears on at least
one bill. A payment-detail route is NOT added.

**Domain guards verified at source** (`packages/domain/src/ap/index.ts:1129-1170`, `ledger/reverse-entry.ts:84-217`):
org-scoped read (`repo/ap.ts:928-935`) ✔ · `authorize(record_ap_payment, payment store)` ✔ · status must be `posted` ✔
(sentence wrong for a repeat, see Contract) · posted-with-no-entry is an `internalFault` ✔ · blank reason refused ✔ ·
reversal via `reverseEntry` (mirror lines, party kept, original flipped to `reversed`) ✔ · idempotent on
`reverse:{entryId}` so a double submit posts one reversal and `markApPaymentVoided` runs once ✔ · allocations kept, so
`openItems` / `postedAllocatedFor` (`repo/ap.ts:874-882`, both `ap.status = 'posted'`) re-open the bill ✔.
**Gaps:**
- **S0·N1 — a payment in a closed month cannot be voided, and the refusal is not a sentence.** `voidPayment` passes no
  `reversalDate` (`ap/index.ts:1152-1156`); `reverseEntry` then throws a raw `Error`
  (`ledger/reverse-entry.ts:149-152`, *"journal entry … fiscal period … is closed — supply reversalDate in an open
  period"*), which `errorMessage` shows with `[hidden]` ids and a parameter name. Fix: optional `voidOn`; see Contract.
- **S0·N2 — voiding an overpayment whose credit was already spent drives the supplier's `1240` negative.** An
  overpayment debits `1240` (`ap/index.ts:1043-1056`); a later `recordPayment` may spend it (`creditApplied`,
  `:1016-1025`, which checks the live balance). `voidPayment` reverses the `1240` debit with no check, leaving
  `advancesPositionOf` (`repo/ap.ts:573-590`) below zero: a credit balance on an asset, i.e. the supplier "owes" money
  that was already used up. Fix: refuse (Contract step 5).
- **S0·N3 — the N2 check and the credit draw race.** `recordPayment`'s `creditApplied` check (`ap/index.ts:1016-1025`)
  reads `advancesPositionOf` with no lock; two concurrent draws can already overspend one credit, and S0·N2's check
  would race a draw the same way. Fix: one per-supplier advisory lock taken by both, before the read.
- **S0·N4 — a cross-store-funded payment is voided without the cross-store capability.** `recordPayment` requires
  `transfer_funds` on the money account's store when it differs (`ap/index.ts:978-981`); `voidPayment` checks only
  `record_ap_payment` at the payment's store (`:1137`), so a manager can put money back into another store's account
  that they could not have drawn from. Fix: the same `authorize` in `voidPayment`.
No migration is needed: `ap_payments` already has `voided_by / voided_at / void_reason` and
`ap_payments_void_shape_check` (`packages/db/schema/ap-payments.ts:96-101`).

**BUILDER** (source):
- `packages/db/src/repo/ap.ts`:
  - `paymentsForInvoice(tx, orgId, invoiceId)` returns, for every `ap_payment` (posted AND voided) with an allocation
    to an expense of that invoice: `{ paymentId, storeId, supplierId, businessDate, amount, appliedHere, referenceNo,
    moneyAccountName, status, voidReason, voidedAt, periodOpen, otherBills: { invoiceId, invoiceNo }[] }`.
    `appliedHere` = the sum of its allocations to this invoice's expenses; `otherBills` = the OTHER invoices its
    allocations touch; `periodOpen` = the status of the fiscal period of its journal entry (`journal_entries.period_id`
    → `fiscal_periods.status = 'open'`). Ordered by `businessDate` desc, then id. Org-scoped (`ap.org_id = orgId`).
  - `unallocatedOf(tx, orgId, paymentId)`: `amount − sum(allocations)` as a money string (the overpayment that went
    to `1240`).
- `packages/db/src/repo/advisory-locks.ts`: `lockSupplierCredit(tx, supplierId)` — the two-int4 form,
  `pg_advisory_xact_lock(SUPPLIER_CREDIT_LOCK_NAMESPACE, hashtext(supplierId))`, with
  `SUPPLIER_CREDIT_LOCK_NAMESPACE = 369002` and the key added to the file's key-list comment. (S1's reimbursement lock
  takes a different constant; whichever commits second rebases the comment.)
- `packages/domain/src/ap/index.ts`:
  - `voidPayment`, in this order: read (unchanged) → `authorize(record_ap_payment, payment.storeId)` (unchanged) →
    S0·N4 cross-store `authorize` → status → reason → S0·N3 lock → S0·N2 check → S0·N1 date → `reverseEntry` →
    `markApPaymentVoided` (unchanged). See Contract.
  - `recordPayment`: when `creditApplied > 0`, `lockSupplierCredit(trx, input.supplierId)` immediately before
    `advancesPositionOf` (`:1018`). Nothing else in `recordPayment` changes.
- `apps/erp/src/app/ap/actions.ts` `voidPaymentAction`:
  - reads `paymentId`, `reason`, `voidOn` (optional) and `invoiceId` (optional). The return path is
    `/ap/invoices/{invoiceId}` when `invoiceId` is a UUID, else `/ap/suppliers/{supplierId}` when that is a UUID, else
    `/ap`. Never a URL taken from the form.
  - drops its own `if (!reason) throw new Error(...)` (`:364`) so the domain's `refuse` sentence is the only one (I1, I7).
  - ok banner: *"Payment of ₱{amount} voided — reversed, not deleted. The bills it paid are owed again."* (amount via
    `formatMoney`, I8).
- `apps/erp/src/app/ap/invoices/[id]/page.tsx`:
  - loads `paymentsForInvoice` and, for the payments' distinct stores, which ones the actor can void at — the
    `heldCapabilities` pre-check plus a per-store `authorize` probe, exactly the pattern at
    `customers/[customerId]/page.tsx:117-136` (bible row 262: money controls render only where usable).
  - a **Payments against this bill** section, after *Expenses recorded against this invoice*, shown whenever there is
    at least one payment: one row each — date · amount · applied here · from (money account) · reference · status. A
    payment with `otherBills` says *"Also pays {invoiceNo, …}"* (links to those bills). A voided payment shows
    *"Voided — {reason}"* and no control.
  - for a posted payment the actor can void at: a native `<details>` (I6; the `channel-settlements/page.tsx:271`
    pattern) summarised *"Void this payment"*. Inside: a required *Reason* input; when `periodOpen` is false, a
    required *Reversal date* `type="date"` defaulting to today (`toBusinessDate()`, `@shareat/core/datetime`) with the
    hint *"This payment is in a closed month. The reversal is dated in an open month."*; hidden `paymentId`,
    `supplierId`, `invoiceId`; and a red-outlined submit *"Void payment"*. When `otherBills` is non-empty the panel says
    *"This also re-opens {invoiceNo, …}."* No `alert()` / `confirm()`.
  - the existing *Void reason* form for the bill is unchanged.

**TESTER:** `packages/domain/tests/integration/t369-s0-void-supplier-payment.test.ts` (new) ·
`apps/erp/tests/integration/t369-s0-void-payment-web.test.ts` (new). No change to
`tests/unit/domain-actions-have-callers.test.ts` (`voidPayment` already has a caller; the defect is the action's).

**Contract:**
`voidPayment(tx, actor, { paymentId, reason, voidOn? }) → { entryId }` (shape unchanged; `voidOn` is new and optional).
After the unchanged read and `authorize`:
1. S0·N4: load the money account (`moneyAccountsRepo.getById`); if `account.storeId !== payment.storeId`,
   `authorize(transfer_funds, { storeId: account.storeId })`.
2. Status: `voided` → refuse *"This payment has already been voided."*; any other non-`posted` → the existing sentence.
3. Reason: unchanged (*"Say why this payment is being voided."*).
4. S0·N3: `lockSupplierCredit(trx, payment.supplierId)`.
5. S0·N2: `u = unallocatedOf(payment)`; if `u > 0` and `advancesPositionOf(supplier) < u` (compare via
   `@shareat/core/money`), refuse *"₱{short} of this payment's overpayment has already been used to pay later bills.
   Void those payments first."* where `short = u − position` (never negative), `formatMoney`.
6. S0·N1: read the original entry's period (`journalRepo.findEntryById` → `findPeriodById`).
   - Open → `voidOn` is ignored and the reversal keeps today's behaviour (the original's own date, no prefix).
   - Not open, `voidOn` absent → refuse *"This payment is in a closed month. Pick a date in an open month for the
     reversal."*
   - Not open, `voidOn` given → `journalRepo.findPeriodForDate(tx, orgId, voidOn)` must be `open`, else refuse
     *"That date is not in an open month. Pick a date in an open month for the reversal."*; then pass
     `reversalDate: voidOn` (the memo gets `reverseEntry`'s own `[prior period]` prefix). `voidOn` is parsed with
     `parseBusinessDate`; a malformed date is refused *"Pick a valid date for the reversal."*
7. `reverseEntry` and `markApPaymentVoided` exactly as today.
Every refusal is `refuse(raw, sentence)` (I7) and writes nothing. Posting pattern: the T-106 reversal of
`ap_payment.simple` / `.overpayment` (POSTING-PATTERNS `:455-480`, `:1242-1262`) — mirror lines, same party, same store.

**Tests** (real Postgres; each red leg asserts the target and is shown red on HEAD or against its named mutant):
- T1 (positive control for every refusal below): a ₱3,000 bill paid in full in an open month; the manager voids with
  reason *"Bounced cheque"*. Exactly one reversal entry; per account the original + reversal net to 0.00 (2110 with
  party = supplier, the cash account); the original entry is `reversed`; the payment is `voided` with `voided_by` =
  the actor and the reason; `openItems` shows the bill owed ₱3,000 again; THEN `voidInvoice` on that bill succeeds
  (DEF-550 end to end — on HEAD only reachable by calling the domain).
- T2 (✗): a staff member at the store → `AuthorizationError`; nothing written. Mutant: delete the `authorize` at
  `:1137` → posts → red.
- T3: a blank / whitespace reason → refused with the domain sentence; nothing written. Mutant: remove the domain check
  (the action's own check is gone after the build) → red.
- T4: void twice → the second is refused *"This payment has already been voided."*; still exactly one reversal.
  Red on HEAD (HEAD says *"This payment is voided, not posted."*).
- T5 (S0·N1): a payment dated in a period that is then closed. (a) No `voidOn` → refused with the closed-month sentence;
  the sentence has no UUID and no `reversalDate`; nothing written. Red on HEAD (raw `reverseEntry` text). (b) `voidOn`
  in an open month → one reversal dated `voidOn`, memo starts `[prior period] `, payment `voided`. (c) `voidOn` in a
  closed month → refused with the second sentence; nothing written. Mutant: drop `reversalDate: voidOn` → (b) red.
- T6 (S0·N2): bill A ₱1,000 paid with ₱1,500 (₱500 to 1240); bill B ₱500 paid entirely with `creditApplied` 500.
  Voiding the first payment → refused, *"₱500.00 of this payment's overpayment…"*; `advancesPositionOf` stays 0.00.
  Red on HEAD (the void posts and the position is −500.00). Positive control: void the B payment first, then the A
  payment → both succeed, position 0.00, both bills owed again. Mutant: remove the check → red.
- T7 (S0·N3): two connections, the gated harness of `t366-s1-cash-custody-locks.test.ts`. 1240 holds ₱500 from
  payment P. A voids P while B records a payment with `creditApplied` 500. Exactly one succeeds; the other gets its
  refusal (N2's, or `recordPayment`'s *"holds only ₱0.00 of return credit"*); the position is never below 0.00; the
  second is observed waiting on an `advisory` lock. Mutant: remove the lock from either function → red.
- T7b (S0·N3, the existing race): two concurrent `recordPayment`s each drawing `creditApplied` 500 from one ₱500 credit
  → exactly one posts. Red on HEAD (both post, position −500.00).
- T8 (S0·N4): an admin pays a Lipa bill from Malvar's safe. A Lipa manager without `transfer_funds` at Malvar voids it
  → `AuthorizationError`, nothing written. Positive control: the admin voids it → posts. Mutant: remove the
  cross-store `authorize` → red.
- T9 (web, render): on a paid bill, a manager at the bill's store sees *Payments against this bill* with one row and a
  *Void this payment* `<details>`; a staff member and a manager of ANOTHER store see the row and no `<details>`; a
  voided payment shows *"Voided — {reason}"* and no control; a payment that also pays bill C shows *"Also pays …"* and,
  in the panel, *"This also re-opens …"*; a closed-month payment's panel has the required date input. Red on HEAD
  (no section).
- T10 (web, action): submitting the form returns to `/ap/invoices/{id}` with the ok banner; a refusal (T6's case)
  returns there with the sentence and no UUID in the URL; a non-UUID `invoiceId` returns to `/ap/suppliers/{id}`. A
  grep of the touched app files finds no `alert(` / `confirm(`.

**Smoke (9008, `shareat_test_setup`; 2027-02 is open there, per T-366):**
1. As a manager, record and verify a supplier bill dated 2027-02-05, record its credit expense, and pay it in full
   from the store's cash on 2027-02-06.
2. Try *Void* on the bill: the banner says *"… Void that payment first, then void the bill."*
3. On the same bill, open *Payments against this bill → Void this payment*, type a reason, submit: the ok banner shows;
   the row reads *Voided — {reason}*; *Recording capacity* is unchanged and the supplier's open items show the bill
   owed again.
4. Void the bill: it now succeeds.
5. Sign in as staff: the payment row is visible with no *Void this payment* control.
6. Repeat step 3's page at 375px wide and in dark mode (the `<details>` open). Screenshots at each step.

---

## S1: DEF-198 — staff reimbursement payout screen (+N1, N2, N3)
**Capability:** `record_ap_payment` (store, manager+, staff ✗), which `reimbursement.ts:43` already checks. For a
cross-store draw, `transfer_funds` on the account's store.
**BUILDER** (source):
- `packages/db/src/repo/expenses.ts`:
  - `reimbursablePayablesAtStore(tx, orgId, storeId)` returns `{ employeeId, displayName, outstanding }[]`,
    grouped by `party_id`, over lines on 2130 at that store (`jl.store_id`), `je.status <> 'draft'`, outstanding
    > 0, joined to `persons`, ordered by outstanding descending;
  - `reimbursablePayableOf` gains an optional `storeId` filter;
- ✎R `packages/db/src/repo/advisory-locks.ts` (T-366 S1's file; **S1 starts after T-366 S1 commits**):
  `lockReimbursementPayee(tx, employeeId)` using T-366's two-int4 form (`pg_advisory_xact_lock(<new namespace
  constant>, hashtext(employeeId))`), a new named namespace constant, and the key added to that file's key-list
  comment. `packages/db/src/index.ts` already exports the module once T-366 lands; touch it only if it does not.
- `packages/db/src/repo/journal.ts` is NOT edited: the replay lookup uses the existing
  `journalRepo.findEntryByIdempotencyKey` (`journal.ts:90`), the same read `postEntry` does first.
- `packages/domain/src/expenses/reimbursement.ts`, in this order after `authorize`:
  1. load the account. ✎R Refuse, in the domain (not only the picker), an inactive account (*"That money account is
     retired."*) or a staff-float account (`custodian = 'staff'`: *"Pay from a store account, not a staff float."*).
     If `account.storeId !== input.storeId`, `authorize(transfer_funds, { storeId: account.storeId })` (N1);
  2. `lockReimbursementPayee` (N3);
  3. ✎R compute the deterministic key `reimbursement:{employeeId}:payout:{input.payoutId}` (`payoutId` = a new
     required input minted server-side at page render, a hidden field) and look up an existing entry with that key.
     If one exists, return it (`{ entryId, outstanding, created: false }`) **before** the cap check — otherwise a
     replay after commit sees outstanding 0 and is refused;
  4. read outstanding **at `input.storeId`** (N2) and refuse an overpayment against it;
  5. post with that key. A double submit of one form posts once.
- `apps/erp/src/app/expenses/reimbursements/page.tsx` (new):
  - `requirePageAccess('/expenses/reimbursements')`, a store `FilterRow` (stores where the actor holds
    `record_ap_payment`), and the table *Person · Owed · Pay*;
  - Pay opens an inline form: amount (default = owed), date (default today), money account (the store's accounts,
    active, not staff floats), memo;
  - empty state: *"Nobody is owed a reimbursement at this store."*
- `apps/erp/src/app/expenses/reimbursements/actions.ts` (new): `payReimbursementAction`. It uses `requireActor`,
  calls the domain, and `back()` with ok *"Paid ₱{amount} to {name}. Still owed: ₱{outstanding}."* plus the
  `checkDraw` warning if any, or with the error.
- `apps/erp/src/app/expenses/reimbursements/lib.ts` (new): the loaders.
- `apps/erp/src/lib/route-capability.ts`: `'/expenses/reimbursements': 'record_ap_payment'` (it names colleagues'
  money, like `/payroll`).
- `apps/erp/src/components/nav.tsx`: *Reimbursements* under Expenses.

**TESTER:** `packages/domain/tests/integration/t369-s1-reimbursement-payout.test.ts` (new) ·
`apps/erp/tests/integration/t369-s1-reimbursement-web.test.ts` (new) · `tests/unit/domain-actions-have-callers.test.ts`
(delete the `payReimbursement` EXEMPT row).

**Contract:** `payReimbursement(tx, actor, { storeId, employeeId, amount, fromMoneyAccountId, on, payoutId, memo? })`
returns `{ entryId, outstanding, created, warning? }`, where `outstanding` is at that store. Posting pattern
`reimbursement.payout` (POSTING-PATTERNS `:190-201`): DR 2130 (employee) / CR the money account.

**Tests** (real Postgres; each red leg asserts the target and is shown red on HEAD):
- T1: owed ₱650 at Lipa; the manager pays 650 from Lipa cash. Exactly one entry, DR 2130 650 party=employee
  store=Lipa, CR 1110 650; outstanding 0.00. Positive control for every refusal below.
- T2 (N2): owed ₱650 at Lipa and ₱0 at Malvar. Paying 100 with `storeId = Malvar` is refused (*"This employee has no
  unpaid reimbursement at this store."*) and no entry is written. Mutant: drop the store filter → posts → red.
- T3 (N1): a Lipa manager without `transfer_funds` at Malvar pays from Malvar's safe → `AuthorizationError`, nothing
  posted. Positive control: an admin (who holds it at both) → posts. Mutant: remove the cross-store `authorize` →
  red.
- T4 (N3): two connections, gated harness as in T-366 S1. Owed 1,000; A pays 700 and B pays 600. Exactly one
  succeeds, the other gets the overpayment refusal, and 2130 at Lipa is 300 or 400, never −300. B is observed
  waiting on `advisory`. Mutant: remove the lock → red.
- T5: owed 650; pay 650 with `payoutId` P, commit; replay P → the SAME `entryId`, `created: false`, no refusal, one
  entry. Mutants: (i) a random key → two entries or a refusal → red; (ii) the replay lookup moved after the cap check
  → the replay is refused ("no unpaid reimbursement") → red.
- T5b ✎R: an inactive account and a staff-float account are each refused by the DOMAIN with its sentence; nothing
  posted. Positive control: T1.
- T6 (✗): a staff member at Lipa → `AuthorizationError`; the web action shows the refusal banner; no entry. Positive
  control: T1.
- T7 (web): a staff GET of `/expenses/reimbursements` gets the page-access refusal; a manager sees the owed row.
  `route-capability-coverage` stays green.

**Smoke (9008, `shareat_test_setup`; 2027-02 is open there, per T-366):**
1. As a manager, create an expense at a store dated 2027-02-05, paid ₱650 *reimbursable* by a named staff member;
   approve it.
2. Open *Expenses → Reimbursements*: the person is listed as owed ₱650.
3. Pay ₱650 dated 2027-02-06 from the store's cash: the banner shows ₱0 still owed and the row disappears.
4. Sign in as staff: the nav has no Reimbursements link, and the URL is refused.
5. ✎R Repeat step 2–3's page at 375px wide and in dark mode.

Screenshots at each step.

---

## S2: DEF-198 — view an attached photo
**Capability:** `PURPOSE_CAPABILITY[file.purpose]` (`files/index.ts:70`, checked inside `readFileUrl`). No new row.
**BUILDER:**
- `apps/erp/src/app/files/[fileId]/route.ts` (new): `GET`, `dynamic = 'force-dynamic'`. It calls
  `requireActor`, then `readFileUrl(null, actor, { fileId })`, then responds 302 to the URL with
  `Cache-Control: private, no-store`.
  - Not found, another org, and `AuthorizationError` all get one uniform 404 page reading *"This photo isn't
    available to you."* The uniform sentence reflects T-364 Q1 (a): no existence leak.
  - ✎R ONLY not-found (another org included) and `AuthorizationError` map to that 404. Anything else (an internal
    fault, the storage driver failing) → 500 with the generic fallback sentence, logged without the URL.
  - A non-uuid `fileId` gets the same 404, without touching the DB.
  - The URL and fileId are never logged.
- `apps/erp/src/app/ap/invoices/[id]/page.tsx:125-128`: the *"photo attached"* line gains *View photo* (`<a
  href="/files/{id}" target="_blank" rel="noopener">`).
- `apps/erp/src/app/inventory/deliveries/[id]/page.tsx`: *View photo* when the delivery has `proofFileId`
  (`repo/deliveries.ts:237,261` already selects it).
- `apps/erp/src/app/customers/[customerId]/page.tsx`: *View photo* on a collection row with `receiptFileId`
  (`repo/ar.ts:550,602`).

**TESTER:** `apps/erp/tests/integration/t369-s2-file-view-web.test.ts` (new; it installs the in-memory driver, as
`files.test.ts` does) · `tests/unit/domain-actions-have-callers.test.ts` (delete the `readFileUrl` row).

**Tests:**
- T1: a manager at the invoice's store → 302, `Location` starts `memory://orgs/{org}/stores/{store}/receipt_photo/`,
  `Cache-Control` contains `no-store`.
- T2 (✗): a staff member without `record_supplier_invoice` at that store → 404 with the uniform sentence and no
  `Location`. Positive control: T1. Mutant: return `readFileUrl`'s error text → the body contains the fileId → red.
- T3: another org's file id, and a random uuid → the same 404 body byte-for-byte as T2.
- T4: a manager at ANOTHER store → 404.
- T5 ✎R: a driver whose `signedUrl` throws → 500, not 404, and the body carries no path. Mutant: a catch-all to 404
  → red.

**Smoke:**
1. Upload a supplier invoice with a photo on `/ap`, then open it. *View photo* opens the image if
   `FIREBASE_STORAGE_BUCKET` is set.
2. With the in-memory driver, the Network tab shows the 302 and its `Location`.
3. As staff without the grant: the 404 sentence.

---

## S3: DEF-479 — edit or withdraw an unverified sales day (+ DEF-291's sales-day leg)
**Capabilities:** edit an `open` day needs `submit_sales_day`; edit a `submitted` day needs `verify_sales_day` (once
submitted it is the verifier's); void an unverified day needs `void_sales_day` (manager+, staff ✗). All exist
(CAPABILITY-MATRIX `:32-34`).
**Rulings (planner):**
- R1. Edit changes figures, channels and tenders, never the store or the date: the date is what the create-block and
  the unique index key on.
- R2. Edit never consults the create-block (`create.ts:9-20`).
- R3. Voiding an unverified day writes NO journal entry and requires a reason. `findOldestUnverifiedBefore` already
  excludes `voided`, so the block lifts. ✎R **Withdraw is refused while something else hangs off the day**, with a
  plain sentence naming it and nothing reversed automatically (the dependent is undone first, on its own screen):
  - a live POS usage pull (`pos_usage_pulls` for the day, `status <> 'void'`; `pos/usage-pull.ts:138`,
    `repo/pos-mapping.ts:284`): *"This day has a POS usage pull. Void the pull first."*;
  - `order_wastages` rows with this `sales_day_id` (`schema/order-wastage.ts:92`): *"Wastage is recorded against this
    day. Void it first."*;
  - `remittance_allocations` for this store and `business_date` (or this `sales_day_id`) on a `posted` remittance
    (`schema/remittance.ts:157-167`): *"Cash handed over has been counted against this day. Reverse that handover
    first."*
- R4. Edit does not change status: a submitted day stays submitted, and the verifier sees the edited figures.
- R5 ✎R. **Edit and verify serialise on the day row.** `editSalesDay` and `runVerify` (`verify.ts:69`) both read the
  day with `SELECT … FOR UPDATE` (a new `salesDaysRepo.getByIdForUpdate`) before any other read, and the void of an
  unverified day does the same. Verify can therefore never post figures an edit is half-way through changing.

**BUILDER:**
- `packages/domain/src/sales-days/edit.ts` (new): `editSalesDay(tx, actor, { salesDayId, …the create figures,
  channels, tenders })`. It uses the same `money()` parsing as create, `updateDraft`, and `writeChannels` /
  `writeTenders` imported from `create.ts` (replace semantics via `replaceChannels` / `replaceTenders`).
  - A `verified` or `voided` day is refused: *"Only an unverified sales day can be edited — this one is {status}."*
  - ⛔ `create.ts` is NOT edited (T-370 owns `:44`).
- `packages/domain/src/sales-days/verify.ts`: `voidSalesDay` accepts `open`/`submitted` and marks them voided with no
  reversal. Its `:188-193` refusal becomes *"This sales day is already voided."* for `voided`. The verified branch is
  unchanged.
- `packages/domain/src/sales-days/index.ts`: export `editSalesDay`.
- `packages/db/src/repo/sales-days.ts`: `markUnverifiedVoided(tx, orgId, id, { voidedBy, voidReason })` with the
  predicate `status in ('open','submitted')` and a zero-rows `recordGone`; ✎R `getByIdForUpdate(tx, orgId, id)`;
  `withdrawBlockers(tx, orgId, day)` returning which of R3's three dependents exist (one query each, read-only).
- ✎R `verify.ts`'s `runVerify` switches its first read to `getByIdForUpdate` (R5); nothing else in verify changes.
- `apps/erp/src/app/sales-days/SalesDayForm.tsx` (new): the form body extracted from `new/page.tsx`, taking
  `defaults` and `action`.
- `apps/erp/src/app/sales-days/new/page.tsx`: uses `SalesDayForm`. Wallets come from the new store-scoped
  `listStoreMoneyAccounts(orgId, storeId)` (DEF-291; replaces `:35`).
- `apps/erp/src/app/sales-days/[id]/edit/page.tsx` (new): `SalesDayForm` prefilled from the day, its channels and
  its tenders.
- `apps/erp/src/app/sales-days/actions.ts`:
  - `editSalesDayAction`, whose FormData parsing is shared with create (one helper, not two copies);
  - `voidSalesDayAction` unchanged in signature.
- `apps/erp/src/app/sales-days/[id]/page.tsx`:
  - *Edit* link for `open`/`submitted`;
  - the void form (`:254`) is shown for `open`/`submitted`/`verified`, worded *"Withdraw this unverified day"* vs
    *"Void (reverses the posting)"*;
  - if Q1 is unanswered or (b), the draft wording adds *"The date stays used — a new day cannot be entered for {date}."*
- `apps/erp/src/app/sales-days/lib.ts`: `listStoreMoneyAccounts`; drop the `listMoneyAccountsForPicker` re-export.
- `apps/erp/src/app/expenses/lib.ts`: delete `listMoneyAccountsForPicker` (`:175-195`), which has no remaining
  consumer.

**TESTER:** `packages/domain/tests/integration/t369-s3-sales-day-edit-void.test.ts` (new) ·
`apps/erp/tests/integration/t369-s3-sales-day-web.test.ts` (new).

**Tests:**
- T1 (the Lipa shape): a day with total 1,000 and channels allocating 500. Verify is refused (today's routing
  refusal). Edit the channels to 1,000, then verify → posts one entry. Red on HEAD: `editSalesDay` is not exported.
- T2: edit keeps the status (`open` stays open, `submitted` stays submitted); `updatedAt` moves.
- T3 (✗): staff edits a `submitted` day → `AuthorizationError`, figures unchanged. Positive control: a manager edits
  it. Mutant: check `submit_sales_day` for both statuses → staff succeeds → red.
- T4: edit a `verified` day → refused with the sentence; the journal is untouched.
- T5: void an `open` day as a manager → status `voided`, reason stored, **zero** journal entries for the day. A newer
  day at that store can now be created by staff (the block has lifted). Positive control: before the void, staff
  creating the newer day gets `SalesDayBlockedError`.
- T6 (✗): staff voids an open day → `AuthorizationError`; the day stays open.
- T7: void a `verified` day → unchanged behaviour (one reversal); the existing void tests stay green.
- T8: edit with a channel from another store → the existing `writeChannels` refusal; nothing is changed (all-or-
  nothing in one tx). Mutant: write the header before validating channels → the header changed → red.
- T10 ✎R (R5 race, two connections, gated harness as T-366 S1): A holds `editSalesDay` open mid-transaction
  (channels replaced, not committed); B runs `verifySalesDay`. B is observed waiting (`wait_event_type = 'Lock'`,
  `transactionid`/`tuple`), then posts from A's committed figures. Reverse order: A verifies, B edits → B waits, then
  is refused (*verified*). Mutant: plain `getById` in either → B never waits / posts stale figures → red.
- T11 ✎R (R3, one leg per dependent): an open day with (i) a live usage pull, (ii) an `order_wastages` row, (iii) a
  posted remittance allocation on its date → withdraw refused with that dependent's sentence; the day stays open.
  Positive controls: a `void` pull and a `reversed` remittance do not block. Mutant: drop each check → red.
- T9 (web, DEF-291): `/sales-days/new?store=Lipa` renders only Lipa's wallets. The server loader's returned set
  contains no other store's account (asserted on the loader, not only the markup).

**Smoke:**
1. At a store, create a day for 2027-02-10 with total ₱1,000 and a channel of ₱500. Verify is refused.
2. *Edit*: set the channel to ₱1,000, save, verify → verified.
3. Create 2027-02-11 as staff, then sign in as a manager and *Withdraw* it with a reason → voided. Staff can now
   create 2027-02-12.
4. As staff, the Withdraw form is absent and a forged POST is refused.
5. ✎R The edit page at 375px and in dark mode.

After merge, the orchestrator uses the new Edit on the kept dev draft (Lipa 2026-09-28, Ian's reproduction) and tells
Ian. The lane does not touch the dev DB.

---

## S4: DEF-302 (Ian (a)) — refuse stock in a closed month, in plain words, before any write
**Ruling:** no override for stock, ever (I5). The trigger `0145` is unchanged and stays the enforcement (I3).
**BUILDER:**
- `packages/domain/src/stock/period-guard.ts` (new): `closedStockPeriodSentence(tx, orgId, date, doing)` returns
  `string | null`. It reads `journalRepo.findPeriodForDate`.
  - For a period with status `closed` or `locked`, it returns *"{Month YYYY} is closed. Stock can't be {doing} on
    {d MMM YYYY} — a closed month's stock stays as it was, and the closed-month override doesn't change that. Use a
    date in an open month."*
  - For `locked`, the word is "locked".
  - Month and date via `humanDate`.
  - No period, or `open` → `null` (unchanged behaviour).
- **S4a** (parallel-safe):
  - `packages/domain/src/production/index.ts`: at the top of `postProduction`, `editPostedProduction` and
    `voidProduction`, after `authorize`, check `record.producedOn` with doing = "produced" / "changed" / "voided".
    Return `{ ok: false, reason: sentence }` before any read-for-write.
  - `packages/domain/src/trade/returns.ts`: `recordCustomerReturn` checks `returnedOn` (doing = "returned") before
    dispatching to either branch.
  - ✎R (DEF-528; Ian's (a) covers every stock-plus-ledger flow, not only the three named):
    - `packages/domain/src/deliveries/receive.ts`: `receiveDelivery` (`:83`) checks `deliveredOn` (doing =
      "received") before its first movement; `postReceiptValue` (`:182`) posts in the same tx;
    - `packages/domain/src/stock/usage.ts`: `postUsageRecord` (`:68`) checks `usedOn` (doing = "used" / "wasted"
      by kind) before its first movement (`:117`; `postWastage`/`postConsumption` at `:156`); `voidUsageRecord`
      (`:203`) checks `voidedOn` (doing = "voided");
    - `packages/domain/src/stock/supplier-returns.ts`: `recordReturn` (`:77`) moves stock at `now` (`:164`) but posts
      at `returnedOn` (`:228`) — it checks BOTH today's date and `returnedOn` (doing = "returned"); `voidReturn`
      (`:268`, movement at `now` `:313`) checks today's date.
- **S4b** (after T-372 S3): `packages/domain/src/trade/index.ts`:
  - `receiveTradeOrder` checks `receivedOn` BEFORE the line loop, because `setLineReceivedQuantity` (`:893`) writes
    inside it; doing = "received"; throw `refuse(raw, sentence)`;
  - `dispatchTradeOrder` checks `order.orderDate` before its first write; doing = "dispatched".

**TESTER:** `packages/domain/tests/integration/t369-s4a-stock-closed-month.test.ts` ·
`packages/domain/tests/integration/t369-s4b-trade-closed-month.test.ts` (new).

**Tests** (a period closed via the repo, as in `stock-movements-period-override.test.ts`):
- T1 production post dated in a closed month:
  - `{ok:false}` with the reason matching `/^September 2026 is closed\. Stock can't be produced on/`, and no
    `/cannot move stock/`;
  - zero `stock_movements`, zero entries, and the record stays `draft`.
  - Red on HEAD: the reason is the trigger text or a thrown P0001.
  - Positive control: the same record in an open month posts.
  - Mutant: remove the guard call → the trigger still refuses (P0001 *cannot move stock*), which proves I3 → the
    leg asserting the sentence goes red.
- T2 production void and edit of a record whose `producedOn` is now closed (post while open, then close) → the
  sentence; the record stays `posted`; no reversal.
- T3 `recordCustomerReturn`, internal and external, `returnedOn` closed → the sentence; no movement, no entry, no
  `customer_returns` row.
- T4 (S4b) `receiveTradeOrder` with `receivedOn` closed → the `refuse` user sentence via `errorMessage`; no
  `trade_order_lines.received_quantity` changed, no delivery row, no movement. Positive control: an open date.
- T5 (S4b) dispatch of an order whose `orderDate` is closed → the sentence; the order stays not dispatched.
- T6 (I5): an admin holding `override_period_lock` gets the SAME sentence on T1/T4 (there is no override input on
  these functions; asserted by the sentence and by zero `period_overrides` rows).
- T7: `locked` → the same sentence with "locked".
- T8 ✎R (DEF-528, one leg each, same shape as T1 — sentence, zero movements, zero entries, positive control on an
  open date, mutant = remove that call): `receiveDelivery` (`deliveredOn` closed); `postUsageRecord` wastage AND
  consumption (`usedOn` closed); `voidUsageRecord`; `recordReturn` with `returnedOn` closed while today is open,
  and with today closed while `returnedOn` is open (both refused); `voidReturn` with today closed.
- The existing `stock-movements-period-override.test.ts` stays green, unchanged.

**Smoke:**
1. `/inventory/production`: a draft dated 2026-09-15 → Post → the banner reads "September 2026 is closed…".
2. The same for a customer return dated 2026-09-15.
3. (S4b) Receive a commissary order with the date 2026-09-15.
4. ✎R A supplier delivery received on 2026-09-15, and a wastage record dated 2026-09-15.

Screenshots.

---

## S5: DEF-314 — post one late entry into a closed month
**Capability:** `override_period_lock` (org, admin+; the adminless-manager fallback per row 196), authorised inside
`postEntry:189`. The screen never decides it. The control shows only to holders (`heldCapabilities`).
**Scope:** per Q3. Default (a): the reimbursement payout (S5a) and expense approval (S5b).
**BUILDER S5a** (after S1):
- `apps/erp/src/lib/period-override.ts` (new):
  - `closedMonths(orgId)`: `schema.fiscalPeriods` rows with status `closed`, as `{ startsOn, endsOn, label }`.
    `locked` is excluded: it cannot be overridden;
  - `readPeriodOverride(fd)`: returns `{ reason, note } | undefined`, only when the confirm box is on and `reason`
    is in `PERIOD_OVERRIDE_REASONS`; `note` is required when `reason = 'other'`.
- `apps/erp/src/components/ClosedMonthOverride.tsx` (new, client): given `closedMonths` and the date field's name,
  it appears only when the chosen date falls in a closed month. ✎R It is a native `<details>` panel in the
  `channel-settlements/page.tsx:271` style, built from `components/ui` `Input`/`Button` — no new disclosure primitive,
  no `confirm()`; the confirm is an inline checkbox the server re-reads.
  - It reads *"{Month} is closed. You can post this one entry into it. It will be recorded against your name with
    the reason below."*
  - It has a reason select with plain labels (Late supplier bill · Correction required by BIR/regulator · Fixing a
    mistake · Other), a note, and a confirm checkbox.
  - Non-holders are never passed the component.
- `packages/domain/src/expenses/reimbursement.ts`: optional `periodOverride?: { reason, note? }` input, forwarded
  as `{ actor, reason, note }` to `postEntry` (I4).
- The reimbursement page and action from S1: mount the control; pass `readPeriodOverride(fd)`.

**BUILDER S5b** (after T-367 S2/S5): `packages/domain/src/expenses/approve.ts` (the same optional input, forwarded at
`:201`) · `apps/erp/src/app/expenses/actions.ts` (the approve action) · `apps/erp/src/app/expenses/[id]/page.tsx`
(mount the control on the approve form).
**TESTER:** `packages/domain/tests/integration/t369-s5-closed-month-override.test.ts` ·
`apps/erp/tests/integration/t369-s5-override-web.test.ts` · `tests/unit/t369-override-not-on-stock-screens.test.ts`
(new).

**Tests:**
- T1: an admin pays a reimbursement dated in a closed month with `{ reason: 'data_entry_error', note }` → posted;
  one `period_overrides` row with actor = the admin, the reason, the note, and `period_status_at_post = 'closed'`.
  Red on HEAD: the input is ignored → closed-period error.
- T2 (✗): a manager in an org WITH an admin sends the same fields → `AuthorizationError`; no entry, no override row.
  Positive control: T1. Mutant: authorize `record_ap_payment` instead of forwarding → red.
- T3: no override fields and a closed month → refused; no override row. The web banner says the month is closed
  (no id).
- T4: a `locked` period with the override → refused with the locked sentence; no row.
- T5: an open month WITH override fields → the web action does not forward them: `readPeriodOverride` plus a
  server-side date check (the date's period is `closed`, else drop the override), so no audit noise. Mutant:
  forward unconditionally → a row with `open` → red.
- T6 (web): an invalid reason string → the override is dropped → closed-month refusal. Holders see the control in the
  rendered HTML; a manager does not.
- T7 (S5b): the same T1/T2 on `approveExpense`.
- T8 (unit, I5): `ClosedMonthOverride` is imported only by an allowlist (`expenses/reimbursements/page.tsx`,
  `expenses/[id]/page.tsx`). Any import under `inventory/`, `commissary/` or `trade` fails.

**Smoke:**
1. As admin, pay a reimbursement dated 2026-09-15 (closed): the panel appears. Choose *Fixing a mistake*, add a note,
   confirm → posted.
2. `select * from period_overrides` shows the row.
3. As a manager: no panel; the same date gives *"September 2026 is closed…"*.
4. ✎R The open panel at 375px and in dark mode.

---

## S6: DEF-291 — money-account lists offer what the person can use
**Capability:** `transfer_funds` (store, manager+).
**BUILDER S6a:**
- `apps/erp/src/app/money-transfers/lib.ts`: `listTransferableAccounts(actor)` returns accounts only at stores where
  the actor holds `transfer_funds`. Use the per-store authorize loop of `channel-settlements/page.tsx:73-86`, once
  per distinct store.
- `apps/erp/src/app/money-transfers/page.tsx`: the From/To selects use it. The balances list keeps its current
  read gate (`view_financial_reports`).
- If no store qualifies: *"You can't move money at any store."*

**BUILDER S6b** (only if Q2 = (a), after T-367):
- `lib/money-lines/load.ts`: add `otherStoreSources` for stores where the actor holds `transfer_funds`; the signature
  gains `actor`.
- `components/money/MoneyLines.tsx`: a collapsed *"Another branch — needs permission to move that branch's money"*
  group (T-266 §6.4).
- The callers: `expenses/new/page.tsx`, `expenses/actions.ts`, `ap/invoices/[id]/page.tsx`.

**TESTER:** `apps/erp/tests/integration/t369-s6-account-lists-web.test.ts` (new).

**Tests:**
- T1: a Lipa-only manager → Malvar's accounts are absent from the loader's result. Red on HEAD: present.
- T2: an admin → both stores.
- T3 (✗ unchanged): a forged POST naming Malvar by the Lipa manager is still refused by the domain (`:135`).
- Mutant: skip the loop → T1 red.
- (S6b) T4: the other-store group holds only stores with the grant; an approval from it posts with `transfer_funds`
  checked (`approve.ts:127`).

**Smoke:** as a one-store manager, open `/money-transfers`: the selects list that store only. As admin: all stores.

---

## S7 (only if Q1 = (a)): a voided day frees its date
**BUILDER:**
- A migration at the next free index: drop `sales_days_org_id_store_id_business_date_unique` and recreate it
  `WHERE status <> 'voided'`. Update `meta/_journal.json`, `schema/sales-days.ts` (the index `.where(...)`), and the
  trigger/RLS registries if the guard requires them. Hand-authored per ADR-012 §5.
- `repo/sales-days.ts`: `findByBusinessDate` filters `status <> 'voided'`.

**TESTER:** `packages/db/tests/integration/t369-s7-migration.test.ts` and a domain leg:
- void → create the same date → succeeds;
- two live days for one date → unique violation;
- mutant: the index without the predicate → red.

## S8: DEF-551 — a cross-store draw credits the safe that paid, and records what one store owes the other
Added 2026-10-01 by the Opus planner at HEAD `5b8aeb7`, on Ian's ruling (a) (Ruling log). S8's N-numbers are its own
(`S8·N1`…).

**The defect.** Three writers allow a store's debt to be paid from ANOTHER store's money account (each authorizes
`transfer_funds` on the account's store) but post the credit leg at the OWING store:
- `payReimbursement` — `packages/domain/src/expenses/reimbursement.ts:204-206` (`storeId: input.storeId`);
- `approveExpense` — `packages/domain/src/expenses/approve.ts:225` (every routed line at `expense.storeId`,
  including the money-account credits);
- `recordPayment` (AP) — `packages/domain/src/ap/index.ts:1076-1079` (the `cashPortion` credit at `input.storeId`;
  the cross-store `authorize` is `:997-999`).

`balanceOf()` (`packages/db/src/repo/money-accounts.ts:281-310`) reads a non-1140 account as
`journal_lines.store_id = account.storeId`. So a Lipa debt paid from Malvar's safe leaves Malvar's safe unchanged
and drives Lipa's cash negative, and `checkDraw` (which reads the PAYING account) approves a draw that never shows.

**Census of every other money-account writer, verified at source.** None needs a change in S8:
- `createMoneyTransfer` (`money-transfers/index.ts:193-246`) is already right: each leg sits at its own account's
  store, plus the 1250/2150 pair when `crossStore`.
- These REFUSE another store's account, so no cross-store credit can arise: `releaseCashRequest`
  (`cash-requests/index.ts:219`), `payLiability` (`liabilities/index.ts:190`), `recordContribution` /
  `recordDrawing` / `repayFromOwner` (`owners/index.ts:154, 304, 385`), `postPayRun` (`payroll/index.ts:411`),
  `postSeparation` (`payroll/separation.ts:145`), `post13thMonthRun` (`payroll/thirteenth-month.ts:158`), and the
  channel destination (`channel-settlements/index.ts:696`).
- `voidPayment` (`ap/index.ts:1148-1200`) uses `reverseEntry`, which mirrors every original line. After S8 it reverses
  the 1250/2150 pair too, with no code change (S8·T6 proves it).
- ⚠️ **S8·N1, a new DEF for the orchestrator.** `recordCollection` (`ar/index.ts:267`), `disburseLoan`
  (`loans/index.ts:117`) and `recordLoanPayment` (`loans/index.ts:192`) have NO account-store check at all: no
  refusal and no `transfer_funds`. Each posts the money leg at the document's store (`ar :371`, `loans :140, :252`).
  They have the same shape as DEF-551 and they also lack the N1 gate. This is out of S8 (see Q5).

**v1 as requirements (§1.2d).** v1 posts the due-from/due-to pair in one place only: the cross-store loan deduction
(`ERP-rebuild/src/lib/financial/channel-settlement/cross-store-loan.legs.ts`), which v2 ports at
`channel-settlements/index.ts:572-596`. v1's expense and supplier payments had no inter-store legs. The goal: the
money that left a safe shows as leaving THAT safe, and the store it was spent for owes the store that paid. v2 beats
v1 by putting both facts in the same single entry.

**Reused convention, not a new one.** Ian's ruling has exactly the shape of the channel-settlement loan deduction
(*"the PAYING store gave up cash that was not its debt → it is owed (DR 1250) … the OWNING store … now owes the paying
store instead (CR 2150)"*, `channel-settlements/index.ts:572-576`). Both money-transfers and commissary use the same
account pair: **1250 Due from related store / 2150 Due to related store**, both `requiresParty`
(`seed/chart-of-accounts.ts:148, 228`), `partyType: 'store'`, and **`partyId` = the OTHER store's `code`**
(POSTING-PATTERNS `:765-768`; code resolved with `moneyTransfersRepo.storeCodes`). Invariant 6's reciprocal finding
`dueFromDueToNotReciprocal` (`repo/findings.ts:89`) already watches Σ1250 = Σ2150. No new account, party type or
finding.

**Capability:** unchanged. `record_ap_payment` / `approve_expense` at the owing store, and `transfer_funds` at the
account's store when they differ (already enforced at `reimbursement.ts:97`, `approve.ts:137`, `ap/index.ts:997`).

**Posting shape (the rule).** The money-account credit goes at the ACCOUNT's store. The owing store's liability (or
expense) debit stays at the owing store. Then, for each paying store P ≠ owing store O, with X the total credited to
P's accounts in this entry:
- DR 1250 at P, party = O's code, for X;
- CR 2150 at O, party = P's code, for X.

Each store's own lines now net to zero, and the org total is unchanged.

**The ₱650 example.** Ana is owed ₱650 at Lipa (2130, from `expense.reimbursable`). An admin pays her from Malvar's
office safe (1130). One entry, `reimbursement_payout`:

| Account | Store | Debit | Credit | Party |
|---|---|---:|---:|---|
| 2130 Reimbursements payable to employees | Lipa | 650.00 | | employee (Ana) |
| 2150 Due to related store | Lipa | | 650.00 | store (Malvar's code) |
| 1250 Due from related store | Malvar | 650.00 | | store (Lipa's code) |
| 1130 Cash on hand — office | Malvar | | 650.00 | — |

Lipa nets 0 (650 − 650) and so does Malvar. Malvar's safe is −650 and Lipa's cash is untouched. Lipa owes Malvar
₱650 (2150 at Lipa, credit 650) and Malvar is owed ₱650 by Lipa (1250 at Malvar, debit 650): equal and opposite.

**Per-store tie.** Today only the ORG trial balance is asserted (`commissary-transfer.test.ts:587-608`, `select
sum(debit) - sum(credit) … where org_id`), and no trigger balances per store. S8's tests assert the per-store tie for
the entries they post (`group by store_id` → every row 0.00); S8 adds no trigger.

**Settlement.** No flow settles 1250/2150 today. A cross-store `createMoneyTransfer` from Lipa back to Malvar posts
DR 1250 at Lipa and CR 2150 at Malvar. That GROSSES UP both stores' positions: economically it nets, but neither
balance clears. Settlement is OUT of S8 — **S8·N2, a new DEF for the orchestrator**: "an inter-store balance has no
settle flow; a repaying transfer grosses it up instead of clearing it". See Q6.

**BUILDER** (source):
- `packages/domain/src/ledger/inter-store.ts` (new), the single shared helper:
  `withInterStoreLegs(tx, orgId, { owingStoreId, lines, memo }): Promise<PostEntryLine[]>`.
  - It takes lines whose money credits already carry their own `storeId`.
  - For each `storeId` ≠ `owingStoreId` whose lines net to a credit X (X > 0), it appends DR 1250 at that store
    (party = the owing store's code) and CR 2150 at `owingStoreId` (party = that store's code), each X.
  - It resolves codes once with `moneyTransfersRepo.storeCodes`, and throws `internalFault` if a code is missing.
  - It returns `lines` unchanged when every line is at the owing store, so the same-store shape is byte-identical.
  - It uses `@shareat/core/money` (I8), never `Number`.
  - It refuses (`internalFault`) a non-owing store that nets to a DEBIT. No caller in S8 produces one, and a silent
    reverse pair would mis-state both stores.
  - Export it from `packages/domain/src/index.ts` beside `./ledger/post-entry` (`:10`).
- `packages/domain/src/expenses/reimbursement.ts`:
  - the credit leg's `storeId` becomes `account.storeId`;
  - the `lines` pass through `withInterStoreLegs(…, { owingStoreId: input.storeId })` before `postEntry`;
  - the replay check (`:113-125`) also requires `credit.storeId === account.storeId`. A pre-S8 cross-store payout
    replayed after S8 is refused as "a different amount, store or account". That is correct: it is the defective
    shape, and nothing deploys from `main`.
- `packages/domain/src/expenses/routing.ts`: `RoutingPayment` gains optional `moneyAccountStoreId`. The cash/online
  branch (`:142-173`) sets `line.storeId` ONLY when it is given, so the existing unit fixtures (which never pass it)
  keep their `toEqual` shape. `RoutingLine` gains optional `storeId`.
- `packages/domain/src/expenses/approve.ts`:
  - `wallets` (`:118`) also keeps `acct.storeId`, and the routing input passes `moneyAccountStoreId`;
  - `:225` becomes `storeId: l.storeId ?? expense.storeId`;
  - the mapped lines pass through `withInterStoreLegs(…, { owingStoreId: expense.storeId })`;
  - `drawnPerAccount` / `checkDraw` are unchanged: they already read the paying account.
- `packages/domain/src/ap/index.ts` `recordPayment`: the `cashPortion` credit (`:1076-1083`) gets
  `storeId: account.storeId`, and the lines pass through `withInterStoreLegs(…, { owingStoreId: input.storeId })`.
  `ap_payments.store_id` stays `input.storeId`: the payment belongs to the owing store's AP.
- `tests/worked-examples/fixtures.ts`: a new example `reimbursement.payout-cross-store`, with the four lines above.
  Use `storeRef: 'branch1'` for the owing store (Lipa) and `storeRef: 'commissary'` for the paying store (Malvar). The
  union's own doc says it means "two distinct stores", so the harness is not edited. Add a one-line comment saying so.
- `docs/POSTING-PATTERNS.md`: a new `### \`reimbursement.payout-cross-store\` — Paid from another store's safe` directly
  after `reimbursement.payout` (`:190-201`):
  - the 4-line table above in the `Account | Store | Debit | Credit | Party` form of `customer.return-internal`;
  - **Trap:** the credit at the owing store balances perfectly and is wrong: `balanceOf` reads the safe at the
    safe's store, so the paying safe never moves and the owing store's cash goes negative (DEF-551). Name the same
    shape for `expense_payment` and `ap_payment` in one sentence.
  - Then `npm run toc` (never hand-edit the TOC).
- **Migration: none.** 1250/2150, `party_type = 'store'` and the reciprocal finding all exist. 0178 stays reserved
  for T-372 S6 and S8 takes no index.

**TESTER:**
- `packages/domain/tests/integration/t369-s8-cross-store-draw.test.ts` (new). Two stores, admin at both, a Lipa-only
  manager. Reuse the fixture shape of `t369-s1-reimbursement-payout.test.ts:151-210`.
- `packages/domain/tests/unit/inter-store-legs.test.ts` (new): the pure arithmetic of `withInterStoreLegs`, with
  `storeCodes` stubbed.
- `packages/domain/tests/integration/t369-s1-reimbursement-payout.test.ts`: T3's positive control (`:368-375`)
  gains the store/balance asserts of S8·T1 (it posts the exact DEF-551 case and today asserts only count and
  outstanding). No existing test pins the wrong `store_id`: a grep of every cross-store payout/approve/AP test
  (`t369-s1`, `t369-s0` T8 `:593-615`, `t367-s2-invoice-gate`, `ap*.test.ts`) asserts counts, outstanding or the
  refusal, never the credit's store. The builder re-greps for `storeId).toBe(` near a cross-store pay before
  claiming that.
- `tests/unit/posting-patterns-doc.test.ts` and `tests/integration/posting-patterns.test.ts` are unchanged and must
  stay green with the new fixture (parity in both directions; the fixture is posted and reversed against real
  Postgres).

**Contract:** no signature changes. `payReimbursement`, `approveExpense` and `recordPayment` return what they do
today. The posted shape is the rule above. `withInterStoreLegs` is the only place the pair is built for these three.

**Tests** (real Postgres; each red leg asserts the target and is shown red on HEAD):
- T1 (reimbursement, the ₱650 case): owed 650 at Lipa; the admin pays 650 from Malvar's safe.
  - The entry has exactly the 4 lines of the table: account, store, side, amount, `party_type`/`party_id` (Lipa's
    and Malvar's codes).
  - `balanceOf(malvarSafe)` falls by exactly 650.00; `balanceOf(lipaCash)` and `balanceOf(lipaSafe)` are unchanged.
  - 1250 at Malvar = +650.00 and 2150 at Lipa = −650.00 (debit − credit): equal and opposite.
  - `group by store_id` over the entry's lines → every store nets 0.00.
  - `dueFromDueToNotReciprocal` raises nothing.
  - Red on HEAD: the credit is at Lipa, Malvar's safe is unchanged, and Lipa's cash is −650.
- T2 (positive control, same store, unchanged): the manager pays 650 from Lipa's own safe. Exactly TWO lines (DR 2130 /
  CR 1130, both at Lipa), no 1250/2150 line, and `lines` deep-equal to the pre-S8 shape. Green on HEAD and after.
- T3 (expense approval): a Lipa expense of ₱1,000 split ₱600 Lipa cash + ₱400 Malvar safe, approved by the admin.
  - Lipa cash −600 and Malvar safe −400.
  - Exactly one 1250/2150 pair, for 400 (not 1,000).
  - Each store nets 0.00.
  - Red on HEAD: Malvar's credit is at Lipa.
  - Positive control: the same split with both legs from Lipa → no pair.
- T4 (AP payment): ₱12,000 owed to a supplier at Lipa, paid from Malvar's safe by the admin.
  - Malvar safe −12,000; DR 2110 at Lipa; the 1250/2150 pair for 12,000; `ap_payments.store_id` = Lipa; Lipa's open
    item cleared.
  - With `creditApplied` 2,000: the pair is for the 10,000 cash portion only.
  - Red on HEAD.
- T5 (✗ unchanged): the Lipa-only manager drawing on Malvar's safe is still `AuthorizationError` in all three
  writers, and nothing is posted (the N1 gates are untouched). Positive control: T1.
- T6 (void mirrors): void T4's payment (`voidPayment`). Malvar's safe returns to its prior balance; 1250 at Malvar and
  2150 at Lipa return to 0.00; the reversal carries the same `party_id`s (POSTING-PATTERNS `:1254`). No code change:
  this guards `reverseEntry`'s mirror.
- T7 (unit, `withInterStoreLegs`):
  - two paying stores in one entry → two pairs;
  - all lines at the owing store → returned `===` unchanged;
  - a non-owing store netting to a debit → `internalFault`;
  - centavo sums (0.10 + 0.20) exact.
- Mutants (each turns a named test red):
  - (i) keep the credit at the owing store → T1/T3/T4 red;
  - (ii) drop the pair but keep the credit at the account's store → the per-store tie is red;
  - (iii) swap the parties (each line names its OWN store) → T1's party asserts are red;
  - (iv) append the pair unconditionally → T2 is red;
  - (v) in approve, build the pair from the expense total instead of the drawn amount → T3 is red.

**Smoke (9008, `shareat_test_setup`; 2027-02 open):** no screen offers another store's account until S6b (Q2), so
the cross-store payout is posted by a domain call. Use a `tsx` script in the scratchpad, run as an admin, not a
forged POST.
1. Note `/money-transfers` balances for Malvar's office safe and Lipa's cash.
2. Owe ₱650 at Lipa (S1 smoke step 1), then pay it from Malvar's safe via `payReimbursement`.
3. `/money-transfers`: Malvar's safe is down ₱650 and Lipa's cash is unchanged.
4. `/reports/trial-balance?store=<Lipa>` shows 2150 ₱650 credit and ties; `?store=<Malvar>` shows 1250 ₱650 debit
   and ties; the org-wide view ties with 1250 and 2150 equal.
5. `/expenses/reimbursements` at Lipa: Ana is no longer listed.

Screenshots at steps 3–4.

**Not in S8:**
- settling an inter-store balance (S8·N2, Q6);
- AR collections and loans (S8·N1, Q5);
- any picker offering another store's account (S6b).

**Questions S8 adds (for the orchestrator to put to Ian; defaults let S8 proceed):**
- **Q5: Collections and loan payments.** Today the three writers in S8·N1 accept another store's account with no
  permission check and the wrong store, which is DEF-551's bug plus a missing gate. Choose:
  - (a) **apply the same ruling: gate `transfer_funds` and post the pair** (recommended; one call to the helper
    each);
  - (b) refuse another store's account there, like payroll and owners.
  Default until answered: neither is built here, and it is logged as a new DEF.
- **Q6: How should Lipa pay Malvar back?** Choose:
  - (a) **a "Settle between stores" transfer that DR 2150 at Lipa / CR Lipa cash and DR Malvar safe / CR 1250 at
    Malvar** (recommended; it clears both balances);
  - (b) leave the balances to net at group level.
  Default: (b), a follow-up DEF.

---

## S8b: DEF-556 — collections and loans across stores
Added 2026-10-02 by the Opus planner, on Ian's ruling (a) for Q5 (Ruling log). **Depends on S8** (`withInterStoreLegs`
does not exist until S8 commits). S8b's N-numbers are its own (`S8b·N1`…).

**The defect (S8·N1, now DEF-556).** Three writers accept ANY money account in the org, with no store check and no
`transfer_funds`, and post the money leg at the DOCUMENT's store:
- `recordCollection` — `packages/domain/src/ar/index.ts:267` fetches the account; the debit is at `input.storeId`
  (`:371`). Gate today: `record_ar_collection` at `input.storeId` (`:240`) only.
- `disburseLoan` — `packages/domain/src/loans/index.ts:117`; the debit is at `loan.storeId` (`:140`). Gate:
  `record_ap_payment` at `loan.storeId` (`:111`) only.
- `recordLoanPayment` — `loans/index.ts:192`; the credit is at `loan.storeId` (`:253`). Gate: `record_ap_payment` at
  `loan.storeId` (`:186`) only. `checkDraw` (`:230`) already reads the paying account.

So a Lipa-only manager can drain Malvar's safe into a Lipa loan payment today, and the ledger shows Malvar's safe
untouched while Lipa's cash goes negative.

**The new half: money flowing IN.** S8's three writers only CREDIT another store's account (money leaves P). Here,
`recordCollection` and `disburseLoan` DEBIT another store's account (money lands at P for O's document). Then P is
holding O's money, so **P owes O**: the pair runs the other way. `recordLoanPayment` is S8's direction exactly.

**Posting shape (the rule, both directions).** The money-account line goes at the ACCOUNT's store. Every other line
(1210, 2140, 6400, 2400, 7200) stays at the document's store O. Then, for each store P ≠ O, with X the net of P's
lines in this entry:
- P nets to a CREDIT X (money left P; S8's case): DR 1250 at P, party = O's code / CR 2150 at O, party = P's code.
- P nets to a DEBIT X (money landed at P; new): DR 1250 at O, party = P's code / CR 2150 at P, party = O's code.

Each store's own lines net to zero; the org total is unchanged; Σ1250 = Σ2150 still holds.

**The ₱2,000 example.** A ₱2,000 charge is open at Lipa. The customer pays it into Malvar's office safe (1130), and an
admin records it. One entry, `ar_collection`:

| Account | Store | Debit | Credit | Party |
|---|---|---:|---:|---|
| 1130 Cash on hand — office | Malvar | 2,000.00 | | — |
| 2150 Due to related store | Malvar | | 2,000.00 | store (Lipa's code) |
| 1250 Due from related store | Lipa | 2,000.00 | | store (Malvar's code) |
| 1210 Accounts receivable | Lipa | | 2,000.00 | customer |

Malvar's safe is up ₱2,000 and Malvar owes Lipa ₱2,000. Lipa's receivable is cleared and Lipa is owed ₱2,000.

Loans, same rule: a ₱4,800 Lipa loan payment (₱4,500 principal + ₱300 interest) from Malvar's safe posts DR 2400 Lipa
4,500 (party loan) · DR 7200 Lipa 300 · CR 1130 Malvar 4,800 · DR 1250 Malvar 4,800 (party Lipa) · CR 2150 Lipa 4,800
(party Malvar). A ₱50,000 Lipa loan drawn into Malvar's safe posts DR 1130 Malvar · CR 2400 Lipa (party loan) · DR 1250
Lipa (party Malvar) · CR 2150 Malvar (party Lipa), each 50,000.

**Capability:** unchanged (I2). The document's own capability at the document's store (`record_ar_collection` /
`record_ap_payment`), plus `transfer_funds` at the account's store when the stores differ. That is S8's rule (S1·N1:
`reimbursement.ts:97`).

**BUILDER** (source):
- `packages/domain/src/ledger/inter-store.ts` (S8's helper): a non-owing store that nets to a DEBIT no longer throws
  `internalFault`. It gets the mirrored pair above. One helper, both directions; each store's sign is handled on its
  own. A store that nets to exactly 0.00 gets no pair. Lines all at the owing store are still returned `===`
  unchanged. Update the helper's doc comment.
- `packages/domain/src/ar/index.ts` `recordCollection`:
  - after the account fetch (`:268`): `if (account.storeId !== input.storeId) await authorize(trx, actor,
    'transfer_funds', { storeId: account.storeId })`, before the charge lock (`:318`);
  - the money-account debit (`:371`) gets `storeId: account.storeId`;
  - `lines` pass through `withInterStoreLegs(trx, actor.orgId, { owingStoreId: input.storeId, lines, memo })`
    before `postEntry`. Only the cash portion moves: 2140, 6400, 1210 and the surplus 2140 stay at `input.storeId`;
  - `ar_collections.store_id` stays `input.storeId`.
- `packages/domain/src/loans/index.ts`:
  - `disburseLoan`: the same gate after `:118` (`loan.storeId` is the owing store); the debit (`:140`) gets
    `storeId: account.storeId`; the lines pass through the helper.
  - `recordLoanPayment`: the same gate after `:193`, before `positionOf`; the credit (`:253`) gets
    `storeId: account.storeId`; the lines pass through the helper. `checkDraw` is unchanged.
  - `reverseLoanEntry` and `positionOf` are unchanged: both read 2400 by party, and 2400 never moves store.
- `voidCollection` (`ar/index.ts:482`) and `reverseLoanEntry` (`loans/index.ts:302`) use `reverseEntry`, which mirrors
  every line, pair included. No code change (T7 proves it).
- `tests/worked-examples/fixtures.ts`: a new example `ar_collection.cross-store` with the 4 lines above, owing store
  `storeRef: 'branch1'` (Lipa) and receiving store `storeRef: 'commissary'` (Malvar), with S8's one-line comment.
- `docs/POSTING-PATTERNS.md`: a new `### \`ar_collection.cross-store\` — Paid into another store's safe` directly after
  `ar_collection.no-fee`, in the `Account | Store | Debit | Credit | Party` form. **Trap:** money landing at another
  store makes THAT store the debtor; the pair runs opposite to `reimbursement.payout-cross-store`. One sentence names
  `loan_payment` (S8's direction) and `loan_disbursement` (this direction). Then `npm run toc`.
- **Migration: none.**

**TESTER:**
- `packages/domain/tests/integration/t369-s8b-cross-store-collections-loans.test.ts` (new). Two stores, admin at both,
  a Lipa-only manager holding `record_ar_collection`, `record_ap_payment` and `transfer_funds` at Lipa only. Reuse
  S8's fixture shape.
- `packages/domain/tests/unit/inter-store-legs.test.ts` (S8's): S8·T7's "debit → `internalFault`" leg is REPLACED by
  T8 below. That is the one intended red-to-green flip of an S8 assertion.
- A grep of `ar*.test.ts`, `loans*.test.ts` and `t367-*` for a collection or loan posted against another store's
  account: if any pins the old `store_id` or a success that T4 now refuses, it changes with a comment naming DEF-556.
  The builder re-greps before claiming none.

**Contract:** no signature changes. The three writers return what they do today.

**Tests** (real Postgres; each red leg asserts the target and is shown red on HEAD or on S8's commit):
- T1 (collection, the ₱2,000 case), by the admin:
  - exactly the 4 lines of the table (account, store, side, amount, party type and id);
  - `balanceOf(malvarSafe)` +2,000.00; `balanceOf(lipaCash)` and `balanceOf(lipaSafe)` unchanged;
  - 1250 at Lipa = +2,000.00 and 2150 at Malvar = −2,000.00 (debit − credit);
  - `group by store_id` → every store nets 0.00; `dueFromDueToNotReciprocal` raises nothing;
  - the charge's outstanding is 0.00;
  - red on HEAD: the debit is at Lipa and Malvar's safe is unchanged.
- T2 (collection, every optional leg): ₱5,000 collected into Malvar's safe with a ₱250 fee, ₱500 store credit applied
  and a ₱300 surplus. The pair is for the cash portion only (₱4,250), and 6400 and both 2140 lines are at Lipa.
- T3 (positive control, same store): the same collection into Lipa's own safe → no 1250/2150 line, and `lines`
  deep-equal to the pre-S8b shape. The same for one loan payment and one disbursement.
- T4 (✗, new gate): the Lipa-only manager naming Malvar's safe in each of the three writers → `AuthorizationError`
  naming `transfer_funds`; no entry, no `ar_collections` row, and the loan position unchanged. Red on HEAD (today all
  three succeed). Positive control: the admin, T1/T5/T6.
- T5 (loan payment, ₱4,800 from Malvar's safe): Malvar's safe −4,800.00; 2400 at Lipa down 4,500.00; 7200 at Lipa
  300.00; the pair DR 1250 Malvar / CR 2150 Lipa for 4,800.00; per-store tie. And `checkDraw` still refuses when
  Malvar's office safe holds less than the payment (it reads the paying account).
- T6 (loan disbursement, ₱50,000 into Malvar's safe): Malvar's safe +50,000.00; 2400 at Lipa; the pair DR 1250 Lipa /
  CR 2150 Malvar; per-store tie.
- T7 (voids mirror): `voidCollection` on T1 and `reverseLoanEntry` on T5. The safe returns to its prior balance; 1250
  and 2150 for the pair return to 0.00; the reversal lines carry the same `party_id`s. The charge is open again, and
  a `paid_off` loan re-opens as today. No code change: this guards `reverseEntry`'s mirror.
- T8 (unit, the helper):
  - one non-owing store netting to a debit → the mirrored pair (CR 2150 at it, DR 1250 at the owing store);
  - one entry with a paying store AND a receiving store → two pairs, opposite directions;
  - a non-owing store netting to 0.00 → no pair;
  - centavo sums exact (I8).
- Mutants (each turns a named test red):
  - (i) keep the money line at the document's store → T1/T5/T6 red;
  - (ii) keep S8's debit refusal in the helper → T1/T6 red;
  - (iii) not mirroring the direction (DR 1250 at the receiving store) → T1's party/side asserts and the per-store
    tie are red;
  - (iv) drop the new `transfer_funds` gate → T4 red;
  - (v) build the collection's pair from `amount` instead of the cash portion → T2 red.

**Smoke (9008, `shareat_test_setup`; 2027-02 open):** no picker offers another store's account (S6b), so post through
a `tsx` scratchpad script as the admin, never a forged POST. Collect ₱2,000 of a Lipa charge into Malvar's safe, then:
`/money-transfers` shows Malvar's safe +₱2,000 and Lipa's cash unchanged; `/reports/trial-balance?store=<Malvar>` shows
2150 ₱2,000 credit and ties; `?store=<Lipa>` shows 1250 ₱2,000 debit and ties; the customer page shows the charge
paid. Screenshots of the two trial balances.

**Not in S8b:** a picker offering another store's account on the customer or loan screens (S6b's pattern, not
ruled); settling the balance (S9).

---

## S9: DEF-557 — settle between stores
Added 2026-10-02 by the Opus planner, on Ian's ruling (a) for Q6 (Ruling log). S9's N-numbers are its own (`S9·N1`…).
**S9 does not need S8's code:** inter-store balances exist today (cross-store money transfers, channel-settlement loan
deductions, commissary). It shares only `fixtures.ts` and `POSTING-PATTERNS.md` with S8/S8b.

**The defect.** Nothing clears 1250/2150. A Lipa → Malvar transfer meant to repay posts the ordinary cross-store pair
(`money-transfers/index.ts:229-248`): DR 1250 at LIPA and CR 2150 at MALVAR. That adds a second, opposite debt beside
the first instead of clearing it, so both stores' 1250 and 2150 grow forever.

**v1 as requirements (§1.2d).** v1 has no settlement either; its pair appears only in the cross-store loan deduction
(S8's v1 note). The goal: when one store hands another the money it owes, both stores' books show the debt gone. v2
beats v1 by making the settlement the same single entry as the cash move, capped by what the ledger says is owed.

**Where it lives.** `/money-transfers`, a new `<details>` panel **"Settle between stores"** (I6: the native
disclosure, inline form, `back()` banners, no `alert()`/`confirm()`). It lists each ordered pair with a positive net
balance where the person holds `transfer_funds` at BOTH stores, in words: "Lipa owes Malvar ₱650.00". Choosing a row
fills the form:
- **From:** the debtor's active office accounts. **To:** the creditor's active office accounts (bible row 152: office
  to office only).
- **Amount** (pre-filled with the full balance), **received** (defaults to the amount; less only for a bank fee),
  **date**, **reference**, **notes**.
- A hidden `settlementId` = `crypto.randomUUID()` generated when the page renders.

It is a money transfer, so it is listed with the others, tagged "Settlement", and voided with the existing Void.
When there is no pair to settle, the panel says "No store owes another." and offers no form. It is not a checkbox on
the ordinary transfer form: a settlement has a cap and a direction an ordinary transfer does not.

**Capability:** no new one (I2). `transfer_funds` at BOTH stores, exactly as a cross-store transfer
(`money-transfers/index.ts:135, 151`; bible row 153).

**Posting shape (the rule).** Debtor D pays creditor C. The cash legs are a normal transfer: DR C's account at C for
`amountIn`, CR D's account at D for `amountOut`, and a fee (6870, at D) when `amountOut > amountIn`. Then the CLEARING
pair, for `amountIn` (what C actually received; the fee is D's own cost, as in a transfer):
- DR 2150 at D, party = C's code (D's debt to C goes down);
- CR 1250 at C, party = D's code (C's claim on D goes down).

**"Lipa repays Malvar ₱650"** (it clears S8's ₱650 example). From Lipa's office safe to Malvar's office safe, one entry,
`transfer`:

| Account | Store | Debit | Credit | Party |
|---|---|---:|---:|---|
| 1130 Cash on hand — office | Malvar | 650.00 | | — |
| 1250 Due from related store | Malvar | | 650.00 | store (Lipa's code) |
| 2150 Due to related store | Lipa | 650.00 | | store (Malvar's code) |
| 1130 Cash on hand — office | Lipa | | 650.00 | — |

Each store nets 0.00. Lipa's safe −650, Malvar's +650. 2150 at Lipa (party Malvar) and 1250 at Malvar (party Lipa)
both return to 0.00. Σ1250 = Σ2150 still.

**What is owed: the NET position of the pair, read from both stores' books.**
- From D's books: Σ at D of 2150 party C (credit − debit), minus Σ at D of 1250 party C (debit − credit).
- From C's books: Σ at C of 1250 party D (debit − credit), minus Σ at C of 2150 party D (credit − debit).
- Non-draft entries only, like `reciprocalDrift` (`repo/findings.ts:77-84`). Computed in SQL `numeric` and returned
  as strings, never a JS float compare (I8; DEF-272's class).
- Every writer posts the pair together, so the two readings agree. If they ever differ, settling is refused (below)
  rather than clearing against one side's number.
- A pair whose debt was voided AFTER it was settled goes negative. That simply reads as the reverse debt (C now owes
  D) and is settled the other way round. Nothing special is built for it.

**Refusals** (I7: no ids, no column names; each a `refuse(raw, userSentence)`; nothing is written on any of them):
- same store: "Both accounts belong to Lipa — there is nothing to settle between stores.";
- either end not an office account, or retired: the existing transfer sentences (row 152);
- nothing owed either way: "Lipa and Malvar owe each other nothing.";
- wrong direction: "Malvar doesn't owe Lipa — Lipa owes Malvar ₱650.00. Swap the accounts.";
- more than owed (`amountIn` > owed): "Lipa owes Malvar ₱650.00, so ₱700.00 is more than the debt. Send the
  difference as an ordinary transfer.";
- `amountIn > amountOut`: the existing income sentence;
- the two books disagree: "The two stores' records of what is owed don't match, so this can't be settled yet. Ask
  the accountant to check the stores' due-to and due-from balances." (a hard refusal, logged with both figures);
- an office source that cannot cover it: `checkDraw`, unchanged;
- a closed month: the period trigger's sentence, unchanged.

**Partial settlement:** allowed. Any `amountIn` from ₱0.01 up to the owed balance. The remainder stays owed and the
panel shows it.

**Idempotency / double submit.** `settlementId` comes from the form, as `payoutId` does for S1·N3
(`reimbursement.ts:103-130`):
- the journal key is `transfer:${settlementId}:post`, and the `money_transfers` row's id IS `settlementId`;
- before the cap read, `findEntryByIdempotencyKey`. A replay with the same accounts and amounts returns the first
  result. The same id with other figures is refused: "This settlement was already recorded with different figures.
  Reload the page and try again.";
- the primary key is the database's own backstop against a racing double click.

**Concurrency.** New `lockInterStorePair(tx, storeA, storeB)` in `packages/db/src/repo/advisory-locks.ts`, namespace
**369003** (next after S0's 369002). It is keyed on the UNORDERED pair:
`hashtext(least(a, b) || ':' || greatest(a, b))`, so D→C and C→D serialize together. It is taken after the two
`authorize` calls and before the replay lookup and the owed read: the order S1 uses (`reimbursement.ts:101-104`).
Only settlement takes it. Every other 1250/2150 writer can only RAISE a debt or (on void) restore one, and neither
can make a settlement exceed what is owed. Update the namespace list in the file's header comment.

**Void.** The existing `voidMoneyTransfer` reverses every line, so the debt comes back exactly. No cap applies to a
reversal (row 152's rule: a correction must always be possible). One change: ⚠️ **S9·N1** — a cross-store transfer's
void (settlement or ordinary) today authorizes only the SOURCE store (`money-transfers/index.ts:311`), though creating
it needed both (row 153). S9 adds `transfer_funds` at the destination account's store when it differs. Both kinds
need it, and the creation rule is the precedent.

**Findings and reports.** `dueFromDueToNotReciprocal` is unchanged: the clearing pair is equal and opposite, so
Σ1250 = Σ2150 holds. It is org-wide and cannot see a per-pair mismatch. S9 refuses on one instead of building a
per-pair finding (⚠️ **S9·N2**, a new DEF for the orchestrator: "no finding watches 1250/2150 per store pair"). The
trial balance and `balanceOf` need no change. `remittance.ts:42` excludes `source_type = 'transfer'` from custody
movement, which is why the settlement keeps `sourceType: 'transfer'`. A new source type would leak settlements into
the cashier's remittance figures.

**BUILDER** (source):
- `packages/domain/src/money-transfers/index.ts`:
  - extract `runCreate`'s shared part (`:104-212`: load ends, office-only rule, both `authorize` calls, amount
    parsing, `checkDraw`, fee and cash legs) into an internal `prepareTransfer(tx, actor, input)`. This is a pure
    move: `createMoneyTransfer` keeps its exact output and the existing transfer tests are its guard;
  - `runVoid` gains the destination-store `authorize` (S9·N1).
- `packages/domain/src/money-transfers/settle.ts` (new):
  `settleBetweenStores(tx, actor, { settlementId, fromMoneyAccountId, toMoneyAccountId, amountOut, amountIn,
  transferDate, feeAccountCode?, reference?, notes? }): Promise<CreateMoneyTransferResult & { owedAfter: string }>`.
  Order: `prepareTransfer` → same-store refusal → `lockInterStorePair` → replay → `interStorePosition` (both
  readings) → direction, cap and agreement refusals → clearing pair → `postEntry` (`sourceType: 'transfer'`,
  `sourceId: settlementId`, memo `Settlement — Lipa to Malvar`) → insert the row with `id: settlementId`.
  Export it from `money-transfers/index.ts`.
- `packages/db/src/repo/money-transfers.ts`:
  - `InsertMoneyTransferInput` gains optional `id`;
  - new `interStorePosition(tx, orgId, debtorStoreId, creditorStoreId): { owedPerDebtor: string; owedPerCreditor:
    string }`;
  - new `interStorePositions(tx, orgId, storeIds)`: every ordered pair with a positive net, for the panel;
  - `listMoneyTransfers` gains a derived `settles: boolean` (an `exists` over the entry's 2150 DEBIT at the source
    store). No column.
- `packages/db/src/repo/advisory-locks.ts`: `lockInterStorePair` (369003).
- `apps/erp/src/app/money-transfers/`:
  - `SettleBetweenStoresForm.tsx` (new);
  - `actions.ts` gains `settleBetweenStoresAction`;
  - `lib.ts` loads the positions for the stores where the person holds `transfer_funds`;
  - `page.tsx` renders the panel and the "Settlement" tag.
- `tests/worked-examples/fixtures.ts`: `transfer.settle-between-stores`, the 4 lines above. Lipa is
  `storeRef: 'branch1'` and Malvar `storeRef: 'commissary'`, with S8's comment.
- `docs/POSTING-PATTERNS.md`: a new `### \`transfer.settle-between-stores\` — Paying back what one store owes another`
  after `transfer.cash.with-fee`. **Trap:** an ordinary transfer back posts DR 1250 at the PAYER, which grosses both
  debts up instead of clearing them (DEF-557). Only the settlement debits 2150 at the payer. Correct the Transfer
  section's intro sentence "not inter-store (that is `commissary_dispatch`)": cross-store transfers carry the pair
  since T-139. Then `npm run toc`.
- **Migration: none.** No column: the row id carries the idempotency, the lines carry the "settles" tag, and
  1250/2150 and `party_type 'store'` exist. 0179 is not needed.

**TESTER:**
- `packages/domain/tests/integration/t369-s9-settle-between-stores.test.ts` (new). Two stores with office safes, admin
  at both, a Lipa-only and a Malvar-only manager. Seed the debt with an ordinary `createMoneyTransfer` Malvar → Lipa
  ₱650: Lipa now owes Malvar ₱650, independent of S8. The concurrency harness is copied from
  `t369-s1-reimbursement-payout.test.ts:56-144` (gated two connections, never a bare `Promise.all` race).
- `apps/erp/tests/integration/t369-s9-settle-action.test.ts` (new): the action's ✗ and the refusal sentences reaching
  `?error=`.
- `domain-actions-have-callers` and `route-capability-coverage` must stay green: the new action is the caller.

**Contract:** `createMoneyTransfer` and `voidMoneyTransfer` keep their signatures. `createMoneyTransfer`'s output is
unchanged; `voidMoneyTransfer` refuses one more case (S9·N1). `settleBetweenStores` is the only writer of the
clearing pair.

**Tests** (real Postgres; each red leg asserts the target and is shown red on HEAD):
- T1 (the ₱650 example):
  - exactly the 4 lines of the table (account, store, side, amount, parties);
  - Lipa's safe −650.00 and Malvar's +650.00;
  - 2150 at Lipa (party Malvar) and 1250 at Malvar (party Lipa) both 0.00;
  - both readings of `interStorePosition` are 0.00; per-store tie; `dueFromDueToNotReciprocal` raises nothing;
  - red on HEAD, in contrast: the same repayment through `createMoneyTransfer` leaves 2150 at Lipa at 650 and ADDS
    1250 at Lipa 650.
- T2 (partial): settle 400 → 250 owed on both readings; settle 250 → 0; then 0.01 more → "owe each other nothing".
- T3 (refusals; each asserts the sentence, no id in it, and that the entry, row and balance counts are unchanged):
  more than owed (700); wrong direction (Malvar → Lipa); same store; a pair with no balance; a cashier account at
  either end; `amountIn > amountOut`.
- T4 (✗): the Lipa-only and the Malvar-only managers → `AuthorizationError`, nothing posted. Positive control: the
  admin, T1.
- T5 (idempotency): the same `settlementId` and figures twice → one entry, one row, the same ids returned, 0.00
  owed. The same id with 300 instead of 650 → the replay refusal, and nothing changes.
- T6 (concurrency): owed 650; A settles 400 and B settles 400 with different ids. B is observed waiting on
  `advisory`; exactly one succeeds and the other gets the more-than-owed refusal with 250 in it. 250 stays owed and
  never goes below 0. A Lipa↔Commissary settlement does not block a Lipa↔Malvar one.
- T7 (void): `voidMoneyTransfer` on T1 → 650 owed again on both readings, and the reversal lines carry the same
  parties. Settling again succeeds. ✗ (S9·N1): the Lipa-only manager cannot void it (red on HEAD), and the same holds
  for an ordinary cross-store transfer.
- T8 (fee): `amountOut` 660, `amountIn` 650 between two office bank accounts → 6870 10.00 at Lipa, and exactly 650
  cleared.
- T9 (books disagree): in-test, post a one-sided 2150 credit at Lipa (party Malvar) against 6870 → the readings differ
  → the disagreement refusal, nothing posted.
- T10 (panel source): `interStorePositions` lists "Lipa → Malvar 650.00" and omits the pairs that net to 0.
- T11 (`settles` tag): `listMoneyTransfers` marks the settlement `true` and the seeding transfer `false`.
- Mutants (each turns a named test red):
  - (i) post the ordinary gross-up pair instead → T1 red;
  - (ii) drop the cap → T3's more-than-owed red;
  - (iii) drop the lock → T6 red;
  - (iv) clear `amountOut` instead of `amountIn` → T8 red;
  - (v) authorize only the source store → T4's Malvar-only leg red;
  - (vi) read only the debtor's books → T9 red;
  - (vii) look the replay up after the cap read → T5's second call is refused as "nothing owed" (red).

**Smoke (9008, `shareat_test_setup`; 2027-02 open)**, as the admin:
1. Make Lipa owe Malvar ₱650 (a Malvar → Lipa office transfer).
2. `/money-transfers` → "Settle between stores" shows "Lipa owes Malvar ₱650.00".
3. Settle ₱400. The banner confirms, the panel shows ₱250, and the list tags the row "Settlement".
4. Try ₱300 → the refusal banner.
5. Settle ₱250 → "No store owes another."
6. `/reports/trial-balance?store=<Lipa>` and `?store=<Malvar>`: 2150/1250 are 0.00 and both tie.

Screenshots at steps 2, 3, 4 and 6, plus the panel at 375px and in dark mode.

**Not in S9:** offsetting two opposite debts without cash (Q8); a per-pair finding (S9·N2); settling the commissary's
historical balances in bulk.

**Questions S8b and S9 add (for the orchestrator to put to Ian; defaults let both proceed):**
- **Q7: Can a cross-store collection or loan payment use another store's CASHIER drawer?** Cross-store transfers are
  office to office only (row 152). S8, as ruled, does not add that rule to draws.
  - (a) **Mirror S8: no custodian rule beyond `transfer_funds`** (recommended; Ian's ruling names only the gate).
  - (b) Another store's account must be an office account.
  - Default: (a).
- **Q8: If Lipa owes Malvar ₱650 and Malvar owes Lipa ₱400 on separate records, may they be offset without moving
  cash?** S9 settles the NET (₱250) with cash. The two gross balances stay on the books, netting to zero.
  - (a) **Not now** (recommended; nothing reads the gross pair).
  - (b) Add a no-cash "offset" settlement.
  - Default: (a).

---

## Out of scope
- A void for a reimbursement payout (Q4; if (a), a follow-up slice after S5a).
- Viewing capability per record rather than per upload purpose, and DEF-320's purposes.
- ✎R Stock flows that post NO ledger entry: counts (`stock/count-workflow.ts`) and in-store room transfers
  (`stock/transfers.ts`, which already refuses early via its own `assertPeriodOpen` `:45-58`, showing *"fiscal period
  … is closed — cannot move stock dated …"* with the id redacted). Counts show the `0145` trigger sentence today
  (*"cannot move stock into a closed period (moved_at = …)"*). Deferred under DEF-528; wastage, usage, delivery
  receipt and supplier returns are IN S4a (they do post).
- Changing `dispatchOrder` to date by the dispatch day (new DEF, orchestrator).
- The override on screens other than Q3's answer.
- Reopening a period (bible row 193 forbids it).
- NaN in the existing `Number()` comparisons (T-371).
- CAPABILITY-MATRIX notes, the GLOSSARY `:152` correction, register rows, and the bible — all the orchestrator's, at
  wrap-up.

## Done when
- S1, S2, S3, S4a, S5a and S6a are green. S4b is green after T-372 S3; S5b after T-367; S6b and S7 per Q2 / Q1.
- Each red leg was shown red on HEAD or against its named mutant before the build.
- Typecheck is clean. The unit suite passes, including `domain-actions-have-callers`,
  `route-capability-coverage`, `nav-route-reachability`, `production-caller-ratchet`, and the T8 allowlist. The
  FULL integration suite passes before push.
- Each slice's smoke was run on 9008 against `shareat_test_setup`, with screenshots. ✎R Every new screen
  (reimbursements, sales-day edit, the override panel) also has a 375px screenshot and a dark-mode screenshot; a grep
  of the touched app files finds no `alert(` / `confirm(`.
- `npm run build` passes with the dev server stopped. `file` on each touched file shows LF.
- The builder touched only BUILDER paths.
- The orchestrator, at wrap-up:
  - marks DEF-198 (the two rows), 314, 302, 479, 291 and (for the S4a flows) DEF-528 fixed with hashes;
  - files N1–N3, the Q4 gap and the dispatch-date finding as new DEFs;
  - corrects DEF-302's and DEF-291's census lines;
  - regenerates the production-caller baseline by script (never by hand, DEF-240).

## Questions only Ian can answer
- **Q1: When a sales day is withdrawn or voided, can a new one be entered for the same date?**
  Example: Lipa's 28 September report was typed wrong and a manager withdraws it. Today the system then refuses any
  new report for 28 September, forever, so Lipa's real sales for that day can never be recorded. The same is true
  after voiding a verified day.
  - (a) **Yes — voiding frees the date** (recommended; v1 did this by archiving the old report). It needs a small
    database change (S7).
  - (b) No — the date stays used; a mistake must be fixed by editing before it is verified.
  - Default until you answer: (b), and the Withdraw button warns that the date stays used.
- **Q2: Should the expense screen offer another branch's money?**
  Example: a Lipa expense was actually paid from Malvar's safe. Today the Lipa expense screen lists only Lipa's
  accounts, so this cannot be entered at all, even though the system allows it for someone permitted to move
  Malvar's money.
  - (a) **Show other branches' accounts in a folded "Another branch" group, only to people allowed to move that
    branch's money** (recommended; this is the design you approved for T-266).
  - (b) Keep it to this branch only.
  - Default: (b).
- **Q3: Which screens get the "post into a closed month" control (admins only, with a reason, recorded)?**
  Example: an August supplier bill turns up in October after August is closed, and it must be booked as an August
  expense.
  - (a) **Expense approval and staff reimbursement payouts** (recommended; that is where late paperwork lands).
  - (b) (a) plus supplier payments and customer collections.
  - (c) Every screen that posts money.
  - Default: (a). Stock screens never get it — your ruling.
- **Q4: Should a staff reimbursement payout be undoable?**
  Example: a manager pays Ana back ₱650 but picks the wrong cash drawer. v1 had a Void button for this; v2 has none,
  so the mistake cannot be corrected on screen.
  - (a) **Add Void: it reverses the payout, and Ana is shown as owed again** (recommended; same permission as
    paying).
  - (b) No.
  - Default: not built in this task; logged as a new defect.

## Ruling log
- 2026-10-01, Ian (chat): S0 closed-month void → **(a)** the person picks the reversal date (pre-filled today, open month only). Recorded on the Open Questions page.
- 2026-10-01, orchestrator: S0's SUPPLIER_CREDIT_LOCK_NAMESPACE is **369002** (S1 took 369001 for the reimbursement payee lock).
- 2026-10-01, orchestrator (from S3 RED): Ian's Q1 manager-only re-entry belongs to **S7** — S7 tests must add "void → create the same date: manager succeeds, staff refused". S3 pins only that withdrawing an unverified day lifts the create-block.
- 2026-10-01, orchestrator (S3 audit): wastage recorded against a day blocks WITHDRAW by design (the day is real; correct it by editing) — sentence "Wastage is recorded against this day, so it can't be withdrawn — edit its figures instead." Edits write an audit row (who, before→after). Until S7 the withdraw panel says the date stays used.
- 2026-10-01, Ian (chat; Open Questions page): DEF-551 → **(a) allow** a store's debt (reimbursement payout, expense/AP payment) to be paid from another store's money account. The safe that paid is credited at ITS store, and the 1250/2150 due-from/due-to pair (party = the other store's code, the channel-settlement loan-deduction convention) records what the owing store owes the paying store until settled. Specified as **S8**; settlement (Q6) and AR/loans (Q5) are follow-ups.
- 2026-10-01, Ian (Open Questions page): DEF-556 (Q5) → **(a)**. Customer collections, loan disbursements and loan repayments may use another store's money account only with `transfer_funds` at that account's store, and they post S8's inter-store legs. Specified as **S8b** (after S8).
- 2026-10-01, Ian (Open Questions page): DEF-557 (Q6) → **(a)**. Build a "settle between stores" transfer that clears 1250/2150. Specified as **S9**.
- 2026-10-02, planner: `withInterStoreLegs` handles BOTH directions from S8b on. Money landing at another store makes that store the debtor (CR 2150 there / DR 1250 at the document's store); S8·T7's debit refusal is replaced.
- 2026-10-02, planner: S9 takes lock namespace **369003** (`lockInterStorePair`, unordered pair). It keeps `sourceType: 'transfer'` because `remittance.ts:42` excludes that type from custody. The cap is the NET pair position read from both stores' books, and it clears `amountIn`. A cross-store void now needs `transfer_funds` at both stores (S9·N1). No migration.
- 2026-10-02, Ian (Open Questions page): S8b/S9 defaults confirmed — a cross-store collection may land in another store's cashier drawer with transfer_funds there (no extra drawer rule); no paper offset of opposite inter-store debts now.
