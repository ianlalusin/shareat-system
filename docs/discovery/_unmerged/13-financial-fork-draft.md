# 13 — Financial & Accounting Capabilities Inventory

Source repo: `C:\Users\ianla\webapps\ERP-rebuild` (read-only discovery — nothing modified).
Domain: expenses · AP · AR · payments/collections · cash requests/advances/liquidation ·
remittance & cash handling · sales day/report · channel settlements · budgets · recurring
expenses · loans · fixed assets & depreciation · prepaid items · equity · bank/e-wallet
accounts.

**Framing.** Every row below answers "what business problem does this solve," not "how is
it coded." The owner's instruction stands: this codebase is a requirements document
written in TypeScript — flawed execution does not mean the need is fake. Where v1's own
architecture is already known-broken (no nominal ledger, no control accounts — see
`06-accounting-gaps.md`), that is noted but does not by itself make a capability a
DELETE-CANDIDATE.

**Verdict key** — DUPLICATE (works, carry it) · CORRECT (needed, v1's implementation is
wrong) · ADD (need is real, v1's version is incomplete) · DELETE-CANDIDATE (looks
redundant — **ask Ian, never assert delete**).

**Plan-mapping key** — phase numbers from `PROJECT_BIBLE.md` §10: 0 Foundation · 1
Accounting spine · 2 Money-moving source documents · 3 Inventory · 4 Attendance · 5
Payroll · 6 Reporting & dashboards · 7 Peripheral modules · 8 Cutover.

All rows are `[VERIFIED]` against the cited `file:line` in `ERP-rebuild` (read directly,
or read by a dispatched sub-agent working from these same instructions and reporting
back its own file:line citations).

---

## A. Sales day / cash remittance / day-close / reporting

| Capability | What problem it solves | Who | Where (v1) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Sequential-verification guard | Blocks starting a newer day's report while an older day is still unverified, so unposted revenue can't pile up silently | cashier/manager | `sales-day.actions.ts:23-42,343-356`; `sales-report-draft.actions.ts:189-210` | Phase 2 | CORRECT |
| Verify sales day | Locks the day's totals and posts the cash/online sale legs | manager/admin | `sales-day.actions.ts:49-160` | Phase 2 (+1 for the missing revenue leg) | CORRECT |
| Void sales day | Reverses a verified/remitted day, cascading to any channel-AR it created | manager/admin | `sales-day.actions.ts:167-309` | Phase 2 | CORRECT |
| Submit sales day (cashier handoff) | Cashier hands the day's tally to a manager for review | cashier | `sales-day.actions.ts:319-388` | Phase 2 | DUPLICATE |
| Per-shift cash drawer (cash-remit shift) | Tracks each cashier's own float/cash-in/cash-out/variance, independent of the day total — accountability per person, not just per store | cashier/manager | `sales-report-draft.actions.ts:330-495`; `cashRemit.utils.ts:19-41` | Phase 2 | CORRECT — easy to drop if a rebuild treats "sales day" as one flat total |
| Save sales day draft | Data-entry form pre-verification; recomputes branch-sale channel from AR every save rather than trusting client cache | cashier/manager | `sales-report-draft.actions.ts:94-324` | Phase 2 | CORRECT |
| Remit sales report | Records actual cash/online physically handed over; computes shortage/overage | manager/admin | `sales-report.actions.ts:39-380` | Phase 2 | CORRECT |
| Mark "nothing to remit" | Closes a day whose cash was already fully covered via transfers, without a redundant remit call | manager/admin | `sales-report.actions.ts:409-499` | Phase 2 | DUPLICATE |
| Reopen (disabled stub) | Dead back-door kept only as an always-errors stub redirecting to Adjustment | admin | `sales-report.actions.ts:384-407` | Phase 2 | DELETE-CANDIDATE — ask Ian if any UI still calls it |
| Multi-staff shortage allocation | Splits one shortage across N staff (e.g. ₱60/₱40) | manager/admin | `sales-report.actions.ts:522-706` | Phase 2 | CORRECT |
| Legacy single-staff shortage charge + void | Older single-owner shortage model, still live alongside the multi-allocation one | manager/admin | `sales-report.actions.ts:725-923` | Phase 2 | DELETE-CANDIDATE — ask Ian whether legacy path is still exercised |
| Void one shortage allocation | Reverses one allocation, rebuilds the staff's salary-advance balance | manager/admin | `sales-report.actions.ts:934-1026` | Phase 2 | CORRECT |
| Sales report Adjustment (restate-in-place correction) | The one sanctioned way to correct a verified/remitted report — restates the doc and re-posts under the SAME journal sourceId, voiding any leg dropped to zero | admin | `sales-report-adjustment.actions.ts:214-558` | Phase 2 | CORRECT — mechanism (restate-in-place) conflicts with v2 invariant 5 (posted entries immutable, corrections are reversal entries); need real, must be re-expressed as a reversal+re-post |
| Void an Adjustment (LIFO-only) | Reverses only the most recent correction; an expense-domain adjustment can never be auto-reversed | admin | `sales-report-adjustment.actions.ts:562-719` | Phase 2 | CORRECT |
| List adjustments / list day's expenses | Audit-trail support views | manager/admin | `sales-report-adjustment.actions.ts:723-796` | Phase 6 | DUPLICATE |
| Cash-request coverage of unremitted days | Lets a cash-request release pay down a past day's unremitted cash instead of drawing fresh petty cash; measured against net-of-outflows, never gross | manager/admin | `sales-coverage.actions.ts:38-194` | Phase 2 | ADD — cross-links two doc types; easy to omit if built independently |
| Manager Daily Review checklist | One-page daily health checklist aggregated from existing sources, read-only, with sign-off | manager/admin | `daily-review.actions.ts:75-355` | Phase 7 | DUPLICATE |
| Daily account-balance snapshot (cron + manual) | Nightly per-store balance/anomaly rollup that feeds ledger daily rows | system-cron / manager | `daily-snapshot.actions.ts:21-69` | Phase 6 | CORRECT |
| Dashboard "Attention Today" rail | Surfaces low-stock + open integrity findings, each source failing independently | manager/admin | `dashboard-attention.actions.ts:26-91` | Phase 6 | DUPLICATE |
| Dashboard Summary rebuild (self-heal) | Full recompute of AR/AP/cash-request/staff counters for the dashboard | any store member | `dashboard-summary.actions.ts:11-165` | Phase 1 (control accounts retire the need for a self-heal scan) + Phase 6 | ADD — v2 gets this mostly for free via views once control accounts exist |
| Sales target | Manager sets a monthly ₱ goal for actual-vs-target tracking | manager/admin | `sales-target.actions.ts:11-42` | Phase 6 | DUPLICATE |
| Sales channel benchmark (typo guard) | Trailing 60-day channel average, flags an implausible keyed amount | any store member | `sales-channel-benchmark.actions.ts:29-62` | Phase 6 | DUPLICATE |
| Financial Integrity Check Suite (~15 drift detectors, some auto-fix) | Catches the specific ways derived/projection data silently diverges from source (accounts-vs-journal, expense summary drift, duplicate meat names, missing channel AR, stale shift rollups, orphaned void leftovers, unallocated AR cash, unnetted clearing accounts, etc.) | admin | `integrity-check.actions.ts:45-1089` | Phase 1's ten invariants + CI tests structurally retire most of this class | ADD — several checks (e.g. duplicate active meat-product names, branch-sale AR↔expense mirror) are cross-domain informational checks no invariant covers |
| Ledger browsing (snapshot, balances, paginated ledger, account daily rows, custom range) | Lets a manager inspect cash movement and drill into one account's or one day's legs | manager/admin | `reports.actions.ts:131-388` | Phase 6 | DUPLICATE |
| Report export workbook + print view | Multi-report Excel export + single-date print layout | manager/admin | `report-export.actions.ts:181-305` | Phase 6 | DUPLICATE |
| Category export (parallel export system) | A second, separately-implemented Excel-data fetcher covering overlapping report categories | manager | `excel-export.actions.ts:21-285` | Phase 6 | DELETE-CANDIDATE — ask Ian whether this or `report-export` is authoritative |
| Balance Sheet (live + historical) | Full balance sheet from the ledger; Retained Earnings is a pure plug; `unclassifiedAccounts` tripwire catches any account the classifier doesn't recognize | manager/admin | `balance-sheet.actions.ts:125-317` | Phase 1 (trial balance) + Phase 6 (view) | ADD — v2 gets this from a view, but the tripwire discipline (never let an unclassified account silently vanish into RE) must be preserved |
| Income Statement generation (multi-source hybrid scan) | Full P&L for a date range; deliberately pulls revenue/cost from MANY places since v1 has no nominal ledger | manager/admin | `income-statement.actions.ts:55-505` | **Phase 1 — explicitly named as "retired by the nominal ledger" in bible §16.7 row 4** | ADD — v1's hybrid-scan mechanism is the workaround being replaced; the recognition RULES it encodes (branch-sale revenue from AR not salesDay; loan interest/AR-platform-fee/salary journal-only) are the intent to preserve |
| Save / list / delete Income Statement | Persist, browse, remove saved statements | manager/admin | `income-statement.actions.ts:509-576` | Phase 6 | DUPLICATE |

---

## B. Accounts Payable — expenses, suppliers, payments, receipts, deliveries

| Capability | What problem it solves | Who | Where (v1) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Create/edit posted expense w/ split payments | Records a cost with cash/online/credit/reimbursable/"other" splits in one document | cashier/manager | `expense.actions.ts:141-867` | Phase 2 | CORRECT |
| Cashier-cash vs non-cashier day-lock split | A verified sales report only locks money that actually left the cashier drawer; edit can't dodge the lock by switching payment methods | system | `expense.actions.ts:126-139,217-233` | Phase 2 | CORRECT — subtle rule, easy to lose |
| CAPEX auto-capitalization → depreciating asset | A big-ticket purchase becomes a fixed asset with straight-line depreciation instead of an immediate expense | system, manager-triggered | `expense.actions.ts:235-320,682-721` | **NOT PLANNED** (see below) | ADD |
| Cash-request liquidation on expense post/edit/void | Draws down a staff float as it's spent; edit restores-then-reapplies so it never double-counts | cashier/manager | `expense.actions.ts:354-369,723,1051-1057` | Phase 2 | CORRECT |
| Budget consumption + hard cap | Tracks monthly spend per category, blocks posting once a set cap is exceeded | manager | `expense.actions.ts:394-623` | Phase 2 — explicitly named in bible §16.4: "Budgeting and variance modules → Instead: **Existing budget feature only**" | DUPLICATE — deliberately kept as-is, not expanded |
| AP account + open-item projection + supplier index delta | Every credit expense seeds an `ap__{supplier}` account and open-item line | system | `expense.actions.ts:404-417,725-768` | **Phase 1 — invariant 6** (this is exactly the missing control-account problem) | ADD |
| Receipt recording-state sync | Keeps a receipt's "how much of this paper has been expensed" balance correct as expenses are tagged/untagged | system | `expense.actions.ts:465-521` | Phase 2 | CORRECT |
| Expense summary projection (atomic-with-post) | Feeds dashboard daily/category rollups without a separate rebuild step | system | `expense.actions.ts:770-794` | Phase 6 (views) | ADD — v2 gets this for free via a view; the "commit atomically with the source write, never fire-and-forget" lesson must be preserved |
| Learned particulars/category suggestion mapper | Populates "what did you buy" autocomplete from real usage | system | `expense.actions.ts:831-843,877-927` | **NOT PLANNED** | ADD |
| Learned delivery-link ratio stat | Feeds an AI rule flagging "this category is usually delivery-linked but this expense has no delivery" | system | `expense.actions.ts:845-855,937-954` | **NOT PLANNED** | ADD |
| Void expense — full reversal cascade | Reverses journal, AP open item, budget, cash request, unlinks any delivery — one call undoes everything a post did | manager/admin | `expense.actions.ts:956-1228` | Phase 2 | CORRECT |
| No "revive" — void is permanent | Corrections are always void + re-post, never un-void | — | `expense.actions.ts:1230-1235` | **Phase 1 — invariant 5, already matches v2's target model** | DUPLICATE |
| Rebuild all AP data (self-heal) | Recomputes every expense's paid/outstanding from actual payment allocations | manager+ | `ap.actions.ts:31-123` | Firestore-drift-specific; real FKs may retire the need | DELETE-CANDIDATE — ask Ian if still needed once Postgres enforces referential integrity |
| Mark supplier(s) reconciled | Formal "verified as of date" audit certification, zero ledger effect | admin | `ap.actions.ts:136-279` | **NOT PLANNED** | ADD |
| Set expense due date + resync AP | Correct/backfill a due date, refresh the AP-open projection | manager+ | `ap-client-bridge.actions.ts:21-40` | Phase 2 | DUPLICATE |
| Apply supplier payment allocated across N bills | Records "we paid supplier X ₱Y" spread across specific invoices; overpayment auto-seeds a supplier-advance account | manager/admin | `payment.actions.ts:137-442` | Phase 2 | CORRECT |
| Update / void a posted payment | Corrects/reverses a payment, restoring every AP balance and cash-request float it touched | manager/admin | `payment.actions.ts:444-950` | Phase 2 | CORRECT |
| Reconcile preview + confirm (FIFO auto-allocation) | One click applies leftover unallocated payment to a supplier's oldest open bills | manager/admin | `payment.actions.ts:953-1108` | Phase 2 | DUPLICATE |
| Commissary AR mirror on branch payment | A branch paying its commissary supplier auto-settles the matching inter-branch AR — one physical payment, two ledgers kept in sync, via a best-effort two-transaction fake distributed transaction | system | `payment.actions.ts:421-435,714-734,936-943` | **Phase 1 — invariant 6, reciprocal Due-from/Due-to elimination; landmine #27 names this exact pattern for structural retirement** | CORRECT — need real, mechanism is the thing v2 must not carry forward |
| Reconcile receipt balance (repair) | Recomputes a receipt's recorded/unrecorded amount from linked expenses AND salary advances | admin | `receipt.actions.ts:50-131` | Firestore-drift-specific | ADD |
| Create/edit supplier receipt, photo-proof gated | Captures the paper backing a purchase; blocks external-supplier receipts with no photo | cashier/manager | `receipt.actions.ts:205-421` | Phase 2 | CORRECT |
| VAT enforcement from supplier master | Rejects VAT fields on a non-VAT supplier, recomputes VAT server-side | system | `receipt.actions.ts:283-325` | Phase 2 (PH rules §16.5) | CORRECT |
| Verify a pending receipt | Manager confirmation before expenses can tag against it | manager/admin | `receipt.actions.ts:429-473` | Phase 2 | DUPLICATE |
| Void a receipt — cascades every linked expense | Removes a supplier doc and everything posted against it; refuses while a live salary advance is tagged to it | manager/admin | `receipt.actions.ts:475-649` | Phase 2 | CORRECT |
| Manage expense category taxonomy (group/category/rules) | Defines OPEX/COGS/CAPEX/PERSONAL/OTHERS and per-category rules (needs receipt/particulars/budget); system rows frozen | admin | `expense-entry.actions.ts:60-166` | Phase 2 infrastructure | ADD |
| Batch import/export categories via Excel | Bulk-onboard/update the category list | admin | `expense-entry.actions.ts:222-330` | Phase 7 | DUPLICATE |
| Per-store enable/disable of categories | Lets one store hide a category | manager+ | `expense-entry.actions.ts:339-453` | Phase 2/7 | DUPLICATE |
| Set monthly budget cap | Caps spend per category per month | manager/admin | `expense-budget.actions.ts:44-208` | Phase 2 (explicit §16.4 keep) | DUPLICATE |
| Auto-reissue budgets | Daily/weekly caps reset in place; monthly+ caps spawn a fresh doc only when due | system-cron | `expense-budget.actions.ts:214-361` | Phase 2 (explicit §16.4 keep) | DUPLICATE |
| Particulars autocomplete + archive/relabel | "What was bought" catalog with a self-healing read-model index | cashier/manager | `expense-particulars.actions.ts:41-171` | **NOT PLANNED** | ADD |
| Create/edit draft delivery (goods receipt note) | Captures what a delivery/purchase contains before posting to stock | cashier/manager/inv. staff | `delivery.actions.ts:57-306` | Phase 3, AP linkage secondary | CORRECT |
| Receive delivery → posts stock-in | Turns a draft into real on-hand stock; over-receipt hard-rejected unless a manager overrides | cashier/manager/inv. staff | `delivery.actions.ts:350-671` | Phase 3 | CORRECT |
| Void delivery → cascades expense/receipt/stock reversal | Undoes a delivery and everything it caused, sequential fail-fast | manager/admin | `delivery.actions.ts:675-924` | Phase 3 | CORRECT |
| Link / force-link / inline-create expense to a delivery item | Ties the financial record to the physical goods it paid for; cost-variance tolerance raised to ₱0.99 to absorb invoice rounding | cashier→admin (tiers) | `delivery.actions.ts:994-1239` | Phase 2/3 seam | CORRECT |
| Batch-record expenses across a whole delivery | One payment split allocated proportionally across every un-expensed item | cashier/manager | `delivery-expense.actions.ts:39-302` | Phase 2 | CORRECT |
| Record / void supplier return | Traceable stock-OUT for goods physically sent back — deliberately NOT wired to AP/expense/journal | inv. staff→admin | `supplier-return.actions.ts:76-421` | Phase 3 | CORRECT — the deliberate non-posting is intent, not a bug (see Intent section) |
| Define + confirm recurring/scheduled expense | Models rent, subscriptions, utilities; due dates computed from frequency | manager/admin | `recurring-expense.actions.ts:77-429` | Phase 2 | CORRECT |
| Prepaid/amortized recognition mode (from recurring expense) | A quarterly/annual bill books as a prepaid asset, amortized monthly instead of one lump P&L hit | manager/admin | `recurring-expense.actions.ts:116-125,254-342` | **NOT PLANNED** (ties to the missing prepaid module) | ADD |
| Scheduled auto-pay (cron, self-heal lookback) | Fixed-amount, autoPay-enabled bills post themselves; insufficient funds/locked day → pending + alert, never silent skip | system-cron | `recurring-expense.actions.ts:525-892` | Phase 2 | CORRECT |
| Safe-default cash routing (recurring payments) | A scheduled payment never silently drains the cashier till unless explicitly chosen | system | `payment-routing.ts` | Phase 1/2 intent | DUPLICATE |
| Delete template, preserve history | Removing a recurring template never rewrites past P&L (orphaned-by-design) | manager/admin | `recurring-expense.actions.ts:448-478` | Phase 2 | DUPLICATE |
| Skip a due date (with mandatory reason) | Records a deliberate non-payment | manager/admin | `recurring-expense.actions.ts:480-511` | Phase 2 | DUPLICATE |
| Manage bank/e-wallet/card accounts | Registers online payment rails with opening balances, seeds matching journal account | manager+ | `payment-accounts.actions.ts:25-149` | Phase 1 (COA) | CORRECT |
| Create/edit supplier master | VAT status, classification, bank accounts — the record everything hangs off | manager+ | `supplier.actions.ts:30-107` | Phase 2 | DUPLICATE |
| Admin delete supplier, blocked by live receipts | Prevents deleting a supplier out from under real history | admin | `supplier-admin.actions.ts:58-100` | Phase 2 | DUPLICATE |
| Bulk-transfer receipts between suppliers | Repoints receipts from a duplicate/wrong supplier | admin | `supplier-admin.actions.ts:108-166` | Phase 2 | DUPLICATE |
| Get/set global CAPEX policy | Threshold + default useful life + salvage value driving auto-capitalization | admin | `capitalization.actions.ts:29-80` | **NOT PLANNED** | ADD |
| Record / void reimbursement payout | Pays a staffer back for out-of-pocket purchase, nets the `staff_reimbursable__{staffId}` liability | manager/admin | `reimbursement.actions.ts:51-148,152-237` | **NOT PLANNED** (no phase names a staff-owed liability distinct from AP) | ADD |

---

## C. Accounts Receivable — customers, credit sales, collections, channel AR

| Capability | What problem it solves | Who | Where (v1) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Create/update AR customer + branch mirror | Sets up a customer ledger and auto-provisions the matching AP supplier on a linked branch | manager/admin | `ar-customer.actions.ts:32-98,105-199,168-192` | Phase 2 | CORRECT |
| Mark customer(s) reconciled | Certifies a customer as verified-zero-balance as of a date, zero ledger effect | admin | `ar-customer.actions.ts:210-340` | **NOT PLANNED** | ADD |
| Create credit sale | Records a sale on store credit as a receivable | cashier/manager | `ar-credit-sale.actions.ts:191-314` | Phase 2 | CORRECT |
| Update credit sale | Corrects a posted credit sale's amount without breaking the ledger | manager/admin | `ar-credit-sale.actions.ts:318-430` | Phase 2 | CORRECT |
| Void credit sale | Reverses a mis-entered credit sale; blocked if collections already applied | manager/admin | `ar-credit-sale.actions.ts:33-186` | Phase 2 | CORRECT |
| Write-off receivable (full or partial) | Formally writes off uncollectible AR as bad-debt expense | admin | `ar-credit-sale.actions.ts:453-596` | Phase 2 | CORRECT |
| Create AR collection | Records incoming payment with cashier/manager verification routing and proof-image gate for online | cashier/manager | `ar-collection.actions.ts:456-596` | Phase 2 | CORRECT |
| Apply AR collection — three-leg pattern | Applies a collection against receivables, keeping gross-applied/actual-received/platform-fee-kept as three distinct legs, never netted inline | manager/admin | `ar-collection.actions.ts:33-220` | Phase 2 | CORRECT — the three-leg separation is the intent to preserve |
| Void AR collection | Reverses a wrong/duplicate collection, reopens receivables, voids any spawned fee expense, runs a reconcile pass | manager/admin | `ar-collection.actions.ts:224-451` | Phase 2 | CORRECT |
| Record platform-fee expense (separate doc) | Books a platform's skimmed fee as its own P&L line via a doc, alongside the inline journal leg the apply-action already posted | manager/admin (UI) | `ar-collection.actions.ts:611-688` | Phase 2 | DELETE-CANDIDATE — ask Ian; this is the root cause of a confirmed real double-booking incident (`06-accounting-gaps.md` §3.2) |
| Auto-create channel AR | Opens a receivable per non-daily-remit channel after a sales day verifies | system, gated manager/admin | `ar-channel.actions.ts:39-237` | Phase 2 | CORRECT — the verify-lock exclusion list is intent worth preserving (bible §16.6) |
| Reconcile channel AR on adjustment | Keeps channel receivables in sync when an admin edits a verified report's channel breakdown | admin | `ar-channel.actions.ts:266-374` | Phase 2 | CORRECT |
| Repair channel AR (backfill) | Backfills missing channel-AR receivables across a date range | manager/admin | `ar-channel.actions.ts:398-467` | Firestore-drift-specific | ADD |
| Repair collection / void redundant platform-fee expenses | Two linked cleanup tools for the platform-fee double-booking bug | admin | `ar-maintenance.actions.ts:44-231,246-327` | Firestore-drift-specific, tied to the item above | DELETE-CANDIDATE — ask Ian whether permanent tooling or one-time cleanup |
| Admin force-delete (collection / credit sale) | Removes a record outside normal flow, routing through the real void path if anything posted | admin | `ar-maintenance.actions.ts:337-378,459-491` | **NOT PLANNED** | ADD |
| Recompute AR balance (drift correction) | Recomputes a customer's balance from receivables truth | admin | `ar-maintenance.actions.ts:390-446` | Firestore-drift-specific | ADD |
| AR aging report | Standard 30/60/90/90+ aging for collections prioritization | any store member | `ar-aging.actions.ts:40-165` | **Phase 6 — explicitly named in bible §16.4: "Instead: Due date + aging buckets"** | CORRECT |
| Record channel settlement — signed fee netting | Posts a platform payout: clears the receivable, books each fee/tax/penalty, nets any loan via clearing, deposits only the true net | manager/admin | `channel-settlement.actions.ts:62-525`; `channel-settlement/fees.ts`,`posting.ts` | Phase 2 | CORRECT — signed netting (never filter to positive-only) is explicit bible-preserved intent (§16.6) |
| Void channel settlement | Cleanly reverses a settlement; refuses if a loan was deducted (must reverse loan first) | manager/admin | `channel-settlement.actions.ts:548-735` | Phase 2 | CORRECT |
| Batch settlement plan → record | Upload a platform payout file covering many days; preview auto-classifies each day, post approved ones in one op | manager/admin | `channel-settlement-batch.actions.ts:67-147,171-271` | Phase 2 | CORRECT |
| Record channel adjustment (period-level charge/refund) | Books a platform charge/refund not tied to one day's receivable | manager/admin | `channel-settlement-batch.actions.ts:281-379` | Phase 2 | CORRECT |
| Repair orphan channel AR | Re-issues a channel receivable voided in error but actually paid by the platform | manager/admin | `channel-settlement-batch.actions.ts:388-512` | Firestore-drift-specific | ADD |
| Channel discrepancy → HR infraction | Traces a settlement mismatch to the filing cashier/verifying manager and files a disciplinary record | manager/admin | `channel-settlement-discrepancy-infraction.actions.ts:118-163,243-336` | **NOT PLANNED** (Phase 7 territory, not named) | ADD |
| Record online remittance | Records cashier→office cash/e-wallet transfer; shortage auto-charges a named staff member | manager/admin | `online-remittance.actions.ts:41-171` | Phase 2 | CORRECT |
| Void online remittance | Reverses a remittance and its shortage charge, rebuilds the SA projection | manager/admin | `online-remittance.actions.ts:184-278` | Phase 2 | CORRECT |

---

## D. Cash & accounts, cash requests / advances / liquidation

| Capability | What problem it solves | Who | Where (v1) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Set opening balance (cash/online) | Admin-only, idempotent one-time seed of a starting balance via a deterministic journal entry | admin | `accounts.actions.ts:32-89` | Phase 8 (opening-balance migration) | CORRECT — the "refuse to overwrite once set" idempotency pattern is intent worth preserving |
| Create balance adjustment | Admin reconciliation glue for "found extra cash" / "count short," posted through the same journal-writer as everything else, motive captured in `reason` | admin | `accounts.actions.ts:93-161` | Phase 1/2 | CORRECT |
| Get cash accounts with opening-balance status | Read model powering the accounts dashboard cards, with fallback seed rows for a brand-new store | any store member | `accounts.actions.ts:191-327` | Phase 6 | DUPLICATE |
| Accounts dashboard (chart of accounts + AR/AP totals) | One summary screen: cash/online balances plus AR/AP outstanding totals and counterparty counts | any store member | `accounts.actions.ts:343-390` | **Phase 1 — control accounts make this a native, always-correct view instead of a live scan-and-sum** | ADD |
| Update cash account settings (rename, set owner) | Lets a manager relabel/re-own a cash sub-account, mirrored to `paymentAccounts` for online | manager/admin | `accounts.actions.ts:394-462` | Phase 1 | DUPLICATE |
| Rebuild account balance from journal (self-heal) | Recomputes one account's totals/monthly rollups from posted legs when the incremented balance drifts | manager/admin | `accounts.actions.ts:466-563` | Firestore-drift-specific; v2 balances are pure views, no cached-field drift possible | DELETE-CANDIDATE — ask Ian |
| Create cash request | Any staff member requests a float for a purpose, date-locked to the requested day | any staff | `cash-requests.actions.ts:35-91` | Phase 2 | CORRECT |
| Update cash request | Edits an undecided request; owner or manager/admin only | requester/manager/admin | `cash-requests.actions.ts:93-135` | Phase 2 | DUPLICATE |
| Approve cash request | Self-dealing block (requester can't approve own request, even as manager — admin override only); transactional read-check-write specifically fixes a real double-decrement race in the dashboard pending-count | manager/admin | `cash-requests.actions.ts:137-196` | Phase 2 | CORRECT — the race-condition fix (transactional status check "PROVES the prior status," not just observes it) is intent worth preserving |
| Reject cash request | Declines a pending request with a mandatory reason | manager/admin | `cash-requests.actions.ts:198-246` | Phase 2 | DUPLICATE |
| Void cash request (pre-release only) | Cancels a request before money moved; refuses once released (that path reverses the ledger instead) | manager/admin | `cash-requests.actions.ts:256-317` | Phase 2 | CORRECT |
| Release cash request (envelope vs. till cash-source modes) | Hands the approved float to the requester from cashier/online/office; "envelope" mode draws capped, FIFO-attributed prior-day unremitted cash, re-validated server-side against a fresh scan (never trusts the client's cap check) | manager/admin | `release-cash-request.actions.ts:28-185` | Phase 2 | CORRECT — the envelope/till distinction is a real, non-obvious cash-source rule |
| Void a release | Reverses a released-but-unspent request; refuses if any of the float was already consumed by expenses, returned, or shortage-charged — those must be voided first | manager/admin | `release-cash-request.actions.ts:199-319` | Phase 2 | CORRECT |
| Return a cash request | Records the unspent remainder coming back; sub-₱1 variance auto-closes, material variance stays open for a shortage charge | manager/admin | `return-cash-request.actions.ts:28-140` | Phase 2 | CORRECT |
| Charge cash-request shortage to staff | Converts unreturned float into the staff member's `staff_advance` receivable (repaid via payroll) — replaced an older off-ledger liability model | manager/admin (`canChargeStaff`) | `charge-cash-request-shortage.actions.ts:42-178` | Phase 2 | CORRECT |
| Void a shortage charge | Reverses the charge, restores remaining/variance, reopens the request if the restore crosses the auto-close threshold | manager/admin (`canVoidRecords`) | `charge-cash-request-shortage.actions.ts:189-310` | Phase 2 | CORRECT |

---

## E. Fixed assets, depreciation, prepaid, loans, liabilities, equity

| Capability | What problem it solves | Who | Where (v1) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Create/edit fixed asset + auto-depreciation schedule | Registers equipment/furniture/vehicles as a depreciating balance-sheet asset instead of a one-time P&L hit; computes monthly straight-line depreciation from cost/salvage/useful-life | manager/admin | `asset.actions.ts:35-178` | **NOT PLANNED — primary finding, see below** | ADD |
| Import legacy asset (mid-life) | Onboards an asset acquired before go-live, preserving its already-accumulated depreciation and continuing at the original monthly rate | manager/admin | `asset.actions.ts:201-324` | NOT PLANNED | ADD |
| Update asset status | Simple lifecycle flip | manager/admin | `asset.actions.ts:326-348` | NOT PLANNED | DUPLICATE |
| Dispose asset (write-off, P&L loss) | Clears a broken/lost asset off the books and recognizes remaining book value as a loss | manager/admin | `asset.actions.ts:367-494` | NOT PLANNED | ADD — v1's own version is a landmine (bible #34: the loss posts to the journal but appears on **no** report — asset write-offs never reduce reported net income today) |
| Process monthly depreciation (interval-aware, idempotent) | Posts the period's depreciation for every active asset, respecting monthly/quarterly/annual intervals, capped at salvage value | manager/admin | `depreciation.actions.ts:67-232` | NOT PLANNED | ADD |
| Void monthly depreciation | Reverses one asset's one-month depreciation post, restores accumulated/book value | manager/admin | `depreciation.actions.ts:245-375` | NOT PLANNED | ADD |
| Create/edit prepaid item (capitalization threshold, on-account) | Books an annual insurance/permit/rent prepayment as a current asset instead of one lump P&L hit; below-threshold amounts are refused (file as OPEX instead) | manager/admin | `prepaid.actions.ts:69-243` | **NOT PLANNED — primary finding, see below** | ADD |
| Void prepaid item (cascade) | Reverses every posted leg (purchase, amortizations, write-offs, refunds) tagged to one item | manager/admin | `prepaid.actions.ts:255-349` | NOT PLANNED | ADD |
| Write off prepaid item (early termination, optional refund) | Early-cancels a policy/contract, recognizing remaining book value as expense and/or booking a refund as a pure balance-sheet move | admin only | `prepaid.actions.ts:369-498` | NOT PLANNED | ADD |
| Import legacy prepaid item | Onboards a prepaid item already in force before go-live | admin | `prepaid.actions.ts:516-623` | NOT PLANNED | ADD |
| Process monthly amortization (prepaid, idempotent) | Recognizes 1/coverageMonths of each active prepaid item's cost as non-cash expense every month, whole-month (no daily pro-rate), capped at the tail | manager/admin/system | `amortization.actions.ts:73-242` | NOT PLANNED | ADD |
| Create/manage generic liability account | A named accrued-obligation account (statutory, custom, admin-defined) distinct from AP | manager/admin | `liability.actions.ts:34-88` | **Phase 1 (accounts) + Phase 5 (statutory subledger, §16.5)** — the generic free-form liability beyond statutory has no explicit home | ADD |
| Record liability charge | Increases a liability with a caller-chosen counter-account, nature-inferred direction | manager/admin | `liability.actions.ts:92-198` | Phase 1/5 | CORRECT |
| Record liability payment | Decreases a liability; rejects over-payment rather than silently truncating and auto-flipping to settled (a real historical bug fix) | manager/admin | `liability.actions.ts:202-313` | Phase 1/5 | CORRECT |
| Void liability charge / payment | Reverses either, restoring balance and status | manager/admin | `liability.actions.ts:315-473` | Phase 1/5 | CORRECT |
| Loan interest total (read-only) | Sums journal-only interest legs for a date range since loan interest has no backing expense doc and would otherwise be invisible to P&L | manager/admin | `loan.actions.ts:44-81` | **Phase 1 — retired by the nominal ledger** | ADD |
| Create/edit loan (amortization schedule, disbursement) | Registers a lender loan with amortizing/other interest method, computes the repayment schedule, posts disbursement to a chosen source account (or opening-balance for legacy loans) | manager/admin | `loan.actions.ts:85-230` | **NOT PLANNED — primary finding, see below** | ADD |
| Record loan payment (principal/interest split, dedup key) | Posts a payment, splitting principal vs. interest; rejects principal over-payment; supports an idempotency key for automated (e.g. channel-settlement-deducted) postings | manager/admin | `loan.actions.ts:234-418` | NOT PLANNED | ADD |
| Void loan payment | Reverses a payment, restores loan status to active | admin only | `loan.actions.ts:422-521` | NOT PLANNED | ADD |
| Loan auto-deduct (scheduled repayment cron) | Posts every due scheduled repayment across all stores, idempotently, computing principal/interest split via the amortization schedule each run | system-cron / manager (run-now) | `loan.actions.ts:523-650` | NOT PLANNED | ADD |
| Create/manage owner (capital account holder) | Registers an owner with ownership %, drawing limit/period | admin | `equity.actions.ts:47-102` | Phase 1 (equity account type exists in COA) | CORRECT |
| Record capital contribution | Owner puts money into the business; posts a 2-leg journal | manager/admin | `equity.actions.ts:106-209` | Phase 1 | CORRECT |
| Record drawing (with drawing-limit check) | Owner withdrawal; blocked once cumulative drawings exceed a configured total limit | admin only | `equity.actions.ts:213-312` | Phase 1 | CORRECT |
| Void equity movement | Reverses a contribution or drawing, restores owner totals | admin only | `equity.actions.ts:321-411` | Phase 1 | CORRECT |

---

## F. Admin/system financial tooling (bootstrap, repair, migration)

| Capability | What problem it solves | Who | Where (v1) | ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Seed system accounts (COA bootstrap) | Idempotently seeds cash/online/system accounts for a new or pre-existing store | admin/system | `financial-init.actions.ts:141-161` | **Phase 1 — this literally is Phase 1's chart-of-accounts seed job** | DUPLICATE |
| Reconcile accounts + orphaned-remittance cleanup | Single-pass: seeds missing online accounts, recomputes drift, cleans stale direct-flow remittance entries left by an old repair run | admin/manager | `financial-init.actions.ts:173-280` | Firestore-drift-specific; v2 invariants should make this structurally unnecessary | DELETE-CANDIDATE — ask Ian |
| Rebuild account balances from journal | Same rebuild, exposed as its own action | admin/manager | `financial-init.actions.ts:288-307` | same | DELETE-CANDIDATE — ask Ian |
| Seed global expense catalog | Seeds/repopulates the top-level expense-category taxonomy | admin | `financial-init.actions.ts:316-334` | Phase 2/7 | DUPLICATE |
| Migrate legacy expense-entry IDs | One-time rewrite of expense docs referencing retired category IDs | admin/manager | `financial-init.actions.ts:344-413` | One-time migration, not a standing capability | DELETE-CANDIDATE — ask Ian; not a feature to re-implement, only relevant during ETL |
| Repair cash journal (date-scoped re-post) | Re-posts missing cash-domain journal legs from source docs (salesDays, transfers, cashRequests, salaryAdvances) for a date range | admin/manager | `financial-init.actions.ts:437-676` | Firestore-drift-specific; real DB constraints (invariant 1: no single-leg escape hatch) should make "missing legs" structurally impossible | DELETE-CANDIDATE — ask Ian |
| Diagnose cash journal (read-only missing-leg probe) | Explains WHY legs are missing (unverified days, zero-amount days, missing account seeds) before repair runs | admin/manager | `financial-init.actions.ts:744-1049` | same | DELETE-CANDIDATE — ask Ian |
| Repair online account journal legs | Re-posts missing online-only legs for a date range, rebuilds online balances | admin/manager | `financial-init.actions.ts:1069-1142` | same | DELETE-CANDIDATE — ask Ian |
| Provision store (finish store setup) | Runs every store-bootstrap seed step (accounts, expense categories, infraction types, inventory locations) and reports a human checklist for what's left — replaced a fire-and-forget client-side seed that could silently half-fail | admin | `store-provision.actions.ts:52-130` | Phase 0/7 — no phase names a store-onboarding checklist explicitly | ADD |
| Get store readiness checklist (read-only) | Same checklist without running seeds | admin | `store-provision.actions.ts:133-146` | Phase 7 | DUPLICATE |
| Get pending monthly runs (R7 report-time gate) | Detects months with unposted depreciation/amortization and surfaces a blocking banner on income-statement/balance-sheet/snapshot pages | any store member | `monthly-runs.actions.ts:66-161` | Tied to the missing assets/prepaid modules | ADD |
| Get prepaid balance summary (dashboard KPI) | Sums all `prepaid__*` account balances for a quick dashboard tile | any store member | `monthly-runs.actions.ts:167-200` | same | DUPLICATE |
| Run pending monthly runs (batch) | Executes amortization + depreciation for every flagged month in sequence, admin-gated as a period-close action | admin | `monthly-runs.actions.ts:203-226` | same | ADD |
| Import legacy AP/AR/staff-advance/staff-reimbursable/cash balance (5 actions) | Onboards a store's pre-system opening balances per counterparty, one call each, idempotent per caller-supplied import id | admin | `legacy-import.actions.ts:39-374` | **Phase 8 — exactly what "opening-balance migration only" needs (bible §G Stage 2)** | CORRECT |
| Backfill from legacy projections (bulk opening-balance import) | Same opening-balance import, but reads every legacy aggregate (cashAccounts, arCustomers, ap_suppliers_index, assets, loans, liabilityAccounts, salary-advance) and posts the whole set in one bulk, dry-run-capable operation | admin | `backfill-legacy-projections.actions.ts:61+` | Phase 8 | CORRECT |
| Save POS payment-method map (admin full rewrite) | Maps a POS payment-method string to a real payment account, admin-controlled | admin | `store.actions.ts:211-233` | Phase 2 | DUPLICATE |
| Resolve one unmapped POS payment method (additive-only) | Lets a manager fill exactly one gap at closing time without being able to re-point or delete a mapping an admin already set; restricted to active, cashier-owned accounts only | manager | `store.actions.ts:244-291` | Phase 2 | CORRECT — the additive-only + cashier-owned-only guards are real business rules, not incidental |

---

## Capabilities with no home in the plan

This is the primary deliverable. Grouped by what breaks operationally if never rebuilt.

### 1. Fixed assets & depreciation — entire module absent from all 8 phases
`asset.actions.ts`, `depreciation.actions.ts`, and the CAPEX-auto-capitalization half of
`expense.actions.ts` (`:235-320,682-721`) have no phase. Unlike loans/prepaid/budgets,
**this is not in bible §16.4's deliberate-omission list either** — it is simply
unscheduled. **What breaks:** every equipment/furniture/vehicle purchase either has no
way to be tracked as a depreciating asset (posts as a full P&L expense the month it's
bought, distorting margins) or has to be manually shoe-horned into a generic liability/
expense account with no depreciation schedule, no book value, no disposal/write-off
accounting. A restaurant group buying grills, freezers, delivery vehicles, and POS
hardware needs this routinely, not as an edge case.

### 2. Prepaid expenses & amortization — entire module absent
`prepaid.actions.ts`, `amortization.actions.ts`, and the prepaid-mode half of
`recurring-expense.actions.ts` (`:116-125,254-342`). Also unscheduled, not deliberately
omitted. **What breaks:** annual insurance, business permits, and prepaid rent either
hit the P&L as one lump-sum expense in the month paid (distorting that month's net
income) or get tracked off-system in a spreadsheet, defeating the point of "the books
are correct."

### 3. Loans — entire module absent
`loan.actions.ts` — loan registration, amortization-schedule computation, payment
recording with principal/interest split, void, and the auto-deduct cron. Also
unscheduled. **What breaks:** a lender loan (working-capital, equipment financing) has
no home; either it's crammed into the generic liability-account actions (which lose the
amortization schedule, the principal/interest split, and the auto-deduct cron this
codebase clearly needed enough to build), or a business owner tracks loan payments by
hand outside the system.

### 4. Owner capital, drawings, drawing limits — workflow absent even though the account type exists
`equity.actions.ts`. The bible's chart-of-accounts design (§16.3) declares `equity` as
one of five account types, so the *ledger slot* exists in Phase 1 — but no phase names
the *workflow* to move money into or out of it (owner CRUD, contribution/drawing
recording, drawing-limit enforcement). **What breaks:** an admin has no sanctioned way to
record "the owner put in ₱200,000" or "the owner drew ₱50,000," and the drawing-limit
guard (a real control against uncontrolled owner withdrawals) has no equivalent.

### 5. Reimbursement payouts as a distinct staff-owed liability
`reimbursement.actions.ts` — pays a staffer back for an out-of-pocket business expense,
netting a `staff_reimbursable__{staffId}` liability kept separate from both AP (supplier
money) and salary-advance (staff-owed-to-store money). No phase names this. **What
breaks:** if folded into generic AP, staff and supplier obligations lose the
distinguishing field that today prevents a reimbursement claim from being mistaken for a
vendor bill on reports and aging views.

### 6. Statutory-remittance and other multi-purpose "generic liability" beyond §16.5's specific SSS/PhilHealth/Pag-IBIG subledger
`liability.actions.ts`'s generic charge/payment/void pattern is used today for
statutory withholding AND ad-hoc admin-defined accrued liabilities (e.g.
`tax_payable_2026q1`). Bible §16.5 plans the statutory subledger specifically for Phase
5. **What breaks if the generic pattern isn't also carried forward:** any liability that
isn't SSS/PhilHealth/Pag-IBIG/withholding-tax (a permit renewal accrual, a legal
settlement payable, a utility deposit liability) has nowhere to post.

### 7. Drift-repair / self-heal admin tooling as a class
`ap.actions.ts:rebuildAllApDataAction`, `financial-init.actions.ts`'s five repair/
diagnostic actions, `accounts.actions.ts:rebuildAccountBalanceAction`,
`ar-maintenance.actions.ts`'s repair/recompute trio, `ar-channel.actions.ts:
repairChannelArAction`, `channel-settlement-batch.actions.ts:repairOrphanChannelArAction`.
No phase names "drift-correction admin tooling" as a deliverable — the implicit bet is
that Postgres's real constraints (FKs, CHECK, the ten invariants) make this class of bug
structurally rarer. **What breaks:** even a correct system accumulates edge cases
(a partial migration, a bug in a future feature, a manual data fix gone wrong) where a
derived total legitimately drifts from source. Today's operators have a self-service
"Rebuild" button; a v2 with no equivalent forces every drift into a support ticket or a
hand-run SQL script — a real regression in operability even if it's never load-bearing
for correctness.

### 8. AI-assisted expense data entry (particulars autocomplete, delivery-link-ratio anomaly signal)
`expense-particulars.actions.ts`, plus the two learned-suggestion helpers inside
`expense.actions.ts` (`:831-855,877-954`). No phase covers AI-assisted data entry or the
"this category is usually delivery-linked but this expense has no delivery" anomaly
signal. **What breaks:** lower severity — data-entry staff lose an autocomplete
convenience, and one AI-insight source (a real, if minor, fraud/error signal) goes
quiet. Not a correctness gap, but worth a deliberate decision rather than a silent drop.

### 9. Channel-settlement discrepancy → staff infraction filing
`channel-settlement-discrepancy-infraction.actions.ts`. Sits at the seam between Phase 2
(settlement math) and Phase 7 (HR/infractions), named by neither explicitly. **What
breaks:** a recurring settlement variance traced to a specific cashier or verifying
manager has no linked disciplinary record — it becomes an informal, untracked
conversation instead of an auditable accountability trail.

### 10. Mark-reconciled / bulk-mark-reconciled (AR and AP)
`ar-customer.actions.ts:210-340`, `ap.actions.ts:136-279`. A pure "we verified this
balance was zero/correct as of date X" audit certification, zero ledger effect, fits no
phase's deliverable list. **What breaks:** no formal, timestamped record of a completed
reconciliation review exists for audit purposes — reconciliation becomes something that
happened in someone's head, not something the system attests to.

---

## Intent worth preserving

Business rules encoded in the code that a schema-only rewrite would lose.

1. **Envelope vs. till cash-request release modes** (`release-cash-request.actions.ts:36-45,92-101`).
   "Envelope" draws capped, FIFO-attributed prior-day unremitted cash; "till" draws
   today's own drawer. The distinction determines whether the release counts against
   today's sales-report auto-deduction — losing it would let a manager accidentally
   double-draw against cash that's already spoken for.

2. **Cash-request approval race fix is structural, not incidental**
   (`cash-requests.actions.ts:153-188`). The approve/reject/void actions wrap the
   status-read-and-flip in a transaction specifically because a plain get→check→update
   let two concurrent approvals both read `pending` and both decrement a dashboard
   counter — a real, dated (2026-08-05) production incident. Any rebuild of the
   approval flow must re-derive "prior status" from a value the transaction itself
   proved, never from an outer, non-atomic read.

3. **Reject over-payment on liability/loan payments instead of silently truncating**
   (`liability.actions.ts:263-267`, `loan.actions.ts:365-370`). Both files carry an
   explicit comment: an earlier `Math.max(0, …)` silently truncated an excess payment
   and auto-flipped the account to settled/paid-off — a real historical bug. The fix
   (throw, don't clamp) is the correct instinct and must survive.

4. **Cross-store commissary payment mirror is best-effort by design, non-fatal**
   (`payment.actions.ts:421-435`). A mirror failure must never block the real branch
   payment from recording — v2 gets to make this a single ACID transaction instead, but
   the underlying business fact (the branch's payment is authoritative; the commissary
   side is a reflection of it) must still hold even if the mechanism changes.

5. **Additive-only POS payment-method resolution for managers**
   (`store.actions.ts:235-283`). A manager closing at night can fill exactly one gap in
   the payment-method map; they cannot re-point or delete a mapping an admin already
   set. This prevents a closing-time fix from silently redirecting money an admin
   deliberately routed elsewhere.

6. **Supplier returns deliberately do not touch AP/expense/journal**
   (`supplier-return.actions.ts`, per `06-accounting-gaps.md §1.6`: "does not touch
   AP/expense/journal by design"). A return moves stock only; any AP credit for the
   returned goods is a manual, informational reminder, never an enforced posting. This
   reads as a gap but is a stated design choice — confirm with Ian before "fixing" it
   into an automatic AP credit, since the intent may be that returns are rare enough
   that automatic reversal risk (wrong amount, wrong period) outweighs the convenience.

7. **Drawing-limit check on owner withdrawals** (`equity.actions.ts:249-253`). Only a
   `total`-period limit is enforced today (no `monthly` enforcement path was found
   wired), but the schema and the check both anticipate it — worth confirming with Ian
   whether monthly drawing limits were intended to work and silently don't, or were
   deliberately deferred.

8. **Void-is-permanent, correction-is-always-a-new-record** — already a v1 convention
   (`expense.actions.ts:1230-1235` and the policy-engine citations in
   `03-business-logic.md §2.10`) that happens to already match v2's target invariant 5.
   The one place this is NOT yet true in v1 is the sales-report Adjustment flow, which
   restates a doc in place — that is the one correction path that needs deliberate
   re-expression as a reversal, not a silent carry-forward.

9. **Idempotent, deterministic ids for every legacy-import and repair action**
   (`legacy-import.actions.ts`, `backfill-legacy-projections.actions.ts`,
   `accounts.actions.ts:26-28,55-56`). Every opening-balance and backfill action is
   keyed so a retried or re-run call is a safe no-op, never a duplicate. This is exactly
   the idempotency discipline bible §11 rule 2 requires of the v2 ETL — the v1 pattern
   is the reference implementation to port the *principle* of, even though the
   mechanism (deterministic Firestore doc ids) doesn't carry over literally.
