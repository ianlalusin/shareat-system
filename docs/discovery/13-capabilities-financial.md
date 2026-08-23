# 13 — Capabilities: Financial & Accounting

Source: `C:\Users\ianla\webapps\ERP-rebuild` (read-only). Scope: `src/lib/actions/*.actions.ts` for
expenses · AP · AR · payments/collections · cash requests/advances/liquidation · remittance/cash
handling · sales day/sales report · channel settlements · budgets · recurring expenses · loans ·
fixed assets/depreciation · prepaid items · equity · bank/e-wallet accounts, plus the statement/
reconciliation/migration layer (`income-statement`, `balance-sheet`, `integrity-check`, `reports`,
`report-export`, `excel-export`, `monthly-runs`, `legacy-import`, `backfill-legacy-projections`
`.actions.ts`) and supporting pure-logic modules under `src/lib/financial/` (journal builders,
`account-defs.ts`, `balancer.ts`, `vat.ts`, `cash-request/liquidation.ts`). ~63 action files read
in full; every row below was read directly, not inferred from file names.

Read first (not re-derived here): `docs/discovery/06-accounting-gaps.md` (the structural defects —
no nominal ledger, no AP/AR control accounts, single-leg-is-trivially-balanced, the platform-fee
double-count incident), `docs/discovery/03-business-logic.md` (the action catalogue + cross-cutting
invariants), `PROJECT_BIBLE.md` §10 (phase plan) and §16 (accounting spine). This doc's job is
different: **what business problem does each capability solve**, and **does the v2 plan have a home
for it**.

All claims are `[VERIFIED]` (code read directly, cited `file:line`) unless marked `INFERRED`.

Phase names used in the "In the ERPv2 plan?" column, per `PROJECT_BIBLE.md` §10:
**P1** = accounting spine (chart of accounts, journal, posting engine, fiscal periods, trial
balance) · **P2** = money-moving source documents ("Expenses, AP, AR, payments, cash requests,
sales day, settlements") · **P3** = inventory · **P5** = payroll · **P6** = reporting & dashboards ·
**P7** = peripheral modules ("Admin, onboarding, memos, performance, checklists, cookbook").

---

## A. Sales day, remittance, day-close, reporting

| Capability | What problem it solves | Who | v1 (`file:line`) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Sequential-verification gate | Refuses to submit/verify a *newer* sales day while an older one is still unverified, so unposted revenue/AR/remittance can't silently pile up. Admin overrides. | Manager, cashier | `sales-day.actions.ts:23-42,343-356` | **P2** | DUPLICATE |
| Verify sales day | Locks the day, posts the cash/online sale legs. | Manager, admin | `sales-day.actions.ts:49-160` | **P2** (posting itself needs P1's real revenue leg — see 06-accounting-gaps) | CORRECT |
| Void sales day (+ channel-AR cascade) | Reverses a verified day; auto-voids every channel receivable it spawned so a deleted day can't leave phantom AR. | Manager (own), admin (remitted) | `sales-day.actions.ts:167-309` | **P2** | DUPLICATE |
| Submit for review (cashier) | Cashier hands a filled-in day to a manager; notifies managers. | Cashier | `sales-day.actions.ts:319-388` | **P2** | DUPLICATE |
| Remit sales report | Records that the cashier's counted cash/online physically reached the office; computes shortage/overage, requires a named staff charge target when short. | Manager, admin | `sales-report.actions.ts:39-380` | **P2** | DUPLICATE |
| Mark "nothing left to remit" | Server-side re-verification (via posted transfers) that a zero-remaining claim is actually true — never trusts the client. | Manager, admin | `sales-report.actions.ts:409-499` | **P2** | DUPLICATE |
| Multi-staff shortage allocation | Splits one day's cash shortage across several staff in one pass (e.g. two cashiers shared a shift). | Manager, admin (needs `canChargeStaff`) | `sales-report.actions.ts:522-706` | **P2** | DUPLICATE |
| Single-staff shortage charge (legacy) | Older, single-target version of the same capability above. | Manager | `sales-report.actions.ts:725-811` | **P2** | ask Ian — looks superseded by the multi-allocation version; both are live |
| Void a shortage charge (both models) | Reverses either shortage-charge shape; multi-alloc version also rebuilds the affected staff's salary-advance balance. | Manager, admin (`canVoidRecords`) | `sales-report.actions.ts:813-1026` | **P2** | DUPLICATE |
| Sales Report Adjustment (revenue) | The *only* sanctioned way to correct a verified/remitted report: restates the doc, re-posts the sale journal under the same sourceId, auto-recomputes every derived total, reconciles channel AR, cascades daily snapshots. | Admin only | `sales-report-adjustment.actions.ts:214-434` | **P2** | DUPLICATE |
| Sales Report Adjustment (remittance) | Corrects expected-side remittance figures only; refuses to touch actual-received (that requires reversing the real transfer). | Admin only | `sales-report-adjustment.actions.ts:436-487` | **P2** | DUPLICATE |
| Sales Report Adjustment (expense) | Corrects a drawer expense tied to the day, delegating to the real expense void/edit path so nothing bypasses that reversal cascade. | Admin only | `sales-report-adjustment.actions.ts:489-551` | **P2** | DUPLICATE |
| Void an adjustment (LIFO) | Reverses the most-recently-applied adjustment only; older ones must be voided in order. | Admin only | `sales-report-adjustment.actions.ts:562-719` | **P2** | DUPLICATE |
| List adjustments / day's expenses | Read models feeding the Adjustment dialog. | Manager, admin | `sales-report-adjustment.actions.ts:723-796` | **P6** | DUPLICATE |
| Sales-day draft save | Cashier's pre-verify working entry (multiple saves before submit). | Cashier | `sales-report-draft.actions.ts:94+` | **P2** | DUPLICATE |
| Cash-remit shift draft | Per-shift draft for a multi-cashier day, netted against the day baseline so shifts don't double-count POS pulls. | Cashier | `sales-report-draft.actions.ts:330-495` | **P2** | DUPLICATE |
| Cashier unremitted-cash lookup | True unremitted balance per day (net of same-day cash outflows, not raw sales), oldest-first — feeds "envelope" cash-request funding. | Manager | `sales-coverage.actions.ts:38-84` | **P2** | DUPLICATE |
| Apply/reverse cash-request coverage | Marks which unremitted days a released cash-request float actually drew down; reversible on release-void. | Manager | `sales-coverage.actions.ts:93-194` | **P2** | DUPLICATE |
| Daily Review checklist | Read-only manager aggregator: open integrity items, attendance, inventory, branch orders, AI top-of-mind — one screen instead of six. | Manager | `daily-review.actions.ts` | **P6** | DUPLICATE |
| Daily money-account snapshot | Per-day account-balance snapshot (manual + nightly cron), the input every downstream account rollup reads. | System cron, manager (manual) | `daily-snapshot.actions.ts` | **P6** | DUPLICATE |
| Dashboard "Attention Today" | Aggregates low-stock + flagged-insight items into one rail; one failing source degrades gracefully instead of breaking the page. | Manager, admin | `dashboard-attention.actions.ts` | **P6** | DUPLICATE |
| Dashboard summary self-heal rebuild | Recomputes AP/AR/cash-request/staff counters from source when they drift; stampede-guarded so N managers opening a store don't fire N full rescans. | Any store member (widened deliberately — see file) | `dashboard-summary.actions.ts` | **P6** | CORRECT (only needed because v1 has no control accounts — P1 removes the drift class structurally) |
| Sales target | Per-store, per-month revenue goal for actual-vs-target reporting. | Manager, admin | `sales-target.actions.ts` | **P6** | DUPLICATE |
| Sales-channel benchmark / typo guard | Trailing average per non-daily-remit channel (Grab/FoodPanda) flags an implausible manual entry before it posts. | Cashier, manager (read) | `sales-channel-benchmark.actions.ts` | **P6** | DUPLICATE |

## B. Accounts payable — expenses, suppliers, payments, receipts

| Capability | What problem it solves | Who | v1 (`file:line`) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Record an expense | The central money-out entry: multi-method funding in one transaction (cash/credit/online/reimbursable/cash-request), receipt tagging, per-category budget check, CAPEX auto-capitalize at threshold. | Cashier, manager, admin | `expense.actions.ts:141-867` | **P2** | DUPLICATE |
| Void an expense | Full reversal cascade — journal, AP, cash-request liquidation, budget, receipt count, delivery unlink; blocked once a capitalized asset has started depreciating. | Manager, admin | `expense.actions.ts:956-1228` | **P2** | DUPLICATE |
| CAPEX capitalization policy | Global ₱ threshold (+ per-category override) that decides expense-now vs. capitalize-and-depreciate. | Admin (config), system (applied) | `capitalization.actions.ts`, `expense.actions.ts:235-280` | **P2** (feeds P1's asset accounts) | DUPLICATE |
| Expense category taxonomy | Global, server-validated P&L categories that gate whether a category needs a receipt / particulars / budget, and protect system-seeded categories from tampering. | Admin | `expense-entry.actions.ts:60-330` | **P2** | DUPLICATE |
| Per-store category enable/disable | Lets one store hide a category it never uses without deleting the global definition. | Manager, admin | `expense-entry.actions.ts:339-453` | **P2** | DUPLICATE |
| Expense particulars catalog | Learned "what specifically did you buy" autocomplete per category, index-cached so the combobox is one read, not N. | Cashier, manager | `expense-particulars.actions.ts` | **P2** | DUPLICATE |
| Expense budgets | Per-category monthly spend cap with soft enforcement and configurable auto-reissue (daily/weekly/monthly/quarterly/annual). | Manager, admin | `expense-budget.actions.ts` | *(not named in P2's list)* **NOT PLANNED** | DUPLICATE |
| AP data rebuild/repair | Recomputes `paidAmount` from actual payment allocations and rebuilds the supplier index when it drifts. | Manager, admin | `ap.actions.ts:31-123` | **P1** (the control-account redesign removes most of the *need* for this) | CORRECT |
| Mark supplier reconciled (single + bulk) | An admin's "I checked this, balance is zero" stamp — informational, separate from the derived open/closed AP status. | Admin | `ap.actions.ts:136-279` | **P2** | DUPLICATE |
| Resync AP after a due-date edit | Keeps the AP-open aging projection in step when a due date changes. | Manager | `ap-client-bridge.actions.ts` | **P2** | DUPLICATE |
| Supplier payment | Allocates one payment across specific open AP items (FIFO or manual), auto-opens a supplier-advance account on overpayment, supports cash-request funding, mirrors to the commissary's AR on a branch→commissary payment. | Manager, admin | `payment.actions.ts:137-442` | **P2** | DUPLICATE |
| Edit / void a payment | Full journal diff on edit; complete reversal + commissary-mirror reversal on void. | Manager, admin | `payment.actions.ts:444-950` | **P2** | DUPLICATE |
| Supplier-reconciliation preview/confirm | Auto-suggests a FIFO match of existing unallocated payments against open AP — a catch-up tool for historical bookkeeping gaps. | Manager, admin | `payment.actions.ts:952-1109` | **P2** | DUPLICATE |
| Receipt capture (supplier paper) | Photo-proof requirement for external purchases (narrow server-verified exemption for a pre-photo-rule delivery); VAT computed authoritatively from the supplier's own VAT status, never trusted from the client. | Cashier, manager | `receipt.actions.ts:177-421` | **P2** | DUPLICATE |
| Verify a receipt | Manager sign-off gate before a receipt can be tagged to any expense. | Manager, admin | `receipt.actions.ts:429-473` | **P2** | DUPLICATE |
| Void a receipt | Cascades through the shared expense-void primitive for every linked expense; refuses while any salary advance is still tagged to it. | Manager, admin | `receipt.actions.ts:475-654` | **P2** | DUPLICATE |
| Receipt-balance reconciliation | Recomputes recorded/unrecorded amounts from linked expenses *and* salary advances (a real gap once let Reconcile silently erase a tagged advance's contribution). | Admin | `receipt.actions.ts:50-131` | **P2** | DUPLICATE |
| Record delivery expenses (batch) | Turns a received delivery's line items into one delivery-level payment split, proportionally allocated per item → one receipt + N posted expenses; reuses the delivery's own receipt when one exists instead of minting a duplicate. | Cashier, manager | `delivery-expense.actions.ts` | **P2** | DUPLICATE |
| Link / force-link / unlink an expense to a delivery item | Ties an already-posted expense to the physical goods it paid for, or corrects a wrong link. | Cashier, manager (force = admin) | `delivery.actions.ts:994-1334` | **P2** | DUPLICATE |
| Settle a delivery discrepancy flag | Marks a shortage/variance line as manager-reviewed and closed. | Manager | `delivery.actions.ts:1335-1398` | **P2** | DUPLICATE |
| Recurring expense template | A scheduled bill (rent, utilities, subscriptions) with fixed or variable amount, optional prepaid/amortized mode. | Manager, admin | `recurring-expense.actions.ts:77-171` | *(not named in P2's list)* **NOT PLANNED** | DUPLICATE |
| Confirm a recurring payment (manual) | Posts one period's bill; defaults cash away from the cashier till; refuses to double-book a system-owned payroll/statutory row. | Manager, admin | `recurring-expense.actions.ts:173-429` | *(not named)* **NOT PLANNED** | DUPLICATE |
| Delete a recurring template | Removes only the template — every expense it already generated stays untouched, orphaned-by-design, so past P&L is never silently rewritten. | Manager, admin | `recurring-expense.actions.ts:448-478` | *(not named)* **NOT PLANNED** | DUPLICATE |
| Skip a recurring due date | Records a deliberate skip with a required reason, not a silent gap. | Manager, admin | `recurring-expense.actions.ts:480-511` | *(not named)* **NOT PLANNED** | DUPLICATE |
| Auto-pay recurring expenses | Cron + manual "run now"; insufficient funds / a locked day / a variable amount all become a pending record + manager alert instead of a silently skipped bill; 7-day self-healing lookback, idempotent per due date. | System cron, manager (manual) | `recurring-expense.actions.ts:525-892` | *(not named)* **NOT PLANNED** | DUPLICATE |
| Payment accounts (bank/e-wallet) master | CRUD + activate/deactivate for every online money account the store holds. | Manager, admin | `payment-accounts.actions.ts` | **P2** | DUPLICATE |
| Supplier master | Vendor record: VAT status, payment options, bank accounts. | Manager, admin | `supplier.actions.ts` | **P2** | DUPLICATE |
| Admin supplier delete/merge | Blocks deletion while any live receipt references the supplier; bulk-transfers receipts to a survivor first. | Admin | `supplier-admin.actions.ts` | **P2** | DUPLICATE |
| Supplier return | Traceable stock-OUT + audit trail for goods physically returned to a supplier. Deliberately does **not** touch AP/expense/journal — `apAlreadyHandled` is an operator self-declaration, never enforced. | Cashier, manager, inventory staff | `supplier-return.actions.ts` | primarily **P3** (inventory); the AP-reminder half is unassigned | ask Ian — the "financial reminder, never enforced" design is a real product decision, confirm it should carry forward as-is rather than becoming enforced |

## C. Accounts receivable

| Capability | What problem it solves | Who | v1 (`file:line`) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| AR customer master (+ branch link) | Customer record; linking to a branch auto-provisions a mirror AP supplier on that branch so commissary↔branch orders have something real to post against. | Staff (create), manager (edit) | `ar-customer.actions.ts:32-199` | **P2** | DUPLICATE |
| Mark AR customer reconciled (single + bulk) | Admin "verified at zero" stamp, mirrors the AP version. | Admin | `ar-customer.actions.ts:200-341` | **P2** | DUPLICATE |
| Credit sale | Records a receivable at time of sale (walk-in on account, or a channel's daily sales). | Cashier, manager | `ar-credit-sale.actions.ts:191-314` | **P2** | DUPLICATE |
| Edit a credit sale | Re-posts the charge journal at the delta, blocked if already voided. | Manager, admin | `ar-credit-sale.actions.ts:318-430` | **P2** | DUPLICATE |
| Void a credit sale | Refused while any collection is still applied against it — collections must go first. | Manager, admin | `ar-credit-sale.actions.ts:33-186` | **P2** | DUPLICATE |
| Write off a receivable | Controlled, journal-balanced bad-debt recognition (credit AR / debit bad-debt expense); partial write-off supported; direct edits to the outstanding amount are explicitly named as the wrong path. | Admin only | `ar-credit-sale.actions.ts:453-596` | **P2** | DUPLICATE |
| AR collection (apply) | Applies a payment against specific receivables; a platform-fee deduction is posted as its **own** distinct leg, never blended into the amount collected. | Manager, admin | `ar-collection.actions.ts:33-220` | **P2** | CORRECT — this exact design is what the documented platform-fee double-count incident exploited; v2 needs the same discipline enforced structurally, not by convention |
| Void an AR collection | Reverses receivables, customer balance, and any linked platform-fee expense together. | Manager, admin | `ar-collection.actions.ts:224-451` | **P2** | DUPLICATE |
| Create an AR collection | Records money received; auto-verified for a manager, pending for a cashier. | Cashier, manager | `ar-collection.actions.ts:456-596` | **P2** | DUPLICATE |
| Record platform-fee expense from a collection | Books the fee a platform kept when a customer paid less than billed. | Manager, admin | `ar-collection.actions.ts:601-688` | **P2** | CORRECT — same double-count risk as above |
| Auto-create channel AR | Daily platform receivable (Grab/FoodPanda), fired at sales-day verification, idempotent per (channel, date), deliberately outside the verified-cash lock since it never touches the drawer. | System (post-verify), manager (repair) | `ar-channel.actions.ts:39-237` | **P2** | DUPLICATE |
| Reconcile channel AR after an adjustment | Void + re-create at the corrected amount when an admin restates a day's channel breakdown. | Admin | `ar-channel.actions.ts:266-374` | **P2** | DUPLICATE |
| Backfill missing channel AR | Date-range repair sweep for days that should have posted a receivable but didn't. | Manager, admin | `ar-channel.actions.ts:398-467` | **P1**-class repair, unnecessary once idempotent posting is DB-enforced | CORRECT |
| Repair a collection missing its fee posting | Diagnoses + fixes a collection whose platform-fee expense is missing or wrong. | Admin | `ar-maintenance.actions.ts:44-231` | **P1**-class repair | CORRECT |
| Clean up double-booked platform-fee docs | Voids a fee expense doc that duplicates an already-posted inline journal leg — this IS the fix for the documented incident. | Admin | `ar-maintenance.actions.ts:246-327` | *(one-time migration, not a standing need in v2)* | DELETE-CANDIDATE — ask Ian; this exists only because v1 can double-post the same fee two ways, which P1's design should make structurally impossible |
| Admin delete AR collection / credit sale | Forced removal, delegating to the real void path when the record already carries journal legs. | Admin | `ar-maintenance.actions.ts:329-491` | **P2** | DUPLICATE |
| Recompute AR customer balance | Re-derives a customer's balance from the truth of its receivables, correcting drift. | Admin | `ar-maintenance.actions.ts:390-446` | **P1**-class repair | CORRECT |
| AR aging report | Current / 31-60 / 61-90 / 90+ buckets by customer. | Any store member | `ar-aging.actions.ts` | **P6** | DUPLICATE |

## D. Channel settlement & online remittance

| Capability | What problem it solves | Who | v1 (`file:line`) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Record a channel settlement | Clears the day's platform receivable through a per-platform clearing account; nets **signed** fee components (a promo day can net *negative* — a real credit); an under-report gain above a small tolerance requires an explicit confirm; pays an optional loan deduction out of clearing; deposits only the **net** to an office bank account. | Manager, admin | `channel-settlement.actions.ts:62-525` | **P2 ("settlements")** | CORRECT — the whole point of this capability is the correct handling of the exact defect class 06-accounting-gaps documents (OC-31); the *need* is proven, v1's fee-netting bug (now fixed) shows how easy it is to get wrong |
| Void a channel settlement | Full reversal; refuses while it paid down a loan (that must unwind first). | Manager, admin | `channel-settlement.actions.ts:528-735` | **P2** | DUPLICATE |
| Batch settlement upload → plan → record | Ingests a platform's payout file, classifies every day auto-post / queue-for-review / skip, books multiple days plus refund/appendix-B adjustments in one pass. | Manager, admin | `channel-settlement-batch.actions.ts` | **P2** | DUPLICATE |
| Repair an orphan channel-AR receivable | One-off fix for a receivable left dangling by a partial failure. | Manager, admin | `channel-settlement-batch.actions.ts:388+` | **P1**-class repair | CORRECT |
| Online remittance | Cashier-owned online wallet → office-owned account transfer, separate from cash remittance; a shortage can be charged to a named staff member. | Manager, admin | `online-remittance.actions.ts:41-171` | **P2** | DUPLICATE |
| Void online remittance | Reverses the transfer and any shortage charge; rebuilds the affected staff's salary-advance balance. | Manager, admin | `online-remittance.actions.ts:184-278` | **P2** | DUPLICATE |
| File a channel-discrepancy infraction | Traces a settlement-vs-invoice variance back to the filing cashier and verifying manager and files a disciplinary record against either/both — never auto-filed, always previewed first. | Manager, admin | `channel-settlement-discrepancy-infraction.actions.ts` | not in P2's list; HR-adjacent (**P7**?) | ADD — a real, actively-used control tying financial variance to accountability; make sure whoever owns HR/infractions in v2 knows this financial trigger exists |

## E. Cash & accounts

| Capability | What problem it solves | Who | v1 (`file:line`) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Set an account's opening balance | One-time starting balance per cash/online account; the deterministic entry id makes a second attempt a refusal, not an overwrite. | Admin only | `accounts.actions.ts:32-89` | **P1** | DUPLICATE |
| Manual balance adjustment | Admin reconciliation glue (found extra cash / count short) with a mandatory reason, posted as a real balanced journal pair against `equity__opening_balance`. | Admin only | `accounts.actions.ts:93-161` | **P1** | DUPLICATE |
| Chart-of-accounts / cash dashboard | Live view of every cash/online/AR/AP balance in one place. | Manager, admin | `accounts.actions.ts:191-390` | **P1/P6** | DUPLICATE |
| Rebuild an account balance from the journal | Self-heal for drift between the running balance and the raw ledger sum — the source-of-truth pattern the ERPv2 spine should make unnecessary. | Manager, admin | `accounts.actions.ts:466-563` | **P1** | CORRECT |
| Store financial bootstrap/repair toolkit | Seeds the chart of accounts + expense catalog for a new store; diagnoses and repairs missing cash/online journal legs. 8 functions. | Admin | `financial-init.actions.ts` | **P1** (seeding), repair half unnecessary under DB constraints | CORRECT |
| Create a cash request | Any staff member can request a cash float for a stated purpose. | Any staff | `cash-requests.actions.ts:35-91` | **P2** | DUPLICATE |
| Approve / reject a cash request | A requester can never approve their own request, even as a manager — admin override only; transactional read-check-write closes a real double-decrement race on the pending counter. | Manager, admin | `cash-requests.actions.ts:137-246` | **P2** | DUPLICATE |
| Void a pre-release cash request | Terminal states before money moved (pending/approved/rejected only). | Manager, admin | `cash-requests.actions.ts:256-317` | **P2** | DUPLICATE |
| Release a cash request | Hands the approved float to the requester from cashier/online/office cash; supports an "envelope" mode drawing on past days' held-over unremitted cash, re-validated server-side. | Manager, admin | `release-cash-request.actions.ts:28-185` | **P2** | DUPLICATE |
| Void a release | Refused once any of the float has been consumed, returned, or shortage-charged — those must unwind first, in order. | Manager, admin | `release-cash-request.actions.ts:199-319` | **P2** | DUPLICATE |
| Return unspent float | Closes out the unspent remainder of a released cash request. | Manager, admin | `return-cash-request.actions.ts` | **P2** | DUPLICATE |
| Charge a shortage to the requester | Converts unreturned float into a staff receivable (`staff_advance__{id}`) that payroll later deducts — replaced an off-ledger liability that used to produce no journal entries at all. | Staff w/ `canChargeStaff` grant | `charge-cash-request-shortage.actions.ts:42-178` | **P2** | DUPLICATE |
| Void a shortage charge | Reverses it, reopening the request if the restored balance clears the auto-close threshold. | Staff w/ `canVoidRecords` | `charge-cash-request-shortage.actions.ts:189-311` | **P2** | DUPLICATE |
| Capitalization policy config | Global CAPEX threshold + default depreciation terms, read by every expense post. | Admin | `capitalization.actions.ts` | **P1/P2** | DUPLICATE |
| Store setup / provisioning checklist | Runs every seedable setup step for a new store, reports per-step success individually (replacing a fire-and-forget that used to fail silently), and refuses to flip a store "active" while a required step is outstanding. | Admin | `store-provision.actions.ts`, `store.actions.ts:10-95` | **P7** | DUPLICATE |

## F. Assets, liabilities, equity, loans, prepaid

| Capability | What problem it solves | Who | v1 (`file:line`) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Fixed-asset register (create/edit) | Records a purchased or existing capital asset, cash- or AP-funded. | Manager, admin | `asset.actions.ts:35-178` | not named in P1 or P2's list (chart of accounts anticipates 1500 Property & equipment; §16.10 requires an "asset purchase" posting pattern) | **NOT PLANNED** — DUPLICATE |
| Import a legacy fixed asset | Balance-sheet-only opening entry that preserves remaining book value and continues depreciating at the original rate — the only way to bring in pre-ERP assets without restating history. | Manager, admin | `asset.actions.ts:201-324` | *(same as above)* | **NOT PLANNED** — DUPLICATE |
| Dispose (write off) a fixed asset | Recognizes the remaining book value as a real, posted P&L loss — the specific gap landmine #34 calls out ("write-offs never reduce reported net income" in v1's *journal*-only version; this action doc already fixes that half by also posting an expense). | Manager, admin | `asset.actions.ts:367-494` | *(same)* | **NOT PLANNED** — DUPLICATE |
| Monthly depreciation runner | Batch, idempotent, respects each asset's monthly/quarterly/annual interval; caps the last period at remaining book value. | Manager, admin (manual), implied cron | `depreciation.actions.ts:67-232` | **P1's chart lists depreciation; no phase names the runner** | **NOT PLANNED** — DUPLICATE |
| Void a month's depreciation | Reverses one asset-month, restores accumulated depreciation and book value. | Admin/manager | `depreciation.actions.ts:245-375` | *(same)* | **NOT PLANNED** — DUPLICATE |
| Prepaid item register | Capitalizes a multi-month prepayment (insurance, permits, SaaS, prepaid rent) at/above the capitalization threshold. | Manager, admin | `prepaid.actions.ts:69-243` | not named (chart lists 1400 Prepaid; §16.10 requires a "prepaid amortisation" pattern) | **NOT PLANNED** — DUPLICATE |
| Monthly amortization runner | Whole-month recognition of 1/coverageMonths into P&L, capped at the tail so the schedule sums exactly to cost. | Manager, admin (manual), implied cron | `amortization.actions.ts` | *(same)* | **NOT PLANNED** — DUPLICATE |
| Void / write off / import a prepaid item | Cascade-voids every posted leg for the item; early-termination with optional refund; legacy import mirrors the asset import. | Admin | `prepaid.actions.ts:255-623` | *(same)* | **NOT PLANNED** — DUPLICATE |
| Loan register | Records a loan draw; computes the amortization schedule (flat or amortizing interest, monthly/other frequency) server-side. | Manager, admin | `loan.actions.ts:85-230` | not named (chart lists 2400 Loans payable; §16.10 requires a "loan draw and repayment" pattern) | **NOT PLANNED** — DUPLICATE |
| Record / void a loan payment | Splits a payment into principal + interest, updates outstanding balance, flips to paid-off at zero. | Manager, admin (void) | `loan.actions.ts:234-521` | *(same)* | **NOT PLANNED** — DUPLICATE |
| Loan-interest total for the P&L | Sums posted `expense__interest` journal legs over a window — interest is journal-only with no backing expense doc, so the income statement can't find it any other way. | Read (report callers) | `loan.actions.ts:44-81` | **P1's fix (real nominal ledger) removes the need for this scan** | CORRECT |
| Loan auto-deduct | Scheduled automatic repayment (cron + manual run-now), computing the period's principal/interest split. | System cron, manager (manual) | `loan.actions.ts:528-651` | not named | **NOT PLANNED** — DUPLICATE |
| Owner registry | Records each owner: ownership %, drawing limit. | Admin only | `equity.actions.ts:47-102` | chart lists 3100/3200 Owner's capital/drawings; decision #57 confirms drawings is a deliberate **ADD** ("never used, so design it right") | **NOT PLANNED for the module itself** — ADD |
| Record a capital contribution | An owner injecting cash into the business. | Manager, admin | `equity.actions.ts:106-209` | *(same)* | ADD |
| Record an owner drawing | A withdrawal, enforced against a configurable limit. | Admin only | `equity.actions.ts:213-312` | *(same — explicitly flagged "never used" by Ian, i.e. low real-world usage in v1 but the capability itself is confirmed wanted)* | ADD |
| Void an equity movement | Reverses a contribution or drawing. | Admin only | `equity.actions.ts:321-411` | *(same)* | ADD |
| Generic liability account (charge/payment) | Books a miscellaneous accrual/liability (e.g. an accrued tax not otherwise modeled) outside the AP/statutory-specific flows. | Manager, admin | `liability.actions.ts` | not named; §16.5 (statutory obligations subledger, decision #49) is a narrower, purpose-built replacement for the statutory subset | **NOT PLANNED** — CORRECT (the statutory subset is explicitly getting a proper subledger in v2, per decision #49; the *generic* liability-account capability itself has no named owner) |

## G. Financial statements, reconciliation & migration

| Capability | What problem it solves | Who | v1 (`file:line`) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Generate an Income Statement | Builds a P&L for a date range from five independently-scanned sources (verified salesDays revenue, branch-sale AR, posted expense docs by frozen category, plus four journal-only scans for loan interest/platform fees/salary/salary-additions that have no backing expense doc) because v1 has no real nominal ledger. Revenue is recognized only from **verified/partially_remitted/remitted** sales days — a draft or voided day never reaches the P&L (policy dated 2026-06-20). Branch-sale revenue is deliberately read from the commissary-dispatch AR, not the salesDay, so it is recognized exactly once regardless of whether that day's cashier report exists yet. | Manager, admin | `income-statement.actions.ts:55-505` | **P1** (the fix — `v_income_statement` as a `GROUP BY` query over `journal_lines` retires every one of these hand-added scan blocks by construction, per bible decision #31/#40) | CORRECT — the need (a trustworthy period P&L) is proven daily; the hand-scan implementation is exactly the defect P1 exists to remove |
| Save / list / delete a saved Income Statement | Lets a manager snapshot a generated statement as a permanent, dated record instead of a disposable on-screen report — e.g. for board/loan-application use. | Manager, admin | `income-statement.actions.ts:509-576` | **P1/P6** | DUPLICATE |
| Generate a Balance Sheet (live or "as of" a past date) | Reads the unified accounts collection and buckets every balance-tracking account by prefix into Assets/Liabilities/Equity; Retained Earnings is computed as the plug (assets − liabilities − explicit equity) because v1's journal never posts a revenue/expense leg, so RE has to absorb all P&L activity implicitly. A past-date view recomputes every account from posted journal legs ≤ that date instead of trusting the live running balance. | Manager, admin | `balance-sheet.actions.ts:125-317` | **P1** — a real nominal ledger + control accounts means RE is a genuine derived figure, not a forced plug that silently hides misclassification | CORRECT |
| Unclassified-account tripwire (balance sheet) | Any account carrying a real balance that the classifier can't bucket is surfaced loudly instead of silently vanishing into the RE plug — this is exactly the failure mode of a real historical bug (a new `supplier_advance__` prefix that briefly had nowhere to go, understating assets and equity by the same amount with no visible error). | System (surfaced to admin) | `balance-sheet.actions.ts:99-106,236-244` | **P1** (a declared, enumerated chart with FK-constrained account types makes an "unknown prefix" structurally impossible — decision #39) | CORRECT — the *tripwire instinct* is exactly right even though P1's design removes the specific failure class it detects |
| On-demand ledger reconciliation ("does the ledger tie out") | Re-sums every posted journal leg per account from scratch and reports drift against the stored running balance — the only check that proves the stored number against raw history rather than against another copy of itself. Persists a dated log so a passive "reconciled / N drifting" signal is visible without re-running it. | Admin | `integrity-check.actions.ts:72-122`, `balancer.ts:143-211` | **P1** (invariant 1/10: the trial balance ties by construction; a Postgres CHECK+trigger design removes the *need* to periodically catch drift after the fact) | CORRECT |
| Financial integrity audit — 15 targeted drift detectors | A battery of read-only checks, each written to catch one specific, previously-real production incident: dashboard-summary counters vs. source docs, channel-AR missing after a re-record, stale shift roll-ups after a void, voided salesDays lingering in the live collection, AR collections with a floating unallocated residual, clearing/suspense accounts not netted to zero, deliveries cleared with no backing expense, supplier payments allocated to a voided/missing expense, branch-sale AR with no matching branch expense, void-cash suspense not resolved, salesDay cash+online vs. the actual posted sale journal, branch-sale display-mirror drift, and slicer-payroll production-summary drift. Optional one-click auto-fix re-runs the matching rebuild and reports before/after. | Admin | `integrity-check.actions.ts:1-1143` | mostly **NOT PLANNED as a standing tool** — P1's constraints (single ledger, enforced balance, control accounts) make roughly half these specific drift classes structurally impossible, but the *general capability* ("run a battery of sanity checks against the books on demand") has no named owner in any phase | ADD — the specific detectors retire with the bugs they were built for, but "a button that proves the books are internally consistent" is a real, load-bearing admin habit that deserves a designed home, not just an emergent side-effect of better constraints |
| Cash/ledger report snapshot (by preset or custom range) | Aggregates posted journal legs into the day/domain/source-type rollups the cash and ledger report pages render, computed live from the journal (no cache) so it's never stale. | Any store member with access | `reports.actions.ts:44-140` | **P6** | DUPLICATE |
| Cash account balances / ledger page / day-entries drill-down | Per-account balance list and transaction-level drill-down so a manager can trace "why does this account read what it reads" down to individual legs. | Any store member with access | `reports.actions.ts:144+` | **P6** | DUPLICATE |
| Workbook / print export of financial reports | Generates `.xlsx` server-side (expenses, receipts, AR, AP, and more) for a date range, and a structured payload for a browser print view — the way figures leave the system for an accountant, a lender, or a filing. | Manager, admin | `report-export.actions.ts`, `excel-export.actions.ts` | **P6** | DUPLICATE |
| Pending monthly-close checker (depreciation/amortization) | Scans a date range for every asset/prepaid item that *should* have posted its monthly depreciation/amortization but hasn't, estimates the amount, and runs all of it in one click — the safety net that stops a forgotten month from silently understating expense forever (surfaces as a blocking banner on the income statement, balance sheet, and daily-snapshot pages). | Admin (run), manager (see banner) | `monthly-runs.actions.ts:66-226` | *(not named — depends on P1's fixed and P2's expense-recognition modules, but no phase names the periodic "did we close everything" check itself)* | **NOT PLANNED** |
| Legacy opening-balance import (AP/AR/cash/staff-advance/staff-reimbursable) | The one-time bridge for bringing a store's pre-system balances into the ledger without restating history — posts balance-sheet-only journal entries against `equity__opening_balance`, idempotent per caller-supplied import id. | Admin | `legacy-import.actions.ts:1-300+` | **P1/ETL** (bible §G "Stage 2 — opening-balance entry as of a chosen date" is exactly this capability, generalized) | DUPLICATE |
| Bulk backfill from legacy projections | The same opening-balance import, automated across every counterparty in one pass (cash, AR, AP, assets, loans, liabilities, salary-advance balances) instead of one-by-one; dry-run mode previews the write set before committing. | Admin | `backfill-legacy-projections.actions.ts:1-100+` | **P1/ETL** | DUPLICATE |

---

## Capabilities with no home in the plan

Every row above marked **NOT PLANNED**, collected here with what breaks operationally if it is
never rebuilt. This is the primary deliverable of this pass.

1. **Fixed assets + depreciation** (register, dispose, monthly runner, legacy import — Group F).
   Without it: no fixed-asset register on the balance sheet, no monthly depreciation expense, and
   every CAPEX purchase either gets misclassified as a one-time expense or has nowhere to land.
   The chart of accounts in `docs/plans/phase-1-accounting-spine.md` §B already reserves 1500
   Property & equipment and 1590 Accumulated depreciation — the *account* exists in the plan; the
   *module that posts to it* does not.

2. **Prepaid items + amortization** (register, void/write-off, monthly runner, legacy import —
   Group F). Without it: a real, actively-used capability (insurance, permits, annual SaaS,
   prepaid rent) has no home. Every such purchase would either expense in full on the day paid
   (spiking that month's OPEX and understating every following month) or sit unrecognized on a
   balance no one tracks. 1400 Prepaid is reserved in the chart with the same gap.

3. **Loans** (register, payment, auto-deduct, interest tracking — Group F). Without it: no way to
   record a loan draw, service scheduled repayments, or track outstanding principal/interest.
   Channel-settlement loan deductions (Group D, a *planned* P2 capability) directly depend on a
   loan record existing to pay down — settlement posting would have nothing to point at. 2400
   Loans payable is reserved in the chart with the same gap.

4. **Owner equity movements** (capital contributions, drawings, void — Group F). Decision #57 in
   the bible explicitly confirms this is wanted ("Ian: never used, so design it right") — it is
   the one NOT-PLANNED item in this list that the bible has already partially acknowledged as an
   **ADD**, but no phase's "Delivers" column assigns building it. Without it: 3100/3200 sit in the
   chart of accounts with nothing that can ever move them except an opening-balance import.

5. **Generic liability accounts** (charge/payment/void — Group F). The *statutory* subset
   (SSS/PhilHealth/Pag-IBIG/withholding) is explicitly getting its own purpose-built subledger per
   decision #49 — that supersedes this capability for statutory obligations specifically. But v1's
   liability-account module also covers arbitrary non-statutory accruals (e.g. an accrued tax not
   otherwise modeled), and nothing in the plan names an owner for that residual case.

6. **Expense budgets** (per-category monthly cap + auto-reissue — Group B). Without it: a real
   manager control disappears — nothing stops a category from silently overspending, and the
   auto-reissue scheduling (daily/weekly/monthly/quarterly/annual reset) that keeps a budget
   current with zero manual upkeep has no replacement.

7. **Recurring expenses** (template, manual confirm, skip, auto-pay — Group B). Without it: every
   rent/utility/subscription bill reverts to fully manual, ad-hoc entry — losing due-date
   visibility, the safe-cash-routing-away-from-cashier-till default, and the self-healing
   idempotent auto-pay that currently turns a missed cron run into a caught-up run instead of a
   missed bill.

8. **A standing "prove the books tie out" admin tool** (Group G — the 15-detector integrity audit
   and its passive reconciliation log). P1's constraints retire the specific bugs most of these
   detectors were built to catch, but nobody has named an owner for the *habit* itself: an admin,
   today, can push one button before trusting a number and get a dated, itemized answer. Without an
   equivalent in v2, the first time something looks wrong there is no fast, already-built way to
   confirm whether it's real drift or a one-off — someone has to improvise a query instead of
   clicking a report that has existed for months.

9. **The periodic "did we close everything" check** (Group G — `monthly-runs.actions.ts`'s pending
   depreciation/amortization scanner). Even a correct posting engine doesn't *notice* on its own
   that March's depreciation was never run — something has to scan for the gap and surface it before
   the income statement quietly understates expense for a month that never got its entry. No phase
   names this specific watchdog, only the modules (assets, prepaid) it watches.

## Intent worth preserving

Business rules encoded in the code that a schema-only rewrite would lose. Each came from a real
incident, a specific edge case, or a deliberate trade-off — not an accident of implementation.

- **Cashier-drawer cash scoping.** The verified-sales-report lock protects the day's cash *count*,
  so only a payment that actually touches the cashier's own drawer is locked by it; AP/online/
  office/cash-request payments stay editable after verification because they can't threaten a
  count that's already been counted. `expense.actions.ts:126-139,217-226`.
- **Receipt-date authority.** Once an expense is linked to a receipt, the receipt's own entered
  document date — not whatever the client sent — is authoritative for the expense's business date
  and which period-lock check it's judged against. Closes a backdating hole even for a direct API
  call. `expense.actions.ts:179-197`.
- **Missing-vs-failed for the capitalization policy.** A missing policy doc defaults safely; a
  *failed* read refuses the post outright, because guessing would have understated depreciation by
  ~60% on everything capitalized afterward (a documented near-miss, not a hypothetical).
  `expense.actions.ts:57-89`.
- **CAPEX void is blocked once depreciation has posted.** The cost has already flowed to the P&L;
  unwinding it from the expense side isn't safe — dispose the asset through the asset module
  instead. `expense.actions.ts:1033-1049`.
- **`voidExpense` is one shared primitive, reused everywhere** (receipt void, sales-report
  adjustment, the generic admin void dispatcher) specifically because an earlier hand-rolled
  reimplementation in the receipt-void path missed 4 of 7 real reversal effects (budget,
  cash-request liquidation, the expense summary projection, and the CAPEX-asset guard) — a
  production incident, not a style preference. `receipt.actions.ts:14-18,568-602`.
- **A receipt void is refused while any salary advance is still tagged to it** — a salary advance
  is a named person's money movement with its own authorization; a prior version hard-reset the
  receipt's counters on void and permanently destroyed a live advance's contribution.
  `receipt.actions.ts:515-543`.
- **Recurring/scheduled payments default away from the cashier till.** An ambiguous or unset cash
  source resolves to office cash, never cashier, unless cashier was an explicit, deliberate choice
  at confirm time. `payment-routing.ts`, applied at `recurring-expense.actions.ts:230-235`.
- **Auto-pay never fails silently.** Insufficient funds, a locked day, or a variable amount each
  become a pending record + a manager alert — never a skipped payment nobody notices. A 7-day
  self-healing lookback window means a missed cron run catches up on its own without risking a
  double-post (idempotent per due date). `recurring-expense.actions.ts:565-739`.
- **Deleting a recurring template never touches its history.** Every expense it already generated
  keeps its `sourceId` link even after the template is gone — deleting them would silently rewrite
  past P&L. `recurring-expense.actions.ts:431-447`.
- **Cash-request self-approval is blocked, admin-exempt.** A requester can never approve their own
  request even as a manager — the same segregation-of-duties shape (self-block, admin-only
  override) recurs independently for salary advances and overtime approval elsewhere in the
  codebase; the exemption reasoning is the same each time (a single-admin store must still be able
  to act). `cash-requests.actions.ts:165-169`.
- **Cash-request approval is transactional specifically to close a negative-counter race.** A
  plain get→check→update let two concurrent approvals both read "pending" and both decrement the
  pending counter — a genuinely double-decremented counter, not a hypothetical.
  `cash-requests.actions.ts:153-159`.
- **A cash-request release void is refused once any float has been spent, returned, or
  shortage-charged** — those must be unwound first, in that order, so the reversal is never left
  half-done. `release-cash-request.actions.ts:227-241`.
- **AR collections keep a platform-fee deduction as its own distinct leg, never blended into the
  amount collected.** This exact discipline, violated once, is what produced the documented
  platform-fee double-count incident (₱198,148.29 across two stores, later fixed). It is the
  single highest-value rule to enforce *structurally* (not by convention) in v2.
  `ar-collection.actions.ts` header + `CLAUDE.md` high-risk rule #3.
- **Write-off is a controlled, balanced pair — never a direct field edit.** Direct edits to
  `outstandingAmount` are explicitly named in the code as the wrong path, because they break the
  balance-derivable-from-journal invariant. `ar-credit-sale.actions.ts:441-451`.
- **Channel-settlement fee components are SIGNED, not filtered to positive.** A promo/
  incentive-heavy day can produce a genuinely *negative* fee component (a real credit back to the
  merchant); the old "drop anything ≤ 0" behavior silently broke the clearing-nets-to-zero
  invariant and understated the net deposit by exactly the dropped credit, with no tripwire. This
  is the single subtlest money-math rule found across the whole domain.
  `channel-settlement.actions.ts:138-147,196-203`.
- **A settlement "gain" above tolerance requires an explicit confirm.** When a platform pays *more*
  than the recorded receivable (staff under-reported), the excess auto-books as income only below
  max(₱50, 10% of gross); above that, `recognizeGain:true` must be passed explicitly — a guard so
  a data-entry error can't silently become recognized income. `channel-settlement.actions.ts:189-194`.
- **A channel settlement that paid down a loan can't be voided directly** — the loan payment (or
  the cross-store paydown) must be reversed through its own module first, so the settlement
  reversal stays one well-understood transaction instead of a tangled multi-module rollback.
  `channel-settlement.actions.ts:569-576`.
- **Sales-report adjustment never writes a second offsetting entry.** It restates the source doc
  and re-posts the same journal builder under the *same* `sourceId`, letting the journal-writer's
  own delta math (new − prev) do the reversal automatically; a payment channel that disappeared
  from the corrected report is explicitly diffed against the old shape and voided — the sale
  builder silently *skips* a zeroed channel on a fresh post, which would otherwise leave a stale
  posted leg with no counterpart. `sales-report-adjustment.actions.ts:1-17`.
- **Every revenue adjustment recomputes ALL its derived fields from the merged inputs**, overriding
  whatever the caller sent for those keys — a real historical bug (Lipa, 2026-07-12) left
  `totalSales` stale after a channel-only correction. `sales-report-adjustment.actions.ts:19-26,303-328`.
- **Only the most recently applied adjustment can be voided (LIFO).** Voiding an older one out of
  sequence is refused outright — there is no partial-undo. `sales-report-adjustment.actions.ts:583-593`.
- **An expense-domain adjustment can never be auto-reversed once applied** — voided is permanent
  (revive was removed 2026-08-06); the only correction path is a brand-new expense record, the
  same "void is terminal" convention enforced everywhere else in the codebase.
  `sales-report-adjustment.actions.ts:687-701`.
- **Cross-store money movement is two separate, idempotent transactions, not one.** A branch
  paying its commissary supplier, and a channel-settlement loan deduction owned by another store,
  both split into a best-effort pair tied by a deterministic id, because Firestore cannot span two
  stores in one transaction. Already flagged in `03-business-logic.md` §2.3/§8 as "likely the
  single largest simplification available anywhere in this codebase" once both stores are rows in
  one relational database — reconfirmed here from the AP-payment and channel-settlement code
  directly. `payment.actions.ts:421-435`, `channel-settlement.actions.ts:257-266,472-512`.
- **A supplier return is deliberately narrow: stock + audit trail only, never AP/expense/journal.**
  `apAlreadyHandled` is a pure operator self-declaration surfaced to the UI — informational, never
  enforced or automated. This was a considered scope decision, not an oversight; confirm with Ian
  before ever making it enforce anything on the AP side. `supplier-return.actions.ts:1-9`.
- **Revenue is recognized only from a verified sales day.** A draft/submitted or voided day
  contributes ₱0 to the Income Statement — a cashier filling in a form does not move the P&L until a
  manager verifies it. Policy dated 2026-06-20, enforced by an explicit status allow-list, not an
  absence-of-void check. `income-statement.actions.ts:95-101`.
- **Branch-sale revenue is read from the commissary-dispatch receivable, not the salesDay,
  specifically so it can never be missed or double-counted.** It is recognized once, at the moment
  the branch's AR posts, independent of whether that branch's own cashier report exists yet for that
  date — closing a documented gap where a recognized inter-branch sale could sit with AR booked but
  no revenue showing (or the reverse). `income-statement.actions.ts:125-153`.
- **A P&L category is frozen onto the expense at post time and never re-derived later.** The income
  statement reads the `expenseEntryGroup` copied onto each expense the moment it posted, not a live
  lookup against the category master — so relabeling a category (COGS→OPEX) tomorrow can never
  silently rewrite last month's statement. `income-statement.actions.ts:167-172`.
- **The balance sheet's Retained Earnings is a plug, and the code treats that as a liability, not a
  convenience** — it ships its own tripwire (`unclassifiedAccounts`) specifically because a plug
  formula can never itself detect a misclassified account; the balance sheet would still "balance"
  while quietly understating both assets and equity by the same amount. This is a real, previously
  observed failure shape (a new account prefix falling through the classifier), not a hypothetical.
  `balance-sheet.actions.ts:94-106,236-244`.
- **A historical ("as of" a past date) balance sheet is restated from the journal, not read from
  today's running balances**, and voided legs are excluded regardless of when the void happened
  (status-flip void, not a dated reversal) — so a past-dated report reflects what was true as of
  that date under today's understanding of what's still valid, not a frozen snapshot of what the
  balances literally read back then. `balance-sheet.actions.ts:118-122,161-165`.
- **Order wastage the store absorbs is booked as a net-zero memo, not a P&L hit** — `DEBIT
  expense__order_wastage / CREDIT income__wastage_writeoff_contra`. The cooked item's raw-material
  cost already flowed through COGS at purchase time, so a second charge here would double-count the
  same physical loss; the memo exists purely to keep an auditable, queryable trail of *how much*
  wastage happened without moving net income. `wastage-expense.builder.ts:1-16`.
- **Void-cash-retained is deliberately never recognized as a sale.** Cash collected on a receipt
  that's later voided without a refund sits in the drawer backing no transaction; at remittance it's
  parked in a dedicated suspense liability (`liability__void_cash_suspense`) pending re-ring, refund,
  or a deliberate management decision to recognize it — instead of being folded into ordinary sales
  cash, which would recognize revenue that was never actually earned. A lingering non-zero balance
  is a standing integrity signal, not routine. `account-defs.ts:205-211`, `integrity-check.actions.ts:816-839`.
- **An unexplained cash surplus at remittance time is a liability, not income, until someone
  explains it.** `others__remittance_overage` is credit-nature specifically because a surplus could
  be tips, a miscounted prior deposit, or an error — the system refuses to guess that it's earned
  revenue by defaulting it there. `account-defs.ts:94-98`.
- **An overpayment to a supplier is tracked as the store's own asset (unapplied credit), not an
  error to correct.** `supplier_advance__{id}` lets a payment that exceeds allocated invoices become
  usable credit against a future invoice instead of failing the payment or requiring an immediate
  refund. `account-defs.ts:456-481`, `payment.actions.ts:283-285`.
- **When a delivery platform pays more than a locked sales report recorded, the excess is booked as
  other income on the settlement's own date rather than reopening the locked report.** Editing a
  closed period to fix a staff under-report was explicitly rejected in favor of recognizing the gain
  where it was actually discovered. `account-defs.ts:197-203`.
- **The integrity-check suite's detectors are each a scar from one specific incident, not generic
  hygiene** — e.g. the "deliveries cleared without a backing expense" check exists because a
  real bulk data-entry event (2026-05-01 to 06-15, all stores) left goods in inventory with no AP
  ever booked for them, and the check quantifies exactly how much liability is still unrecorded.
  Losing the *habit* of writing a targeted detector the moment a real data gap is found — not just
  losing these 15 specific checks — is the actual risk to carry forward. `integrity-check.actions.ts:628-672`.
- **VAT/SC-PWD compliance is explicitly out of scope for v2, by Ian's own decision, not an
  oversight to fix.** `06-accounting-gaps.md` flags v1's senior/PWD discount amounts being
  hardcoded to zero on the live sales-entry path as a real BIR-compliance gap — but
  `PROJECT_BIBLE.md` decision #75 already resolves this at the design level: **Shareat System is a
  management ledger, not a statutory filing basis.** No VAT engine, no output-VAT liability
  accounts, no BIR report builder; SC/PWD discounts become plain contra-revenue (4900) like any
  other discount. Anyone picking up the "senior/PWD" thread from `06-accounting-gaps.md` should read
  it as **already decided**, not as an open NOT-PLANNED gap in this document.
