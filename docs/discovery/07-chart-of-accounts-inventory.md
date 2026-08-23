# 07 — Chart of Accounts Inventory & Posting Patterns

Source repo: `C:\Users\ianla\webapps\ERP-rebuild` (read-only discovery — nothing modified).
Purpose: exhaustive inventory of every account and posting pattern in the current system, as raw input to the Shareat System chart-of-accounts alignment. **No redesign, no recommendation — inventory and description only.**

Primary sources read in full: `src/lib/financial/ACCOUNTING_BLUEPRINT.md` (1218 lines), `src/lib/financial/accounts/account-defs.ts`, `src/lib/financial/accounts/account-registry.ts`, `src/lib/financial/accounts/account-resolver.ts`, `src/lib/financial/balance-sheet-classify.ts`, `src/lib/financial/journal/journal-writer.ts`, `src/lib/financial/balancer/balancer.ts`, `src/types/financial.ts`, all 22 files under `src/lib/financial/journal/builders/`, `src/lib/financial/channel-settlement/{posting,fees,channel-settlement-map,cross-store-loan.legs}.ts`, `src/lib/financial/commissary/{branch-sale-ar,autobook,receive-hook}.ts`, `src/lib/financial/salary-advance/account-allowlists.ts`, `src/lib/actions/income-statement.actions.ts` (the P&L read path — read closely since it determines which journal-native accounts actually reach a report), `AGENTS/ERP Guardian/SCHEMA_MAP.md` (accounts + journal sections). Plus targeted greps across all 36 files in `src/lib/actions/` that call a journal builder or `commitJournalLegs`/`addJournalEntriesToTransaction` directly, and the UI pages under `src/app/manager/accounts/`, `src/app/accounting/`.

Evidence format: `file:LINE`. Anything not directly verified in code is marked **UNCERTAIN**.

---

## 1. The complete account inventory

Every account ID prefix the codebase's `inferAccountNature()` / account-registry / builders can produce. **41 distinct account IDs or ID-families** across 16 prefixes.

### 1.1 Fixed system accounts (28) — seeded once per store by `ensureSystemAccounts()`

Source: `SEED_ACCOUNTS` array, `src/lib/financial/accounts/account-defs.ts:77-224`.

| Account ID | UI label | Prefix family | Nature | Business meaning | Evidence | Usage |
|---|---|---|---|---|---|---|
| `cash__cashier` | Cashier Cash | `cash__` | debit | Cash physically in the cashier's drawer | `account-defs.ts:79` | ACTIVE |
| `cash__office` | Office Cash | `cash__` | debit | Cash held in the office safe | `account-defs.ts:80` | ACTIVE |
| `cash__staff` | Cash Request (UI label; formerly "Staff Cash" — key/domain unchanged, display-only rename) | `cash__` | debit | Float released to a staff member, not yet returned | `account-defs.ts:81`; rename noted `SCHEMA_MAP.md:752` | ACTIVE |
| `others__voucher` | Voucher | `others__` | debit, `tracksBalance:false` | Payment-method label only, no running balance | `account-defs.ts:84` | ACTIVE (label only) |
| `others__store_credits` | Store Credits | `others__` | debit, `tracksBalance:false` | Payment-method label | `account-defs.ts:85` | ACTIVE (label only) |
| `others__points` | Points | `others__` | debit, `tracksBalance:false` | Payment-method label (loyalty points redemption) | `account-defs.ts:86` | ACTIVE (label only) |
| `others__others` | Others | `others__` | debit, `tracksBalance:false` | Catch-all payment-method label (also catches `gift_certificate`, `rebate`, and any unrecognized `other` sub-type) | `account-defs.ts:87`; catch-all logic `account-resolver.ts:29-37` | ACTIVE (label only) |
| `others__remittance_variance` | Remittance Variance | `others__` | debit, `tracksBalance:true` | Slice-2a placeholder for remittance variance, superseded by the unified variance model (shortage→`staff_advance__`, overage→`others__remittance_overage`) before it was ever posted to | `account-defs.ts:92` | **DEFINED BUT UNUSED** — comment explicitly says so, `account-defs.ts:89-92` |
| `others__remittance_overage` | Remittance Overage | `others__` | **credit** | Unexplained cash/online surplus at remittance time, held pending review | `account-defs.ts:98`; nature explicit exception `account-registry.ts:37` (`account-defs.ts` same file) | ACTIVE — `remittance.builder.ts:89,199` |
| `expense__platform_fee` | Platform Fee Expense (journal) | `expense__` | debit | Platform commission withheld at source on an AR (channel) collection | `account-defs.ts:105` | ACTIVE — journal-only P&L source, read directly by income-statement, `income-statement.actions.ts:296` |
| `clearing__grab` | Grab Settlement Clearing | `clearing__` | debit (explicit) | Suspense account: Grab payout in transit between gross recognition and net bank deposit; must net to ₱0 per settlement | `account-defs.ts:111`; nature `account-registry.ts:41` | ACTIVE — `channel-settlement/posting.ts:77-93` |
| `clearing__foodpanda` | Foodpanda Settlement Clearing | `clearing__` | debit | Same as above, FoodPanda | `account-defs.ts:112` | ACTIVE |
| `expense__online_order_expenses` | Online Order Expenses (journal) | `expense__` | debit | Aggregate of all delivery-platform settlement deductions (commission, marketing, VAT, WHT, penalty, variance) | `account-defs.ts:118` | **Seeded for trial-balance completeness only** — the P&L OPEX line is read from the per-deduction `/expenses` docs, NOT this account (`account-defs.ts:117`, confirmed by absence from `income-statement.actions.ts` account scans) |
| `expense__depreciation` | Depreciation Expense (journal) | `expense__` | debit | Aggregate monthly/quarterly/annual depreciation across all assets | `account-defs.ts:123` | Same pattern — a paired `/expenses` doc is what the P&L reads (`expenseEntryGroup='OPEX'`), this account is balance-sheet/trial-balance plumbing only. Confirmed: `income-statement.actions.ts` never queries `accountId=='expense__depreciation'` |
| `expense__salary` | Salary Expense (journal) | `expense__` | debit | ONE lump-sum per pay period — the only route payroll cost reaches the P&L | `account-defs.ts:139` | ACTIVE — journal-only P&L source, read directly, `income-statement.actions.ts:357` |
| `expense__salary_additions` | Salary Additions Expense (journal) | `expense__` | debit | Store-defined allowances/incentives/bonuses, kept as a separate P&L line from base salary | `account-defs.ts:146` | ACTIVE — journal-only P&L source, read directly, `income-statement.actions.ts:398` |
| `expense__loss_on_disposal` | Loss on Disposal (journal) | `expense__` | debit | Remaining book value of a written-off fixed asset | `account-defs.ts:151` | **Posted to, but never read by the P&L report** — `income-statement.actions.ts` has no query for this account id and no `/expenses` doc is created for a disposal (`asset-disposal.builder.ts`). A booked write-off currently never reduces reported net income. |
| `expense__interest` | Interest Expense (journal) | `expense__` | debit | Loan interest, recognized cash-basis at payment time | `account-defs.ts:156` | ACTIVE — journal-only P&L source, read directly, `income-statement.actions.ts:255` |
| `expense__amortization` | Amortization Expense (journal) | `expense__` | debit | Aggregate monthly amortization of prepaid items | `account-defs.ts:162` | Same "trial-balance plumbing, P&L reads the `/expenses` doc" pattern as depreciation — confirmed absent from `income-statement.actions.ts` account scans |
| `equity__capital` | Owner Capital | `equity__` | credit | Net owner contribution (single account for both contributions and drawings — no separate drawings contra) | `account-defs.ts:169` | ACTIVE |
| `income__wastage_recovery` | Wastage Recovery (staff) | `income__` | credit | Recognized when a staff member is charged for wasted inventory (contra to the expense already booked) | `account-defs.ts:176` | ACTIVE (as a balance-sheet-side salary-advance counter — see §3, not read by income-statement) |
| `income__charge_recovery` | Charge Recovery (staff) | `income__` | credit | Generic recovery kept-by-store from staff (cash shortages, breakage, payroll tardiness) | `account-defs.ts:187` | ACTIVE (same caveat — not read by income-statement) |
| `expense__order_wastage` | Order Wastage (absorbed) | `expense__` | debit | Net-zero memo: order-level wastage the store absorbs (item cost already flowed through purchases) | `account-defs.ts:194` | Posted (`wastage-expense.builder.ts`), **not read by income-statement** — deliberately net-zero (paired with `income__wastage_writeoff_contra`), so it never affects Net Income even though invisible to the report |
| `income__wastage_writeoff_contra` | Wastage Write-off Contra | `income__` | credit | Counter-leg to the above | `account-defs.ts:195` | Same — posted, not surfaced on any report |
| `income__platform_settlement_gain` | Platform Settlement Gain | `income__` | credit | Other-income when a delivery platform pays MORE than the (immutable) sales report recorded, gated behind a materiality threshold | `account-defs.ts:203`; gate `SCHEMA_MAP.md:228` | ACTIVE — the only `income__*` account surfaced as "Other Income" on the P&L, `income-statement.actions.ts:16-18,435-459` |
| `liability__void_cash_suspense` | Void Cash Suspense | `liability__` (general) | credit | Cash collected on a voided receipt, not refunded — held as a liability pending re-ring/refund instead of recognized as sales cash | `account-defs.ts:211` | ACTIVE — `remittance.builder.ts:112-118` |
| `liability__salaries_payable` | Salaries Payable | `liability__` (general) | credit | PARK account: per-staff payouts debit it; the period's lump-sum salary expense credits it back to (ideally) zero | `account-defs.ts:218` | ACTIVE — central to the payroll double-posting design (§3) |
| `equity__opening_balance` | Opening Balance Equity | `equity__` | credit | Counter for every pre-system (legacy) balance import | `account-defs.ts:223` | ACTIVE — used by 6+ legacy-import builders |

### 1.2 Dynamic account families (13) — one real account per counterparty/entity, created lazily on first use

| ID pattern | Suffix | Nature | Business meaning | Dynamic/fixed | Evidence | Usage |
|---|---|---|---|---|---|---|
| `online__{paymentAccountId}` | admin-created payment account (bank/e-wallet) | debit | Bank/e-wallet balance | Dynamic — created when an admin adds a payment account | `buildOnlineAccountDoc`, `account-defs.ts:229-246` | ACTIVE |
| `ap__{supplierId}` | supplierId (real supplier, OR a commissary "mirror supplier" `commi__{commissaryStoreId}__{arCustomerId}`) | **credit** | Amount owed to a supplier | Dynamic — lazy-seeded on first credit expense | `buildApAccountDoc`, `:249-267`; mirror-id shape `commissary/autobook.ts:59-64` | ACTIVE. Likely instance count: one per real supplier ever booked on credit, plus one per branch↔commissary pair |
| `ar__{customerId}` | customerId (real customer, OR `channel_{channelId}` pseudo-customer for GrabFood/FoodPanda daily receivable, OR a branch store acting as the commissary's customer) | debit | Amount a customer/channel/branch owes the store | Dynamic — lazy-seeded on first credit sale/charge | `buildArAccountDoc`, `:296-314`; channel pseudo-customer id `ACCOUNTING_BLUEPRINT.md:269-271` | ACTIVE |
| `staff_advance__{staffId}` | staffId | debit | What a staff member owes the store — spans salary advance disbursement, cash-request shortage, wastage charge, tardiness charge, opening balance. **Single source of truth** for staff receivables (blueprint calls this out explicitly) | Dynamic — lazy-seeded | `buildStaffAdvanceAccountDoc`, `:275-293` | ACTIVE |
| `staff_reimbursable__{staffId}` | staffId | **credit** | What the store owes a staff member for out-of-pocket business expenses | Dynamic — lazy-seeded | `buildStaffReimbursableAccountDoc`, `:322-340` | ACTIVE |
| `asset__{assetId}` | assetId | debit | Fixed asset gross cost, preserved forever (never decremented by depreciation) | Dynamic — lazy-seeded | `buildAssetAccountDoc`, `:347-363` | ACTIVE |
| `contra_asset__{assetId}` | assetId (same id as its paired `asset__`) | **credit** | Accumulated depreciation for one asset. Net book value = `asset__{id}.balance − contra_asset__{id}.balance` | Dynamic — lazy-seeded | `buildContraAssetAccountDoc`, `:438-454` | ACTIVE |
| `prepaid__{prepaidItemId}` | prepaidItemId | debit | Prepaid current-asset (insurance, permits, prepaid rent, annual SaaS, maintenance contracts), decremented by monthly amortization (unlike depreciation, no contra account — direct reduction) | Dynamic — lazy-seeded | `buildPrepaidAccountDoc`, `:416-432` | ACTIVE |
| `liability__loan_{loanId}` | loanId | **credit** | Outstanding loan principal | Dynamic — lazy-seeded | `buildLoanLiabilityAccountDoc`, `:370-386` | ACTIVE |
| `liability__{key}` (general, non-`loan_`) | admin/system-chosen key: `void_cash_suspense` (fixed instance, see §1.1), `salaries_payable` (fixed instance), `statutory`, `withholding_tax`, one per store-defined payroll deduction type with `treatment:'remit'`, or any free-form key an admin types when creating a liability account (e.g. `tax_payable_2026q1`) | **credit** | Accrued obligations — statutory contributions withheld (SSS/PhilHealth/Pag-IBIG), BIR withholding tax, store-defined remit-type deductions, admin-defined accrued liabilities | Dynamic family, but note two of its members (`void_cash_suspense`, `salaries_payable`) are ALSO always-present fixed seeds — see §1.1 | `buildLiabilityAccountDoc`, `:392-408`; seeded lazily via `prepareLiabilityAccountSeed` at `payroll-staff-payout.actions.ts:569-571,583` (statutory/withholding_tax/custom keys) and `liability.actions.ts:156,258` (admin-created) | ACTIVE |
| `supplier_advance__{supplierId}` | supplierId | debit | Unapplied credit the store holds with a supplier after an AP overpayment | Dynamic — lazy-seeded on first overpayment | `buildSupplierAdvanceAccountDoc`, `:463-481` | ACTIVE — third leg of `ap-payment.builder.ts:113-130`, only when `unallocatedAmount>0` |
| `asset__due_from_{storeKey}` | short store key (e.g. `lipa`, `malvar`) | debit (falls through `inferAccountNature`'s default; not an explicit prefix check) | Inter-store receivable: Store A funded Store B's platform loan repayment out of its own settlement clearing | Dynamic — **no seed factory exists**; the account doc is created purely by `commitJournalLegs`'s merge-write the first time a leg posts to it, so it never receives `nature`/`label`/`domain`/`isSystem`/`tracksBalance` fields the way every other family does | `channel-settlement/cross-store-loan.legs.ts:23-38`, comment `:12-13` "the accounts auto-create via merge-upsert" | ACTIVE but UNCERTAIN completeness of the resulting `AccountDoc` (see §4) |
| `liability__due_to_{storeKey}` | short store key (e.g. `malvar`, `banay`) | credit (caught by the explicit `liability__` prefix rule, so nature inference is correct even without a seed) | Inter-store payable: the loan-owning store owes the funding store back | Dynamic — same no-seed-factory caveat as above | `cross-store-loan.legs.ts:41-58` | ACTIVE, same UNCERTAIN caveat |

**Total: 28 fixed + 13 dynamic families = 41.** (If every dynamic family's live instance count were expanded — e.g. one `ap__` row per supplier, one `ar__` row per customer/channel/branch — actual account *documents* in a mature store easily number in the hundreds; this table counts distinct **ID patterns/families**, as the brief asked.)

---

## 2. The prefix → debit/credit nature table, exactly as implemented

Source: `inferAccountNature()`, `src/lib/financial/accounts/account-defs.ts:19-43`. This is the ONLY function the balancer and every builder use to classify a leg — nature is never stored as data on the leg itself.

```ts
if (accountId.startsWith('ap__'))                    return 'credit';   // :31
if (accountId.startsWith('liability__'))              return 'credit';   // :32
if (accountId.startsWith('staff_reimbursable__'))     return 'credit';   // :33
if (accountId.startsWith('income__'))                 return 'credit';   // :34
if (accountId.startsWith('equity__'))                 return 'credit';   // :35
if (accountId.startsWith('contra_asset__'))           return 'credit';   // :36
if (accountId === 'others__remittance_overage')       return 'credit';   // :37
if (accountId.startsWith('clearing__'))               return 'debit';    // :41 (explicit, "so it can't be accidentally reclassified")
return 'debit';                                                          // :42 (DEFAULT — catches everything else)
```

**Everything that falls through to the line-42 default is debit-nature purely by omission, not by an explicit rule:** `cash__*`, `online__*`, `others__*` (all non-overage members), `ar__*`, `asset__*`, `prepaid__*`, `staff_advance__*`, `expense__*`, `supplier_advance__*`, and `asset__due_from_*`. Every one of these happens to be correctly debit-nature, but the function has **no explicit check for any of them** — a typo'd prefix, or a genuinely new asset/expense-like prefix added without updating this function, silently becomes debit-nature with no error, ever. There is no allow-list or exhaustiveness check on `inferAccountNature` itself (a separate, parallel function — `classifyBalanceSheetAccount()`, below — DOES have such a check, but only for the balance-sheet report, not for posting).

A second, independent classifier exists for the balance-sheet report only: `classifyBalanceSheetAccount()`, `src/lib/financial/balance-sheet-classify.ts:37-56`. Its header comment states **order matters**: `liability__loan_` must be tested before the general `liability__` (otherwise every loan account would be bucketed as "Other Liabilities" instead of "Loans") — this is the one place in the codebase the code itself flags a prefix-matching order dependency. `classifyBalanceSheetAccount` has a case for every prefix in §1 (confirmed by its own header comment: it exists specifically so a unit test can assert every account the registry can create lands in a bucket, added after a real bug where `supplier_advance__` existed in the registry but not in this dispatch and was silently missing from the balance sheet).

---

## 3. Posting patterns — the actual legs written today

Legend: **P&L nominal leg** = a journal leg on an `income__*`/`expense__*` account that a report actually reads. Confirmed against `income-statement.actions.ts`'s own account-id queries (lines cited below) — this is the most load-bearing single fact in this document, so it is stated precisely per pattern rather than assumed.

### Cash expense (no supplier credit)
```
TRIGGER: upsertExpense, src/lib/actions/expense.actions.ts:141
BUILDER: buildExpenseJournalEntries, src/lib/financial/journal/builders/expense.builder.ts:19-135
LEGS TODAY:
  - cash__cashier (or office/staff)   direction: out   amount: payment-split amount
MISSING/NOTES: single leg, "trivially balanced" per balancer.ts:64-67. NO expense nominal
  leg is ever written to the journal for an ordinary expense. The /expenses doc itself
  (with its denormalized `expenseEntryGroup: 'COGS'|'OPEX'|'CAPEX'|...`) is the sole P&L
  source — income-statement.actions.ts:168-210 scans posted /expenses docs directly, never
  an expense__* journal account, for ordinary expenses.
```

### Credit expense (AP booking)
```
TRIGGER: upsertExpense, src/lib/actions/expense.actions.ts:141 (payment.method === 'credit')
BUILDER: buildExpenseJournalEntries, expense.builder.ts:33-52
LEGS TODAY:
  - ap__{supplierId}                  direction: in     amount: credit-split amount
MISSING/NOTES: single leg, balance-sheet only (liability recognition). Same as above — the
  expense doc, not this leg, is what the P&L reads.
```

### CAPEX capitalize leg (a variant of the above, fires from the SAME builder)
```
TRIGGER: upsertExpense, when expense.assetId is set, expense.builder.ts:114-132
LEGS TODAY:
  - asset__{assetId}                  direction: in     amount: totalAmount
MISSING/NOTES: this is a SECOND, independent code path that can post an `asset__` IN leg —
  the other is the dedicated asset-purchase flow below (upsertAssetAction). Both exist
  concurrently; an expense-editor "capitalize" flag routes through this one, the
  /inventory/assets "Add Asset" form routes through the other.
```

### AP payment (paying a supplier)
```
TRIGGER: applyPaymentTransaction, src/lib/actions/payment.actions.ts:137 (also updatePaymentTransaction:444, voidPaymentTransaction:745)
BUILDER: buildApPaymentJournalEntries, ap-payment.builder.ts:36-133
LEGS TODAY:
  - cash__{source} / online__{id}     direction: out    amount: total payment
  - ap__{supplierId}                  direction: out    amount: allocated (applied to invoices)
  - supplier_advance__{supplierId}    direction: in     amount: unallocated (only if overpaid)
MISSING/NOTES: pure balance-sheet — no nominal leg (correct: a payment is not an expense).
  Overpayment (unallocatedAmount) IS modeled on-ledger since this leg was added (blueprint
  §17 originally flagged this as unmodeled; confirmed now closed).
```

### Supplier receipt / delivery
```
TRIGGER: none at the financial-journal layer.
LEGS TODAY: NONE. Receiving stock (a `deliveries/` doc) or logging a `receipts/` doc has
  ZERO journal effect by itself — receipts only track recordedAmount vs totalAmount as a
  pre-expense staging record.
MISSING/NOTES: only recording an EXPENSE against the receipt (upsertExpense with
  receiptId set) posts anything to the journal. This matches CLAUDE.md's own stated
  invariant #2: "An expense records cost; accounts payable records an obligation; cash
  movement records actual money. Keep them distinct" — receiving goods is none of the
  three.
```

### Sales day verification (cash + online + credit sales)
```
TRIGGER: verifySalesDayAction, src/lib/actions/sales-day.actions.ts:49 (voidSalesDayAction:167)
BUILDERS: buildSaleJournalEntries, sale.builder.ts:8-61; buildArChargeJournalEntries, ar-charge.builder.ts:20-44
LEGS TODAY:
  - cash__cashier                     direction: in     amount: cashPayments
  - online__{accountId}               direction: in     amount: per-account online breakdown
  - ar__{customerId}                  direction: in     amount: credit-sale amount (channel_{id} pseudo-customer for GrabFood/FoodPanda)
MISSING/NOTES: NO income__sales / income__revenue nominal leg is EVER posted to the journal
  for ordinary sales, cash or credit. Revenue for the P&L is read directly from the
  `salesDays/{date}` source doc (income-statement.actions.ts:88-100), filtered to
  status ∈ {verified, partially_remitted, remitted}. The journal only ever records the
  balance-sheet SIDE of a sale (cash/online/AR going up) — never the revenue side.
```

### Cash remittance (cashier drawer → office)
```
TRIGGER: remitSalesReportAction, src/lib/actions/sales-report.actions.ts:39
BUILDER: buildCashRemittanceJournalEntries, remittance.builder.ts:34-126
LEGS TODAY:
  - cash__cashier                     direction: out    amount: expected
  - cash__office                      direction: in     amount: actual
  - staff_advance__{chargeToStaffId}  direction: in     amount: shortage   (if expected > actual)
  - others__remittance_overage        direction: in     amount: overage   (if actual > expected)
  - cash__cashier                     direction: in     amount: voidCashRetained (if any voided-receipt cash was retained, drawer-side offset)
  - liability__void_cash_suspense     direction: in     amount: voidCashRetained (its counter-leg)
MISSING/NOTES: pure cash movement between drawer and office, no nominal leg (correct — a
  remittance is not P&L). The void-cash-suspense pair exists to keep a voided receipt's
  uncollected cash out of recognized sales cash.
```

### Online remittance (per payment-account transfer)
```
TRIGGER: recordOnlineRemittanceAction, src/lib/actions/online-remittance.actions.ts:41
BUILDER: buildOnlineRemittanceJournalEntries, remittance.builder.ts:142-209
LEGS TODAY:
  - online__{sourceAccountId}         direction: out    amount: expected
  - online__{targetAccountId}         direction: in     amount: actual
  - staff_advance__{chargeToStaffId}  direction: in     amount: shortage   (if any)
  - others__remittance_overage        direction: in     amount: overage   (if any)
MISSING/NOTES: same shape as cash remittance, no nominal leg.
```

### AR charge / credit sale (outside the sales-day flow, e.g. a standalone credit invoice)
```
TRIGGER: createCreditSaleAction, src/lib/actions/ar-credit-sale.actions.ts:191 (updateCreditSaleAction:318, voidCreditSaleAction:33)
BUILDER: buildArChargeJournalEntries, ar-charge.builder.ts:20-44
LEGS TODAY:
  - ar__{customerId}                  direction: in     amount: creditAmount
MISSING/NOTES: single leg, balance-sheet only. Same revenue gap as sales-day credit sales —
  no income leg; whatever revenue recognition exists for this path is off the journal
  entirely (arTransactions doc / salesDays doc, not verified further in this pass — mark
  UNCERTAIN whether a standalone credit sale independent of a sales day is even counted
  in reported revenue anywhere).
```

### Channel AR auto-creation (GrabFood/FoodPanda daily receivable)
```
TRIGGER: autoCreateChannelArAction, src/lib/actions/ar-channel.actions.ts:39
BUILDER: buildArChargeJournalEntries, ar-charge.builder.ts (same as above; customerId = channel_{channelId})
LEGS TODAY:
  - ar__{channel_{channelId}}         direction: in     amount: channel's day sales
MISSING/NOTES: same shape/gap as AR charge above.
```

### AR collection (customer pays their balance, incl. channel commission withheld at source)
```
TRIGGER: applyArCollectionAction, src/lib/actions/ar-collection.actions.ts:33 (voidArCollectionAction:224)
BUILDER: buildArCollectionJournalEntries, ar-collection.builder.ts:34-96
LEGS TODAY:
  - {destAccountId} (cash__/online__) direction: in     amount: actualReceived
  - ar__{customerId}                  direction: out    amount: grossApplied
  - expense__platform_fee             direction: in     amount: platformFee (if any)
MISSING/NOTES: the platform-fee leg IS a real P&L nominal leg — one of only 4 journal-only
  accounts income-statement.actions.ts reads directly (income-statement.actions.ts:294-322,
  "Platform Fees (collections)" OPEX line). This fixed a prior double-book / phantom
  cash-OUT bug (blueprint §6.2 slice 3c) where a separate /expenses doc synthesized a cash
  leg that never actually left the store.
```

### Commissary branch-sale AR (commissary dispatches goods to a branch it owns)
```
TRIGGER: prepareBranchSaleArPosting / commitBranchSaleArPosting, called from
  branch-order-receive.actions.ts:627,660 and branch-sales-settle.actions.ts:203,221
BUILDER (inline, not a shared builder file): src/lib/financial/commissary/branch-sale-ar.ts:120-134
LEGS TODAY:
  - ar__{branchCustomerId}             direction: in     amount: dispatch/settlement amount
  sourceType 'commissary_dispatch' (types/financial.ts:70)
MISSING/NOTES: single leg on the commissary store's own ledger — the mirrored AP leg lands
  in the BRANCH's separate ledger via an ordinary credit expense (see next pattern), not
  via any shared transaction — these are two independent Firestore transactions in two
  different stores' subcollections, kept in sync by convention (deterministic mirror ids),
  not by a single atomic write. `JournalSourceType` also declares `'commissary_receive'`
  with a doc-comment "AP posted against commissary" (types/financial.ts:69,71) — but this
  string is NEVER used as a journal sourceType anywhere in the codebase; it is reused,
  confusingly, as the (unrelated) INVENTORY-ledger sourceType for the branch's physical
  stock receipt (inventoryLedger/meatInventoryLedger, branch-order-receive.actions.ts:472,534).
  See §4.
```

### Commissary delivery expense (branch books the mirrored AP)
```
TRIGGER: recordCommissaryDeliveryExpensesAction, src/lib/actions/commissary-delivery-expense.actions.ts:48
  (calls the ordinary upsertExpense, expense.actions.ts:141, one per delivery line)
BUILDER: buildExpenseJournalEntries, expense.builder.ts (same as "credit expense" above)
LEGS TODAY:
  - ap__{commi__{commissaryStoreId}__{arCustomerId}}   direction: in   amount: line cost
MISSING/NOTES: this is an ordinary credit expense against a special "mirror supplier" id
  (commissary-delivery-expense.actions.ts:93-110, mirror-supplier.ts) — reuses the generic
  ap__ family rather than a dedicated prefix. Same P&L path as any other credit expense
  (an /expenses doc with a category/sub-category, not a journal nominal leg).
```

### Channel/platform settlement (Grab/FoodPanda payout advice)
```
TRIGGER: recordChannelSettlementAction, src/lib/actions/channel-settlement.actions.ts:62
BUILDER: buildSettlementPosting, channel-settlement/posting.ts:59-111
LEGS TODAY:
  - ar__{customerId}                  direction: out    amount: outstanding (receivable cleared)
  - clearing__{grab|foodpanda}        direction: in     amount: outstanding + gain (clearingIn)
  - income__platform_settlement_gain  direction: in     amount: gain (if platform paid MORE than the immutable sales report recorded)
  - expense__online_order_expenses    direction: in/out amount: |deductionsTotal| (sign-aware — a net promo credit flips direction, see fees.ts)
  - clearing__{grab|foodpanda}        direction: out/in amount: |deductionsTotal| (counter-leg to the above)
  - {destAccountId} (online__)        direction: in     amount: netToBank
  - clearing__{grab|foodpanda}        direction: out    amount: netToBank
  - (cross-store loan, if the channel's loan is owned by a DIFFERENT store — separate txn):
    clearing__{platform} OUT + asset__due_from_{loanStoreKey} IN   (payer side)
    liability__loan_{loanId} OUT + liability__due_to_{payerStoreKey} IN   (loan-owner side)
MISSING/NOTES: income__platform_settlement_gain IS the P&L "Other Income" nominal leg
  (confirmed read directly, income-statement.actions.ts:16-18,435-459). The
  expense__online_order_expenses leg is NOT what the P&L reads for fees — a SEPARATE
  /expenses doc is created per individual deduction line (commission, marketing, VAT, WHT,
  penalty — buildSettlementPosting's `expenseDocs`, posting.ts:96-97,107) and THAT is what
  income-statement.actions.ts's doc-based OPEX scan picks up. The journal account exists
  purely so the trial balance/clearing-nets-to-zero tripwire has something to check against.
```

### Cash request release / return / shortage-charge
```
TRIGGER: releaseCashRequestAction, src/lib/actions/release-cash-request.actions.ts:28;
  returnCashRequestAction, return-cash-request.actions.ts:28;
  chargeCashRequestShortageAction, charge-cash-request-shortage.actions.ts:42
BUILDERS: buildCashRequestReleaseJournalEntries / buildCashRequestReturnJournalEntries,
  cash-request.builder.ts:27-127. Shortage-charge legs are constructed INLINE in
  charge-cash-request-shortage.actions.ts (no shared builder file) per
  ACCOUNTING_BLUEPRINT.md:290-294.
LEGS TODAY:
  Release:  cash__{cashier|office}/online__{id}  OUT  +  cash__staff  IN
  Return:   cash__staff  OUT  +  cash__{target}/online__{id}  IN
  Shortage: cash__staff  OUT  +  staff_advance__{staffId}  IN
MISSING/NOTES: pure balance-sheet (float movement between accounts and a staff
  receivable). No nominal leg — correct, a cash request is not an expense. Historically
  (pre-slice-3a) the shortage charge created an off-ledger salary-advance doc with NO
  journal leg at all — fixed; see §16 of the blueprint.
```

### Salary advance (disbursement / repayment / charge)
```
TRIGGER: upsertSalaryAdvance, src/lib/actions/salary-advance.actions.ts:114 (voidSalaryAdvance:756)
BUILDER: buildSalaryAdvanceJournalEntries, salary-advance.builder.ts:43-155
LEGS TODAY:
  Disbursement:  cash__{source}/online__{id}  OUT  (per split)  +  staff_advance__{staffId}  IN (total)
  Repayment:     cash__{source}/online__{id}  IN   (per split)  +  staff_advance__{staffId}  OUT (total)
  Charge:        staff_advance__{staffId}  IN  +  {chargeCounterAccountId}  IN
                 (counter restricted to the CHARGE_COUNTER_ALLOWED allow-list:
                  income__wastage_recovery | income__charge_recovery | equity__opening_balance —
                  salary-advance/account-allowlists.ts:9-13)
MISSING/NOTES: disbursement/repayment are pure balance sheet. The 'charge' txType IS a
  real nominal leg when the counter is income__* (wastage/tardiness recovery) — but this
  income is NOT read by income-statement.actions.ts anywhere (confirmed absent from its
  account scans) — it sits on the balance sheet's income__* account balance but never
  reaches a P&L report today.
```

### Payroll payout (per-staff payslip)
```
TRIGGER: payStaffPayrollAction, src/lib/actions/payroll-staff-payout.actions.ts:361
  (voidStaffPayrollPayoutAction:674); slicer variant paySlicerPaymentAction,
  staff-payment.actions.ts:386
BUILDERS: buildPayrollPayoutJournalEntries, payroll-payout.builder.ts:84-189;
  buildSlicerPaymentJournalEntries, slicer-payment.builder.ts:64-131 (identical shape, minus
  every deduction leg — slicer pay has no payslip)
LEGS TODAY:
  - liability__salaries_payable       direction: out    amount: gross + additions (PARKED, not expensed)
  - cash__{account}/online__{id}      direction: out    amount: net pay, one leg per funding split
  - staff_advance__{staffId}          direction: out    amount: advance recovered (if any)
  - liability__statutory              direction: in     amount: SSS/PhilHealth/Pag-IBIG withheld
  - liability__withholding_tax        direction: in     amount: BIR withholding withheld
  - income__charge_recovery           direction: in     amount: tardiness charge-back
  - {custom deduction account}        direction: in     amount: one leg per distinct account (store-defined deductions grouped BY ACCOUNT, not by type)
MISSING/NOTES: deliberately NO expense__salary leg here — the gross is PARKED against
  liability__salaries_payable specifically to avoid double-counting, because the period's
  cost is recognized exactly ONCE by the separate lump-sum action below. This is the single
  most unusual (non-standard, from an accountant's perspective) posting pattern in the
  system — an ordinary "pay an employee" event does not touch a salary expense account at
  the moment of payment at all.
```

### Payroll salary-expense recognition (lump-sum, once per pay period)
```
TRIGGER: recordPayrollSalariesExpenseAction, src/lib/actions/payroll-staff-payout.actions.ts:934
BUILDER: buildPayrollSalaryExpenseJournalEntries, payroll-salary-expense.builder.ts:47-79
LEGS TODAY:
  - expense__salary                   direction: in     amount: totalGross
  - expense__salary_additions         direction: in     amount: totalAdditions (if > 0)
  - liability__salaries_payable       direction: in     amount: totalGross + totalAdditions (clears the park)
MISSING/NOTES: THIS is where payroll actually reaches the P&L — writes to
  `payrollSalaryExpenses/`, NEVER to `/expenses`, so the ordinary doc-based expense scan
  never sees it; income-statement.actions.ts has a DEDICATED journal-scan block just for
  this (`income-statement.actions.ts:324-422`) with an explicit comment that this must
  remain the ONLY salary source or payroll double-counts.
```

### Loan (disbursement / payment)
```
TRIGGER: upsertLoanAction, src/lib/actions/loan.actions.ts:85; recordLoanPaymentAction:234
  (voidLoanPaymentAction:422)
BUILDER: buildLoanDisbursementJournalEntries / buildLoanPaymentJournalEntries, loan.builder.ts:34-142
LEGS TODAY:
  Disbursement:  cash__{source}/online__{id}  IN  +  liability__loan_{loanId}  IN
  Payment:       cash__{source}  OUT  +  liability__loan_{loanId}  OUT (principal)  +  expense__interest  IN (if interest > 0)
MISSING/NOTES: interest IS a real, directly-read P&L nominal leg
  (income-statement.actions.ts:249-284, "Loan Interest" OPEX). Cash-basis only — no accrual
  model exists; interest recognized exactly when paid.
```

### Asset purchase + depreciation
```
TRIGGER: upsertAssetAction, src/lib/actions/asset.actions.ts:35; processMonthlyDepreciationAction,
  depreciation.actions.ts:67; disposeAssetAction, asset.actions.ts:367;
  importLegacyAssetAction, asset.actions.ts:201
BUILDERS: asset-purchase.builder.ts:36-80; depreciation.builder.ts:34-70;
  asset-disposal.builder.ts:32-85; asset-legacy-import.builder.ts:36-90
LEGS TODAY:
  Purchase (cash):      asset__{id}  IN  +  cash__{source}/online__{id}  OUT
  Purchase (on account): asset__{id}  IN  +  ap__{supplierId}  IN
  Depreciation:          expense__depreciation  IN  +  contra_asset__{assetId}  IN
  Disposal:              asset__{id}  OUT  +  contra_asset__{id}  OUT (if any)  +  expense__loss_on_disposal  IN (residual book value only, if > 0)
  Legacy import:         asset__{id}  IN  +  contra_asset__{id}  IN (if accum>0)  +  equity__opening_balance  IN (if book value>0)
MISSING/NOTES: depreciation recognition ALSO creates a paired `/expenses` doc at the same
  transaction (blueprint §6.5 5a) — that doc, not the expense__depreciation journal
  account, is what the P&L reads. The disposal's `expense__loss_on_disposal` leg is real and
  posted, but — unlike depreciation/amortization — has NO paired /expenses doc AND is not
  in income-statement.actions.ts's journal-scan list. A booked disposal loss is therefore
  invisible to every income statement generated today (see §4).
```

### Prepaid purchase + amortisation
```
TRIGGER: upsertPrepaidItemAction, src/lib/actions/prepaid.actions.ts:69; processMonthlyAmortizationAction,
  amortization.actions.ts:73; writeOffPrepaidItemAction, prepaid.actions.ts:369;
  importLegacyPrepaidItemAction, prepaid.actions.ts:516
BUILDER: prepaid-purchase.builder.ts:42-144; amortization.builder.ts:39-183
LEGS TODAY:
  Purchase (cash):        prepaid__{id}  IN  +  cash__{source}/online__{id}  OUT
  Purchase (on account):  prepaid__{id}  IN  +  ap__{supplierId}  IN
  Monthly amortization:   expense__amortization  IN  +  prepaid__{id}  OUT
  Write-off:              expense__amortization  IN  +  prepaid__{id}  OUT (remaining book, same shape as amortization)
  Refund on cancellation: cash__{dest}/online__{id}  IN  +  prepaid__{id}  OUT   (no P&L leg by design — U5 path (a))
  Legacy import:           prepaid__{id}  IN  +  equity__opening_balance  IN
MISSING/NOTES: same "P&L reads the /expenses doc, not the journal account" pattern as
  depreciation — amortization creates a paired /expenses doc; expense__amortization itself
  is trial-balance plumbing.
```

### Wastage
```
TRIGGER (order-level, absorbed by store): resolveWastageChargeInternal, src/lib/actions/wastage.actions.ts:736
  (called from resolveWastageDisputeAction:570 and other resolution paths)
BUILDER: buildWastageExpenseJournalEntries, wastage-expense.builder.ts:18-48
LEGS TODAY (absorbed remainder only):
  - expense__order_wastage             direction: in    amount: storeExpense (remainder after any staff %-split)
  - income__wastage_writeoff_contra    direction: in    amount: same
TRIGGER (staff-charged %-split, same flow): postWastageChargesInternal → upsertSalaryAdvance
  (txType:'charge', chargeCounterAccountId:'income__wastage_recovery'), wastage.actions.ts:678-698
LEGS TODAY (charged portion): staff_advance__{staffId} IN + income__wastage_recovery IN (per staff, salary-advance.builder.ts charge shape)
TRIGGER (raw-inventory wastage, separate from order wastage): general-inventory.actions.ts:440-462,
  meat-usage.actions.ts:350,362 — same salary-advance charge mechanism, chargeCounterAccountId:'income__wastage_recovery'
MISSING/NOTES: the order-wastage pair is a deliberate net-zero memo (debit=credit, never
  moves Net Income) — but it is ALSO simply never surfaced on the P&L (not in
  income-statement.actions.ts's scans), so even as a memo line item it is invisible to a
  reader of the report, not just net-zero. Plain inventory wastage (general-inventory,
  meat-usage) posts NOTHING to the journal for the store-absorbed portion at all — only the
  staff-charged portion (if any) touches the ledger, via the salary-advance income leg,
  which itself is never read by the P&L either (see "Salary advance" above).
```

### Inventory count adjustment
```
TRIGGER: none in the financial journal.
LEGS TODAY: NONE. Physical stock counts, adjustments, and reconciliation write exclusively
  to the separate inventory-ledger system (inventoryLedger/, meatInventoryLedger/,
  itemStockLedger/) — a parallel ledger with its own sourceType union
  (types/inventory.ts:191: 'adjustment', 'initial_balance', etc.), structurally unrelated to
  stores/{s}/journal. Confirmed by reading postInventoryUsageRecordAction
  (general-inventory.actions.ts): the only financial-journal touchpoint anywhere near
  inventory counting is the staff wastage-charge salary-advance leg described above — a
  routine "usage" or plain stock adjustment record has zero GL effect.
```

### Transfer (within one store)
```
TRIGGER: recordTransferAction, src/lib/actions/transfer.actions.ts:24 (voidTransferAction:191)
BUILDER: buildTransferJournalEntries, transfer.builder.ts:26-86
LEGS TODAY:
  - {fromAccountId}                   direction: out    amount: amount + fee
  - {toAccountId}                     direction: in     amount: amount (net)
  - {feeAccountId}                    direction: in     amount: fee (if any, must be a debit-nature "expense-like" account)
MISSING/NOTES: `fromAccountId`/`toAccountId` are full account ids within a SINGLE store —
  `TransferInput.storeId` is singular (transfer.builder.ts:16). Fee leg, if present, IS a
  real nominal expense leg but is UNCERTAIN whether income-statement.actions.ts reads it —
  no fee-specific account id (e.g. no seeded "bank fee" account) was found scanned there;
  not confirmed either way in this pass.
```

### Transfer between stores
```
TRIGGER: none as a single first-class action. The only actual cross-store money movement
  found is the channel-settlement cross-store loan mechanism (see "Channel/platform
  settlement" above) and the commissary branch-sale AR/AP mirror pair (see "Commissary
  branch-sale AR" / "Commissary delivery expense" above).
LEGS TODAY: two INDEPENDENT single-store transactions/actions, one per store, tied together
  only by matching ids/keys (loanStoreKey, payerStoreKey, the deterministic mirror-supplier
  id) — never one atomic multi-store transaction.
MISSING/NOTES: there is no dedicated "interbranch cash transfer" builder or account family
  beyond these two special cases; a plain "move ₱X of cash from Store A to Store B" event
  (as opposed to a loan-repayment or a commissary sale) was not found anywhere in the
  actions layer.
```

### Capital / equity movement
```
TRIGGER: recordCapitalContributionAction, src/lib/actions/equity.actions.ts:106;
  recordDrawingAction:213 (voidEquityMovementAction:321)
BUILDER: buildCapitalContributionJournalEntries / buildDrawingJournalEntries, equity-movement.builder.ts:39-95
LEGS TODAY:
  Contribution:  cash__{source}/online__{id}  IN  +  equity__capital  IN
  Drawing:       cash__{source}/online__{id}  OUT +  equity__capital  OUT
MISSING/NOTES: single global equity__capital account for BOTH directions — no separate
  drawings-contra account (a design decision explicitly recorded and rejected in the
  blueprint, §6.5 5b, as "adds complexity without improving audit quality for a restaurant
  business" — noted here only as a fact of what exists, not evaluated).
```

### Reimbursement (claim + payout)
```
TRIGGER (claim, folded into the ordinary expense flow): upsertExpense, expense.actions.ts:141,
  payment split method:'reimbursable'
BUILDER: buildExpenseJournalEntries, expense.builder.ts:54-75
LEGS TODAY (claim): staff_reimbursable__{staffId}  direction: in   amount: reimbursable split amount
TRIGGER (payout): recordReimbursementPayoutAction, src/lib/actions/reimbursement.actions.ts:51
  (voidReimbursementPayoutAction:152)
BUILDER: buildReimbursementPayoutJournalEntries, reimbursement-payout.builder.ts:32-70
LEGS TODAY (payout): cash__{source}/online__{id}  OUT  +  staff_reimbursable__{staffId}  OUT
MISSING/NOTES: no dedicated reimbursement-submission module — a reimbursable claim is just
  another payment-split method on the ordinary expense editor, so the SAME /expenses doc
  (with its expenseEntryGroup) is what feeds the P&L for the underlying cost; the payout
  itself is pure balance-sheet (settling the staff_reimbursable liability, no new expense).
```

### Legacy / opening-balance imports (six shapes, all balance-sheet-only)
```
TRIGGER: importLegacyApAction/importLegacyArAction/importLegacyStaffAdvanceAction/
  importLegacyStaffReimbursableAction/importLegacyCashBalanceAction,
  src/lib/actions/legacy-import.actions.ts:39/111/218/269/320; plus importLegacyAssetAction
  (asset.actions.ts:201) and importLegacyPrepaidItemAction (prepaid.actions.ts:516)
BUILDER: legacy-balance-import.builder.ts:39-291 (AP/AR/staff-advance/staff-reimbursable/cash);
  asset-legacy-import.builder.ts, prepaid-purchase.builder.ts (asset/prepaid variants)
LEGS TODAY: every shape pairs the real account (ap__/ar__/staff_advance__/
  staff_reimbursable__/cash__/online__/asset__/prepaid__) against equity__opening_balance,
  direction chosen so debit=credit by construction (assets/receivables IN grow equity; AP/
  staff-reimbursable-owed shrink it via OUT).
MISSING/NOTES: no P&L effect by design — these exist purely to seed day-1 balances.
  equity__opening_balance nets to (legacy assets + cash + AR) − (legacy AP + loans + staff
  advances owed + other liabilities) = owner's day-1 net contribution, fully derivable from
  the journal (blueprint §6.6, confirmed by the builder set).
```

### Liability charge / payment (general accrued liabilities — tax, accrued expense)
```
TRIGGER: recordLiabilityChargeAction, src/lib/actions/liability.actions.ts:92;
  recordLiabilityPaymentAction:202 (voidLiabilityChargeAction:352, voidLiabilityPaymentAction:414)
BUILDER: liability-charge.builder.ts:45-81; liability-payment.builder.ts:28-65
LEGS TODAY:
  Charge:   liability__{accountId}  IN  +  {chargeCounterAccountId}  IN or OUT (direction caller-supplied per the counter's own nature — expense-nature counters go IN, equity-nature counters go OUT)
  Payment:  cash__{source}  OUT  +  liability__{accountId}  OUT
MISSING/NOTES: whether the charge's counter leg reaches the P&L depends entirely on which
  account the caller passes as chargeCounterAccountId — if it is an expense__* account with
  no dedicated income-statement scan (e.g. a hypothetical `expense__tax`), it would NOT be
  read (only expense__interest/platform_fee/salary/salary_additions are read directly, per
  §3's header). UNCERTAIN whether any live caller currently passes an expense-nature
  counter here versus always using equity__opening_balance (the UI default per
  ACCOUNTING_BLUEPRINT.md:457) — not independently verified beyond the blueprint's own note.
```

---

## 4. Accounts referenced but never created / created but never posted to / posted but never read

**Referenced in the type system but never actually posted to the financial journal:**
- `'commissary_receive'` — declared in `JournalSourceType` (`types/financial.ts:69,71`) with the comment "branch confirms receipt; AP posted against commissary," but grepping the entire codebase for its use shows it is used EXCLUSIVELY as the (separate, unrelated) `MeatLedgerSourceType`/inventory-ledger sourceType (`types/inventory.ts:191`, `branch-order-receive.actions.ts:472,534`). No call to `prepareJournalLegs`/`commitJournalLegs`/any builder anywhere uses `sourceType: 'commissary_receive'`. The branch's mirrored AP is actually booked as an ordinary `'expense_payment'` credit expense (see §3, "Commissary delivery expense"). This is a dead/aspirational value in the financial `JournalSourceType` union, confusingly name-colliding with a real, actively-used inventory-ledger sourceType of the same string.

**Defined (seeded) but never posted to:**
- `others__remittance_variance` — explicitly called out in its own seed comment as "unused as of slice 2b," retained only as a harmless placeholder (`account-defs.ts:89-92`).

**Posted to, but never read by any report (P&L-invisible even though the ledger entry is real and correctly balanced):**
- `expense__loss_on_disposal` — real leg on asset disposal, no `/expenses` doc, absent from `income-statement.actions.ts`'s account scans.
- `expense__order_wastage` / `income__wastage_writeoff_contra` — real, deliberately net-zero pair, but the pair itself never surfaces as a line item on the income statement (net effect on Net Income is correctly zero regardless, but an accountant reading the report cannot see that absorbed wastage happened at all).
- `income__wastage_recovery` / `income__charge_recovery` — real credit-nature legs from salary-advance `charge` and payroll tardiness, never scanned by `income-statement.actions.ts`. (Not fatal to Net Income accuracy since the offsetting debit sits on a balance-sheet receivable, not an expense reversal — but it means "recovered from staff" income is invisible on the P&L.)
- `expense__depreciation` / `expense__amortization` — NOT directly unread: each has a paired `/expenses` doc created in the same transaction, and THAT doc (not the journal account) is what the P&L actually reads. Listed here only to be explicit that the journal account itself is never queried by `income-statement.actions.ts` — it exists for trial-balance/reconciliation completeness, not report generation.
- `expense__online_order_expenses` — same pattern: the aggregate journal account is never queried directly; the per-deduction `/expenses` docs are the real P&L source (confirmed by the account's own seed comment, `account-defs.ts:117`, and by its absence from `income-statement.actions.ts`).

**Created with no seed factory at all (rely purely on `commitJournalLegs`'s partial merge-write):**
- `asset__due_from_{storeKey}` and `liability__due_to_{storeKey}` (cross-store loan) — every other dynamic family has a `prepare*AccountSeed`/`build*AccountDoc` pair that writes a complete `AccountDoc` (label, domain, accountKey, isSystem, isActive, tracksBalance) the first time the account is touched. These two do not — the account doc is assembled by whatever a leg-write's merge happens to include (`journal-writer.ts:170-189`), which is only `storeId`, cash/online-only display tags (that don't apply here), `totalDebits`/`totalCredits`/`balance`/`lastJournalEntryId`/`lastMovementAtMs`/`updatedAtMs`. `label`, `domain`, `accountKey`, `isSystem`, `isActive`, `tracksBalance`, `createdAtMs` are never set for these two accounts. `inferAccountNature`/`classifyBalanceSheetAccount` still classify them correctly by prefix, so balancing and the balance-sheet report are unaffected — but the `AccountDoc` itself is incomplete versus every other account in the system. Marked UNCERTAIN whether any downstream UI (e.g. the accounts list at `/manager/accounts`, which filters on `tracksBalance==true`) actually surfaces these two accounts at all, since that field may never be set to `true` on them.

---

## 5. How account names are displayed to the user

There is **no single central display-name registry**. Labels come from three different places depending on the UI surface:

1. **`AccountDoc.label`** — the primary source. Every fixed seed account carries its label in `SEED_ACCOUNTS` (e.g. `'Cashier Cash'`, `'Salary Expense (journal)'` — `account-defs.ts:79-224`); every dynamic account's `build*AccountDoc` factory constructs its label from live data at creation time (e.g. `` `AP - ${supplierName}` `` for AP, `` `Asset - ${assetName}` `` for assets — `account-defs.ts:259,357` etc.). This label is stored on the account doc itself and generally not recomputed.

2. **Hardcoded fallback maps in specific pages**, used when `AccountDoc.label` is absent or for pretty-printing a raw account id in a drill-down: `CASH_ACCOUNT_LABELS` / `CASH_ACCT_LABELS`, both defined locally in `src/app/manager/accounts/page.tsx:48,204` — e.g. `{ cash__cashier: 'Cashier Cash', cash__office: 'Office Cash', cash__staff: 'Cash Request' }`. The `prettyAcct()` helper (`page.tsx:205-206`) falls back further to `id.slice('online__'.length)` for online accounts, or `id.replace(/__/g, ' · ')` as a last resort — meaning an account id with no known label and no live doc renders as something like `"staff_advance · abc123"`.

3. **Hardcoded section titles on the balance-sheet page**, one per `BalanceSheetBucket` value from `classifyBalanceSheetAccount()` — e.g. `<SectionRows title="Fixed Assets (gross)" lines={bs.fixedAssetsGross} .../>`, `<SectionRows title="Less: Accumulated Depreciation" .../>` (`src/app/accounting/balance-sheet/page.tsx:207-238`). These are UI-layer strings, not stored anywhere, and must be kept in sync by hand with `BalanceSheetBucket`'s member list (`balance-sheet-classify.ts:7-27`).

4. **`OTHER_INCOME_ACCOUNTS`**, a one-entry label map local to the income statement itself: `{ income__platform_settlement_gain: 'Platform Settlement Gain' }` (`income-statement.actions.ts:16-18`) — the only place a P&L line label for a journal-native income account is defined.

Config-owned labels (not derived from the journal at all) also exist for cash sub-accounts and online payment accounts — `cashAccounts/{cash_cashier,cash_office,cash_staff}` and `paymentAccounts/{id}` respectively hold an admin-editable `label`/owner, separate from the `AccountDoc.label` on the corresponding journal account (`ACCOUNTING_BLUEPRINT.md:197-198`); `manager/accounts/page.tsx` merges both sources at read time.

---

## Summary of evidence density

Every posting pattern in §3 is sourced from an actual builder file and an actual action-file trigger with line numbers; every "does this reach the P&L" claim in §3/§4 is sourced from direct inspection of `income-statement.actions.ts`'s own account-id queries (lines 16-18, 168-210, 249-459), not inferred from the blueprint's narrative alone. Anything not independently re-verified against `income-statement.actions.ts` (a handful of edge cases, marked inline) is flagged UNCERTAIN rather than asserted.
