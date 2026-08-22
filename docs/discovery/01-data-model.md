# ERP Firestore Data Model — Discovery Report

Source: `C:\Users\ianla\webapps\ERP-rebuild` (branch `upgrade-next16`), read-only discovery for a relational-DB rebuild.

This report leans heavily on two living documents the codebase already maintains and that I verified against the primary sources (`firestore.rules`, `firestore.indexes.json`, `src/types/*`, `src/lib/actions/*`, `src/lib/financial/*`):

- `AGENTS/ERP Guardian/SCHEMA_MAP.md` (1008 lines) — field-level schema, kept current by an in-repo agent since 2026-06-20
- `AGENTS/ERP Guardian/WORKFLOW_MAP.md` (812 lines) — business-workflow-to-collection map
- `AGENTS/ERP Guardian/ERP_MAP.md` (187 lines) — module/route/fragile-area map

Where a claim is unverified by me directly (i.e., taken from those docs without re-reading the underlying code), it is marked **[from SCHEMA_MAP]** / **[from WORKFLOW_MAP]**. Everything else cites a `path:line` I read directly.

---

## 0. Storage model — top-level shape

- **Multi-store, store-scoped.** Nearly all business data lives under `stores/{storeId}/<subcollection>`. Branch separation is enforced by **path**, not just a field — a document's store is where it lives.
- **Top-level (cross-store) collections:** `users`, `stores`, `staffIdentities`, `expenseEntries`, `appSettings`, `recipes` (+ `recipes/{id}/media`), `productionRecipes`, `cacheJobs`, `configAuditLog`, `fingerprintSecrets/{storeId}/users/{id}`, `faceSecrets/{storeId}/users/{id}` (`firestore.rules:106-635` enumerates every one of these paths explicitly).
- **Accounting core is a live migration.** Legacy dual-ledger (`cashLedger`, `apLedger`, `arLedger`) coexists with the current single-journal model (`accounts` + `journal` + `dailySummary` + `accountMonthlyBalances`). The journal model is the write target for all new code; legacy collections are read-only remnants **[from SCHEMA_MAP §1, §4]**.
- **Everything is a Server Action.** `CLAUDE.md` and `ERP_MAP.md §1` confirm: all mutations go through `src/lib/actions/*.actions.ts` using the Admin SDK, which **bypasses `firestore.rules` entirely**. Rules therefore only gate direct client reads/writes — they are not the authorization boundary for writes. Every server action must self-enforce access control (policy engine + `hasStoreAccess`), and the codebase has a documented history of gaps here (see §5 and the OC-numbered items throughout SCHEMA_MAP/ERP_MAP).
- **Rules-wildcard trap (load-bearing for any port of the security model):** `stores/{storeId}/{col}/{rest=**}` grants read to any store member for **every** subcollection **except** those explicitly excluded (`firestore.rules:398-401`: `localUsers`, `clockTerminals`, `staffPerfMonth`, `staffInfractions`). A narrower `allow read/write: if false` block placed *elsewhere* in the file is a **no-op** unless the collection name is also added to that exclusion list — this has bitten the codebase at least twice (`localUsers`, then `clockTerminals`/`staffInfractions`). Any relational rebuild that tries to mirror "deny unless explicitly allowed" must model this as an explicit allow-list per table/row-policy, not translate the Firestore rule text directly.

---

## 1. Collection inventory

### 1.1 Top-level (cross-store) collections

| Path | Represents | Doc-id convention | Rules |
|---|---|---|---|
| `users/{uid}` | Auth-linked user profile; SOURCE OF TRUTH for permissions | = Firebase Auth uid | self-read/self-limited-update; admin full (`firestore.rules:72-104`) |
| `stores/{storeId}` | Store/branch config | free-form storeId (business-chosen, e.g. slug) | admin-only write (`:106-128`) |
| `staffIdentities/{id}` | Cross-store staff identity registry (links one person's per-store `staff` docs together) | auto-id | provisioned-member read (`:604-612`) |
| `expenseEntries/{id}` | Global P&L category master (category/subCategory/group) | frozen id for system-seeded rows, else auto-id | any signed-in read (`:558-564`) |
| `appSettings/{settingId}` | App-wide config docs, incl. `appSettings/aiProviders` | fixed keys (e.g. `aiProviders`) | admin-only (`:618-620`) |
| `configAuditLog` | Config-change audit trail | auto-id | — (not in rules excerpt; admin-SDK only) |
| `cacheJobs/{jobId}` | Cache/projection job records | auto-id | admin-only (`:614-616`) |
| `recipes/{id}` (+ `recipes/{id}/media/{mediaId}`) | Cross-store cookbook recipes (+ photos/videos) | auto-id | provisioned-member read, server write (`:588-595`) |
| `productionRecipes/{id}` | Cross-store production (meat-conversion) recipes | auto-id | same as `recipes` (`:599-602`) |
| `fingerprintSecrets/{storeId}/users/{localUserId}` | **Server-only** biometric match-token + templates | storeId/localUserId composite path, deliberately top-level so the store wildcard can't reach it | `if false` always (`:625-627`) |
| `faceSecrets/{storeId}/users/{localUserId}` | **Server-only** face-recognition descriptors | same shape as fingerprintSecrets | `if false` always (`:629-634`) |

### 1.2 Store-scoped collections (`stores/{storeId}/...`)

This is the bulk of the schema. Grouped by domain; ~90+ distinct subcollection names were found across `firestore.rules` + `SCHEMA_MAP.md` + indexes. I did not attempt to enumerate every historical/legacy alias — legacy collections retained for the migration (`cashLedger`, `apLedger`, `arLedger`, `inventoryLedger`, `inventoryBalances`) are called out explicitly.

**Sales**
| Collection | Represents | Doc id |
|---|---|---|
| `salesDays/{YYYY-MM-DD}` | One doc per business day per store — the sales report | business date string |
| `salesDays/{date}/adjustments/{adjustmentId}` | Append-only admin-adjustment audit trail | auto-id |
| `cashRemits/{salesDate}` (+ `.../shifts/{shiftId}`) | Cash-remit shift drafts | date / auto-id |
| `salesSummaryMonthDays/{yearMonth}`, `salesSummaryMonthShifts/{yearMonth}` | Monthly rollup projections of the above | `YYYYMM` |
| `oilDays/{dayKey}` | Daily AI-integrity findings ("OIL" = operational integrity layer) | `YYYY-MM-DD` |

**Expenses / AP / suppliers**
| Collection | Represents | Doc id |
|---|---|---|
| `expenses/{eid}` | Expense source doc (cash/online/credit/split payments) | auto-id |
| `suppliers/{sid}` | Supplier master | auto-id |
| `suppliers/{sid}/payments/{pid}` | AP payment source doc | auto-id |
| `suppliers/{sid}/ap_open/{expenseId}` | Per-expense AP outstanding projection — **row deleted when closed** | = source `expenseId` |
| `suppliers/{sid}/ap_suppliers_index/{sid}` | Per-supplier AP rollup | = supplier id |
| `receipts/{rid}` | Groups expense lines under one supplier "business document" | auto-id |
| `expenseBudgets`, `expenseSummaryMonthDays`, `expenseEntrySettings/{settingsDoc}` | Budgets / monthly rollups / per-store category overrides | mixed — `expenseEntrySettings/default` is fixed key |
| `recurringExpenses`, `recurringExpenseRecords/{id}` | Templates + generated period instances | auto-id |
| `expenseParticulars/{particularId}` | Learned particular→category mapping | auto-id |
| `alerts/{id}` | e.g. `recurring_expense_insufficient_funds` | auto-id |

**AR (receivables)**
| Collection | Represents | Doc id |
|---|---|---|
| `arCustomers/{cid}` | AR customer master | auto-id (system-generated ones use a deterministic pattern, e.g. channel customers) |
| `arTransactions/{txid}` | Credit sale or payment/collection row | auto-id, or deterministic for system-generated rows (`ch_<channelId>_<date>` for channel receivables) |
| `arCollections/{colid}` | Collections applied FIFO | auto-id, or deterministic (`chsettle_<channelId>_<salesDate>`, `bpay_<paymentId>`) |

**Cash & GL core**
| Collection | Represents | Doc id |
|---|---|---|
| `accounts/{accountId}` | Running balance per account | **deterministic prefix scheme** — see §2.4 |
| `journal/{entryId}` | One append-only leg per money movement | **deterministic**: `${sourceType}:${sourceId}:${legKey}` (`src/lib/firebase/paths.financial.ts:30-36`) |
| `dailySummary/{YYYY-MM-DD}` | Daily totals per account, `byAccount` map | business date |
| `accountMonthlyBalances/{accountId}__{monthKey}` | Per-account-per-month rollup | composite string |
| `cashRequests/{id}` | Cash request lifecycle | auto-id |
| `cashAccounts/{domainKey}`, `paymentAccounts/{id}` | Cash/online payment account config + balances | domainKey / auto-id |
| `cashDailySummary/{date}` | Cash-specific daily summary | business date |
| `cashMovementDays`, `cashMovementAdjustments`, `cashMovementDays/{date}/domains/{domainId}/accounts/{accountId}` | Legacy cash-movement registry (predates the journal model) | date / nested |
| `cashLedger`, `cashWeeklySummary/{weekKey}`, `cashMonthlySummary/{monthKey}`, `cashYearlySummary/{yearKey}` | Legacy ledger + rollups | mixed |
| `transfers/{id}` | Inter-account transfers | auto-id |
| `paymentsIndex` (collection group) | Cross-collection payment lookup projection | mirrors source payment id |
| `loans/{id}` (+ `.../payments/{pid}`) | Loans + amortization payments | auto-id |
| `prepaidItems/{prepaidItemId}` | Prepaid/amortized items | auto-id |
| `assets/{id}` | Fixed assets (depreciation/disposal) | auto-id |
| `liabilityAccounts` | Standalone liability tracking | auto-id |

**Channel settlement (FoodPanda/Grab)**
| Collection | Represents | Doc id |
|---|---|---|
| `channelSettlements/{id}` | Parent audit doc per settlement | `chsettle_<channelId>_<salesDate>`, or `adj_.../refund_...` for period adjustments |
| `settlementBatches/{batchId}` | One record per recorded batch | auto-id |
| `settlementReviewQueue/{id}` | Manager-approval-pending queued rows | `<channelId>_<date>` |

**Inventory**
| Collection | Represents | Doc id |
|---|---|---|
| `items/{id}` | General inventory item master (new unified model) | auto-id |
| `itemBalances/{itemId}__{locationId}` | Per-location balance **projection** (no named type — inline writes) | composite (`__` separator) |
| `itemStockLedger/{id}` | Signed per-location movement ledger — SOT for `itemBalances` | auto-id |
| `itemLocationSettings/{id}` | Per-item, per-location settings overrides | auto-id |
| `inventoryLocations/{id}`, `inventoryLocationTypes/{id}` | Store locations (rooms/freezers/racks) + type master | auto-id |
| `inventoryLedger`, `inventoryBalances` | **Legacy** movement ledger + store-level balances (maintained aggregate, not SOT, for stores on the location model) | mixed |
| `inventoryUsageRecords`, `meatUsageRecords` | Usage/consumption records | auto-id |
| `deliveries/{id}` | Supplier/commissary delivery (receive → stock in) | auto-id |
| `supplierReturns/{id}` | Stock-OUT record for goods returned to supplier | auto-id |
| `stockTransfers/{id}` | Inter-location transfers (commissary rooms) | auto-id |
| `stockCounts/{id}`, `countSessions/{id}` | Physical count records + location-freeze locks | auto-id |
| `meatProducts/{id}` | Meat slab/sliced product master | auto-id, migrates into `items` as `legacyId='mp_{id}'` |
| `meatInventoryLedger`, `meatInventoryBalances` | Meat-specific ledger + balances (keyed by RAW `meatProducts` id) | `{sourceType}:{recId}:r{n}:{legKey}` for revisions ≥1 **[from SCHEMA_MAP §0a]** |
| `productionRecords` | Slab→sliced conversion records | auto-id |
| `slicerPayments/{id}` | Slicer salary payments (park-then-lump-sum, see §5) | auto-id |
| `branchOrders/{id}`, `branchOrderCounters/{key}` | Commissary↔branch order lifecycle | auto-id / fixed key |
| `commissaryItemConfigs/{itemId}` | Per-item branch pricing rules | = itemId |
| `commissaryItemMap/{mapId}` | Commissary item → branch item map | auto-id |
| `posItemMap/{posItemId}` | **POS sellable item → ERP stock item** | **= sanitized POS inventory doc id** (deterministic, O(1) lookup) |
| `posUsagePulls/{dayKey}` | Per-day POS→usage pull audit | `YYYY-MM-DD` |
| `posSoldItemsCache/{dayKey}` | Read-through cache of the POS sold-items API response | `YYYY-MM-DD` |
| `itemReorderPolicies/{itemId}`, `reorderAlerts/{itemId}` | Smart-reorder config + persisted alerts | = itemId |
| `wastages/{id}`, `wastageSettings` | Order/dine-in/platform wastage + type config | auto-id / fixed |
| `inventoryDepartments` | Department master (usage tagging + checklist picker) | auto-id |
| `inventoryProducts/{productId}` | Stock/inventory product catalog (settings-level) | auto-id |
| `packagingTypes/{id}`, `productionPriceRules/{id}`, `productionSettings/{id}` | Meat/packaging/production config | auto-id |

**Staff / operations / payroll**
| Collection | Represents | Doc id |
|---|---|---|
| `staff/{id}` | Per-store staff record | auto-id |
| `staff/{id}/signatures/{id}` | Immutable signature-capture audit history | auto-id |
| `staff/{id}/hourlyRateHistory/{id}` | Rate-change history | auto-id |
| `localUsers/{id}` | Local (non-Firebase) login credential — cashier/slicer/cook | auto-id |
| `attendanceSessions/{id}` | Clock in/out sessions | auto-id |
| `attendanceRawTaps/{id}`, `attendanceImports/{id}` | Raw device taps + import batches | auto-id |
| `shifts/{shiftId}` | Scheduled shifts (collection-group queried) | auto-id |
| `breakLogs/{id}` | Break start/end tracking | auto-id |
| `clockTerminals/{terminalId}` | Registered biometric/offline clock stations (server-only) | auto-id |
| `overtimeRecords/{id}`, `absenteeRecords/{id}` | OT + absence tracking | auto-id |
| `payrollPeriods/{id}`, `payslips` | Legacy payroll periods + payslips | auto-id |
| `payrollRuns/{runId}` (+ `payslips/{staffId}`), `payrollRunLocks/{start}__{end}` | **Legacy/superseded** whole-period payroll run + idempotency lock | mixed |
| `payrollStaffPayouts/{payoutId}` | **Current** per-staffer payout | deterministic `staffPayoutId(periodStart,periodEnd,staffId)` |
| `payrollSalaryExpenses/{id}` | One lump-sum salary expense per period | create-if-absent, keyed by period |
| `payrollPeriodCache/{periodKey}` | Cached period computation (preview) | periodKey |
| `payrollDeductionTypes/{typeId}` | Store's custom deduction catalogue | auto-id |
| `staffPayrollDeductions/{staffId}__{typeId}` | Per-staffer deduction enrolment | composite (double-underscore) |
| `payrollAdjustments/{periodStart}__{periodEnd}__{staffId}` | Per-period manager overrides (e.g. advance-recovery override) | composite |
| `salaryAdvances/{id}`, `salaryAdvanceStaffBalances/{id}` | Salary advances + running balance | auto-id / = staffId |
| `salaryAdvanceSettings/{settingId}` | Per-store SA config | fixed |
| `staffInfractions/{id}`, `infractionTypes/{id}` | Disciplinary records + type master | auto-id |
| `memos/{id}` | Manager memos (+ optional attached document) | auto-id |
| `checklistTemplates`, checklist reports (name unconfirmed) | Recurring checklist config + submissions | auto-id |
| `managerDailyReports/{dayKey}`, `managerDailyReportSettings/recurientItems`, `managerTasks/{id}` | Manager daily report + persistent task inbox | dayKey / fixed / auto-id |
| `onboardingDocs/{docId}`, `onboardingExams/{examId}`, `onboardingProgress/{progressId}` | Employee onboarding content + progress | auto-id |
| `performanceConfig/meta`, `staffPerfMonth/{monthKey}` | Performance scoring config + monthly leaderboard projection | fixed / `YYYYMM` |
| `absenteeSettings/{settingId}`, `attendanceConfig` (embedded on `stores/{storeId}`, not a subcollection) | Config | fixed |
| `activityLog` (collection group) | Cross-cutting audit trail of actions | auto-id |
| `aiCallLog/{id}`, `dailyInsights/{dayKey}`, `aiInsightConfig/{docId}` | AI call audit + daily insight docs + config | auto-id / dayKey / fixed |

**Dashboard / integrity**
| Collection | Represents | Doc id |
|---|---|---|
| `dashboardSummary` (implied singleton per store, not explicitly in rules excerpt but referenced throughout) | Pre-computed dashboard counters | fixed / per-store |
| `insightScorecards/month__{period}` | Manager OIL scorecard, feeds performance leaderboard | composite |

**Legacy / pending-sync**
| Collection | Represents |
|---|---|
| `pendingSyncs/{syncId}`, `deadLetterSyncs/{syncId}` | Sync queue, server-only, client read blocked from client writes |

---

## 2. Field shapes — the significant collections

The following collections have complete, verified field-level passes in `SCHEMA_MAP.md §7` (I read these directly and am summarizing, not re-deriving). Types live in `src/types/index.ts` unless noted.

### 2.1 `users/{uid}` — `UserProfilePlain` (`src/types/index.ts:9,38`)
`role: 'admin'|'manager'|'staff'`, `status: 'pending'|'approved'|'rejected'|'deactivated'`, `storeAccess: string[]` (**the** user→store FK, stored as an array, not a join table), `isActive: boolean`, `canAcceptRemittance`/`canAccessFinancialReports` booleans, `activeStoreId`/`lastActiveStoreId` (UI-preference pointers, not access grants), `createdAt`/`updatedAt` (Timestamp server-side, epoch-ms in the `Plain` DTO used across the server-action boundary via `src/lib/serialize.ts`).

### 2.2 `stores/{storeId}` — `StorePlain` (`:66,107`)
`storeKind: 'commissary'|'branch'|'kiosk'|null` (null = standalone — drives most inventory/nav feature gating), `salesChannels: SalesChannel[]` (embedded array, not a subcollection: `{channelId,name,isActive,isRemittedDaily?}`), `posStoreId`/`posPaymentMethodMap: Record<string,string>` (POS integration link — a map used as a dictionary), `attendanceConfig`/`payrollConfig`/`holidayCalendar` — **entire sub-config objects embedded on the store doc**, not normalized out. This is a strong "everything nests" pattern that a relational schema would want to split into `attendance_config`, `payroll_config`, `holiday_calendar` tables keyed by store_id.

### 2.3 `stores/{storeId}/staff/{id}` — `StaffPlain` (`:584`)
`positions: string[]` is now the SOT for role assignment (`position` is a denormalized `positions[0]` for display) — a relational model wants a join table `staff_positions` if multiple positions matter, or a single FK if not. `linkedLocalUserId` and `linkedUserUid` are two *separate* FKs into two different identity systems (`localUsers` and Firebase `users`) — a staff row can be reached via either or neither, and self-dealing checks (§5) resolve identity through **three fallback paths** across both. `hourlyRateEffectiveFrom` (a date string) anchors a separate `hourlyRateHistory` subcollection.

### 2.4 `stores/{storeId}/accounts/{accountId}` — `AccountDoc` (`src/types/financial.ts:88`)
The GL chart-of-accounts row. **Doc id is not an auto-id — it's a deterministic, parseable composite string**: `{domain}__{accountKey}`, e.g. `cash__cashier`, `ap__{supplierId}`, `ar__{customerId}`, `liability__loan_{loanId}`, `staff_advance__{staffId}`. `inferAccountNature()` (`src/lib/financial/accounts/account-registry.ts:19`, read via `balancer.ts:13,53`) parses the prefix to decide debit/credit nature at read time — **the account "type" is encoded in the primary key**, not a separate column, and order-of-prefix-matching matters (`liability__loan_` must be checked before `liability__`). A relational rebuild should split this into a real `nature`/`domain`/`account_key` columns and stop parsing the PK, but every consumer (`balancer.ts`, `account-defs.ts`, tie-out scripts) currently depends on the parseable-id contract. Balance convention: `balance = totalDebits − totalCredits` for *every* account regardless of nature; sign interpretation is applied at render time.

### 2.5 `stores/{storeId}/journal/{entryId}` — `JournalEntry` (`src/types/financial.ts:153`)
**Doc id is deterministic**: `${sourceType}:${sourceId}:${legKey}` (`src/lib/firebase/paths.financial.ts:30-36`) — this is the idempotency mechanism for the entire GL: re-running the same write with the same inputs always resolves to the same row, so `commitJournalLegs` (§4) can safely recompute deltas against the previous state of the same doc rather than needing a separate dedup table. `sourceType` is a 39-member closed union (`src/types/financial.ts:25-80`) — every business event that touches money is one of exactly these: `sale`, `expense_payment`, `cash_request_release/return`, `ap_payment`, `salary_advance`, `ar_collection`, `transfer`, `opening_balance`, `balance_adjustment`, `remittance`, `online_remittance(_variance)`, `recurring_expense`, `asset_purchase/depreciation/disposal/legacy_import`, `capital_contribution`, `drawing`, `loan_disbursement/payment`, `liability_payment`, `{ap,ar,cash,staff_advance,staff_reimbursable}_legacy_import`, `reimbursement_payout`, `slicer_payment`, `prepaid_purchase/amortization/writeoff/refund/legacy_import`, `commissary_dispatch/receive`, `wastage_expense`, `payroll_payout`, `payroll_salary_expense`. This union is effectively the **transaction-type enum** a relational ledger table would need. `direction: 'in'|'out'` is store-account-relative, not universal debit/credit — `balancer.ts:52-56` translates `(nature, direction)` pairs into textbook debit/credit for the balance check.

### 2.6 `stores/{storeId}/expenses/{id}` — `ExpenseV2Plain` (`:416`) **[from SCHEMA_MAP §7.4]**
`status: 'posted'|'voided'` — **no draft/pending state**; an expense is real the instant it's created. `payments: PaymentSplit[]` — a single expense can legitimately mix cash + online + credit in one array (verified against real production data). `expenseEntryGroup` is a **snapshot frozen at posting time** from the top-level `expenseEntries` collection — changing the master category later must never retro-reclassify posted expenses (this is an explicit accounting invariant in `CLAUDE.md`'s high-risk rules). `dayKey` (YYYY-MM-DD) is NOT guaranteed unique per receipt — a real production example shows a receipt closed on one date getting a new expense line added under it two months later, same receipt id, same dayKey convention broken.

### 2.7 `stores/{storeId}/receipts/{id}` — `ReceiptPlain` (`:341`)
`recordingStatus: 'open'|'closed'|'locked'` is the real "is this receipt done" gate — derived (`getReceiptRecordingStatus()`) from `status=='verified' AND unrecordedAmount<=EPSILON`, **not** stable once set: a later void or add of a component expense flips it back open. This is a "denormalized state that can un-terminate" pattern worth flagging for a rebuild — a relational FSM would want a recompute trigger, not a status column trusted as final.

### 2.8 `stores/{storeId}/itemBalances/{itemId}__{locationId}` — inline, no named type (`stock-ledger.ts` et al.; path builder `paths.inventory-ledger.ts:13`)
Composite doc id with a `__` separator encodes a two-part natural key (item, location) directly into the primary key — the classic Firestore "composite key as doc id" pattern that a relational table would instead express as a unique index over two FK columns. Fields (`onHand`, `available`, `reserved`) are written via `FieldValue.increment()` on most paths but **overwritten absolute** on stock-count and room-reallocation — the same field has two different write semantics depending on caller, which a relational migration needs to preserve as two distinct code paths (increment vs. set), not assume one is always safe.

### 2.9 `stores/{storeId}/slicerPayments/{id}` — `src/types/inventory.ts:412-487` **[from SCHEMA_MAP §00]**
Illustrates a recurring pattern in this codebase: **a field's absence is load-bearing.** `payoutDate` is optional and its *absence* is what keeps every pre-migration paid row invisible to a Firestore range query on that field (Firestore excludes docs missing the range field from a range query) — this is deliberately used as a version/migration gate rather than a boolean flag. A relational port must not "helpfully" backfill such a NULL, and must model "excluded from range because NULL" explicitly (e.g., `WHERE payout_date IS NOT NULL AND payout_date BETWEEN ...`) since SQL range predicates already behave this way with NULLs — this is one of the few Firestore quirks that transfers over almost for free.

### 2.10 `stores/{storeId}/wastages/{id}` — `src/types/wastage.ts` **[from SCHEMA_MAP §3 "Staff/operations"]**
`allocation: {rows:{staffId,staffName,percent}[]}` — the store's own share is **never stored**, it's `100 − Σrows[].percent`, computed at read/post time so rounding dust always lands on the store rather than a person. A relational model should keep this derivation as a computed column/view rather than a stored redundant `storePercent`, to preserve the "always sums to exactly 100" guarantee by construction.

### 2.11 Other collections with complete field passes in SCHEMA_MAP §7 (not reproduced here in full — see that doc)
`stores/{storeId}/suppliers/{sid}` (`SupplierPlain`), `stores/{storeId}/arCustomers/{cid}` (`ARCustomerPlain`), `expenseEntries/{id}` (`ExpenseEntryPlain`), `stores/{storeId}/items/{id}` (`ItemPlain`), `stores/{storeId}/meatProducts/{id}` (`MeatProductPlain`), `stores/{storeId}/inventoryLocations/{id}` (`InventoryLocationPlain`), `recipes/{id}` (`RecipePlain`), `stores/{storeId}/loans/{id}` (`LoanPlain` + `loans/{id}/payments/{pid}`).

---

## 3. Relationships (FKs in disguise)

Firestore has no foreign keys or joins; every relationship below is either (a) a string field holding another collection's doc id, (b) an array of ids, or (c) a denormalized copy of the related doc's display fields. This is the section most directly relevant to a relational rebuild — each row is effectively "this needs to become a real FK / join table."

| From | Field | To | Shape | Notes |
|---|---|---|---|---|
| `users/{uid}` | `storeAccess` | `stores/{storeId}` | `string[]` | The core authorization edge. A user↔store many-to-many, stored as an array on the "many" side — classic candidate for a join table `user_store_access(user_id, store_id)`. |
| `stores/{storeId}` | `posStoreId` | external POS system's store id | `string \| null` | Cross-system FK, not internal. |
| `stores/{storeId}` | `posPaymentMethodMap` | payment-method labels → account ids | `Record<string,string>` | Map-as-dictionary; a relational table `store_payment_method_map(store_id, method_key, account_id)`. |
| `stores/{storeId}/staff/{id}` | `linkedLocalUserId` | `stores/{storeId}/localUsers/{id}` | `string \| null` | 1:1, staff→local-login-credential. |
| `stores/{storeId}/staff/{id}` | `linkedUserUid` | `users/{uid}` | `string \| null` | 1:1, staff→Firebase-account (used for self-dealing checks — see §5). |
| `stores/{storeId}/staff/{id}` | `branchId` | (which config applies) | `string \| null` | Soft FK for attendance/payroll config selection. |
| `stores/{storeId}/localUsers/{id}` | `linkedStaffId` | `stores/{storeId}/staff/{id}` | `string \| null` | Inverse of the above; also drives `position` mirroring (staff is SOT once linked). |
| `stores/{storeId}/expenses/{id}` | `supplierId` | `stores/{storeId}/suppliers/{sid}` | `string` | **Overloaded**: for channel-settlement expenses this is repurposed to hold an `arCustomers` id instead of a real supplier — a single FK column pointing at two different tables depending on a flow, which a relational schema must either split into two nullable FKs or add a discriminator column. |
| `stores/{storeId}/expenses/{id}` | `receiptId` | `stores/{storeId}/receipts/{id}` | `string \| null` | Many expenses : one receipt. |
| `stores/{storeId}/expenses/{id}` | `deliveryId` (per delivery-linked expense) | `stores/{storeId}/deliveries/{id}` | `string \| null` | Expense↔delivery link for inventory-impacting purchases. |
| `stores/{storeId}/expenses/{id}` | `cashRequestIds` (+ legacy singular `cashRequestId`) | `stores/{storeId}/cashRequests/{id}` | `string[]` | **One expense can draw from several cash requests** — a real many-to-many, modeled as an array with a single-field auto-index rather than a join table. The plural superset was added 2026-07-05; the singular field is kept for the "primary" one. |
| `stores/{storeId}/suppliers/{sid}/ap_open/{expenseId}` | doc id = `expenseId` | `stores/{storeId}/expenses/{id}` | 1:1 (doc-id-as-FK) | Deleted when the expense closes — a "presence = state" pattern (row exists ⇔ AP item is open). |
| `stores/{storeId}/arCustomers/{cid}` | `linkedStoreId` | `stores/{storeId'}` (a different store) | `string \| null` | Commissary→branch mirror: this AR customer *represents* another store. |
| `stores/{storeId}/arTransactions/{txid}` | `customerId` | `arCustomers/{cid}` | `string` | credit_sale/payment rows FK to the customer. |
| `stores/{storeId}/arTransactions/{txid}` | `channelId` | (FoodPanda/Grab channel, code-level not a collection) | `string \| null` | |
| `stores/{storeId}/loans/{id}` | *(none — deterministic)* | `accounts/{liability__loan_{id}}` | doc-id templating | No stored `accountId` field; the GL account is derived by string-templating the loan's own id. A relational FK would be more honest here than the implicit convention. |
| `stores/{storeId}/journal/{entryId}` | `accountId` | `accounts/{accountId}` | `string` (deterministic id, see §2.4) | Every leg's core FK. |
| `stores/{storeId}/journal/{entryId}` | `supplierId`/`customerId`/`employeeId`/`expenseId`/`cashRequestId`/`prepaidItemId` | respective collections | `string \| null` (denormalized dimensions) | Present purely to make the journal directly queryable by business dimension without a join — the indexes in `firestore.indexes.json` (`journal (accountId, businessDate)`, `journal (sourceType, sourceId, status)`) confirm these are real query paths, not just audit fields. |
| `stores/{storeId}/itemBalances/{itemId}__{locationId}` | doc id halves | `items/{itemId}` (or raw `meatProducts`/legacy id) + `inventoryLocations/{locationId}` | composite PK | See §2.8. |
| `stores/{storeId}/items/{id}` | `expenseEntryId` | `expenseEntries/{id}` (top-level) | `string \| null` | Auto-expense classification on delivery. |
| `stores/{storeId}/items/{id}` | `legacyId` | `'mp_{meatProductId}'` / `'ip_{id}'` | `string \| null` | Migration back-reference into the pre-unification id space — a *namespaced string FK*, not a real id, requiring string-prefix stripping (`rawCommissaryItemId()`) everywhere it's dereferenced. This prefix-strip pattern recurs across meat/commissary/POS-map code and is one of the sharper "gotchas" for a rebuild (see §3 hazards below). |
| `stores/{storeId}/commissaryItemMap/{mapId}` | `branchItemId` | branch-side `items`/`meatProducts` | `string \| null` | `null` means "ledger only, leave on-hand" — a deliberate three-state FK (mapped / explicitly-unmapped-null / no-doc-at-all-unmapped) that a relational schema should make explicit rather than overload NULL for two different meanings. |
| `stores/{storeId}/posItemMap/{posItemId}` | `productId` | `stores/{storeId}/items` (or `inventoryProducts`) RAW id | `string \| null` | Same two-vs-three-state overload as above: `null` = deliberately ignored, absent doc = unmapped/undecided. `recipeId` alternatively points at a *global* `productionRecipes` doc for the "1 sale → N items" explosion case — so this single field's target table depends on `linkState`. |
| `stores/{storeId}/branchOrders/{id}` items[] | `sourceLocationId` | `inventoryLocations/{id}` | `string \| null`, embedded in an array field | FK embedded inside an array-of-objects field, not a top-level column — common throughout this schema (see §3 general observation below). |
| `stores/{storeId}/staffPayrollDeductions/{staffId}__{typeId}` | doc id halves | `staff/{staffId}` + `payrollDeductionTypes/{typeId}` | composite PK | Enforces "at most one enrolment per (staff, type)" via the PK itself rather than a unique index — a pattern repeated at `itemBalances`, `commissaryItemMap`(?), `payrollAdjustments`. |
| `stores/{storeId}/payrollAdjustments/{start}__{end}__{staffId}` | doc id thirds | period + `staff/{staffId}` | composite PK | |
| `stores/{storeId}/slicerPayments/{id}` | `productionRecordIds` | `productionRecords/{id}` | `string[]` | Many-to-many (one payment can cover several production records; a live payment also *freezes* those records against edit/void — a business rule enforced by querying this array, not a DB constraot). |
| `stores/{storeId}/payrollSalaryExpenses/{id}` | `payoutIds`, `slicerPaymentIds` | `payrollStaffPayouts` **and** `slicerPayments` | `string[]` (two id spaces concatenated in one field for `payoutIds`!) | **Hazard**: `payoutIds` spans two different tables' id spaces in one array; `slicerPaymentIds` is the only way to tell them apart. A relational rebuild must NOT merge these into one FK column — model as two separate join tables. |
| `stores/{storeId}/wastages/{id}` (`chargedToStaff`) | embedded `WastageStaffCharge[]` | `staff/{staffId}` + `salaryAdvances` (created as a side effect) | array of objects, each triggering a write to a *different* collection | The wastage doc doesn't store the resulting salary-advance charge's id inline in a clean FK — the relationship is "this posting created that other row," established at write time via a deterministic idempotency key (`wastageChargeTxId`) rather than a stored pointer both ways. |
| `stores/{storeId}/dashboardSummary` | (no direct FK) | derived from `cashRequests`, `arTransactions`, `staff` counts | aggregation, not a relationship | Listed here to make clear it is *not* itself a join — see §4. |

**General relationship hazards for a relational rebuild:**
1. **FKs frequently live inside array-of-object fields**, not as scalar columns (`payments: PaymentSplit[]` on expenses/slicerPayments/payrollStaffPayouts, each split potentially carrying its own `accountId`/`cashRequestId`; `chargedToStaff[]` on wastages; `branchOrders.items[].sourceLocationId`). A straightforward one-table-per-collection mapping will need each of these to become a genuine child table.
2. **Doc-id-as-composite-key is used as a substitute for a unique constraint** in at least five places (`itemBalances`, `staffPayrollDeductions`, `payrollAdjustments`, `payrollStaffPayouts` via a deterministic-id function, journal entries). This is good news for a relational port — these translate cleanly into `UNIQUE(a,b[,c])` constraints — but the *code* currently relies on "same inputs → same doc id → overwrite/merge is safe" as its idempotency mechanism, so the equivalent SQL needs `ON CONFLICT DO UPDATE` upsert semantics, not a naive INSERT.
3. **A single field's target table is sometimes flow-dependent** (`expenses.supplierId` → either `suppliers` or `arCustomers`; `posItemMap.productId` vs `.recipeId`). These need an explicit discriminator column in a relational schema even though Firestore never needed one.
4. **Namespaced/prefixed ids as a migration bridge** (`'mp_'`, `'ip_'` prefixes into `items`, stripped by `rawCommissaryItemId()` at every read/write site touching meat or commissary balances). Any relational migration script must replicate this stripping exactly or silently create phantom rows — this has already caused at least one real production bug in the Firestore system itself (**[from SCHEMA_MAP, meat products section]**).

---

## 4. Projections / rollups / summary docs

Firestore has no server-side aggregation queries at the scale this app needs, so the codebase maintains hand-rolled projections at nearly every layer. All of the below are written transactionally alongside their source write (never by a separate batch job, except where noted as "cron rebuild"), which is the pattern a relational rebuild should evaluate replacing with either a real `GROUP BY` query or a materialized view refreshed on write.

| Projection | Derived from | Written by | Rebuildable? |
|---|---|---|---|
| `stores/{s}/accounts/{accountId}` (`balance`, `totalDebits`, `totalCredits`) | Every posted `journal` leg for that account | `commitJournalLegs` (`journal-writer.ts:180-189`), via `FieldValue.increment` | Yes — `reconcileAccounts()` (`balancer.ts:143-211`) recomputes from raw journal and reports drift; deliberately does **not** trust `accountMonthlyBalances` as ground truth since both are written by the same transaction (drift there would just prove self-consistency, not correctness) |
| `stores/{s}/dailySummary/{date}` (`byAccount` map, `grandTotalDebits/Credits`) | Same journal legs, bucketed by day | same `commitJournalLegs` call, same transaction (`journal-writer.ts:195-208`) | Yes, same source |
| `stores/{s}/accountMonthlyBalances/{accountId}__{monthKey}` | Same journal legs, bucketed by month | same `commitJournalLegs` call (`journal-writer.ts:214-222`) | Yes; `rebuildAccountBalanceAction` **[from SCHEMA_MAP §3 Cash & GL core]** |
| `stores/{s}/suppliers/{sid}/ap_open/{expenseId}` + `ap_suppliers_index/{sid}` | Per-expense AP state | `applyApProjection` / `applySupplierIndexAmountDelta`, called from 8+ transaction sites across expense/payment/receipt actions **[from SCHEMA_MAP §5, `types/index.ts:2395-2428` code comments]** | Partially — `rebuildSupplierIndex` exists but the dashboard's AP counters (`apActiveCount`, `apOutstandingTotal`) were found to have drifted low for months because only 3 of the 8+ write sites updated them, and were subsequently demoted to **rebuild-only** (excluded from the live-increment path entirely) |
| `stores/{s}/dashboardSummary` | `cashRequests.status`, `arTransactions.status`/`outstandingAmount`, `staff.isActive` counts, plus AP figures (rebuild-only) | `incrementDashboardSummary` (per-write, ~20 call sites) for the live counters; `rebuildDashboardSummaryAction` for the rest, nightly + on-demand | Self-healing: dashboard checks `rebuiltAt`/`driftSuspectedAt` per store per page mount and re-triggers rebuild if stale (>6h) or drift-suspected |
| `stores/{s}/staffPerfMonth/{monthKey}` | `staff`, `attendanceSessions`, `absenteeRecords`, `staffInfractions`, `salaryAdvances`, `salaryAdvanceStaffBalances`, `insightScorecards`, `performanceConfig`, checklist reports, usage records, POS metrics | `buildAndWriteStaffPerfMonth`, full replace (`merge:false`) — safe because it's a pure derivation | Nightly cron `POST /api/cron/rebuild-performance` + manual button; **NOT rebuildable for the 2026-05..07 window** because the underlying attendance rows were purged **[from SCHEMA_MAP 2026-08-20/21 entry]** — an example of a projection whose source data can simply vanish |
| `stores/{s}/payrollPeriodCache/{periodKey}` | Live aggregation over `attendanceSessions`, `overtimeRecords`, staff rates, deductions | Computed on read and cached; **frozen** (immutable) once a period posts (`frozen`+`frozenRunId`), then **deleted** on void so it recomputes live again | `schemaVersion` field (currently 4) gates cache validity — bump on any pay-semantics change |
| `stores/{s}/posUsagePulls/{dayKey}` | POS sold-items API response vs. `inventoryUsageRecords` | Server action per pull, idempotent re-pull | Re-pull is itself the "rebuild" mechanism — always safe to re-run |
| `stores/{s}/posSoldItemsCache/{dayKey}` | Raw POS API response | TTL cache (5 min today / 24h past), explicitly "derived data — safe to delete at any time" | Trivially — just re-fetch |
| `catalogCache` (mentioned in user memory, POS-side) | POS catalog | POS is sole writer as of 2026-08-21 | n/a to this repo |
| `itemBalances`/`inventoryBalances`/`projections/inventoryStocks`, `meatInventoryBalances`/`projections/meatStocks` | Signed ledger legs (`itemStockLedger`, `inventoryLedger`, `meatInventoryLedger`) | Same write path as the ledger entry (dual-write) | Yes — `scripts/rebuild-inventory-stocks.mjs`, `scripts/reconcile-itembalances.mjs`, `reconcile-meat-projections.ts` |
| `receipts/{id}.recordingStatus`/`recordedAmount`/`unrecordedAmount` | Sum of linked `expenses` | Recomputed by `reconcileReceiptBalance` on every mutation to a child expense | Yes, but **not monotonic** — can flip `closed`→open again post-hoc (§2.7) |
| `arCustomers/{cid}.outstandingBalance`, `suppliers/{sid}.outstandingBalance` | Denormalized copy of the `ar__{cid}`/`ap__{sid}` GL account balance | Every AR/AP-affecting transaction | Tie-out scripts assert these equal the GL account balance; historically found to drift when a writer used `set(merge:true)` instead of a guarded `update()` **[from SCHEMA_MAP 2026-08-06 entry re: `planArCustomerBalanceMove`]** |
| `dashboardSummary` counters specifically excluded from live increment (`apActiveCount`, `apOutstandingTotal`, `apNextDueDateMs`) | AP state | **Rebuild-only by design** since 2026-08-05 — the type is compile-error-guarded so no future caller can accidentally wire a live increment for these | Only via `rebuildDashboardSummaryAction` |

**Rebuild pattern worth carrying into the relational design:** almost every projection above has (a) a live incremental writer co-located in the same transaction as its source event, and (b) an independent from-scratch rebuild function that recomputes it by scanning raw source rows, used both for disaster recovery and for periodic drift-checking. A SQL rebuild would replace most of the live-increment writers with either triggers or application-level `UPDATE ... SET x = x + delta` in the same transaction, and would replace the rebuild scripts with `INSERT INTO ... SELECT SUM(...) ... GROUP BY ... ON CONFLICT DO UPDATE`.

---

## 5. Transactional invariants

`runTransaction` appears in **72 of 179** action files (`Grep` over `src/lib/actions/*.ts`); `.batch()` (non-transactional multi-write) appears in another 32. This section lists the invariant each protects, grouped by domain. Every one of these needs an equivalent SQL transaction (or a `SERIALIZABLE`/advisory-lock strategy) in a relational port — Firestore's optimistic-transaction retry-on-contention behavior is not automatically replicated by a plain multi-statement SQL transaction, especially for the counter-increment patterns.

### 5.1 The universal primitive: `commitJournalLegs` (`src/lib/financial/journal/journal-writer.ts`)
Every money-moving action in the system funnels through this. One call inside a transaction:
1. Reads the *existing* journal entry at the deterministic id (if any) to compute a **delta**, not an absolute value (`prepareJournalLegs`, `journal-writer.ts:80-117`).
2. Writes the journal entry itself (`t.set`).
3. `FieldValue.increment()`s the account balance, the daily summary's `byAccount` map, and the monthly rollup — **three denormalized aggregates updated atomically with the source-of-truth row, in the same Firestore transaction** (`journal-writer.ts:168-222`).
4. `validateJournalBalance()` (`balancer.ts:63-86`) is asserted (by the caller, before committing) for any multi-leg entry — debits must equal credits in textbook terms, computed via `inferAccountNature()` per leg. Single-leg entries are trivially "balanced" (e.g., simple expense recognition) — **this is a real weak spot**: a caller that mistakenly submits only one leg of what should be a two-leg entry does not get caught by this check (this is exactly the bug that shipped slicer-payment cash-outs with no counter-leg for months — see §5.3).

Invariant: **a source event either posts every leg (journal entry + 3 rollups) or none** — enforced by Firestore transaction atomicity. The deterministic entry id (`sourceType:sourceId:legKey`) additionally makes the whole operation **idempotent** — re-running the same logical write recomputes the same delta from the same "previous" state and converges, rather than double-posting.

### 5.2 Void/reversal invariant
Voiding is modeled as **rewriting the same journal entry doc** with `status:'voided'`, never a new compensating entry. `computeDeltas()` (`journal-writer.ts:233-269`) has explicit branches for `isVoiding` (subtract the previous amount back out) and `isReviving` (posted→voided→posted again, add it back) — so the account/daily/monthly rollups stay correct across an arbitrary number of void/revive cycles on the *same* logical leg. Several call sites (§WORKFLOW_MAP, "Receipt/expense void", "Slicer settlement") deliberately made "revive" **terminal** at the application layer (2026-08-06, `262711c`) even though the ledger primitive itself still supports it — a business-rule restriction layered on top of a more permissive low-level mechanism.

### 5.3 Domain-specific invariants (from `WORKFLOW_MAP.md`, cross-checked against the grep results)

| Workflow | Files | Invariant protected |
|---|---|---|
| Production post/void/edit | `production.actions.ts` | Record status + source slab balance + every output `meatProducts` doc are all read *before* any write inside one transaction, so concurrent posts on the same slab serialize (fixes a real −20kg drift bug from two concurrent posts both reading the same "available" snapshot). Ledger is append-only across revisions; `status==='posted'` filter required by every consumer. |
| Slicer payment pay | `staff-payment.actions.ts`, `payroll-staff-payout.actions.ts` | Re-reads the payment doc (double-pay guard) + the **period's `payrollSalaryExpenses` ref** (mutual-exclusion lock against a concurrent "Record lump sum") inside one transaction; `assertJournalBalanced` before commit; refuses `legs.length < 2` explicitly (catches the historical "one leg, no counter-leg" bug class). |
| Payroll salary-expense recognition | `payroll-staff-payout.actions.ts` | Seeds the `liability__salaries_payable` account, **re-runs the membership query inside the transaction** and aborts if the id set moved since the pre-transaction read (classic read-then-recheck-in-tx pattern against concurrent modification), stamps `salaryExpenseId` on every cleared row. |
| Payroll payout | `payroll-staff-payout.actions.ts` | Refuses if a non-voided payout already exists for staffer+period (deterministic doc id enforces this at the storage layer too); period-lock checked pre- and in-transaction. |
| Wastage allocation posting | `wastage.actions.ts` | Transactional `isOpen` **claim** (`claimOpenWastage`) prevents two concurrent resolutions of the same wastage; allocation legs (staff charge + store net-zero memo) posted together or not at all. |
| AR/AP payment allocation | `payment.actions.ts`, `ar-collection.actions.ts` | FIFO allocation across open items must not double-apply; a payment must move exactly two legs (cash down, AP down) atomically. |
| Cash request lifecycle | `cash-requests.actions.ts`, `release-cash-request.actions.ts`, `return-cash-request.actions.ts`, `charge-cash-request-shortage.actions.ts` | released = spent + returned + shortage must net to zero across the whole chain; release-source mode (`envelope` vs `till`) changes which day's expected remittance is affected. |
| Delivery/receipt void cascade | `delivery.actions.ts`, `receipt.actions.ts` | **Explicitly non-atomic across the cascade** (documented, accepted risk OC-14) — void delivery → void each linked expense (each its own transaction) → void receipt if orphaned → reverse inventory. Retry-safe because already-voided records are skipped, but a mid-cascade failure leaves a genuinely inconsistent intermediate state that the app tolerates and documents rather than solves with a single distributed transaction. **This is the one clear place where the Firestore design intentionally traded atomicity for progress**, and a relational rebuild has an opportunity to actually fix it with a real multi-table transaction. |
| Branch order receive | `branch-order-receive.actions.ts`, `commissary-delivery-expense.actions.ts` | No phantom stock: commissary can't dispatch/fulfil more than on-hand; OUT (commissary) and IN (branch) post at the same "receipt" moment; per-location writes gated by a legacy-entry idempotency probe so they commit as one unit; branch AP auto-book is deliberately **best-effort/non-fatal** (not in the same transaction as the physical receipt) — another documented atomicity trade-off, with a retry + integrity-detector safety net rather than a stronger transaction. |
| Count-session freeze | `count-session.actions.ts`, `general-inventory.actions.ts` | A location under an active freeze session blocks concurrent usage/wastage posts — enforced as a pre-check read (`isLocationFrozenByCountSessions`) inside the posting transaction, not a DB-level lock. |
| Stock transfer in-transit reservation | `stock-transfer.actions.ts` | `itemBalances.reserved` incremented on dispatch, decremented on receive-or-void-of-in-transit; void of an already-received transfer must **not** touch `reserved` — an easy double-release bug if the transaction doesn't branch on the transfer's prior status. |
| Overtime/salary-advance/staff-payment self-approval | `overtime.actions.ts`, `salary-advance.actions.ts`, `staff-payment.actions.ts`, shared `src/lib/server/actor-own-staff.ts` | Segregation-of-duties: the acting user must not be the staffer the money/approval concerns. Resolved via three fallback identity paths, all fail-open by design (a lookup failure never blocks legitimate work) — **the resolver's own author flags this as a residual risk (OC-48)**, since one of the three paths trusts a client-supplied `localActor` on shared floor devices. |
| Manager grants (`canVoidRecords`/`canAdjustInventory`/`canChargeStaff`) | many action files via `buildServerPolicyContext` | Deny-by-default; admin bypasses; enforcement is **entirely in application code**, not the database — a relational rebuild using row-level security could push this down to the DB layer instead. |

### 5.4 `.batch()` (non-transactional bulk writes) — 32 files
Used where either (a) the writes are independent enough that partial completion is acceptable (bulk rebuilds, cache jobs, admin resets), or (b) a true transaction isn't needed because there's no read-then-conditionally-write step (e.g., seeding, bulk imports). Notable: `rebuild-projections.actions.ts`, `admin-reset.actions.ts` (test-data teardown), `pos-item-map.actions.ts`, `attendance-fingerprint.actions.ts`, `attendance-face.actions.ts` (biometric secret writes — atomic within the batch but not read-guarded against concurrent enrollment).

---

## 6. Query patterns

`firestore.indexes.json` declares **84 composite indexes** across 37 distinct collection groups (`python3 -c "import json; ..."` count against the file, verified 2026-08-22). Ranked by index count (a reasonable proxy for how many distinct filter/sort combinations that collection is queried by):

| Collection | # indexes | What it implies about query load |
|---|---|---|
| `expenses` | 12 | Filtered/sorted by every combination of `category`, `dayKey`, `status`, `supplierId`, `sourceType`, `creditAmount` — this is the most heavily-queried transactional collection in the app. |
| `arTransactions` | 7 | Filtered by `customerId`, `type`, `businessDate`, `sourceType`, `isVoided` in many combinations — AR aging + channel reconciliation. |
| `cashRequests`, `payments`, `salaryAdvances` | 5 each | Dashboard/aging-style list views. |
| `ap`, `cashMovementAdjustments`, `journal`, `paymentsIndex`, `productionRecords` | 3 each | |
| `activityLog`, `arCollections`, `arCustomers`, `branchOrders`, `cashLedger`, `meatProducts`, `meatUsageRecords`, `shifts`, `staffInfractions` | 2 each | |
| everything else (`attendanceSessions`, `breakLogs`, `dailySummary`, `expenseBudgets`, `expenseEntries`, `infractionTypes`, `inventoryUsageRecords`, `itemBalances`, `items`, `meatInventoryLedger`, `paymentAccounts`, `receipts`, `staff`, `transfers`, `wastages`, `managerTasks`, `domains`) | 1 each | Simple list/detail queries. |

**Top ~30 concrete query shapes** (collection, filters, order — from the index file directly; `[CG]` = collection-group scope, queried across every store):

1. `expenses`: `supplierId ==, createdAt desc, creditAmount desc, status desc` — supplier detail page, expense history
2. `expenses`: `supplierId ==, creditAmount ==, status ==` — AP-open lookups per supplier
3. `expenses`: `supplierId ==, dayKey ==`
4. `expenses`: `category ==, dayKey desc, createdAt desc` — category-filtered expense list
5. `expenses`: `dayKey desc, createdAt desc` — plain day-scoped list (likely the default `/financial/expenses` view)
6. `expenses`: `category ==, updatedAt desc`
7. `expenses`: `creditAmount desc, dayKey desc`
8. `expenses`: `dayKey ==, status ==` / `status ==, dayKey ==` — AP-aging style
9. `expenses`: `sourceType ==, createdAt desc` — e.g. recurring-generated expenses
10. `expenses`: `status ==, creditAmount ==`
11. `arTransactions`: `businessDate ==, isVoided ==, sourceType ==, type ==, createdAt desc` — channel reconciliation
12. `arTransactions`: `customerId ==, createdAt desc` / `customerId ==, type ==, createdAt desc` — customer statement
13. `arTransactions`: `type ==, businessDate ==, isVoided ==` / `type ==, sourceType ==, businessDate ==, isVoided ==, createdAt desc` — AR aging by type
14. `arTransactions`: `sourceType ==, businessDate ==` — channel-day lookup
15. `cashRequests`: `status ==, requestDate desc` — pending-request list (feeds `dashboardSummary.pendingCashRequestCount`)
16. `cashRequests`: `dayKey ==, releasedAmount ==` / `dayKey ==, releaseSource ==` / `returnedDayKey ==, returnTarget ==` — cash-movement reconciliation
17. `cashRequests`: `requesterName ==, requestDate desc`
18. `payments` **[CG]**: `storeId ==, dayKey ==` and three more `dayKey/isVoided/paymentSource/storeId/status` variants — **the only heavily-indexed collection-group query in the schema besides `shifts`, `arCustomers`, and `domains`**, meaning "all payments across all stores for a given day/method" is a real cross-store query path (likely a finance-wide reconciliation view). This is the strongest signal that a relational rebuild should NOT strictly partition payments by store schema/table — a single `payments` table with a `store_id` column and this composite index is the natural fit.
19. `salaryAdvances`: `staffId ==, dayKey ==` / `staffId ==, txDate desc` — per-staff advance history
20. `salaryAdvances`: `dayKey ==, staffId ==, txType ==, voided ==` — day-scoped reconciliation
21. `journal`: `accountId ==, businessDate ==, createdAtMs desc` / `accountId ==, status ==, businessDate ==` — account statement / ledger view
22. `journal`: `sourceType ==, sourceId ==, status ==` — resolving all legs of one source document (the "look up everything this expense/payment posted" query)
23. `ap`: `status ==, dueDate ==` / `creditAmount ==, status ==` / `status ==, creditAmount ==` — AP aging (collection-group over `ap_open`? — same shape family as `suppliers/{sid}/ap_open`)
24. `productionRecords`: `slicerStaffId ==, productionDate desc` / `slicerStaffId ==, status ==, dayKey ==` / `status ==, productionDate desc` — slicer payment generation source query
25. `staffInfractions`: `staffId ==, incidentDate desc` / `monthKey ==, staffId ==` — per-staff history + monthly performance-projection source
26. `meatUsageRecords` / `inventoryUsageRecords`: `dayKey ==, createdAt desc` (+ `usageDate desc` variant) — daily usage log
27. `meatInventoryLedger`: `productId ==, createdAt desc` — per-product ledger view
28. `itemBalances`: `itemId ==, onHand desc` — "which locations hold this item, richest first"
29. `arCustomers` **[CG]**: `linkedStoreId ==, status ==` — cross-store lookup of commissary-mirror AR customers (small, targeted collection-group query, unlike the broad `payments` one)
30. `shifts` **[CG]**: `storeId ==, createdAt desc` — cross-store shift feed, plus a same-collection `salesDate ==, createdAtMs ==` index

**`collectionGroup()` call sites found directly in code** (not just declared indexes) — 6 total:
- `src/lib/actions/admin-reset.actions.ts:185` — `collectionGroup('domains')`, filtered client-side by `storeId` (test-data teardown, not a hot path)
- `src/lib/actions/branch-order.actions.ts:78` — `collectionGroup('arCustomers')`
- `src/lib/financial/tie-out/tie-out.server.ts:46` — `collectionGroup('ap_open').where('storeId','==',storeId)` — monthly tie-out report
- `src/lib/financial/cash-movement.registry.ts:130,145` — `collectionGroup('payments')` (legacy cash-movement registry, superseded by the journal model but still read)
- `src/lib/actions/integrity-check.actions.ts:683` — comment referencing a `collectionGroup('payments')` query for cross-store payment integrity checks

**Realtime vs. on-demand read pattern** (from `CLAUDE.md`'s documented convention, not re-verified per-page): the app deliberately uses Firestore's `onSnapshot`/`useCollection` realtime listeners **only** for live-collaboration surfaces; everything else uses on-demand `getDocs` + manual refresh, or a paginated server-action wrapper (`useFirestoreServerPagination` + `DateRangeSearch`) for high-volume transactional lists. This matters for a relational rebuild's API design: most "list" pages can be plain paginated REST/RPC queries; a small number of screens (need to be identified screen-by-screen, out of scope here) will need a websocket/SSE equivalent to replace the realtime listener.

---

## 7. Volume / hotness guesses

Firestore has no query-log export I can read directly; these are inferred from (a) index count/shape, (b) commit-frequency and dated schema-churn entries in SCHEMA_MAP/WORKFLOW_MAP (a proxy for how actively a collection is being worked on and therefore likely written), and (c) the business nature of each collection (a multi-store restaurant ERP with daily sales/attendance/inventory cycles). Store-count context: SCHEMA_MAP's 2026-08-20 purge entry gives real numbers — **7 stores**, with per-store attendance volumes of ~1,258 (Lipa) / ~352 (Malvar) / ~49 (TEST) / ~1 (Davao) sessions over a 3-month window, i.e. Lipa alone runs roughly 14-20 attendance sessions/day.

### HOT (written many times per business day, per store)
- `journal` — every money-moving action posts at least one leg; this is the single busiest collection by construction, since 39 distinct source types all funnel through it.
- `accounts`, `dailySummary`, `accountMonthlyBalances` — incremented in the **same transaction** as every journal write, so identical write frequency to `journal` (just fewer distinct docs, since many writes hit the same account/day/month doc — high **contention** risk on popular accounts like `cash__cashier`, which is exactly why `commitJournalLegs` uses `FieldValue.increment` rather than read-modify-write).
- `expenses` — highest index count (12) of any collection; multiple expenses per receipt, receipts happen daily per store.
- `attendanceSessions`, `attendanceRawTaps`, `breakLogs` — one row per clock event per staffer per day; ~14-20/day at the busiest observed store.
- `activityLog` — cross-cutting audit trail; every logged mutation across every domain writes here (`logInventoryChange()` alone covers all inventory mutations).
- `itemBalances`, `itemStockLedger`, `inventoryUsageRecords` — every sale-driven POS usage pull, every delivery receipt, every wastage/usage record touches these.
- `dashboardSummary` — incremented from ~20 distinct call sites across the codebase (per `ERP_MAP.md §6`), so effectively hot-by-fanout even though it's one doc per store.
- `posUsagePulls`, `posSoldItemsCache` — daily-cadence but potentially large payloads (explicitly capped: skipped above ~3000 items / ~700KB to stay under Firestore's 1MiB doc limit — a concrete signal that this collection's data volume is a genuine engineering constraint today, not a future concern).

### WARM (written regularly but not multiple-times-per-transaction; read frequently)
- `salesDays`, `cashRemits` — once/day/store, but heavily read (income statement, dashboards, remittance).
- `arTransactions`, `arCollections`, `payments`, `cashRequests`, `salaryAdvances` — several per day per store, each with its own aging/history views (indexes bear this out — 5-7 composite indexes apiece).
- `deliveries`, `receipts`, `productionRecords`, `slicerPayments`, `wastages` — several per day at busy stores, each carrying a substantial workflow (multi-step lifecycle, cascading voids).
- `staffPerfMonth`, `payrollPeriodCache`, `payrollStaffPayouts`, `payrollSalaryExpenses` — periodic (monthly/semi-monthly) but each write is consequential and the docs are read constantly in between writes.
- `branchOrders`, `commissaryItemMap`, `stockTransfers` — regular but lower cadence than daily sales (commissary↔branch cadence, likely a few times/week per branch).
- `dailyInsights`, `aiCallLog` — one/day/store by cron, but the AI call log grows with every Ask-ERP interaction too.

### COLD / reference (rarely written after initial setup; read constantly)
- `users`, `stores`, `staff`, `suppliers`, `arCustomers`, `items`, `meatProducts`, `inventoryLocations`, `inventoryLocationTypes`, `expenseEntries`, `recipes`, `productionRecipes`, `packagingTypes`, `productionPriceRules`, `inventoryDepartments`, `payrollDeductionTypes`, `infractionTypes`, `checklistTemplates`, `appSettings`, `performanceConfig` — master/config data, edited occasionally by admins/managers, read on nearly every page load.
- `loans`, `assets`, `prepaidItems` — low count, long-lived, amortized over time rather than frequently rewritten.
- `payrollRuns`/`payrollRunLocks` (legacy, superseded 2026-08-05) — effectively frozen; only voided going forward, never newly created.
- `cashLedger`, `apLedger`-equivalent legacy collections — explicitly "superseded by journal; do not extend" **[from SCHEMA_MAP §3]** — read-only historical.
- `fingerprintSecrets`, `faceSecrets`, `clockTerminals` — written once per enrollment/registration event, read on every biometric clock-in (so read-hot, write-cold).
- `recipes/{id}/media` — write-once-per-upload, read on cookbook page views.

### Caveat
These are structural inferences from index shape, schema-churn dates, and documented business cadence — not measured read/write counts. A rebuild that needs real numbers should instrument the current app (Firestore usage dashboards / custom metrics) for at least one full month before finalizing table partitioning or index design, particularly for the `journal`/`accounts` hot path, where the actual per-account write-contention rate materially affects whether a relational port needs row-level locking tuning or can rely on plain `UPDATE` statements.

---

## Appendix A — files read directly for this report

- `firestore.rules` (635 lines, full read)
- `firestore.indexes.json` (1670 lines; parsed programmatically for collection/field/scope, full index list reproduced in §6)
- `src/lib/financial/journal/journal-writer.ts` (full read)
- `src/lib/financial/balancer/balancer.ts` (full read)
- `src/lib/firebase/paths.financial.ts` (excerpt)
- `src/types/financial.ts` (excerpts: `JournalDirection`, `JournalSourceType`, `JournalEntry`, `AccountDoc` doc comment)
- `src/types/index.ts` (excerpt: `DashboardSummaryPlain`)
- `src/lib/ai/data-graph.ts`, `src/lib/actions/admin-reset.actions.ts` (excerpt, for the `domains` collection-group query)
- `AGENTS/ERP Guardian/SCHEMA_MAP.md` (1008 lines, full read)
- `AGENTS/ERP Guardian/WORKFLOW_MAP.md` (812 lines, full read)
- `AGENTS/ERP Guardian/ERP_MAP.md` (187 lines, full read)
- `CLAUDE.md` (repo root, full read via system reminder)
- Grep sweeps: `runTransaction` (72 files), `.batch()` (32 files), `collectionGroup(` (6 call sites), `writeBatch(` (0 — this repo's Admin SDK code uses `.batch()`, not the client-SDK `writeBatch()` function)

Everything under `AGENTS/ERP Guardian/*.md` is itself a first-party artifact of this codebase (not my inference) — I treated it as a primary source, cross-checked its most load-bearing claims (the rules wildcard trap, the journal writer, the balancer) against the actual code, and did not find any discrepancy worth flagging.
