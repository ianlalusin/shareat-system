# 06 — Accounting Gaps: Where the Current ERP Is Wrong, Incomplete, or Non-Standard

Source repo: `C:\Users\ianla\webapps\ERP-rebuild` (read-only discovery — nothing modified).
Purpose: requirements input for ERPv2, whose primary goal is correct, industry-standard, simple accounting.

Sources read: `AGENTS/ERP Guardian/OPEN_CONCERNS.md` (953 lines, read in full), `src/lib/financial/ACCOUNTING_BLUEPRINT.md` (1217 lines, read in full), `AGENTS/ERP Guardian/DECISION_LOG.md` (1009 lines, read in full), `AGENTS/ERP Guardian/CHANGE_REVIEW_LOG.md` (4465 lines, skimmed by section header + targeted reads), `src/lib/financial/journal/journal-writer.ts`, `src/lib/financial/balancer/balancer.ts`, `src/lib/financial/accounts/account-defs.ts`, `src/lib/financial/journal/builders/{expense,sale,ar-collection,wastage-expense}.builder.ts`, `src/lib/actions/income-statement.actions.ts`, `src/lib/payroll/statutory.ts`, `src/lib/actions/payroll-recurring-seed.actions.ts`, `src/lib/financial/vat.ts`, `docs/INVENTORY_GAPS.md`, `docs/derived-counter-review.md`, `docs/split-payments.md`, `docs/CURRENT_STATE.md`, `docs/supplier-routing.md`, `docs/linked-data-pattern.md` (skimmed, not accounting-relevant), plus targeted greps across `src/`.

Claim provenance markers used throughout:
- **[DOCUMENTED]** — already recorded as a known concern/decision in OPEN_CONCERNS.md or DECISION_LOG.md.
- **[FOUND]** — discovered independently during this pass, reading code/docs directly.
- **INFERRED** — not directly stated by the codebase's own docs; reasoned from code structure. Flagged explicitly.

---

## 1. The current accounting model — how it actually works

### 1.1 Confirmed: one leg per document, not header+lines

The premise in the task brief is correct and precisely verifiable in code. A "journal entry" in this system is **not** a header document with an array of debit/credit lines. It is a flat collection, `stores/{storeId}/journal/{entryId}`, where **each document is a single account movement** (`src/lib/financial/journal/journal-writer.ts:33-56`, the `JournalEntryInput` shape):

```ts
interface JournalEntryInput {
  storeId, businessDate, sourceType, sourceId, legKey,
  accountId, direction: 'in' | 'out', amount, status?: 'posted'|'voided', ...
}
```

- `accountId` — one account per doc (e.g. `cash__cashier`, `ap__{supplierId}`).
- `direction` — `'in'` (balance increases) or `'out'` (balance decreases). **Nothing else.** (`ACCOUNTING_BLUEPRINT.md:94-99`, glossary at `:1186`).
- A multi-leg "transaction" (e.g. an AR collection with a platform fee) is a **group of 2-3 separate documents** that share `sourceType`+`sourceId` but each carry their own deterministic id: `buildJournalEntryId(sourceType, sourceId, legKey)` (`journal-writer.ts:89`). There is no parent/header document tying the legs together as a unit — grouping is implicit, by convention (same `sourceType:sourceId` prefix), not enforced by schema.
- `computeDeltas()` (`journal-writer.ts:233-269`) treats each leg independently: it reads the previous version of *that one leg* and computes the balance delta for *that one account*. There is no cross-leg invariant enforced at write time inside `commitJournalLegs` itself — balance is validated separately, before the write, by the balancer (§1.2).

**Debit/credit is not stored.** `direction: in/out` is the only stored polarity. "Debit" or "credit" is *derived* at read time by combining `direction` with the account's **nature**, which itself is inferred from a string-prefix convention on `accountId` (`src/lib/financial/accounts/account-defs.ts:19-43`):

| Prefix | Nature |
|---|---|
| `ap__*`, `liability__*`, `staff_reimbursable__*`, `income__*`, `equity__*`, `contra_asset__*`, `others__remittance_overage` | credit |
| everything else (`cash__*`, `online__*`, `ar__*`, `asset__*`, `prepaid__*`, `staff_advance__*`, `expense__*`, `clearing__*`, `others__*`) | debit |

`balancer.ts:52-56` (`isLegDebit`) then classifies each leg as a textbook debit or credit contribution using `nature × direction`, purely for the pre-write balance check (§1.2). Nothing about "debit" or "credit" is ever persisted on the leg document itself.

### 1.2 Balance maintenance and validation

- **`validateJournalBalance()` (`balancer.ts:63-86`)**: sums debit-contribution legs vs. credit-contribution legs across the set of legs about to be written, and requires `|debits − credits| < 0.005` (half a centavo). Called before commit for multi-leg entries (`assertJournalBalanced`).
- **Single-leg entries are defined as "trivially balanced" (`balancer.ts:64-67`).** This is load-bearing and consequential — see §3.1: most ordinary expense recognition posts exactly **one** leg (the cash/AP/online side) with **no counter-leg for the expense account itself**, and the balancer explicitly does not object.
- **Account balances** (`accounts/{accountId}.balance`) are maintained by `FieldValue.increment()` inside the same transaction as the leg write (`journal-writer.ts:180-189`) — never recomputed on read during normal operation. Convention: `balance = Σ(in-amounts) − Σ(out-amounts)` for every account regardless of nature; UI flips sign for display on credit-nature accounts (`ACCOUNTING_BLUEPRINT.md:86-92`).
- **`reconcileAccounts()` (`balancer.ts:143-211`)** is the actual source-of-truth check: it re-sums every posted journal leg per account from scratch and compares to the stored `balance` field, reporting `drift` beyond the ε tolerance. Deliberately does **not** compare the stored balance against the `accountMonthlyBalances` projection, because both are written by the same transaction and would only prove self-consistency (`balancer.ts:138-142`, well-reasoned).
- **Void = status-flip, not a reversing entry.** A void re-writes the *same* deterministic doc id with `status: 'voided'`; `computeDeltas()` detects the `posted→voided` transition and applies the exact negative of the original delta (`journal-writer.ts:238-263`). The original leg is mutated in place (its own `status`/`updatedAtMs` change) — there is no separate, dated reversal document. `ACCOUNTING_BLUEPRINT.md:894-898` names this "status-flip void" explicitly as a departure from textbook append-only reversal, calls it "sufficient for small-business audit," and says the writer already supports the alternative if ever needed.

### 1.3 Chart of accounts / account-ID conventions

Accounts are not a real, editable chart-of-accounts table with numeric codes — they are Firestore documents whose `id` is a structured string, most of them **lazily created on first use** rather than pre-defined:

| Prefix | Meaning | Lazy? |
|---|---|---|
| `cash__cashier`/`cash__office`/`cash__staff` | drawer sub-accounts | No (seeded) |
| `online__{paymentAccountId}` | e-wallet/bank accounts | Yes |
| `ap__{supplierId}` | one payable account **per supplier** | Yes |
| `ar__{customerId}` | one receivable account **per customer** | Yes |
| `prepaid__{prepaidItemId}` | one account per prepaid item | Yes |
| `asset__{assetId}` / `contra_asset__{assetId}` | one pair per fixed asset | Yes |
| `staff_advance__{staffId}` / `staff_reimbursable__{staffId}` | one account per employee | Yes |
| `liability__{loanId or type}` | loans, statutory, salaries payable, etc. | mixed |
| `expense__*`, `income__*`, `equity__*` | a small, hand-maintained, **global** set of P&L/equity labels | No (hardcoded list) |

This is functionally a subsidiary ledger with **per-supplier, per-customer, per-asset, per-employee accounts living directly in the "chart of accounts" collection**, rather than a small set of control accounts (AP, AR, Fixed Assets) reconciled against separate subsidiary ledgers. See §3.4 for the consequence.

### 1.4 The nominal-ledger / P&L split — the single most important structural fact

Confirmed directly in code, and this is **the largest deviation from a standard general ledger** (elaborated in §3.1): the journal only carries a complete double-entry picture for **balance-sheet accounts**. For ordinary expense recognition (`buildExpenseJournalEntries`, `src/lib/financial/journal/builders/expense.builder.ts:19-135`), a cash-paid expense posts **exactly one leg**: `OUT cash__cashier`. There is no `expense__meat` / `expense__utilities` / etc. leg — the P&L category (`expenseEntryGroup: COGS|OPEX|CAPEX|...`) lives only on the source `expenses` document (denormalized at post time, `ACCOUNTING_BLUEPRINT.md:169-171`), never in the journal. Likewise sales (`buildSaleJournalEntries`, `sale.builder.ts:8-61`) post only the cash/online side — **there is no revenue account leg at all**; revenue lives only in `salesDays.totalSales` and friends.

The Income Statement (`src/lib/actions/income-statement.actions.ts`) is therefore not "sum the nominal accounts in the ledger." It is a **hand-maintained union of several independent data sources**, confirmed by direct read of that file:
1. A scan of `expenses/` filtered by `dayKey` range + `status=='posted'`, classified into COGS/OPEX by the denormalized `expenseEntryGroup` (`:157-201`).
2. A **separate, individually-added scan of the `journal/` collection filtered by `accountId=='expense__interest'`** (`:253-264`), because loan-interest legs have no backing expense doc.
3. A separate scan for `accountId=='expense__platform_fee'` (`:295-302`).
4. A separate scan for `accountId=='expense__salary'` (`:356-361`).
5. A separate scan for `accountId=='expense__salary_additions'` (`:397-402`).
6. A separate, dictionary-driven scan (`OTHER_INCOME_ACCOUNTS`) for "other income" journal accounts (`:433-459`).

Every time a new feature introduces a P&L-relevant journal leg with no backing document (loan interest, platform fees, payroll, payroll additions), it requires a **new, manually-added scan block** in this one file, or that leg is silently invisible to the Income Statement. This exact failure mode already materialized twice — see OC-31 (§2, Medium) and the Platform-fee double-count decision (§3.1).

### 1.5 Periods / locks

- `stores/{s}/lockedDays/{yyyy-mm-dd}` marks a day locked; `assertDayNotLockedServer({storeId, salesDate, feature})` is called pre-transaction and again inside the transaction by money-moving actions that use it (`ACCOUNTING_BLUEPRINT.md:135-136, 202`).
- Locking is **feature-scoped**, not a single "period close." `LockableFeature` (`lockedDay.guard.server.ts`) has ~21 members as of 2026-08-22; some features are additionally gated by "verified" status (`VERIFIED_LOCK_FEATURES`), others only by the day-close lock. Payroll and (as of 2026-08-22, partially) inventory/production are deliberately **excluded from `VERIFIED_LOCK_FEATURES`** (only the manual day-close blocks them) — see §2 for the coverage gaps this leaves.
- There is **no single "close the books for month X" operation**. Locks are per-day, per-feature; there is no month-end/year-end close routine, no retained-earnings roll-forward, and (§3.6) no evidence of a trial balance or formal closing entries anywhere in the codebase.

### 1.6 Inventory is quantity-only — no valuation, no Inventory asset account

**[FOUND]** — grepped the full account-nature table (`account-defs.ts`) and `balance-sheet.actions.ts`: there is **no `inventory__*` account prefix anywhere**, and the balance-sheet action file contains zero references to "inventory." Stock is tracked purely as **quantity** in `itemStockLedger`/`itemBalances`/`meatInventoryLedger`/`meatInventoryBalances` — none of these carry a currency value or feed a balance-sheet "Inventory" line. Cost recognition happens once, at the moment a delivery is **manually linked to an expense document** (`ACCOUNTING_BLUEPRINT.md:1211-1217`: "cost of goods is recognized via a manually-linked expense doc... Auto-link/bulk-create paths were removed in 2026-04 in favour of explicit human linking"). This means:
- COGS timing is **purchase-basis, not consumption/sale-basis** — a delivery expensed on receipt hits the P&L in that period regardless of when the stock is actually used or sold. INFERRED consequence: gross margin in any given period can be distorted whenever purchase timing and sale timing diverge (bulk buys, slow-moving stock).
- There is no perpetual-inventory GL entry (no `DR COGS / CR Inventory` at time of sale, no `DR Inventory / CR AP` at time of receipt). This is a **periodic-inventory-like model bolted onto an otherwise transaction-by-transaction ledger** — genuinely non-standard for a system that otherwise aspires to full double-entry.
- Count adjustments have **"no direct GL effect"** by the blueprint's own words (`ACCOUNTING_BLUEPRINT.md:1216`) — a stock write-off or count correction changes quantity only; any P&L effect is deferred until "the adjusted stock is eventually used/sold," which (per the point above) may never actually happen since usage/wastage don't post a valued COGS entry either.
- Supplier returns move stock only — **"does not touch AP/expense/journal"** by design (`docs/INVENTORY_GAPS.md:114-118`); an AP credit for returned goods is a manual, informational reminder only (`financialReminder` field), not an enforced posting.

---

## 2. KNOWN GAPS — the main deliverable

Organized by severity. "Status" reflects the OPEN_CONCERNS.md / DECISION_LOG.md record as of the read date (2026-08-22), not a re-verification by this pass.

### CRITICAL

None found that are currently both **open** and **live in production** at Critical severity. The one item that would have qualified — the cookieless-caller auth regression (OC-41) — was fixed and verified (§2, High, closed). The severity floor in this repo's own convention treats "money-wrong-in-prod" or "permission leak" as Critical; nothing meeting that bar is presently Open per OPEN_CONCERNS.md's summary table.

### HIGH

1. **[DOCUMENTED — OC-13, now Verified-fixed 2026-07-21] `voidReceiptAction` posted void journal legs with no period-lock guard.** `src/lib/actions/receipt.actions.ts` — `voidReceiptAction` reversed AP/journal for every linked expense without calling `assertDayNotLockedServer`, while the parallel `voidExpense` path enforced it. A locked (closed) period's P&L could be moved by voiding the parent receipt instead of the expense directly. **Business impact:** money-wrong-in-a-closed-period, undetectable by the period-lock control. Fixed in commit `ecba043` (per-expense pre-check + in-transaction re-check on both void and revive directions) — closed and re-verified.

2. **[DOCUMENTED — OC-17, Verified-fixed 2026-07-21] `autoCreateChannelArAction` was an exported, unauthenticated server action** that could post an arbitrary AR receivable + credit GL sales for any `storeId`, gated only by a period-lock check (no role/store-access check). **Business impact:** any authenticated caller could inflate reported sales and AR for a store they had no access to. Fixed same commit as OC-13.

3. **[DOCUMENTED — OC-29, Open as of 2026-08-04, status at last read] `api/memos/document` GET streams a memo file with zero caller authentication** (no session, no role, no store-access check — only a storagePath-prefix guard). Memos can carry HR/disciplinary/financial content. Adjacent to accounting (financial memos, disciplinary records referenced by wastage/payroll accountability flows) rather than squarely inside it, but flagged because it's the same class of gap (`OC-32`/`OC-33`, both High, fixed) that hit `voidReceiptAction`/`voidProductionRecordAction`.

4. **[DOCUMENTED — OC-32/OC-33, Verified-fixed] `voidReceiptAction`/`verifyReceiptAction` and `voidProductionRecordAction` were missing `hasStoreAccess`** — a granted non-admin manager scoped to Store A could void/verify a receipt (reversing budget, cash-request liquidation, AP, delivery links) or void a production record (restoring slab stock, reversing the payroll-feeding `productionMonthlySummary`) for **any other store**. Both fixed.

5. **[DOCUMENTED — OC-41, Verified-fixed 2026-08-10] The cookieless-caller auth fix (`4076e39`) broke two legitimate machine callers** (the mobile Flutter inventory API and the wastage-email cron ingest), which would have 403'd every mobile stock movement and silently failed every platform wastage ingest — i.e., a well-intentioned security fix would have **stopped inventory from being recordable at all** from the floor. Correctly caught before merge consequences compounded; fixed with an explicit `AsyncLocalStorage`-scoped trusted-principal allow-list.

6. **[DOCUMENTED — OC-22, Verified-fixed 2026-07-22] Recurring-expense auto-pay posts expense + journal legs with no period-lock guard.** Once the org-wide cron was wired live (`12996c3`), a bill due on an already-verified-locked day would post into a closed period. Fixed with per-due-date lock checks + a skip/alert path.

7. **[FOUND, still current — the pattern behind OC-31] Every new "P&L-only, no backing document" journal account requires a hand-added scan in `income-statement.actions.ts`, or it is invisible to the P&L.** This is a structural defect, not a one-off bug (see §1.4, §3.1). It has already caused two real, documented double-count/mis-recognition incidents (the platform-fee double-book, and OC-31 below) and is a standing landmine for every future feature that introduces a journal-only expense account (statutory employer share, any new fee type, any new deduction).

### MEDIUM

8. **[DOCUMENTED — OC-31, Open as of last read] Channel-settlement signed-fee-netting fix (`6de3796`) changed how a promo/incentive-heavy settlement day posts; historical settlements recorded *before* the fix may be mis-posted (fee overstated, `netToBank` understated by the same amount) with no tripwire, because the old bug's net-to-zero clearing masked it.** No backfill or historical audit has been run; a read-only audit script (`scripts/audit-pre-fix-channel-settlement-fee-drops.mjs`) has existed since 2026-08-15 and had not been run as of the last log entry. **Business impact:** understated deposits-in-transit / overstated platform OPEX for an unknown number of historical settlement days.

9. **[DOCUMENTED — OC-26/OC-27, Open] Commissary AR↔branch-AP mirror posts AR-collection journal legs with no period-lock guard**, and its repair action is missing a store-access check. A branch-payment edit/void whose `dayKey` falls in an already-closed **commissary** period can re-post a commissary collection into that closed period (branch and commissary locks are independent).

10. **[DOCUMENTED — OC-16, status per last read: Open, display-only] The "Unremitted Amount" month-rollup card on the sales-report page double-presents an already-charged cash shortage** — it sums `max(0, computed − actual)` per day without subtracting `shortageCharges`, while the adjacent Charge-Shortage control on the same page correctly nets `computed − actual − charged`. Once a shortage is charged (becomes a staff receivable), the same peso is still shown as "still owed as a remittance." **Business impact:** a manager reading the card overstates what is still collectible in cash; display-only (no GL/mutation), but it directly contradicts high-risk rule #9 (no double-count in reports).

11. **[DOCUMENTED — OC-19, Open] Admin sales-report adjustments restate the source `salesDays` doc and re-post the journal delta-safely, but never refresh `salesSummaryMonthShifts`/`salesSummaryMonthDays`.** The per-shift breakdown table renders from the stale projection until the next nightly rebuild. Not a double-count (the headline totals and Income Statement read the corrected source doc directly) but a documented case of "reports must read projections, not recompute ad hoc" being violated for one specific view.

12. **[DOCUMENTED — OC-18, Open per last read, mitigation shipped] Payroll payout can draw the cashier drawer.** The payout account picker's *default* avoids the cashier drawer but does not *restrict* against it; server-side validation of `cashAccountId` against a non-drawer account was reportedly added later (`24f478d`, per DECISION_LOG) but the GL-model sign-off itself is still recorded as awaiting Ian's explicit confirmation. **Business impact if unenforced:** a net-pay cash-out from the cashier drawer on a verified-locked day, invisible to the cashier's own remittance reconciliation.

13. **[DOCUMENTED — OC-34, Open] Admin void of an `arCustomers` doc (mode `'void'`, not `'delete'`) still decrements `arActiveCount`/`arOutstandingTotal`, even though the source query that builds those totals keeps counting the (merely voided, not deleted) doc.** A drift between the dashboard AR tile and the underlying data.

14. **[DOCUMENTED — OC-36, Open] `planArCustomerBalanceMove`, the shared rule meant to keep every AR-balance dashboard writer consistent, is applied to only 4 of roughly 12 real AR-balance-affecting writers.** The other ~8 write `arOutstandingTotal`/`arActiveCount` directly, each a candidate for the same one-way/definition-split drift class documented in `docs/derived-counter-review.md` (§3.5).

15. **[DOCUMENTED — OC-37, Open] Payroll void unmarks the source recurring-expense row keyed by `periodEnd`, not the payout's actual `businessDate`.** For any non-end-of-month semi-monthly cutoff, voiding a payout can fail to (or incorrectly) unmark the recurring row it came from.

16. **[DOCUMENTED — OC-38, Open, partially addressed 2026-08-22] No period-lock coverage on 11 of 17 inventory/production stock-writing paths** (`stock-transfer`, `stock-count`, general-inventory usage/wastage, `meat-usage`, `branch-order-fulfilment`, `branch-order-receive`, `branch-stock-reconcile`, `initial-inventory`, `inventory-location`, `production-recipe`, `commissary/stock-out`). 6 paths (supplier-return post, delivery receive/void, production post/edit/void) gained a guard on 2026-08-22 after Ian approved treating stock-period locking as a Firebase-side responsibility; the remaining 11 are enumerated but unguarded. **Business impact:** a stock movement can be posted or backdated into an already-closed accounting period with no block, for the majority of inventory-affecting actions.

17. **[DOCUMENTED — Decision Log, "Firebase-side period locks do not cover inventory," still Open as a formal ruling] Even where a lock exists, it answers "what does a closed period mean" differently on the Firebase side (money-record concept only) than intended for the eventual ERPNext side (stock-period concept)** — the split itself is the open decision, not a specific bug.

18. **[FOUND] No employer-share statutory contribution is computed or posted anywhere.** `src/lib/actions/payroll-recurring-seed.actions.ts:36-43` documents this explicitly and out loud: *"An EMPLOYER share (the portion SSS/PhilHealth/Pag-IBIG bill the STORE on top of the employee's withheld share) is a genuinely different thing: a real, new cost that was never withheld from anyone. It has no leg in payroll-payout.builder.ts today... That is explicitly OUT OF SCOPE here."* Only the **employee's withheld share** is computed (`src/lib/payroll/statutory.ts`) and parked as a liability; the company's own matching contribution (a real, PH-legally-mandated cost, typically comparable in magnitude to the employee share for SSS) never appears in the P&L or on the balance sheet as a liability. **Business impact:** payroll cost (and true statutory liability) is understated by the full employer-share amount, in every period, for every store — an accounting gap material enough to misstate net income and understate a real government liability.

19. **[FOUND] The four statutory-remittance recurring-expense templates (SSS/PhilHealth/Pag-IBIG/Withholding) have no wired confirm→journal posting path.** Same file, `:44-52`: these templates render on `/financial/recurring-expenses` but "does NOT wire a confirm-payment → journal path for the four statutory rows... Building that is a later task." If an operator naively confirms one of these through the generic `confirmRecurringExpenseAction` (the ordinary cash/AP pathway), it would post as a fresh OPEX expense — **double-counting** the employee-share cost that was already recognized when the staffer was paid (parked into `liability__statutory`). This is a live landmine sitting on a UI surface that already exists and invites the wrong action.

20. **[FOUND] Senior-citizen/PWD discount tracking is hardcoded to zero on the primary sales-entry path.** `src/app/financial/sales-report/new/page.tsx:342` writes `seniorDiscount: 0, pwdDiscount: 0, otherDiscount: toNum(values.totalDiscountsGiven)` — every discount, including any that are legally senior/PWD discounts (RA 9994 / RA 10754, which carry mandatory VAT-exemption treatment), is lumped into a generic `otherDiscount` bucket. The schema (`SalesDayPlain.seniorDiscount`/`pwdDiscount`, `src/types/index.ts:1168-1170`) and a different action (`sales-report-draft.actions.ts:76-78, 266-268`) do support the real fields, so this is an inconsistency between two paths, not a schema gap. **This exact issue was independently flagged in the ERPNext VAT decision review** (`DECISION_LOG.md:680`, item 2) as the most realistic real-world VAT-exemption case this system fails to separate. **Business impact:** output VAT is computed on gross sales without excluding the portion that PH law requires to be VAT-exempt for senior/PWD transactions — a genuine BIR-compliance gap, not merely a reporting nicety.

21. **[DOCUMENTED — several OC rows, cross-store store-access omissions on money-moving actions] A recurring class of bug: an exported server action checks role/grant but omits `hasStoreAccess`,** letting a manager granted a specific capability at Store A reach the same action against Store B. Confirmed instances across the review period: `charge-cash-request-shortage.actions.ts` (fixed), `initial-inventory.actions.ts` (fixed), `branch-order-fulfilment.actions.ts::resolveDiscrepancyAction` (OC-20, still open per last read), `store.actions.ts::resolvePosPaymentMethodAction` (OC-21), `commissary-mirror.actions.ts::repairBranchPaymentMirrorAction` (OC-27). Each instance is narrow, but the *pattern* recurring across five-plus independent code paths over two months is itself a signal that the permission model needs a single enforced primitive rather than a per-action reminder to add the check.

22. **[FOUND — self-dealing control's identity input is client-supplied] The three money-affecting segregation-of-duties gates (overtime approval, salary-advance approval, staff-payment approval) resolve "who is the acting local user" partly from a client-supplied `localActor` parameter, with no server-side session.** Documented directly (`DECISION_LOG.md:18-33`): omitting the parameter walks past the self-dealing check, and the gate **fails open** by design. A 2026-08-22 measurement found the *data-gap* half of this risk was near-zero (every real managerial staff record is linked), but the *design* gap — a control whose identity input is supplied by the party being controlled — remains open, with only diagnostic logging added, not a fix.

### LOW

23. **[DOCUMENTED — OC-28, Open] Two "normalize this label" functions for expense particulars have silently diverged** (`normalizeExpenseParticular` strips slashes, `normalizeParticulars` does not), despite a code comment asserting they're kept in sync. No money impact — only an AI-suggestion/catalog key mismatch for slash-containing product names.

24. **[DOCUMENTED — OC-40, Open] `ACCOUNTING_BLUEPRINT.md` (the authoritative spec) still documents `reviveExpense` as a live action at six locations, though it was removed from code 2026-08-06.** A pure documentation-drift item, but worth noting because a rebuild team reading the "authoritative" spec verbatim would build against a retired API.

25. **[FOUND] `docs/split-payments.md`'s `PaymentSplit.method` union (`'cash'|'credit'|'credit_card'|'e_wallet'|'petty_cash'|'other'`) does not match the real, current payment-method vocabulary in `expense.builder.ts` (`cash`/`online`/`credit`/`reimbursable`/`other`, with `online` further split by `accountId`).** Historical/stale doc, low risk, but another instance of the documentation not tracking the live model.

---

## 3. Deviations from standard double-entry

1. **No nominal (P&L) ledger for ordinary revenue and expense — the single largest deviation.** A standard GL posts every transaction as balanced debit/credit lines against real nominal accounts (Sales, COGS, Rent, Utilities...). This system posts **only the balance-sheet side** of an ordinary sale or expense (cash/online/AP/AR movement); the P&L category is a field on the source document, read directly by report code, not a ledger account. **[DOCUMENTED as deliberate for cost-of-build reasons]** — `ACCOUNTING_BLUEPRINT.md §5.6` explicitly defines single-leg entries as valid ("expense recognition, revenue recognition" are cited as the intentional single-leg cases) and the balancer codifies it (`balancer.ts:64-67`). The deviation is therefore **deliberate**, but its downstream consequence — a hand-maintained, ever-growing set of special-case scans in `income-statement.actions.ts` for every P&L-only journal account that has no backing document — was **not** planned as a permanent architecture; it accreted feature-by-feature (interest, then platform fee, then salary, then salary additions) and has already caused one real double-count incident (§3.1 below) plus one still-open audit gap (OC-31). This is the deviation an ERPv2 should not carry forward as-is: a real chart of nominal accounts, posted symmetrically for every transaction, removes the entire class of "forgot to add a scan block" bugs.

2. **Confirmed real incident from this exact deviation — the platform-fee double-count.** `recordPlatformFeeExpenseAction` wrote a real posted **expense document** for a platform fee that `applyArCollectionAction` *also* posted as an inline **journal leg** (`expense__platform_fee`). Because the Income Statement counts expense-docs by category **and separately** scans that exact journal account (added later, on the false premise that the doc-path was "a deprecated no-op" — it was not), every AR-page platform-fee collection was counted twice in OPEX. **[DOCUMENTED — DECISION_LOG.md "Platform-fee P&L recognition," 2026-06-27, and its resolution "Platform-fee expense booked inline (journal leg) only," 2026-07-05].** Confirmed fixed (single source of recognition = the inline leg; 37 duplicate expense docs voided, ₱198,148.29 across two stores) but the *fix itself* is recorded as **Proposed, not yet explicitly ratified by Ian** as of the log's last entry — an accidental deviation, caught and patched, but the underlying architecture (§3.1) that made it possible is unchanged and will produce the same failure shape again for the next P&L-only account (this is exactly what OC-31 already is, for channel-settlement fees).

3. **Status-flip void instead of append-only reversal.** **[DOCUMENTED as deliberate]** `ACCOUNTING_BLUEPRINT.md:894-898` calls this out explicitly as a trade-off: "simpler and sufficient for small-business audit. Regulated environments (SEC/SOX) would want strict append-only reversal entries... Deferred until needed." A voided leg is the *same document*, mutated — not a new dated reversal row referencing the original. This means: (a) the journal is not strictly append-only/immutable (a "posted" document's `status` field does change after the fact, even though the amount/direction/accountId do not), and (b) any external system or auditor expecting one journal row per real-world event will instead see a row whose meaning ("this movement happened") silently flips to "this movement was undone," dated by `updatedAtMs`, not by a fresh entry timestamp.

4. **Per-supplier/per-customer/per-employee/per-asset accounts live directly in the ledger, not in separate subsidiary ledgers reconciled to control accounts.** `ap__{supplierId}`, `ar__{customerId}`, `staff_advance__{staffId}`, `asset__{assetId}` are each first-class ledger accounts (§1.3). Standard practice keeps one **control account** (e.g. "Accounts Payable") in the general ledger and a separate AP subsidiary ledger per supplier, reconciled periodically. Here there is no control account at all — the "AP total" is itself a rollup summed across however many `ap__*` accounts exist (`ap_suppliers_index`, an async, eventually-consistent projection — `ACCOUNTING_BLUEPRINT.md:190`, and **[DOCUMENTED — DECISION_LOG "The AP tile is a rebuild-only snapshot, not a live figure," 2026-08-06]**: the dashboard AP figure was found to be wired at only 3 of 8+ AP-balance write paths, silently drifting low while looking live, and was demoted to an explicit "as of \<rebuiltAt\>" snapshot rather than fixed to be live). This is a genuine structural weakness for aging/subsidiary-vs-control reconciliation: there is no independent control-account total to check the per-supplier sum against, because the control account *is* the sum of the per-supplier accounts by construction — reconciliation can only ever prove internal self-consistency, never catch a missed writer (exactly what happened here).

5. **No formal period-close / trial balance / retained-earnings roll-forward.** **INFERRED** — no code path was found that produces a trial balance, closes nominal accounts into retained earnings, or locks a full accounting period across all features simultaneously. Locking is per-day, per-feature (§1.5); "closing the books" as a discrete, complete operation does not exist. This is standard for many lightweight systems but is a genuine gap relative to "industry-standard" bookkeeping, where a period close is itself a control (it is what makes "closed period" mean something more than "some flags happen to be set").

6. **AR/AP aging has no stored projection — computed on read by joining journal + source docs.** (`ACCOUNTING_BLUEPRINT.md:192`: "No stored aging projection — reports query journal + expenses/arTransactions"). Not wrong, but a deviation from the more common pattern of maintaining an aging schedule as a first-class object; every aging report is a live, potentially expensive join rather than a stored, auditable snapshot.

7. **Sub-centavo balancing tolerance (`MONEY_EPSILON = 0.005`) is baked into the core balance-check and reconciliation code**, not an exceptional/audited override. **[DOCUMENTED as an open confirmation item]** — the "Void cash suspense" decision entry explicitly lists "the balancer sub-centavo tolerance... confirm as accepted journal-balance policy" as still awaiting Ian's sign-off. Reasonable for floating-point noise, but it is a policy decision (how much imbalance is "not really an error") that has never been formally ratified, only shipped.

---

## 4. What is actually GOOD — worth preserving conceptually

1. **The two-phase read/write journal-writer API (`prepareJournalLegs` / `commitJournalLegs`) is a genuinely sound pattern for Firestore's read-before-write transaction constraint**, and it is used consistently: every money-moving action follows the same template (policy check → period-lock pre-check → build inputs → single transaction with all reads before all writes → fire-and-forget non-critical projections after commit). This transaction discipline — **"source-doc write + every ledger write commits in one transaction, no async queue"** — is exactly the right invariant for correctness and is enforced structurally (the old sync-queue infrastructure was deleted entirely in slice 6c, per `ACCOUNTING_BLUEPRINT.md §16` 2026-04-19 entries), not just by convention. Worth carrying forward as a hard rule in ERPv2 regardless of the underlying datastore.

2. **`reconcileAccounts()`'s deliberate re-derivation from raw posted journal entries, never from another projection**, is the correct way to build a drift check — it explicitly avoids the "comparing a thing to a copy of itself" trap (`balancer.ts:138-142`). This reasoning should be preserved as a designed principle, not just a lucky accident.

3. **Deterministic, idempotent entry IDs** (`buildJournalEntryId(sourceType, sourceId, legKey)`) mean a retried write, a re-run backfill script, or a re-attempted cron job cannot accidentally double-post — the same logical event always resolves to the same document, and a second attempt is a no-op or a clean update. This underpins essentially every "idempotent" claim across the codebase's decision log and is a strong, portable design choice.

4. **Multi-leg balance validation before commit (`assertJournalBalanced`)** genuinely does catch a real class of bug: several of the reviewed builders (AR collection with platform fee, cash-request release/return, transfers) are correctly multi-leg and balanced, with unit tests pinning the balance math. Where the model is used as originally intended (true multi-account movements), it works.

5. **The "sale ≠ collection ≠ expense ≠ AP ≠ cash movement" discipline is a real, consistently-enforced distinction**, not just a slogan. It shows up correctly in: the AR-collection builder separating gross-applied (revenue-side receivable clearing) from actual-received (cash side) from platform-fee (expense side) as three distinct legs with the right natures; the wastage builder correctly *not* touching cash when a platform compensates a loss; and the void-cash-suspense treatment (retained void cash held as a liability, not recognized as revenue) specifically because the business event ("cash physically present") and the accounting event ("a sale occurred") were kept separate even under an edge case (a void with no refund).

6. **Explicit, principled rejection of a bad idea (per-staff expected-start for lateness) on evidentiary grounds**, and the general practice of writing every non-trivial decision to `DECISION_LOG.md` with Context/Decision/Reason/Impact/Confirmed-by-Ian, is itself a good process artifact — not code, but worth preserving as a *practice* for ERPv2: every business-rule decision, including the ones rejected, has a paper trail explaining why.

7. **The wastage net-zero contra-write-off treatment** (`wastage-expense.builder.ts`) is a defensible, correctly-balanced accounting choice for the specific case it targets: when the wasted item's raw-material cost has already flowed through COGS at purchase time, booking a *second* P&L hit for the same physical loss would double-count it. Positing a `DR expense__order_wastage / CR income__wastage_writeoff_contra` memo that nets to zero — auditable, traceable, reversible on void — while not hitting net income twice, is the right instinct even though the underlying purchase-basis COGS model (§1.6) is itself non-standard.

8. **VAT math is correct and consistent.** `vat.ts`'s inclusive-tax formula (`vatAmount = amount × 12/112`) is applied identically wherever VAT is computed, confirmed byte-for-byte against the separate ERPNext migration's own dry-run figures (`DECISION_LOG.md:679`). The rounding convention (VAT-first, remainder as the exclusive amount) reconstructs the original gross exactly.

9. **Payroll statutory contributions (employee share) use real PH bracket/MSC tables, not a flat-percentage guess**, are version-tagged (`TAX_TABLE_VERSION = 'PH-2024'`) with an explicit "review annually" comment, and are carefully capped so contributions + withholding can never exceed gross pay (protecting against a degenerate tiny-pay period going negative) with residual-rounding absorbed into the largest line so the GL legs stay exactly balanced (`src/lib/payroll/statutory.ts:160-196`). This is a properly engineered piece of PH-specific logic, distinct from the employer-share gap noted in §2 item 18 — the employee-share math itself is sound.

10. **The park-then-lump-sum payroll model** (pay individual staffers as cash allows, park gross in `liability__salaries_payable`, recognize the period's total salary cost exactly once via a lump-sum expense that drains the liability) is a genuinely well-reasoned response to a real operational constraint (cash paid staffer-by-staffer, not all at once) — it avoids fragmenting the salary expense across many small postings and gives a clean reconciliation invariant ("fully-paid period ⇒ `liability__salaries_payable` nets to zero"). Ian-designed, Approved, backed by a re-runnable live-proof test suite.

---

## 5. Reconciliation and integrity checks that exist today

**What exists:**
- `reconcileAccounts(storeId)` — re-sums every posted journal leg per account from the raw journal and reports drift against the stored `balance` field (`balancer.ts:143-211`). This is the closest thing to a real "does the ledger tie out" check, and it is at least reachable from an admin "Rebuild Balance"/"Reconcile Journal" affordance per `ACCOUNTING_BLUEPRINT.md §16` 2026-04-19 entries.
- Per-domain integrity detectors referenced across `DECISION_LOG.md`/`CHANGE_REVIEW_LOG.md` entries (labelled (a)–(n) in places) covering things like: residual void-cash-suspense balance, AR-without-branch-expense (branch-sale auto-book gap), `skipped_period_locked` counts in the ERPNext mirror, expense-anomaly detectors on the Manager Daily Review.
- A meat-inventory-specific tie-out diagnostic (`scripts/admin-bridge/diag-meat-balance-vs-ledger.ts`) that compares `meatInventoryBalances` against the raw ledger, deliberately excluding wastage-memo-only source types so it doesn't false-positive.
- `dashboard-summary-integrity.ts` / integrity-value-format checks (present as files under `src/lib/financial/`, not read in full this pass, but referenced repeatedly as the mechanism behind several documented fixes).
- A written methodology for *how to audit a derived counter* (`docs/derived-counter-review.md`) — not a check itself, but a documented, evidence-based process ("ask who writes the source field, not who calls the updater") that has already found six real one-way-counter bugs in a single afternoon per its own account.

**What these do NOT check** (confirmed by direct reading, not merely inferred from absence):
- **They do not check that the Income Statement's hybrid doc-scan + journal-scan union is complete.** Nothing in the codebase asserts "every journal account whose nature implies a P&L effect is accounted for by exactly one of: the expense-doc scan, or a named journal-account scan." This is precisely the gap that produced the platform-fee double-count and remains open for OC-31 (channel-settlement fee-drop).
- **They do not check subsidiary-vs-control reconciliation**, because (§3.4) there is no independent control account to check against — the "control total" is definitionally the sum of the subsidiary accounts.
- **They do not check cross-collection double-counting between the journal-derived balance sheet and the doc-derived P&L** — e.g., nothing asserts that a CAPEX-flagged expense's asset-side leg and its P&L exclusion stay consistent as a *joint* invariant (this exact joint invariant broke once, in the ERPNext migration mirror, when a CAPEX clearing account was accidentally created on the wrong side of the chart of accounts — caught by a human review, not an automated check).
- **They do not check period-lock coverage itself** — nothing scans "which money-moving actions call `assertDayNotLockedServer` and which don't" as an automated gate; that inventory (§2 items 6, 16, 17) was compiled by a human/agent grepping the codebase, not by a standing test.
- **They do not check inventory valuation against anything**, because there is no inventory valuation to check (§1.6) — the meat tie-out diagnostic reconciles *quantity*, not value.
- **No trial balance, no P&L-vs-balance-sheet articulation check** (e.g., "does the period's net income equal the change in retained earnings/owner's equity") was found anywhere in the codebase.

---

## 6. The PH-specific rules encoded

**VAT.** `src/lib/financial/vat.ts` + `ACCOUNTING_BLUEPRINT.md §23`. Standard 12% inclusive rate, correct formula, correctly distinguishes vatable/zero-rated/exempt/non-VAT at the field level on receipts, expenses, and suppliers. **Gaps, all previously identified inside the codebase's own review process, confirmed by this pass:**
- `SalesDayPlain.vatableSales`/`vatExemptSales`/`zeroRatedSales`/`outputVatAmount` are declared in the schema but **written by zero code paths** (`DECISION_LOG.md:680`, item 1) — dormant scaffolding, not a working output-VAT report.
- Senior/PWD discount amounts, which carry a real, mandatory VAT-exemption obligation, are **hardcoded to zero on the primary sales-report entry path** (`sales-report/new/page.tsx:342`), lumped into a generic discount bucket instead (§2 item 20). This is the most concrete, currently-live PH-compliance gap found in this pass.
- Every SE (SHAREAT OPC) item class is currently treated as uniformly VATable 12% with no exempt/zero-rated class actually assigned — a deliberate, Ian-confirmed simplification for now (`DECISION_LOG.md:669-682`), correct as a decision but leaves the exemption machinery unused/unverified.
- Input-VAT (purchase-side) reporting is explicitly deferred (`ACCOUNTING_BLUEPRINT.md:1171-1176`, "Next steps (deferred)") — no VAT-return reconciliation (output VAT − input VAT = net payable/refundable) exists yet.
- `vatAmount > totalAmount` is not blocked at the Firestore-rules layer (a stated, deferred hardening item, `ACCOUNTING_BLUEPRINT.md:1176`).

**Withholding tax (compensation).** `src/lib/payroll/statutory.ts` implements the BIR RR 11-2018 graduated withholding tables per pay frequency (monthly/semi-monthly/weekly), computed on taxable pay (gross − contributions), applied correctly per period (not a monthly-equivalent approximation, unlike the contribution calcs). Sound, version-tagged, and explicitly commented "review annually."

**Statutory contributions (SSS/PhilHealth/Pag-IBIG).** Same file — real bracket/MSC/ceiling tables for the **employee share only**, correctly scaled from a monthly-equivalent basis to the actual pay period, capped so total deductions can never exceed gross. **This is the strongest piece of PH-specific logic in the codebase.** The gap is not in this file — it's the complete absence of the **employer's own matching share** anywhere in the system (§2 item 18), which is the actual, legally-required cost to the business and is presently unbooked in full.

**Where it looks wrong or hardcoded, summarized:**
- Tax tables are version-tagged `PH-2024` with a comment demanding annual review — as of the discovery date (2026-08-22) this is stale by construction unless a newer version has since been shipped (not verified in this pass; worth checking directly before relying on it for ERPv2's bracket values).
- Employer-share statutory contributions: **entirely absent** (§2 item 18) — the single largest PH-specific accounting hole found.
- The four statutory-remittance recurring-expense rows have no correct posting path yet (§2 item 19) and are a live double-count trap if used today.
- Senior/PWD discount separation: hardcoded to zero on the live sales-entry path (§2 item 20, §6 above) despite the schema supporting it elsewhere.
