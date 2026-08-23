# ERP Server-Side Business Logic — Discovery Report

Source: `C:\Users\ianla\webapps\ERP-rebuild` (read-only discovery for the relational-DB rebuild). Scope: `src/lib/actions/` (144 `*.actions.ts` files, 578 exported functions), `src/lib/server/`, `src/lib/financial/` (~230 files), `src/lib/inventory/`, `src/lib/payroll/`, `src/lib/attendance/`, `src/lib/operations/`, `src/lib/policies/`, `src/lib/reports/`, `functions/`.

**Methodology.** Every `*.actions.ts` file's exported-function signatures were enumerated (`grep '^export async function'`) and its Firestore mutation targets extracted mechanically (literal `stores/${storeId}/<collection>` template strings, plus a manual read of files using path-helper functions instead of literals). All financial/inventory/payroll/attendance "pure logic" modules relevant to money, dates, tolerances, and self-dealing gates were read in full — these are the files most worth preserving byte-for-byte in a rebuild, since their doc-comments encode years of bug fixes. Everything else was read at the signature + doc-comment level. Every claim below cites `path:line`; anything inferred rather than directly read is marked **[inferred]**.

This repo already has a stated future: `FRAPPE_MIGRATION_CONTEXT.md:1-86` documents that ERP-rebuild is being **demoted from source-of-truth to capture+display** in front of a self-hosted ERPNext/MariaDB backend — i.e., a relational rebuild of the accounting core is already underway as an *industry-standard double-entry system*, independent of this Shareat System effort. That document's "high-risk invariant" list (`FRAPPE_MIGRATION_CONTEXT.md:68`: sale ≠ collection; expense ≠ payable ≠ cash movement; platform deductions stay separated; no double-counting) is the same invariant set section 2 below documents from the code directly — good cross-validation that these are the load-bearing rules, not incidental ones.

Related discovery docs (avoid re-reading in full; cross-referenced below): `02-module-map.md` (routes, cron inventory), `04-auth-and-permissions.md` (role taxonomy, policy-engine detail, security-rules semantics).

---

## 1. Action catalogue

Grouped by domain. "Mutates" lists the store-scoped Firestore collections a file writes to, taken from literal path templates in the file (`stores/{storeId}/<name>` — storeId prefix omitted since it's universal, see §6); a file using only path-helper functions is marked accordingly. One row per file; multi-function files list every exported function.

### A. Sales day / cash remittance / day-close (11 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `sales-day.actions.ts` | `getOldestUnverifiedSalesDayBeforeAction`, `verifySalesDayAction`, `voidSalesDayAction`, `submitSalesDayAction` | `salesDays`, `arTransactions` | Verifying a sales day is the trigger that auto-posts channel AR (`arChannelSales`) and flips the day read-only for non-admins — see §2.1. |
| `sales-report.actions.ts` | `remitSalesReportAction`, `reopenSalesReportAction`, `markSalesDayNothingToRemitAction`, `chargeSalesDayShortagesAction`, `recordSalesDayShortageChargeAction`, `voidSalesDayShortageChargeAction`, `voidSalesDayShortageChargeEntryAction` | `salesDays`, `remittanceDiscrepancies`, `paymentAccounts`, `transfers` | Remit = the cashier's declared cash actually reaching the cashier→office transfer; a shortage becomes a staff charge only through the salary-advance `charge` txType (self-dealing-blocked, §2.9). |
| `sales-report-draft.actions.ts` | `saveSalesDayDraftAction`, `createCashRemitShiftDraftAction`, `saveCashRemitShiftDraftAction` | `salesDays`, `cashRemits/.../shifts` **[inferred from name/paths.cashRemit]** | Draft state precedes verify; shift drafts net against a per-day baseline so a multi-shift day doesn't double-count POS sales (see `posSalesPull.ts`, §7). |
| `sales-report-adjustment.actions.ts` | `recordSalesReportAdjustmentAction`, `voidSalesReportAdjustmentAction`, `listSalesReportAdjustmentsAction`, `listDayExpensesForAdjustmentAction` | `salesDays` (append-only `adjustments` subcollection), `expenses` | Post-verify corrections are append-only audit entries, never in-place edits to the verified totals. |
| `sales-coverage.actions.ts` | `getCashierUnremittedForCashAction`, `applyCashRequestCoverageAction`, `reverseCashRequestCoverageAction` | `cashRequests`, `salesDays` | Lets an unremitted cashier shortfall be "covered" by an existing cash request float rather than a new charge. |
| `daily-review.actions.ts` | `getDailyReviewDataAction`, `saveDailyReviewAction` | `dailyReviewSummary` | Manager's read model over the day's numbers; not a posting path. |
| `daily-snapshot.actions.ts` | `generateDailySnapshotNowAction`, `runDailySnapshotForAllStores` | `stores` (writes a per-store daily snapshot doc) **[via `src/lib/server/daily-snapshot.ts`]** | Cron entry point gated by `systemSecret` (see §7). |
| `dashboard-attention.actions.ts` | `getDashboardAttentionAction` | none (read-only) | Surfaces items needing manager attention from existing projections. |
| `dashboard-summary.actions.ts` | `rebuildDashboardSummaryAction` | `ap_suppliers_index`, `arCustomers`, `cashRequests`, `staff` (reads) → writes `dashboardSummary` **[inferred]** | Full from-scratch rebuild of the dashboard projection — the recovery path when `incrementDashboardSummary` drifts (see `dashboard-summary-integrity.ts`). |
| `sales-target.actions.ts` | `upsertSalesTargetAction` | `salesTargets` | Simple config CRUD. |
| `sales-channel-benchmark.actions.ts` | `getSalesChannelBenchmarksAction` | none (read-only) | Reads `salesDays` to benchmark channel mix. |

### B. AP — expenses, suppliers, payments, receipts (14 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `expense.actions.ts` | `upsertExpense`, `voidExpense` | `expenses`, `receipts`, `deliveries`, `paymentSettings`, + `assets` (CAPEX), `expenseBudgets`, cash-request liquidation, journal, AP projection | THE central money-out writer. Journal legs, AP projection, receipt recording state, cash-request liquidation, and the capitalization threshold all apply inside one flow — see §2.2, §2.11. |
| `ap.actions.ts` | `rebuildAllApDataAction`, `markApSupplierReconciledAction`, `markAllZeroApSuppliersReconciledAction` | `ap_suppliers_index`, `expenses`, `suppliers` | Reconciliation is a manual "I checked this" flag, separate from the open/closed status derived from outstanding balance (`ap/status.ts`, §2.2). |
| `ap-client-bridge.actions.ts` | `setExpenseDueDateAndResyncAp` | `expenses` | Editing a due date must re-sync the AP-open projection so overdue status stays correct. |
| `payment.actions.ts` | `applyPaymentTransaction`, `updatePaymentTransaction`, `voidPaymentTransaction`, `previewSupplierReconcileAction`, `confirmSupplierReconcileAction` | `expenses`, `suppliers` (+ payments subcollection) | A payment allocates across open AP items FIFO-by-id; voiding restores the allocated expenses' outstanding. Cross-store commissary mirror fires from here (`branch-payment-mirror.ts`, §2.3, §8). |
| `receipt.actions.ts` | `reconcileReceiptBalance`, `upsertReceiptAction`, `verifyReceiptAction`, `voidReceiptAction` | `receipts`, `deliveries`, `expenses`, `suppliers`, `configAuditLog` | A receipt is "fully recorded" under a ₱1 tolerance (`receipt/recording.ts:13`, §2.4); non-admin edit/void blocked once any expense is linked (`policy.ts:120-134`). |
| `expense-entry.actions.ts` | `upsertExpenseEntry`, `deleteExpenseEntry`, `batchUpsertExpenseEntries`, `getExportTemplate`, `createStoreExpenseSettings`, `updateStoreExpenseSettings`, `migrateStoreExpenseSettings` | `expenseEntries` (global), `expenseEntrySettings` | The ONE file with a hand-written server-side zod schema (`ExpenseEntryServerSchema`, `expense-entry.actions.ts:25-32`) — the global P&L category taxonomy, gated separately from every transactional write. |
| `expense-budget.actions.ts` | `upsertExpenseBudget`, `runBudgetReissueForAllStores` | `expenseBudgets` | Auto-reissue is a scheduled job (`systemSecret` gated); see `budget-reissue.ts` for the carry-forward rule. |
| `expense-particulars.actions.ts` | `listExpenseParticularsAction`, `rebuildExpenseParticularsIndexAction`, `archiveExpenseParticularAction`, `relabelExpenseParticularAction` | `expenseParticulars` | Learned category→particular mapping; index doc is a read-optimization over the per-particular collection. |
| `delivery.actions.ts` | `saveDeliveryAction`, `updateDeliveryItemAction`, `removeDeliveryItemAction`, `addDeliveryItemAction`, `toggleDeliveryItemNotReceivedAction`, `receiveDeliveryAction`, `voidDeliveryAction`, `adminDeleteVoidedDeliveriesAction`, `linkExpenseToDeliveryItemAction`, `forceLinkExpenseToDeliveryItemAction`, `expenseDeliveryItemAction`, `unlinkExpenseFromDeliveryItemAction`, `markDeliveryItemFlagSettledAction`, `listCandidateExpensesForDeliveryAction` | `deliveries`, `expenses` | Receiving allocates each line to a location (parking in "Receiving" when undecided, `receive-allocation.ts:14-22`, §2.14); a short-ship requires a `ShortageReason` (`shortage-reasons.ts`). |
| `delivery-expense.actions.ts` | `recordDeliveryExpensesAction` | `cashRequests`, `expenses`, `paymentSettings`, `receipts` | Turns received delivery lines into expense docs, one per category-grouped line. |
| `recurring-expense.actions.ts` | `upsertRecurringExpenseAction`, `confirmRecurringExpenseAction`, `deleteRecurringExpenseAction`, `skipRecurringExpenseAction`, `runAutoPayRecurringExpensesForAllStores`, `runAutoPayRecurringExpensesNowAction` | `alerts`, `cashRequests`, `expenses`, `paymentAccounts`, `paymentSettings` | Cash splits are coerced away from the cashier till toward office cash unless explicitly chosen (`payment-routing.ts:19-26`, §2.13). |
| `payment-accounts.actions.ts` | `upsertPaymentAccountAction`, `togglePaymentAccountActiveAction`, `deletePaymentAccountAction` | `paymentAccounts`, `configAuditLog` | Account master CRUD; POS payment-method auto-mapping reads this (§7). |
| `supplier.actions.ts` | `upsertSupplierAction` | `suppliers` | Supplier master CRUD. |
| `supplier-admin.actions.ts` | `countSupplierReceiptsAction`, `adminDeleteSupplierAction`, `adminTransferSupplierReceiptsAction` | `suppliers`, `receipts` | Admin-only supplier merge/delete tooling. |
| `supplier-return.actions.ts` | `recordSupplierReturnAction`, `voidSupplierReturnAction` | **[via path helpers]** | A return reverses inventory received from that delivery and the corresponding AP credit. |

### C. AR — customers, credit sales, collections, channel AR (6 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `ar-customer.actions.ts` | `createArCustomerAction`, `updateArCustomerAction`, `markArCustomerReconciledAction`, `markAllZeroArCustomersReconciledAction` | `arCustomers` | Customer master; `status` (active/inactive) gates whether balance moves fold into the `arOutstandingTotal` dashboard projection (`ar-customer-balance-move.ts`, §2.5). |
| `ar-credit-sale.actions.ts` | `voidCreditSaleAction`, `createCreditSaleAction`, `updateCreditSaleAction`, `writeOffArTransactionAction` | `arCustomers`, `arTransactions` | Credit sale creates a receivable; void reverses the 'sale' journal leg AND the customer balance in the SAME call (a historical bug left the ledger leg posted while only the balance was fixed — `ar-balance-helpers.ts:158-164`). |
| `ar-collection.actions.ts` | `applyArCollectionAction`, `voidArCollectionAction`, `createArCollectionAction`, `recordPlatformFeeExpenseAction` | `expenses`, `paymentAccounts` (+ `arCollections`, `arTransactions` **[via path helpers]**) | Collections apply against receivables and can include a platform-fee deduction recorded as its own expense — kept distinct from the collection itself (see high-risk invariant #3, `CLAUDE.md`). |
| `ar-channel.actions.ts` | `autoCreateChannelArAction`, `reconcileChannelArForAdjustment`, `repairChannelArAction` | `arCustomers`, `arTransactions`, `salesDays` | Auto-creates the FoodPanda/Grab platform receivable at sales-day verification — deliberately excluded from the verified-day lock (`lockedDay.guard.server.ts:74-78`, §2.1) or it would self-block. |
| `ar-maintenance.actions.ts` | `repairCollectionAction`, `voidRedundantPlatformFeeExpensesAction`, `adminDeleteArCollectionAction`, `recomputeArBalanceAction`, `adminDeleteCreditSaleAction` | `expenses` (+ AR collections/transactions **[via path helpers]**) | Recompute-from-source repair tooling — `recomputeCustomerBalanceFromReceivables` (`ar-balance-helpers.ts:169-220`) is the canonical "truth" recomputation. |
| `ar-aging.actions.ts` | `getArAgingReportAction` | none (read-only) | Aging buckets over `arTransactions`. |

### D. Channel settlement & online remittance (4 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `channel-settlement.actions.ts` | `recordChannelSettlementAction`, `voidChannelSettlementAction` | `arCollections`, `arCustomers`, `arTransactions`, `channelSettlements`, `expenses`, `paymentAccounts` | The settlement posting math (`posting.ts`, `fees.ts`) treats fees as a SIGNED net (a promo-heavy day can produce a genuine credit) — see §2.6, the most subtle money-math rule in the codebase. |
| `channel-settlement-batch.actions.ts` | `planChannelSettlementBatchAction`, `recordChannelSettlementBatchAction`, `recordChannelAdjustmentAction`, `repairOrphanChannelArAction` | `arCustomers`, `arTransactions`, `channelSettlements`, `expenses`, `paymentAccounts`, `salesDays`, `settlementBatches`, `settlementReviewQueue` | Batches multiple days' settlements into one payout reconciliation pass. |
| `channel-settlement-discrepancy-infraction.actions.ts` | `planChannelSettlementDiscrepanciesAction`, `fileChannelSettlementDiscrepancyInfractionAction` | `infractionTypes`, `localUsers`, `staff`, `staffInfractions` | Links a settlement variance to a staff infraction when a pattern of discrepancies implicates one person. |
| `online-remittance.actions.ts` | `recordOnlineRemittanceAction`, `voidOnlineRemittanceAction` | `paymentAccounts` | Online-channel money movement separate from the cashier's cash remittance. |

### E. Cash & accounts (9 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `accounts.actions.ts` | `setOpeningBalanceAction`, `createBalanceAdjustmentAction`, `getCashAccountsWithStatusAction`, `getAccountsDashboardAction`, `updateCashAccountSettingsAction`, `rebuildAccountBalanceAction` | `accounts`, `arCustomers`, `suppliers`, `paymentAccounts`, `configAuditLog`, `journal` | Opening balances and manual adjustments post through the same journal-writer as every other transaction — no special-cased balance field. |
| `financial-init.actions.ts` | `ensureSystemAccountsAction`, `reconcileAccountsAction`, `rebuildAccountBalancesAction`, `ensureSystemExpenseEntriesAction`, `migrateSystemExpenseEntryIdsAction`, `repairCashJournalAction`, `diagnoseCashJournalAction`, `repairOnlineAccountsAction` | `accounts`, `cashRequests`, `expenses`, `paymentAccounts`, `remittanceDiscrepancies`, `salaryAdvances`, `salesDays`, `transfers` | Store-provisioning + repair toolkit; seeds the deterministic system account ids (`cash__cashier`, `ap__<supplier>`, etc. — see §6). |
| `cash-requests.actions.ts` | `createCashRequestAction`, `updateCashRequestAction`, `approveCashRequestAction`, `rejectCashRequestAction`, `voidCashRequestAction` | `cashRequests` | Approval self-blocked: a requester cannot approve their own request even as a manager, admin-only override (`policy.ts:47-56`, §2.9). |
| `release-cash-request.actions.ts` | `releaseCashRequestAction`, `voidReleaseCashRequestAction` | `cashRequests` | Releasing hands the approved float to the requester; only an un-returned release can be void-released (`policy.ts:32-34`). |
| `return-cash-request.actions.ts` | `returnCashRequestAction` | `cashRequests` | Closes out a released request's unspent remainder. |
| `charge-cash-request-shortage.actions.ts` | `chargeCashRequestShortageAction`, `voidChargeCashRequestShortageAction` | `cashRequests` | Converts an unliquidated shortage into a staff charge (salary-advance `charge` txType). |
| `capitalization.actions.ts` | `getCapitalizationPolicyAction`, `updateCapitalizationPolicyAction` | `appConfig/capitalization` (top-level doc) | Global CAPEX threshold (₱5,000 default, `expense.actions.ts:44`) that decides expense-vs-asset. |
| `store-provision.actions.ts` | `provisionStoreAction`, `getStoreReadinessAction` | `stores` (+ triggers financial-init) | New-store bootstrap: seeds system accounts, expense entries, default locations. |
| `store.actions.ts` | `updateStoreAction`, `linkPosStoreAction`, `unlinkPosStoreAction`, `listBranchStoresAction`, `savePosPaymentMapAction`, `resolvePosPaymentMethodAction` | `stores`, `paymentAccounts` | POS payment-method override map lives here (§7). |

### F. Assets, liabilities, equity, loans, depreciation, prepaid (7 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `asset.actions.ts` | `upsertAssetAction`, `importLegacyAssetAction`, `updateAssetStatusAction`, `disposeAssetAction` | `expenses` (+ `assets` via `assetDocPath`) | Disposal posts the gain/loss leg; an asset can originate from a CAPEX expense (auto-capitalized) or manual entry. |
| `depreciation.actions.ts` | `processMonthlyDepreciationAction`, `voidMonthlyDepreciationAction` | `expenses` | Straight-line, monthly; idempotent per asset-per-month (mirrors `computeMonthlyDepreciation` in `expense.actions.ts:41-43`). |
| `amortization.actions.ts` | `processMonthlyAmortizationAction` | `expenses` | Prepaid-item monthly recognition; a `LockableFeature` distinct from `depreciation` so a verified day doesn't block system-actor postings (`lockedDay.guard.server.ts:39-40`). |
| `liability.actions.ts` | `upsertLiabilityAccountAction`, `recordLiabilityChargeAction`, `recordLiabilityPaymentAction`, `voidLiabilityChargeAction`, `voidLiabilityPaymentAction` | `liabilityAccounts` **[via path helpers]** | Symmetric charge/payment/void pattern shared with loans. |
| `loan.actions.ts` | `getLoanInterestTotalAction`, `upsertLoanAction`, `recordLoanPaymentAction`, `voidLoanPaymentAction`, `setLoanAutoDeductAction`, `runLoanAutoDeductForAllStores`, `runLoanAutoDeductNowAction` | `stores` (loans + accounts) | Auto-deduct is a scheduled job (cron-gated, §7); can route cross-store (see channel-settlement's `cross-store-loan.ts`). |
| `equity.actions.ts` | `upsertOwnerAction`, `recordCapitalContributionAction`, `recordDrawingAction`, `voidEquityMovementAction` | **[via path helpers]** | Owner capital contributions/drawings post as their own journal source type. |
| `prepaid.actions.ts` | `upsertPrepaidItemAction`, `voidPrepaidItemAction`, `writeOffPrepaidItemAction`, `importLegacyPrepaidItemAction` | `prepaidItems` **[inferred]** | Prepaid asset that amortizes monthly via `amortization.actions.ts`; a `LockableFeature` of its own (`lockedDay.guard.server.ts:38`). |

### G. Payroll & staff compensation (10 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `payroll.actions.ts` | `aggregatePeriod`, `previewPayrollPeriodAction`, `voidPayrollRunAction`, `getPayrollRunForPeriodAction` | `accounts`, `attendanceSessions`, `overtimeRecords`, `payrollRunLocks`, `payrollRuns`, `staff` | Preview-only in Slice 1 (`compute.ts:5`) — reads STORED session hours, never recomputes live against today's config (`workday.ts:15-18`, §2.7). |
| `payroll-staff-payout.actions.ts` | `payStaffPayrollAction`, `voidStaffPayrollPayoutAction`, `recordPayrollSalariesExpenseAction`, `getPayrollSalaryExpenseForPeriodAction`, `voidPayrollSalariesExpenseAction` | `accounts`, `payrollSalaryExpenses` (+ `staffPayouts`) | Per-staff payout freezes the payslip; any later attendance/deduction edit for that period is refused by `paid-guard.server.ts` (§2.8) unless the payout is voided first. |
| `payroll-addition.actions.ts` | `listPayrollAdditionTypesAction`, `upsertPayrollAdditionTypeAction`, `listStaffPayrollAdditionsAction`, `upsertStaffPayrollAdditionAction`, `bulkAssignStaffPayrollAdditionAction`, `removeStaffPayrollAdditionAction` | **[via path helpers]** | Recurring/one-off additions (allowances, bonuses) feeding the payslip. |
| `payroll-deduction.actions.ts` | `listPayrollDeductionTypesAction`, `upsertPayrollDeductionTypeAction`, `listStaffPayrollDeductionsAction`, `upsertStaffPayrollDeductionAction`, `bulkAssignStaffPayrollDeductionAction`, `removeStaffPayrollDeductionAction`, `setPayrollAdvanceOverrideAction` | **[via path helpers]** | Deduction waterfall order matters for statutory-vs-other deductions (see `payroll/compute.ts`). |
| `payroll-recurring-seed.actions.ts` | `syncPayrollRecurringExpenses` | recurring-expense collections **[inferred]** | Bridges payroll additions/deductions into the recurring-expense engine. |
| `salary-advance.actions.ts` | `upsertSalaryAdvance`, `voidSalaryAdvance`, `zeroBalanceSalaryAdvanceAction`, `inspectSalaryAdvanceStaffJournalAction`, `voidStaffAdvanceJournalLegAction`, `recomputeSalaryAdvanceStaffAction`, `getStaffCrossStoreLedgerAction` | `cashRequests`, `receipts`, `salaryAdvanceSettings`, `salaryAdvances` | Self-dealing block on `salary_advance`/`repayment` txTypes (`salary-advance.actions.ts:226-241`, §2.9); `charge` deliberately exempt. `getStaffCrossStoreLedgerAction` is a genuine cross-store read (§6). |
| `salary-advance-settings.actions.ts` | `upsertSalaryAdvanceSettings` | `salaryAdvanceSettings` | Per-store advance policy config. |
| `staff-payment.actions.ts` (Slicer Payment) | `generateSlicerPaymentAction`, `verifySlicerPaymentAction`, `paySlicerPaymentAction`, `voidSlicerPaymentAction`, `getSlicerPaymentsAction` | `accounts`, `payrollSalaryExpenses`, `staff` | Per-piece meat-slicer staff pay, computed from posted production/slicing records — a separate compensation stream from hourly payroll. |
| `overtime.actions.ts` | `saveOvertimeAction`, `approveOvertimeAction`, `voidApprovedOvertimeAction`, `rejectOvertimeAction` | `overtimeRecords` | Self-approval block on `approveOvertimeAction` only — reject/void deliberately left open since they move pay DOWN (§2.9). At most one active record per staffer/day (`overtime-guard.ts:21-37`). |
| `reimbursement.actions.ts` | `recordReimbursementPayoutAction`, `voidReimbursementPayoutAction` | `reimbursementPayouts` | Pays out a staff member's accumulated reimbursable-expense liability. |

### H. Attendance & workforce clock (13 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `attendance-clock.actions.ts` | `getClockCredentialConfigAction`, `clockByPasscodeAction`, `clockByNfcAction`, `clockByFingerprintAction`, `getAttendanceStateAction`, `identifyFaceAction`, `clockByFaceAction`, `listClockSessionsAction`, `getClockSessionAction`, `listOnShiftRosterAction`, `listTodayClockFeedAction` | `attendanceMeta`, `attendancePunchLog`, `attendanceSessions`, `breakLogs`, `configAuditLog`, `staff` | Every clock-in resolves a schedule anchor + raises short-shift pending OT inline (`workday.ts`, `pending-ot.ts`, §2.7). |
| `attendance-review.actions.ts` | `verifyAttendanceSessionAction`, `setAttendancePayrollInModeAction`, `voidAttendanceSessionAction`, `setAttendanceHalfDayAction`, `setAttendanceEarlyOutApprovedAction`, `getAttendanceDecisionOptionsAction`, `setAttendanceLateOutOtAction` | `attendanceSessions`, `breakLogs`, `staff` | Manager Late/Next-in and Early-out decisions feed straight into `resolveWorkday`'s `overlay`/`outOverlay` — same function, not a parallel recompute (§2.7). Every write goes through `paid-guard.server.ts` first (§2.8). |
| `attendance-sweep.actions.ts` | `sweepStaleOpenSessionsAction` | `attendanceSessions` | Scheduled cleanup of sessions with a clock-in but no clock-out past a threshold. |
| `attendance-face.actions.ts` | `enrollFaceAction`, `removeFaceAction`, `listFaceEnrollmentsAction` | `configAuditLog` (+ `faceSecrets`, a top-level `if false`-rules collection) | Biometric secrets deliberately live OUTSIDE the `stores/**` wildcard so the general store-member read rule can't reach them (`04-auth-and-permissions.md`). |
| `attendance-fingerprint.actions.ts` | `enrollFingerprintAction`, `removeFingerprintAction`, `listFingerprintTemplatesAction` | `configAuditLog` (+ `fingerprintSecrets`) | Same isolation pattern as face enrollment. |
| `attendance-payroll.actions.ts` | `linkStaffLocalUserAction`, `provisionLocalUserForStaffAction`, `enrollNfcCardAction`, `generateAssignIdAction`, `clearAssignIdAction`, `updateAttendanceSettingsAction`, `updateStoreClockCredentialsAction`, `updateStaffPayrollAction`, `updateStaffHourlyRateAction` | `configAuditLog`, `staff` | Rate changes are versioned (`staff/{id}/hourlyRateHistory`) rather than overwritten. |
| `break-log.actions.ts` | `startBreakAction`, `endBreakAction`, `voidBreakAction` | `breakLogs` | Break minutes feed `applyBreakAndCaps` (`session-hours.ts`) — only the OVER-allowance portion is deducted from pay. |
| `offline-clock.actions.ts` | `registerClockTerminalAction`, `revokeClockTerminalAction`, `getOfflineClockBundleAction` | `configAuditLog` | Issues the offline-capable terminal bundle (see `05-offline-and-biometrics.md` for the sync/replay contract; `offline-replay.ts` in this scope handles idempotent replay). |
| `absentee.actions.ts` | `saveAbsenteeAction`, `voidAbsenteeAction` | `absenteeRecords`, `absenteeSettings` | Marks a scheduled-but-absent day distinctly from a missed clock-out. |
| `absentee-settings.actions.ts` | `upsertAbsenteeSettings` | `absenteeSettings` | Config CRUD. |
| `missed-report-infraction.actions.ts` | `fileMissedReportInfractionAction`, `excuseMissedReportAction` | `infractionTypes`, `staffInfractions` | Auto-files an infraction when a manager's daily/shift report goes missing past a grace window. |
| `checklist.actions.ts` | `submitChecklistReportAction`, `resubmitChecklistReportAction`, `flagChecklistReportAction`, `verifyChecklistReportAction`, `upsertChecklistTemplateAction`, `deleteChecklistTemplateAction` | **[via path helpers]** | Manager/staff operational checklists — submit → flag/verify lifecycle. |
| `manager-tasks.actions.ts` | `createManagerTaskAction`, `resolveManagerTaskAction` | **[via path helpers]** | Ad-hoc manager to-do items, not a payroll/attendance record. |

### I. Staff / HR (13 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `staff.actions.ts` | `upsertStaff`, `saveStaffSignatureAction`, `setStaffLinkedUserAction` | `configAuditLog`, `meta` (staff counter), `staff` | `staff.active` is a DERIVED field (see `project_staff_active_status_derived` in project memory) — not toggled directly here. |
| `staff-identity.actions.ts` | `upsertStaffIdentityAction`, `deleteStaffIdentityAction`, `rebuildStaffIdentityBalanceAction` | `staffIdentities` (top-level, cross-store) | Links one person's per-store `staff` docs so cross-store balances (salary advance, memos) can be found — see §6. |
| `staff-perf.actions.ts` | `rebuildStaffPerfMonthAction`, `getPosMappingDataAction`, `setStaffPosProfileAction`, `savePerformanceConfigAction`, `getStaffPerfDetailAction`, `getMyStaffPerfAction` | `performanceConfig`, `salaryAdvances`, `staff`, `staffInfractions` | Performance score aggregates attendance + sales attribution + infractions into one monthly figure (`project_employee_performance_score`). |
| `position.actions.ts` | `listPositionsAction`, `upsertPositionAction`, `archivePositionAction`, `restorePositionAction`, `updateLocalUserPositionAction` | `configAuditLog`, `localUsers` | Position is the SOT for local-user operational role (distinct from Firebase `role`) — see `project_staff_position_sot`. |
| `local-user.actions.ts` | `listLocalUsersAction`, `listPasscodeConflictsAction`, `createLocalUserAction`, `updateLocalUserAction`, `resetLocalUserPinAction`, `archiveLocalUserAction`, `restoreLocalUserAction`, `deleteLocalUserAction`, `createLocalUserSelfAction`, `changeLocalUserPinAction`, `verifyLocalUserPinAction` | `configAuditLog` (+ `localUsers`) | The clock-terminal login identity; PIN doubles as the passcode (HMAC-secured, per project memory `project_attendance_login_pin_as_passcode`). |
| `infractions.actions.ts` | `ensureSystemInfractionTypes`, `upsertInfractionType`, `upsertStaffInfraction`, `voidStaffInfraction`, `getStoreInfractionsAction`, `getStaffInfractionsAction` | `configAuditLog`, `infractionTypes`, `staffInfractions` | Auto-infraction sources (`operations/auto-infraction.ts`) and manual filing share the same collection and void discipline. |
| `memo.actions.ts` | `createMemoDraftAction`, `updateMemoDraftAction`, `submitMemoForReviewAction`, `attachMemoDocumentAction`, `removeMemoDocumentAction`, `returnMemoToDraftAction`, `approveMemoAction`, `reconcileMemoRosterAction`, `recordMemoSignatureAction`, `attachSavedSignatureToMemoAction`, `getStaffSignatureStatusAction`, `recordMemoRejectionAction`, `resolveMemoAckAction`, `deleteMemoAction` | `memoDocs`, `staff` | Draft → submit → approve/reject → per-staff acknowledgment, with a roster-reconcile step to keep the ack list in sync with current staff. |
| `onboarding.actions.ts` | `upsertOnboardingDocAction`, `publishOnboardingDocAction`, `rejectOnboardingDocDraftAction`, `archiveOnboardingDocAction`, `proposeOnboardingDocEditAction`, `upsertOnboardingExamAction`, `publishOnboardingExamAction`, `rejectOnboardingExamDraftAction`, `archiveOnboardingExamAction`, `proposeOnboardingExamEditAction`, `getOnboardingExamForStaffAction`, `recordOnboardingViewAction`, `acknowledgeOnboardingDocAction`, `submitOnboardingExamAction`, `listOnboardingPendingReviewAction`, `gradeOnboardingExamSubmissionAction`, `listOnboardingForActorAction`, `listOnboardingProgressAction`, `listOnboardingAllForAdminAction`, `attachOnboardingDocFileAction`, `removeOnboardingDocAttachmentAction`, `getOnboardingDocAction` | `onboardingDocs`, `onboardingExams`, `onboardingProgress` **[via path helpers, `paths.ts:73-95`]` | Largest single action file by function count (22 exports) — draft/propose/publish/reject lifecycle applied to both training docs and exams, plus grading. |
| `manager-daily-report.actions.ts` | `saveManagerRecurringItemsAction`, `listManagerRecurringItemCopyStoresAction`, `copyManagerRecurringItemsToStoresAction`, `upsertManagerDailyReportAction`, `submitManagerDailyReportAction` | **[via path helpers, `paths.manager-daily-report.ts`]** | Recurring report items can be copied across stores — one of the few deliberate cross-store WRITES (not just reads), gated to admin/multi-store managers **[inferred]**. |
| `notification.actions.ts` | `markNotificationReadAction`, `markAllNotificationsReadAction` | **[via `paths.notifications.ts`]** | Simple read-state flip; writer side is `src/lib/server/notifications.ts`. |
| `activity-log.actions.ts` | `getActivityLogsAction`, `flagActivityLogAction`, `commentActivityLogAction`, `resolveActivityLogAction`, `deleteActivityLogAction` | **[via `paths.activity-log.ts`]** | Audit-trail read/annotate; writer side is `src/lib/server/activity-log.ts`. |
| `admin-pin.actions.ts` | `getAdminPinStatusAction`, `setAdminPinAction`, `verifyAdminPinAction` | `configAuditLog` (top-level) | A second-factor PIN gating especially sensitive admin actions. |

### J. Inventory core (14 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `item.actions.ts` | `upsertItemAction`, `toggleItemActiveAction` | `configAuditLog` (+ `items`) | Generic (non-meat) stock item master. |
| `meat-product.actions.ts` | `saveMeatProductAction` | **[via `paths.inventory.ts`]** | Meat products track a `slabProductId` lineage for slice→slice conversions (§2.14, `meat-convert.ts`). |
| `meat-usage.actions.ts` | `saveMeatUsageRecordAction`, `postMeatUsageRecordAction`, `adjustMeatInventoryAction`, `voidMeatUsageRecordAction` | **[via `paths.inventory-ledger.ts`]** | Draft → post → void, ledger-backed (`meatInventoryLedger`); post is the only step that commits stock movement. |
| `general-inventory.actions.ts` | `saveInventoryUsageRecordAction`, `postInventoryUsageRecordAction`, `discardInventoryUsageDraftAction`, `voidInventoryUsageRecordAction`, `adjustInventoryAction`, `setInitialInventoryAction`, `editInitialInventoryAction`, `resetInitialInventoryAction`, `syncInventoryProductToItemAction`, `receiveItemIntoLocationAction`, `countPendingAllocationAction`, `listUnallocatedReceivedInventoryAction` | 8 `runTransaction`/batch call sites — the busiest inventory file | Same draft→post→void lifecycle as meat-usage, generalized to all inventory items; ties into `WASTAGE_REASONS` when the usage type is wastage. |
| `initial-inventory.actions.ts` | `setMeatInitialInventoryAction`, `editMeatInitialInventoryAction`, `resetMeatInitialInventoryAction` | **[via path helpers]** | Opening-balance entry for meat inventory (mirrors general inventory's initial-inventory pair). |
| `inventory-batch.actions.ts` | `expireStaleBatchesAction` | **[inferred: itemBalances / batch subcollection]** | Scheduled sweep that expires batches past their shelf life. |
| `inventory-department.actions.ts` | `upsertInventoryDepartmentAction`, `toggleInventoryDepartmentActiveAction` | **[via path helpers]** | Department taxonomy (kitchen/bar/etc.) for usage attribution. |
| `inventory-location.actions.ts` | `upsertInventoryLocationTypeAction`, `toggleInventoryLocationTypeActiveAction`, `upsertInventoryLocationAction`, `toggleInventoryLocationActiveAction`, `deleteInventoryLocationAction`, `allocateItemToLocationsAction`, `seedInventoryLocationModelAction`, `seedBranchDefaultLocationAction` | **[via `paths.inventory.ts`]** | Location model (room/freezer/etc.) that receive-allocation and count-freeze both key off. |
| `item-location-settings.actions.ts` | `setStoreItemThresholdsAction` | **[via path helpers]** | Per-store, per-item low-stock threshold overrides. |
| `low-stock.actions.ts` | `listStoreLowStockAction` | none (read-only) | Reads current balances against thresholds. |
| `count-session.actions.ts` | `openCountSessionAction`, `setCountSessionStatusAction`, `closeCountSessionAction` | **[via `paths.count-session.ts`]** | An open/counting/reviewing session with `freezeMode:true` FREEZES its locations against concurrent stock movement — see `count-freeze.ts` (§2.15). |
| `stock-count.actions.ts` | `commitStockCountAction` | `stockCounts` | Commits a physical count as the new on-hand truth; the delta from the ledger-derived figure is the count adjustment. |
| `stock-transfer.actions.ts` | `createStockTransferAction`, `transferStockNowAction`, `dispatchStockTransferAction`, `receiveStockTransferAction`, `voidStockTransferAction`, `listStuckTransfersAction` | `transfers` | Draft→dispatch→receive→void lifecycle within ONE store (§2.16); a one-step "now" variant skips straight to `received`. Stuck-transfer detection flags a dispatched-but-never-received transfer past a threshold (`stock-transfer.ts:71-73`). |
| `branch-stock-reconcile.actions.ts` | `reconcileBranchStockToRoomAction` | `inventoryBalances` | Reconciles a branch's aggregate stock into its per-room location balances. |

### K. Production & cookbook (3 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `production.actions.ts` | `saveProductionRecordAction`, `postProductionRecordAction`, `updatePostedProductionRecordAction`, `voidProductionRecordAction` | **[via `paths.inventory-ledger.ts`]** | Posting a production record consumes ingredient stock and produces output stock as one ledger transaction (`production-ledger-legs.ts`); a `LockableFeature` distinct from generic `inventory` movement (`lockedDay.guard.server.ts:49-58`). |
| `production-recipe.actions.ts` | `upsertProductionRecipeAction`, `archiveProductionRecipeAction`, `restoreProductionRecipeAction`, `deleteProductionRecipeAction`, `cookProductionRecipeAction` | **[via `paths.production-recipe.ts`]** | Recipe defines the ingredient→output ratio a production record posts against; deletion is blocked while a stock balance references it (`admin-record-ops.actions.ts:38-40` shows the same in-use guard pattern). |
| `cookbook.actions.ts` | `upsertRecipeAction`, `upsertRecipeBranchVariantAction`, `removeRecipeBranchVariantAction`, `archiveRecipeAction`, `restoreRecipeAction`, `deleteRecipeAction`, `recordRecipeMediaAction`, `deleteRecipeMediaAction`, `deleteStepImageStorageAction`, `setRecipeCoverAction` | `recipes` (top-level, cross-store) + Storage | Presentation/training recipes (with photos/video), NOT the production-conversion recipe above — a cross-store master with per-branch variants. |

### L. Deliveries & suppliers — see B (delivery/supplier files listed there; grouped with AP since receiving is inseparable from AP booking).

### M. Branch orders & commissary (11 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `branch-order.actions.ts` | `listAvailableCommissariesAction`, `listCommissaryItemsForOrderAction`, `createBranchOrderAction`, `updateBranchOrderAction`, `submitBranchOrderAction`, `cancelBranchOrderAction`, `reviewOrderChangeAction` | `arCustomers` (cross-store read via `collectionGroup`) + `branchOrders` | `listAvailableCommissariesAction` is a genuine cross-store discovery query — `collectionGroup('arCustomers').where('linkedStoreId','==',branchStoreId)` (`branch-order.actions.ts:76-79`, §6). |
| `branch-order-fulfilment.actions.ts` | `acceptOrderAction`, `rejectOrderAction`, `updateFulfilmentAction`, `markOrderReadyAction`, `dispatchOrderAction`, `resolveDiscrepancyAction`, `commissaryAddItemAction` | **[via `paths.branch-orders.ts`]** | Commissary-side fulfilment lifecycle; a dispatch discrepancy (ordered vs. sent) is resolved here, feeding branch-side receive variance. |
| `branch-order-receive.actions.ts` | `confirmReceiptAction` | `branchOrders` (+ triggers AR/AP mirror) | Confirming receipt is what fires BOTH the commissary AR and the branch AP mirror (`branch-payment-mirror.ts` context, §2.3) — gated to `cashier`/`inventory staff` positions (`autobook.ts:36`). |
| `branch-order-messages.actions.ts` | `postBranchOrderMessageAction` | **[via path helpers]** | Order-level chat/notes thread. |
| `branch-low-stock-order.actions.ts` | `ensureBranchLowStockOrderAction` | **[via path helpers]** | Auto-drafts a branch order when stock crosses the low-stock threshold. |
| `branch-sales-settle.actions.ts` | `settleBranchSaleAction`, `voidBranchSaleAction`, `repairBranchSalesDayAction`, `backfillMissingBranchSalesAction`, `deferBranchSaleAction`, `listPendingVarianceOrdersAction` | `itemBalances` | "Branch sale" = a commissary selling directly to a branch's end customer as a channel — distinct from a branch-to-branch order (see `branch-sales-channel.ts`, `BRANCH_SALES_CHANNEL_ID`). |
| `commissary-dashboard.actions.ts` | `getCommissaryDashboardSummaryAction` | none (read-only) | |
| `commissary-delivery-expense.actions.ts` | `recordCommissaryDeliveryExpensesAction`, `autoBookBranchDeliveryExpensesAction`, `reverseBranchDeliveryExpensesAction` | `expenses`, `receipts`, `suppliers` | Auto-book is gated by `canBookBranchDeliveryExpense` (`autobook.ts:49-56`) — MUST stay in sync with the receive-confirm gate or a cashier-received delivery silently books no AP (a real historical bug, `autobook.ts:43-45`). |
| `commissary-import.actions.ts` | `previewCommissaryImportAction`, `importCommissaryProductsToBranchAction` | **[inferred: items/meatProducts]** | Bulk-imports a commissary's product catalog into a branch's local item list. |
| `commissary-item-config.actions.ts` | `upsertCommissaryItemConfigAction`, `setCommissaryItemConfigActiveAction`, `setCommissaryItemUnavailableAction`, `setCommissaryItemExpenseEntryAction`, `pullLatestCostsAction`, `getSlabCostsFromDeliveriesAction`, `listCommissaryItemsNeedingCostAction` | **[via `paths.commissary.ts`]** | Pricing mode (fixed/latest-cost) + expense category mapping per commissary item — `hasFullCategory` (`autobook.ts:23-25`) gates whether an order line auto-books. |
| `commissary-item-map.actions.ts` | `upsertCommissaryItemMapAction`, `deleteCommissaryItemMapAction`, `bulkUpsertCommissaryItemMapsAction`, `listCommissaryItemMapsAction`, `listBranchItemsForMappingAction` | **[via `paths.commissary.ts`]** | Maps a commissary's product id to a branch's local item id — required before an order line can auto-book its AP. |
| `commissary-mirror.actions.ts` | `repairBranchPaymentMirrorAction` | triggers `mirrorBranchPaymentToCommissary` / `reverseBranchPaymentMirror` | Admin repair tool for the cross-store branch-payment↔commissary-AR mirror (§2.3, §8). |

### N. Wastage (1 file, 15 exports)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `wastage.actions.ts` | `ensureWastageTypes`, `upsertWastageSettings`, `listStoreManagersAction`, `setWastageMonitorAction`, `createWastage`, `disputeWastage`, `resolveWastageDisputeAction`, `resolveWastageChargeAction`, `setWastageResponsibilityAction`, `voidWastage`, `updateWastageChannelStatusAction`, `findWastageByChannelRefAction`, `countOpenWastagesAction`, `autoChargeOverdueWastagesAction`, `listWastageAuditAction`, `planWastageSettlementMatchAction`, `markWastagePlatformPaidFromSettlementAction`, `chargeWastageFromSettlementMatchAction` | `configAuditLog`, `staff`, `wastageSettings`, `wastages` | A reason is required from the fixed `WASTAGE_REASONS` enum (`wastage-reasons.ts:11-21`); dispute → resolve → optional staff-charge (via salary-advance `charge`, self-dealing-exempt) → optional platform-settlement match for channel-caused wastage. `autoChargeOverdueWastagesAction` is the scheduled auto-charge (§7). |

### O. Reports, exports, dashboards, insights (16 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `reports.actions.ts` | `getReportSnapshotAction`, `getCashAccountBalancesAction`, `getLedgerPageAction`, `getAccountDailyRowsAction`, `getDayEntriesAction`, `getCustomRangeSnapshotAction` | none (read-only) | Read layer directly over `journal`/`accounts`/`dailySummary` — no separate reporting store. |
| `report-export.actions.ts` | `exportReportsWorkbook`, `getReportPrintData` | none (read-only) | Generates `.xlsx` via the `xlsx` package server-side (§7). |
| `excel-export.actions.ts` | `fetchExportDataAction` | none (read-only) | Generic multi-category exporter (expenses/receipts/AR/AP/etc.) for a date range. |
| `balance-sheet.actions.ts` | `getBalanceSheetAction` | none (read-only) | Classifies accounts via `balance-sheet-classify.ts`. |
| `income-statement.actions.ts` | `generateIncomeStatementAction`, `saveIncomeStatementAction`, `listIncomeStatementsAction`, `deleteIncomeStatementAction` | `assets`, `expenses`, `prepaidItems`, `salesDays` (reads) → writes a saved snapshot | Platform-fee handling is explicit (see `project_income_statement_platform_fee` in project memory) — never nets platform fees against gross sales inline. |
| `integrity-check.actions.ts` | `runIntegrityChecksAction`, `getLatestReconciliationLogAction` | `reconciliationLogs` (+ triggers `rebuildDashboardSummaryAction`) | Distinguishes `'stale'` (a rebuild-only projection simply not yet refreshed) from `'drift'` (a broken write path) — collapsing the two was a real bug class (`integrity-check.actions.ts:31-34`). |
| `performance-summary.actions.ts` | `rebuildPerformanceSummaryAction` | writes `staffPerfMonth` projection **[inferred]** | Full rebuild counterpart to the incremental `staff-perf-month.ts` projection. |
| `period-insights.actions.ts` | `getMonthlyInsightAction`, `regenerateMonthlyInsightAction`, `getYearlyInsightAction`, `regenerateYearlyInsightAction` | AI-insight docs **[inferred]** | Calls into `src/lib/ai/period-orchestrator.ts` (out of this scope) — see §7. |
| `daily-insights.actions.ts` | `getDailyInsightsDocAction`, `regenerateDailyInsightsAction` | AI-insight docs **[inferred]** | Same orchestration pattern, daily grain. |
| `oil-insights.actions.ts` | `getStoreInsightConfigAction`, `setStoreInsightConfigAction`, `computeOilDailySliceAction`, `getOilDailySliceAction`, `getOilFeedbackReportAction`, `snoozeFindingAction`, `resolveFindingAction`, `unresolveFindingAction`, `rescanFindingAction`, `recheckMissingReportsAction`, `getInsightWrapupAction`, `acknowledgeInsightWrapupAction`, `logInsightViewAction`, `getManagerScoreSummaryAction`, `getManagerScorecardAction`, `getMonthlyFlaggedItemsAction`, `canAdjudicateAttendanceAction`, `getAttendanceFlaggedItemsAction` | `aiInsightConfig`, `insightPeriodSummary`, `insightScorecards`, `insightViewLog`, `oilDays` | Largest insights file (18 exports) — "OIL" (operational integrity layer) findings feed a manager scorecard; `canAdjudicateAttendanceAction` gates who can resolve an attendance-flagged finding. |
| `insight-compare.actions.ts` | `comparePeriodsAction`, `analyzeComparisonAction` | `oilDays`, `salesDays` (reads) | Period-over-period comparison, AI-assisted analysis of the diff. |
| `cross-store-performance.actions.ts` | `getCrossStorePerformanceAction` | none (read-only) | Deliberate cross-store READ aggregation across `stores` for multi-branch owners (§6). |
| `dashboard-summary.actions.ts` / `dashboard-attention.actions.ts` | (listed in group A) | | |
| `daily-review.actions.ts` / `daily-snapshot.actions.ts` | (listed in group A) | | |
| `sales-day.actions.ts` / `sales-report*.actions.ts` / `sales-target.actions.ts` / `sales-channel-benchmark.actions.ts` | (listed in group A) | | |

### P. POS integration (4 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `pos-api.actions.ts` | `fetchPosStoresAction`, `fetchPosPaymentMethodsAction`, `fetchPosFeedbackAction`, `fetchPosSalesAction`, `fetchPosSoldItemsAction`, `fetchPosInventoryItemsAction` | none (read passthrough) | Thin session-checked wrapper over `src/lib/server/pos-api.ts`'s raw fetchers (§7). |
| `pos-item-map.actions.ts` | `listStockItemsForPosMappingAction`, `listRecipesForPosMappingAction`, `listPosLinkCoverageAction`, `listPosItemMapsAction`, `upsertPosItemMapAction`, `requestPosItemUnmappableAction`, `decidePosItemUnmappableAction`, `deletePosItemMapAction`, `bulkUpsertPosItemMapsAction`, `listOperatingLocationsForPosPullAction` | `posItemMaps` **[via `paths.pos-item-map.ts`]** | Maps a POS-side sold item to a local stock item/recipe so usage-pull can decrement the right inventory (`pos-item-match.ts`). |
| `pos-usage-pull.actions.ts` | `planPosUsagePullAction`, `savePosUsageDraftsAction`, `finalizePosUsageDraftsAction`, `recordPosUsagePullAction` | inventory usage records **[inferred]** | Turns POS sold-items into draft inventory-usage records via the item map; plan→draft→finalize mirrors the general usage-record lifecycle. |
| `pos-usage-backfill.actions.ts` | `backfillPosLineKeysAction` | **[inferred]** | One-time key-migration backfill for `pos-line-key.ts`'s keying scheme. |

### Q. Admin, system, platform (13 files)

| File | Exports | Mutates | Rule |
|---|---|---|---|
| `admin-record-ops.actions.ts` | `adminVoidRecordAction`, `adminDeleteRecordAction`, `adminVoidTransferAction`, `adminRecomputeRemittanceStatusAction` | any allow-listed collection (generic dispatcher) | ONE generic void/delete endpoint for ~15+ record types, with a per-`collectionKey` reversal delegate (e.g. `expenses` → `voidExpense`) so every reversal path stays centralized (`admin-record-ops.actions.ts:540-560`, §2.17). Referential-integrity guard blocks deleting an in-use inventory item (`admin-record-ops.actions.ts:22-40`). |
| `admin-reset.actions.ts` | `resetStoreDataByCategory`, `purgeVoidedRecordsAction` | any store collection (category-driven) | Destructive bulk-reset tooling — admin-only, presumably dev/test-store use. |
| `admin-pin.actions.ts` | (listed in group I) | | |
| `activity-log.actions.ts` / `notification.actions.ts` | (listed in group I) | | |
| `user.actions.ts` | `updateUserProfileAction`, `rejectUserAction`, `deactivateUserAction`, `reactivateUserAction`, `deleteUserAction`, `getUserAuditLogAction`, `listLinkableAccountsAction` | `configAuditLog`, `users` (top-level) | Firebase-Auth-linked profile lifecycle — the approval gate every new signup passes through (see `project_signup_admin_self_demotion` landmine in project memory: `/signup` once overwrote an existing admin). |
| `ai-provider-hub.actions.ts` | `getAiProvidersConfigAction`, `updateAiProviderConfigAction`, `saveAiProviderLayoutAction` | `appSettings/aiProviders` (top-level) | The live AI model/provider selection is a Firestore doc, NOT a code constant (`reference_ai_hub_model_sot_is_firestore` in project memory) — a rebuild must preserve this as runtime-configurable, not hardcode a model. |
| `ai-helper.actions.ts` | `askHelperAction` | none (read + AI call) | "Ask ERP" — retrieves a pre-built manual index rather than inlining the whole user manual per call (`reference_ask_erp_manual_inlined_every_call`). |
| `extract-pdf-text.actions.ts` | `extractPdfTextAction` | none | Utility: OCR/text-extraction from an uploaded PDF (e.g. a supplier invoice). |
| `rebuild-projections.actions.ts` | `rebuildProjectionsAction` | multiple projection collections | Umbrella rebuild dispatcher — likely calls the individual `rebuild*` actions above. |
| `backfill-legacy-projections.actions.ts` | `backfillFromLegacyProjectionsAction` | `ap_suppliers_index`, `arCustomers`, `assets`, `cashAccounts`, `liabilityAccounts`, `loans`, `salaryAdvanceStaffBalances`, `suppliers` | One-time migration backfill from a legacy projection shape into the current one. |
| `legacy-import.actions.ts` | `importLegacyApAction`, `importLegacyArAction`, `importLegacyStaffAdvanceAction`, `importLegacyStaffReimbursableAction`, `importLegacyCashBalanceAction` | `suppliers` (+ AR/staff collections) | Opening-balance import path for a store's pre-system history. |
| `monthly-runs.actions.ts` | `getPendingMonthlyRunsAction`, `getPrepaidBalanceSummaryAction`, `runPendingMonthlyRunsAction` | `expenses` (triggers depreciation/amortization) | Umbrella monthly-close runner — depreciation + amortization + any other month-end job. |

---

## 2. Core business rules

Non-obvious invariants encoded in code, each with its file:line.

### 2.1 Verified-day lock, and what's deliberately excluded from it

`lockedDay.guard.server.ts:141-173` is called at the top of nearly every money-moving action. Two independent lock layers, both admin-bypassable (`lockedDay.guard.server.ts:151`):
- **Manual day-close** (`cashMovementDay.status === 'locked'`) blocks everything.
- **Verified-sales-report lock** blocks only the `VERIFIED_LOCK_FEATURES` set (`lockedDay.guard.server.ts:96-106`: `expense`, `cashRequest`, `supplierPayment`, `arCollection`, `arCreditSale`, `transfer`, `prepaid`, `reimbursement`, `loan`) once the day's `salesDay.status` is `verified`/`partially_remitted`/`remitted`.

The exclusions are the interesting part (`lockedDay.guard.server.ts:60-95`, each with its own paragraph of reasoning): `cashRemitShift`/`remittanceShortage`/`remittanceTransfer`/`sale` are part of the verify→remit flow itself; `amortization`/`depreciation` are system-actor month-end postings; `expenseNonCashier`/`arCollectionNonCashier` don't touch the cashier drawer so don't threaten the day's cash remittance; `arChannelSales` is auto-posted DURING verification (excluding it fixed a real bug where non-admin verifiers couldn't complete verification); `channelSettlement` and `payroll` never touch the cashier drawer either. As of 2026-08-22 (`lockedDay.guard.server.ts:46-58`), `inventory` and `production` are day-close-lock-only — a verified sales report never blocks stock movement.

### 2.2 AP status is derived from balance, never stored as an independent flag

`ap/status.ts:6-9`: `apStatus = outstandingAmount > 0.001 ? 'open' : 'closed'`. `ap/projection.ts:6-16` layers a THIRD status source (`isApProjectionClosed`) used specifically for the AP-open projection row's lifecycle (voided / <₱0.01 outstanding / apStatus==='closed' → row is deleted, not just flagged). Three related-but-distinct epsilons in one small module family (`0.001`, `0.01`) — not a bug, but a rebuild must preserve which check uses which threshold rather than unifying them.

### 2.3 Cross-store settlement is two separate best-effort transactions, never one

`branch-payment-mirror.ts:11-16`: Firestore cannot span two stores in one transaction. A branch paying its commissary supplier commits first (`payment.actions.ts`), then `mirrorBranchPaymentToCommissary` runs as a SEPARATE transaction against the commissary store, made safe by a deterministic id (`branchPaymentMirrorId` = `bpay_${paymentId}`, `branch-payment-mirror.ts:37-39`) so retries are idempotent and a repair tool (`commissary-mirror.actions.ts`) can re-run it. The reverse (`reverseBranchPaymentMirror`) is the same pattern for void/edit. This is the template for every cross-store money movement in the codebase (also used by `cross-store-loan.ts` for channel-settlement loan legs).

### 2.4 Tolerance thresholds are a deliberately varied, purpose-specific set

Not one global epsilon — each was tuned against a real bug:
- `RECEIPT_FULLY_RECORDED_TOLERANCE = 1` (₱1) — `receipt/recording.ts:13`, explicitly raised from `0.001` because sub-peso rounding residue left receipts phantom-"open" forever.
- `CASH_REQUEST_AUTO_CLOSE_BELOW = 1` (₱1) — `cash-request/liquidation.ts:28`.
- `AP_STATUS_EPSILON = 0.001` — `ap/status.ts:1`.
- Half-cent (`0.005`) tolerance on cash-request liquidation validation — `cash-request/liquidation.ts:100`.
- `0.005` drift-detection tolerance in AR receivable reconciliation, `0.001` for whether to cascade the delta into the customer/dashboard total — `ar-balance-helpers.ts:87-89,110,116`.
- `wouldOverdrawSalaryAdvanceBalance`'s epsilon is `-0.001` — "just enough to tolerate float rounding on an exact zero-out, not enough to let a real 1-centavo overage through" (`salary-advance/ledger.ts:19-22`).
- Settlement variance/gain threshold is `0.01` (`channel-settlement/posting.ts:68-69`).
- Stock-ledger reconciliation epsilon is `1e-6` (base-unit quantities, not money) — `stock-ledger.ts:38`.

### 2.5 AR customer status gates whether a balance move counts toward the dashboard total

`ar-balance-helpers.ts:118-124,207-213`: an `'inactive'` or statusless AR customer is outside the `where('status','==','active')` source the dashboard `arOutstandingTotal` projection reads from. Moving such a customer's balance must NOT fold into that projection total — enforced via `planArCustomerBalanceMove`'s `onMissing: 'refuse'` mode, which refuses the whole write on a missing customer doc rather than silently creating one (mirrors the `isAdmin()` missing-doc landmine class).

### 2.6 Channel-settlement fees are netted as a SIGNED total, not filtered to positives

`channel-settlement/fees.ts:1-24`: both platform parsers compute `platformFee` as a residual (`gross − commission − vat − marketing − wht − loan − netPayout`), which can go NEGATIVE on a promo-heavy day — a genuine credit back to the merchant. `netFeeComponents`/`feeLegPosting` (`fees.ts:68-116`) fold every negative component into the platform-fee line (which may end up negative) rather than dropping it, because filtering `amount > 0` (the old behavior) silently broke the "clearing nets to zero" invariant and understated `netToBank` by exactly the dropped credit.

### 2.7 A day's pay is judged by what it delivered, not by when it started

`shift-boundaries.ts:169-284` (`resolveStartAnchor`) and its long comment block: per Ian's 2026-08-04 decision (re-affirmed and extended 2026-08-20), staff schedules follow forecasted demand with no fixed per-person start — so lateness is computed from the SPAN worked against `requiredHoursPerShift`/`halfDayHours`, trying the next allowed start first and only falling back to "late against the previous start" when the span doesn't support it. The one invariant that must survive any change here (`shift-boundaries.ts:192-198`): **moving the anchor forward never reduces a day's guaranteed paid hours.** `workday.ts` is "the one answer to what a day pays" — three previously-hand-duplicated computations (clock-out, manager review, late/next-in decision) were unified here specifically because they had drifted (`workday.ts:1-13`), including a defense-in-depth guard (`workday.ts:126-165`) against an overlay combination that would invert the paid window and let the pairer fabricate a fictitious shift.

### 2.8 A paid period is frozen; edits after payout are refused, not silently accepted

`paid-guard.server.ts:39-49` (`assertStaffNotPaidForPeriod`) refuses an attendance/deduction edit dated inside an already-paid period. `paid-guard.server.ts:69-85` (`assertStaffPeriodNotAlreadyPaid`) is the double-pay guard for a NEW payment — and deliberately checks period OVERLAP, not exact bound equality, because a config change to the semi-monthly cutoffs would otherwise re-derive a different payout id for the same days and let a second real cash payment go out for days already settled (a real bug fixed in round 2/5, `paid-guard.server.ts:55-61`).

### 2.9 Segregation of duties: three independent self-dealing blocks, each with a different exemption shape

- **Cash request approval** — a requester cannot approve their own request even as a manager; admin override only (`policy.ts:47-56`).
- **Salary advance / repayment** — a non-admin cannot record their OWN `salary_advance` or `repayment`; `charge` is deliberately NOT blocked because it increases the staff's own debt, not their benefit (`salary-advance.actions.ts:226-241`).
- **Overtime approval** — a manager cannot approve their OWN overtime; reject/void are deliberately left open because they move pay DOWN (`overtime.actions.ts:93-149`). All three exempt admins on the same reasoning: admin is the top of the `admin|manager|staff` role model, so blocking them would leave a single-admin store with nobody able to act.

### 2.10 Void is terminal; a correction is always a NEW record, never a revival

Stated explicitly for cash requests, expenses, and receipts in the policy engine (`policy.ts:22-24,68-70,105-107`, each citing `ERPNEXT_MIRROR_LOG.md 2026-08-06`) — once `status === 'voided'`, every action returns a failure. This is a cross-cutting convention, not a per-module accident, and it is also why `admin-record-ops.actions.ts`'s generic delete dispatcher (§2.17) treats "already voided" as "reversal already applied, skip straight to the terminal op" (`admin-record-ops.actions.ts:537-539`) rather than re-reversing.

### 2.11 Cashiers get a 48-hour edit window on expenses; managers are unrestricted

`policy.ts:78-88`: a `cashier`-position local user can edit an expense only within 48 hours of `createdAt`; a manager/admin can edit regardless of age. Delivery void additionally requires the per-user `canVoidRecords` grant on TOP of the manager role check (`policy.ts:150-158`) — a role check alone is not sufficient for a reversal that undoes posted stock + expense effects.

### 2.12 Commissary auto-book and the receive-confirm gate must stay in lockstep

`autobook.ts:27-45`: `BRANCH_EXPENSE_POSITIONS = ['cashier', 'inventory staff']` — anyone trusted to CONFIRM a delivery receipt must also be trusted to BOOK its AP, because booking is a deterministic consequence of the receipt (amounts from the delivery, categories from the pre-approved item map). The comment documents a real incident: the auto-book wrapper was tightened to manager/admin-only in a 2026-07-19 sweep while the receipt gate still admitted cashiers, so every cashier-received delivery from then on silently booked NO accounts payable.

### 2.13 Recurring/scheduled payments default away from the cashier till

`recurring-expense/payment-routing.ts:1-8,19-26`: the cashier till is the daily operating drawer; a recurring or auto-pay expense must never silently draw from it. `resolveRecurringCashAccountId` only honors an EXPLICIT `'cashier'` choice — anything ambiguous (null, legacy, unknown) resolves to office cash when available, else cashier as the only remaining cash account. A Cash-Request float (`accountId==='staff'`) is deliberately exempt from this coercion since it was a deliberate, explicit choice at confirm time.

### 2.14 Receiving parks an undecided line rather than guessing its location

`receive-allocation.ts:7-22`: an unallocated (`__unallocated__` or blank) delivery line is parked in the "Receiving" pseudo-location rather than silently defaulted to the default room (the OLD behavior) — falling back to the default room only if no Receiving location exists at all, so stock is never lost.

### 2.15 A count session can freeze locations against concurrent stock movement

`count-freeze.ts:11-31`: a location is frozen when ANY count session covering it has `freezeMode===true` AND is in an active status (open/counting/reviewing). Malformed session docs (missing/non-array `locationIds`, unknown status) fail closed to "not frozen" rather than throwing — a defensive default that matters because this function gates whether OTHER inventory writers are allowed to proceed.

### 2.16 A stock transfer moves per-location balances only; the store total never changes

`stock-transfer.ts:1-5`: transfers are strictly `sourceLocation → destinationLocation` WITHIN one store — they never touch the legacy store-level balance field. Lifecycle is draft → dispatch (decrement source) → receive (increment destination) → void (reverse); a one-step "now" variant exists only for same-actor, no-transit transfers and never produces an `in_transit` state (`stock-transfer.ts:58-62`). A dispatched transfer aged past a configurable threshold is flagged "stuck" (`stock-transfer.ts:67-73`).

### 2.17 One generic admin void/delete endpoint, with per-collection reversal delegation

`admin-record-ops.actions.ts:483-560+`: rather than N admin delete buttons each with their own reversal logic, `adminDeleteRecordAction` dispatches by `collectionKey` to the SAME reversal function the normal void action uses (e.g. `collectionKey==='expenses'` → imports and calls `voidExpense` from `expense.actions.ts`, ensuring the CAPEX asset leg / AP index / budget / receipt-recording-state / cash-request liquidation are ALL reversed — the comment notes the old inline reversal missed the supplier AP index). A referential-integrity guard blocks deleting a `meatProducts`/`inventoryProducts` doc that still has non-zero stock or is referenced by a production recipe (`admin-record-ops.actions.ts:22-40`). Deleting a `branchOrders` or `slicerPayments` doc is blocked while its cross-store/cross-collection settlement is still live, forcing a void-first workflow so a cross-store cascade can't be left half-deleted (`admin-record-ops.actions.ts:521-533`).

### 2.18 Statutory payroll deductions are capped so pay can never go negative

`payroll/statutory.ts:161-188`: SSS/PhilHealth/Pag-IBIG contributions are computed from a monthly-equivalent of the period's basic pay, but if the three independently-rounded lines sum to more than the period's gross, they are scaled down proportionally AND any 1-centavo rounding residual from that scaling is absorbed into the largest line — so contributions total is guaranteed `≤ gross` AND the displayed lines sum EXACTLY to the total (not just approximately), keeping the payslip and the GL in agreement. Withholding tax is capped the same way on top.

### 2.19 A meat "convert" is constrained to same-slab lineage

`meat-convert.ts:1-8,25-42`: slicing one meat product into a different one (e.g. "Pork Belly Sliced" → "Pork Belly Ground") is allowed ONLY when both share the same parent `slabProductId` — enforced both client-side and server-side. It is a pure count move with NO payment/GL/slicer-pay impact, unlike a normal production/slicing record.

### 2.20 Referential-integrity and identity resolution before every self-dealing check

Every self-dealing block (§2.9) depends on `resolveActorOwnStaffIds` (`server/actor-own-staff.ts` — referenced from `overtime.actions.ts:126`, `salary-advance.actions.ts:236`) to map a local-device actor to "their own" staff record via the app-login link plus an email-match fallback — because on a shared floor device, `actorUid` is the DEVICE's Firebase uid, not the individual's, so the self-check cannot rely on `actorUid === staffId` directly.

---

## 3. Money & rounding

- **Representation: plain JS `number` (float), not integer cents, not a decimal/string type.** Every currency field in every type (`ExpenseV2Plain.totalAmount`, `ReceiptPlain.recordedAmount`, `JournalEntryInput.amount`, etc.) is a `number`. There is no `Money` class or minor-unit integer anywhere in the actions/financial layer.
- **`src/lib/money.ts`** is the single rounding/formatting boundary:
  - `roundMoney(value)` (`money.ts:16-28`) — `Math.round(n*100)/100`, half-away-from-zero (not banker's rounding), with an explicit `-0 → 0` normalization ("a tiny negative float... rounds to -0, which Intl.NumberFormat renders as '-0.00' instead of '0'"). Null/undefined → `0`.
  - `formatNumberForInput`/`formatPeso` (`money.ts:36-70`) route every DISPLAYED value through `roundMoney` EXCEPT non-finite values, which are deliberately left as `NaN`/`Infinity` on screen rather than silently coerced to `₱0.00` — "an ugly 'NaN' on screen is a bug report; a confident ₱0.00 is a silent wrong number on an accounting surface" (`money.ts:44-48`).
  - `parseMoney(input)` (`money.ts:76-92`) strips `₱`, commas, whitespace; returns `null` (not `0`) for empty/punctuation-only input, preserving the empty-vs-zero distinction.
- **A SECOND, near-duplicate rounding function exists**: `roundReceiptAmount` in `receipt/balance.ts:3-4` (`Math.round((num + Number.EPSILON) * 100) / 100`), used only in the receipt-reconciliation module family instead of `roundMoney`. Functionally equivalent for all practical values but a second implementation to be aware of when porting — a rebuild should collapse to one.
- **Rounding happens at every incremental step, not just at the end**, specifically to prevent float drift across many small writes: `journal-writer.ts:108-113` rounds every leg's amount at prepare-time so `FieldValue.increment()` chains can't drift; `receipt/recording.ts:47-53` rounds at each incremental link so tagging many expenses one-by-one can't accumulate a phantom balance; `ar-balance-helpers.ts:82-83,197` rounds before every write for the same reason.
- **VAT** (`vat.ts:1-13`): fixed 12% rate; `vatBreakdown(amount)` back-computes the split from a VAT-INCLUSIVE amount as `vatAmount = round(amount * 12/112)`, `vatExclusive = round(amount - vatAmount)` — the two always reconstruct the original amount exactly because the exclusive leg is defined as the remainder, not independently rounded.
- **Double-entry balance is enforced by construction, not by a balance check**: `journal-writer.ts` tracks `inDelta`/`outDelta` as SEPARATE running totals per account (never a single signed delta), specifically because a negative net amount (see §2.6, channel-settlement credits) must flip which side (`in`/`out`) it lands on rather than going negative on one side — `commitJournalLegs` (`journal-writer.ts:125-229`) would otherwise corrupt the two independently-accumulated totals.
- **Deterministic, idempotent entry ids**: `buildJournalEntryId(sourceType, sourceId, legKey)` (`journal-writer.ts:89`) means re-posting the same source event is a no-op/update rather than a duplicate — this is what makes void-then-repost and cross-store retry (§2.3) safe.

**Rebuild implication**: a relational port should move every currency field to `NUMERIC(12,2)` (or integer minor units) at the schema level and re-derive `roundMoney`'s half-away-from-zero + `-0` normalization as an application-layer formatting concern only — the underlying storage no longer needs the float-drift mitigations that motivated per-step rounding, but the TOLERANCE CONSTANTS in §2.4 must be preserved as-is since they encode business decisions ("₱1 is close enough to closed"), not float-precision workarounds.

---

## 4. Date & timezone handling

Three coexisting date utility modules, each with a different job — a rebuild should NOT collapse them into one without preserving which callers need which behavior:

- **`src/lib/date-utils.ts`** — Asia/Manila-pinned, for anything a human reads.
  - `getDayKey(date)` (`date-utils.ts:7-19`) — `Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Manila'})` → `YYYY-MM-DD`.
  - `formatTimePht(date)` (`date-utils.ts:33-39`) — explicitly documents the landmine this file exists to avoid: `new Date(ts).toLocaleTimeString([], ...)` with no `timeZone` resolves against the CONTAINER's zone, and Firebase App Hosting containers run UTC (nothing sets `TZ` in `apphosting.yaml`) — "a 9:05 AM punch in Manila was rendered as 1:05 AM." This is a confirmed historical bug, not a hypothetical.
- **`src/lib/financial/dayKey.ts`** — the business-day-key engine used by the accounting/attendance core (distinct module from `date-utils.ts`, same underlying idea).
  - `dayKeyFromMs(ms, tz='Asia/Manila')` (`dayKey.ts:9-22`) — same `Intl.DateTimeFormat('en-CA')` pattern, explicit `tz` parameter.
  - `monthKeyFromDayKey(dayKey)` (`dayKey.ts:29-31`) — pure string slice (`YYYYMM` from `YYYY-MM-DD`), no Date object at all.
  - `msRangeForDayKey(dayKey, tz)` (`dayKey.ts:40-53`) computes a day's `[startMs, endMs]` bounds via `new Date(d.toLocaleString('en-US', {timeZone: tz}))` — the well-known imprecise "round-trip through a locale string" technique for timezone-shifting a Date. It works for `Asia/Manila` (a fixed +8 offset, no DST) but is NOT a technique that generalizes to a DST-observing zone; flag for the rebuild to replace with a proper timezone library (e.g., `date-fns-tz`, `Temporal`, or a DB-side `AT TIME ZONE`) rather than porting verbatim.
- **`src/lib/datetime.ts`** — generic `date-fns` formatting, deliberately NOT timezone-pinned (`formatDateMMDDYYYY`, `formatTime24h`, `formatDateTimeMMDDYYYY_24h`, all via `dateFnsFormat(d, ...)` with no `timeZone` option, `datetime.ts:31-61`). This module resolves against whatever zone the runtime is in — same UTC-drift exposure `formatTimePht` was built to avoid, just not yet retrofitted. **Flag: any caller of this module rendering a business-relevant time to a human is at risk of the same 8-hour Manila/UTC drift `date-utils.ts:26-29` documents as a real historical bug** — I could not find evidence either way on whether this module's callers are cosmetic-only or user-facing; verify call sites before porting.
- **`recurring-expense/recurrence.ts`'s `formatDate`** (`recurrence.ts:141-143`) uses `d.toLocaleDateString('en-CA')` with NO `timeZone` argument — resolves in the server's local zone. Not a bug in isolation (paired `parseDate`/`setDayOfMonth`/`advancePeriod` all construct local-time `Date`s the same way, so the round-trip is internally consistent regardless of what zone the process runs in), but it is a FOURTH distinct date-formatting idiom in the codebase.
- **Wire-format boundary**: `src/lib/serialize.ts:26-58` (`toPlain`) is the canonical Server-Component → Client-Component serialization boundary — it converts every Firestore `Timestamp`-like value AND every `Date` object to an **epoch-millisecond number**. This means the actual stored/transmitted representation of "a moment in time" throughout this codebase is `number` (ms since epoch), not an ISO string and not a Firestore `Timestamp` once it crosses that boundary. Calendar "business day" identity is a SEPARATE, deliberately-string field (`dayKey`, `businessDate`, `salesDate`, `overtimeDate` — all `YYYY-MM-DD` strings), never derived from the ms value at render time.
- **Noon-anchoring trick to avoid a day-shift**: `delivery-cost.ts:16-20` (`dayKeyToMs`) parses `${dayKey}T12:00:00` specifically because "noon avoids tz day-shift" — i.e., anchoring a day-key to local midnight before converting risks landing on the PREVIOUS UTC day depending on server zone; noon has enough margin either direction.
- **PH holidays**: `src/lib/attendance/ph-holidays.ts` exists (not read in depth — out of the tight-focus set) as the holiday-pay-premium lookup table referenced by `workday.ts`'s `holidays: HolidayEntry[]` parameter.

**Rebuild implication**: for the DB schema, store business-day identity as a genuine `DATE` column (not derived from a timestamp) and every clock-in/out/created-at moment as `TIMESTAMPTZ`. Re-derive `dayKeyFromMs`/`getDayKey` as a single canonical `AT TIME ZONE 'Asia/Manila'` expression (SQL-side or one shared app function) rather than porting all four JS idioms — but keep `msRangeForDayKey`'s CALLERS in mind: anywhere a day's ms bounds are needed for a range query, a SQL `DATE` column with a `BETWEEN` on `TIMESTAMPTZ AT TIME ZONE` is strictly more correct than the current locale-string round-trip.

---

## 5. Validation layer

**Zod is the exception, not the rule, in this codebase's server-side validation.** A repo-wide census (`grep -rl "z.object(\|z.string(\|z.enum("`) found only **9 files** with real zod schemas:

| File | What it validates |
|---|---|
| `src/lib/actions/expense-entry.actions.ts:25-32` | The GLOBAL expense-category taxonomy (`ExpenseEntryServerSchema`) — the ONE server action in all 144 with a hand-written zod schema at the mutation boundary. |
| `src/lib/financial/cashRemit.schemas.ts` | `CashLineItemSchema`, `SalesDaySchema` — shapes for the cash-remit/sales-day forms. |
| `src/lib/financial/expense/payments.ts:294-308` | `ExpensePaymentSplitSchema` — one payment-split row's shape, used as a `RefinementCtx` custom-issue injector (`applyExpensePaymentValidationIssues`) layered ON TOP of the imperative `validateExpensePayments` function (see below) — zod here is a thin wrapper around hand-written logic, not the primary validator. |
| `src/lib/financial/salary-advance/settings-schema.ts` | Store-level salary-advance policy settings. |
| `src/lib/financial/payment/form.ts` | Payment-form field shapes. |
| `src/lib/ai/compare-orchestrator.ts`, `src/lib/ai/flows/runner.ts`, `src/lib/ai/help/tools.ts`, `src/lib/ai/period-orchestrator.ts` | Genkit tool/structured-output schemas (constrain what the LLM returns) — NOT data validation in the accounting sense. |

**The actual validation layer is imperative, hand-rolled, and lives inside each action function** — every function reviewed in this report follows the same shape: manual `if (...) return { success: false, error: '...' }` chains, sometimes centralized into a shared pure validator function that the action calls (e.g. `validateExpensePayments` in `expense/payments.ts:133-277` — 27 distinct check branches covering receipt/particulars requirements, one-credit-row-max, per-method enablement flags, cash-request sufficiency, account/reference requirements, `'other'`/`'reimbursable'` sub-type rules), sometimes inline in the action itself (e.g. `validateTransfer` in `stock-transfer.ts:45-56`, `validateConvertLineage` in `meat-convert.ts:25-42`, `validateWastageReason` in `wastage-reasons.ts:60-71`).

**What this means for the rebuild**: there is no schema catalogue to port wholesale. Validation logic must be MINED out of each action file's imperative checks — the good news is that the pure-logic modules under `src/lib/financial/*`, `src/lib/inventory/*`, `src/lib/attendance/*` already isolate most of it into standalone, unit-tested functions (note the `*.test.ts` sibling next to nearly every pure module) that translate cleanly into either (a) a shared validation library called from application code, or (b) SQL `CHECK` constraints / triggers for the subset that's a pure data-shape or arithmetic invariant (e.g. `getApStatusFromOutstanding`, `wouldOverdrawSalaryAdvanceBalance`, `isApProjectionClosed`).

**Where validation is thin or absent** (flagged, not verified beyond signature-level reading): most of the 90+ "generic CRUD" action files in groups I/J/M (position, inventory-location, commissary-item-map, memo attachments, onboarding docs, etc.) show no dedicated validator module in `src/lib/financial|inventory|attendance` — their input checking, if any, is presumably inline in the action body. I did not read every one of these files in full; a targeted follow-up pass reading the ~40 "simple CRUD" action files directly (rather than via signature+collection grep) would be needed to confirm whether they validate at all before writing.

---

## 6. Multi-store scoping

- **Physical scoping by path, not just by field.** The overwhelming majority of business data lives at `stores/{storeId}/<collection>/...` — confirmed by a direct grep across all 144 action files: 700+ literal path-template hits across ~85 files, covering every domain (expenses, staff, cash requests, sales days, receipts, salary advances, payment accounts, attendance sessions, AR/AP, channel settlements, wastages, etc. — see the raw counts gathered during this discovery). A document's store is where it physically lives; there is no cross-store foreign key to police at the ORM/query level because the path itself IS the boundary.
- **A small, genuinely top-level (cross-store) set**: `users`, `stores`, `staffIdentities`, `expenseEntries`, `configAuditLog`, `appConfig/capitalization`, `appSettings/aiProviders`, `recipes`/`productionRecipes` (cookbook masters), plus the two `if false`-ruled biometric-secret collections (`fingerprintSecrets`, `faceSecrets`) that are top-level SPECIFICALLY so the store-wildcard rule can't reach them (see `04-auth-and-permissions.md` for the rules-side detail).
- **Authorization is enforced separately from physical placement**: `hasStoreAccess(ctx, storeId)` (`server-context.ts:123-127`) — `ctx.isAdmin` bypasses everything; otherwise `ctx.storeAccess.includes(storeId)` against the array on the caller's `users/{uid}` profile. Nearly every action in this report calls `buildServerPolicyContext(actorUid)` then `hasStoreAccess` before touching `stores/{storeId}/...` — the path convention does not by itself prevent a manager with access to store A from acting on store B; that check is a separate, explicit line in every action.
- **Identity resolution does not trust the client**: `buildServerPolicyContext` (`server-context.ts:35-67`) resolves the acting uid from the verified `__session` cookie (or a `runWithVerifiedPrincipal` scope for cookieless mobile/cron callers with their own verified credential) — a client-supplied `actorUid` that disagrees with the resolved identity is a hard `Unauthorized` throw, not a silent override. A dev-only fallback to the client-supplied uid exists but is gated to `NODE_ENV !== 'production'`.
- **Deliberate, narrow cross-store READS** (the exceptions worth cataloguing since they're rare and each has a specific reason):
  1. `listAvailableCommissariesAction` (`branch-order.actions.ts:76-79`) — `collectionGroup('arCustomers').where('linkedStoreId','==',branchStoreId)`, letting a branch discover every commissary that has set up an AR relationship with it, in one round-trip regardless of how many commissaries exist.
  2. `tie-out.server.ts:46` — `collectionGroup('ap_open').where('storeId','==',storeId)`, a collection-group query STILL explicitly filtered back down to one store (defense in depth even though `collectionGroup` alone would already need every doc to carry `storeId` for this to be safe).
  3. `admin-reset.actions.ts:185` — `collectionGroup('domains').get()` with no store filter — an admin-only bulk tool, not a business-logic read path.
  4. `getStaffCrossStoreLedgerAction` (`salary-advance.actions.ts:1292`) and `getCrossStorePerformanceAction` (`cross-store-performance.actions.ts:25`) — explicit, named cross-store aggregation reads for staff who work multiple branches / owners who oversee multiple stores.
  5. `commissary/branch-payment-mirror.ts` (§2.3) — not a read, but the one place a WRITE deliberately spans two stores (as two separate transactions).
- **Cross-store WRITE** beyond the mirror pattern is rare and appears intentionally narrow: `manager-daily-report.actions.ts`'s `copyManagerRecurringItemsToStoresAction` **[inferred from name]** is the only other action-catalogue entry whose name implies writing into a store other than the caller's home store.

**Rebuild implication**: the path-based physical boundary (`stores/{storeId}/...`) maps directly onto a `store_id` foreign key + row-level-security policy (or a partitioned schema) in Postgres. The `hasStoreAccess` check should become the row-level-security predicate rather than an app-layer-only gate, closing the gap `04-auth-and-permissions.md §7` presumably already flags (server actions currently bypass Firestore rules entirely via the Admin SDK, so the ONLY enforcement is the app-layer check — a rebuild onto Postgres RLS would make the boundary defense-in-depth instead of single-layer).

---

## 7. Integration points

### 7.1 POS pull (external REST API, not shared Firestore)

`src/lib/server/pos-api.ts:1-20` — raw fetchers against `POS_API_URL`/`POS_API_KEY` (header `x-api-key`), explicitly NOT server actions ("for trusted server-side callers... that have no browser session"); `src/lib/actions/pos-api.actions.ts` wraps these with a session check for client-facing use. Per `FRAPPE_MIGRATION_CONTEXT.md:37`, POS and CUSTOMER share Firebase project `shareat-hub-v2`; this repo is the separate project `studio-7300228488-a394e` — **they talk over HTTP, never shared Firestore.**

- **Sales pull, shift-vs-day netting** (`posSalesPull.ts:1-21`): the POS API only returns FULL-DAY totals. A daily report consumes the pull 1:1; a SHIFT report (when multiple cashiers share a day) nets out a baseline (sum of what earlier shifts already recorded) so the shift gets only its incremental slice — otherwise the `salesSummaryMonthShifts` projection would double-count, violating the explicit "reports must not double-count" invariant (`CLAUDE.md`, `FRAPPE_MIGRATION_CONTEXT.md:68`).
- **Payment-method mapping** (`posSalesPull.ts:56-77`, `resolvePosPaymentMethods`): a stored override map takes precedence; otherwise exact normalized-name match against active, CASHIER-OWNED accounts only — an amount auto-routed to an office-owned account would be invisible in the remittance form yet still post to the journal, so account ownership is a hard filter, not just a preference. Unmapped methods surface through `diagnostics.gaps` rather than being silently dropped, since a dropped method would understate expected cash remittance.
- **Usage pull** (`pos-usage-pull.actions.ts`, `posUsagePull.ts`/`posUsageLines.ts` in `financial/`): POS sold-items → inventory usage drafts via `pos-item-map` (item/recipe mapping) and `pos-item-match.ts` (name-matching logic), plan → draft → finalize.
- **Cron**: per `02-module-map.md §4` (not re-verified here), a documented "POS→ERP daily sync (fully automated, 2am Manila cron)" exists on the ERPNext side per `FRAPPE_MIGRATION_CONTEXT.md:82`; this repo's OWN scheduled pulls (sales/usage) are HTTP-triggered server actions, not Firebase Cloud Functions (see 7.4).

### 7.2 Commissary ↔ branch (internal, cross-store within this same app)

Not an external integration but architecturally identical to one: `branch-order*.actions.ts` + `commissary-*.actions.ts` + `financial/commissary/*` implement an internal order→fulfil→receive→settle pipeline between two `stores/{storeId}` documents that otherwise have no shared transaction scope (§2.3, §6).

### 7.3 ERPNext / Frappe (in-progress, one-directional, not yet in this scope's code)

`FRAPPE_MIGRATION_CONTEXT.md` (full file read) is the authoritative statement: ERPNext (self-hosted, `erpnext.shareat.net`, MariaDB) is being built as the eventual system of record; THIS repo's Firestore feeds it via nightly cron pulls (master data down, transactions up — never round-trip). As of the doc's writing (2026-07-20): **live** — POS→ERP daily sync, commissary→branch automation mirror, meat track, general AR bridge, VAT/BIR wiring, Expense→AP (Phase 1) and AP payment (Phase 2). **Not yet built**: cash requests/transfers/reimbursement/assets, loyalty, back-office realtime double-write. I found no code IN THIS SCOPE (`src/lib/actions|server|financial|inventory|payroll|attendance|operations|policies|reports`, `functions/`) that actually calls out to ERPNext — the integration presumably lives in a separate sync service outside this repo's read scope, or is not yet wired into the action layer. `ERPNEXT_MIRROR_LOG.md` (referenced but not fully read — out of tight-focus scope) is the change-log obligation for any lifecycle-affecting edit.

### 7.4 Scheduled/cron work — HTTP-triggered server actions, NOT Firebase Cloud Functions

`functions/src/index.ts` is 6 lines — `admin.initializeApp()` and a comment; **no actual Cloud Functions triggers are deployed** (confirmed: `firebase.json` has no `functions` key at all, only `firestore`/`storage`/`emulators`). Every scheduled job found in this scope's action files instead follows the same pattern: an exported `run*ForAllStores` / `run*NowAction` function gated by a `systemSecret` param checked against `CRON_SECRET` via `isSystemAuthority()` (`daily-snapshot.actions.ts:35-40`), invoked by a Next.js API route that Cloud Scheduler hits over HTTP. Found instances: `daily-snapshot.actions.ts` (`runDailySnapshotForAllStores`), `expense-budget.actions.ts` (`runBudgetReissueForAllStores`), `loan.actions.ts` (`runLoanAutoDeductForAllStores`), `recurring-expense.actions.ts` (`runAutoPayRecurringExpensesForAllStores`), `wastage.actions.ts` (`autoChargeOverdueWastagesAction`), `attendance-sweep.actions.ts` (`sweepStaleOpenSessionsAction` — **[inferred cron, not directly confirmed with a `systemSecret` param in the signature list]**). Full cron inventory (routes) already lives in `02-module-map.md §4` — cross-reference rather than re-derive.

### 7.5 AI / Genkit

Out of this report's tight-focus set (`src/lib/ai/*` is a separate, larger cluster), but the action-layer entry points into it are in scope: `daily-insights.actions.ts`, `oil-insights.actions.ts`, `period-insights.actions.ts`, `insight-compare.actions.ts`, `ai-helper.actions.ts`, `ai-provider-hub.actions.ts`. Two facts worth preserving for the rebuild (from project memory, not re-verified against code in this pass): the live AI provider/model selection is a Firestore doc (`appSettings/aiProviders`), not a code constant — `ai-provider-hub.actions.ts` is that doc's only writer; and `ai-helper.actions.ts`'s "Ask ERP" retrieves a pre-built manual index rather than inlining the whole user manual per call (a real cost fix, per project memory `reference_ask_erp_manual_inlined_every_call`).

### 7.6 Printing / exports

No dedicated printing library found in scope; `report-export.actions.ts` (`exportReportsWorkbook`, `getReportPrintData`) and `excel-export.actions.ts` (`fetchExportDataAction`) both generate `.xlsx` workbooks server-side via the `xlsx` npm package (`report-export.actions.ts:3`). `getReportPrintData` returns structured data presumably for a client-side print view (`window.print()`-style) rather than generating a PDF server-side — not confirmed by reading the client caller, out of scope.

---

## 8. Transaction-heaviness ranking

Ranked by `runTransaction`/`.batch()` call-site COUNT per action file (a proxy for how many independent documents a single business event must keep atomically consistent) — not a perfect proxy (one call site can prepare many legs, as `journal-writer.ts`'s two-phase `prepareJournalLegs`/`commitJournalLegs` does), but a reasonable ordering signal combined with the qualitative coordination each flow requires:

| Rank | File | Txn call sites | What one flow coordinates |
|---|---|---|---|
| 1 | `financial-init.actions.ts` | 10 | Store bootstrap/repair — seeds/reconciles `accounts`, `expenses`, `paymentAccounts`, `salesDays`, `transfers`, `cashRequests`, `salaryAdvances`, `remittanceDiscrepancies` in one pass; repair tooling by nature touches everything. |
| 2 | `general-inventory.actions.ts` | 8 | Draft→post→void for generic inventory usage: item balance, item-location balance, stock ledger leg, and (if wastage) the wastage classification — all inside `postInventoryUsageRecordAction`. |
| 3 | `wastage.actions.ts` | 7 | Create→dispute→resolve→charge→settlement-match: a single wastage can touch `wastages`, `staff` (charge), `configAuditLog`, and (via salary-advance) a cash request/receipt — plus the platform-settlement matching path. |
| 3 | `delivery.actions.ts` | 7 | Receive: per-line location allocation + inventory ledger legs + AP expense linkage, all atomically; void must reverse all three. |
| 5 | `memo.actions.ts` | 6 | Draft→submit→approve/reject→per-staff-ack roster reconciliation — the roster-reconcile step alone touches every affected staff's ack doc. |
| 5 | `admin-reset.actions.ts` | 6 | Bulk category-driven deletion across arbitrary collections. |
| 7 | `sales-report.actions.ts` | 5 | Remit: cashier declared cash → transfer → payment-account balance, plus shortage-charge cascade into salary-advance. |
| 7 | `sales-report-adjustment.actions.ts` | 5 | Post-verify correction: append-only adjustment doc + re-derived day totals + linked expense visibility. |
| 7 | `legacy-import.actions.ts` | 5 | Opening-balance import spanning AP/AR/staff-advance/reimbursable/cash in one call. |
| 7 | `inventory-location.actions.ts` | 5 | Location CRUD + `allocateItemToLocationsAction`'s multi-item, multi-location balance split. |
| 7 | `attendance-review.actions.ts` | 5 | Every manager decision (verify / half-day / early-out / late-out-OT) must re-run `resolveWorkday`, write the session, AND raise/void the corresponding pending-OT record (§2.7, §2.8) — each decision is its own transaction. |
| — | `channel-settlement.actions.ts`, `payment.actions.ts`, `payroll-staff-payout.actions.ts`, `ar-credit-sale.actions.ts`, `stock-transfer.actions.ts`, `salary-advance.actions.ts`, `loan.actions.ts`, `liability.actions.ts` | 3–4 each | Each of these is a "textbook" multi-leg journal posting (AR/AP clear + clearing account + fee/gain/variance legs + optional loan leg) — fewer call sites than the above, but the PER-CALL leg count is often higher (`buildSettlementPosting` alone can emit up to 5 legs, `posting.ts:75-94`). |

**Qualitative note beyond the count**: the true "wants a real SQL transaction" ranking should weight `payment.actions.ts` and `commissary/branch-payment-mirror.ts` higher than their raw count suggests — a supplier payment allocation can trigger the CROSS-STORE mirror (§2.3), which is architecturally the one place this codebase has to fake a distributed transaction (best-effort + deterministic id + idempotent retry) specifically BECAUSE Firestore can't span two documents' store boundaries in one transaction. In a relational rebuild where both stores' data lives in the same database, this entire "two best-effort transactions + repair tool" pattern collapses into one real ACID transaction — likely the single largest simplification available anywhere in this codebase. Similarly, `journal-writer.ts`'s two-phase prepare/commit API (built specifically so callers can interleave their OWN reads between Firestore's read-before-write transaction rule) has no reason to exist in Postgres, where read/write ordering within a transaction is unconstrained.

---

## 9. Flagged — not independently verified

- `datetime.ts`'s caller sites (whether any render a business-relevant time to a human, and are therefore exposed to the same UTC-drift class `date-utils.ts` was built to fix) — not traced.
- Whether `attendance-sweep.actions.ts`'s `sweepStaleOpenSessionsAction` is actually cron-invoked with a `systemSecret` — its signature wasn't captured with one in the grep pass; inferred from its name and neighboring pattern only.
- The exact mutation targets for ~35 files that use only path-helper functions (`fooDocPath()`/`fooColPath()`) rather than literal template strings — collection names for these are inferred from the helper function's name and the action file's domain, not from opening every `paths.*.ts` file. Marked `[via path helpers]` or `[inferred]` throughout §1.
- Whether ERPNext-mirror sync code actually exists anywhere in this repo's scope, vs. living entirely in a separate sync service — I found the migration's CONTEXT document but no outbound HTTP/webhook call sites to an ERPNext endpoint inside `src/lib/actions|server|financial|inventory|payroll|attendance|operations|policies|reports` or `functions/`.
- `src/lib/ai/*` internals (orchestrators, signal extraction, cost/throttle config) — deliberately out of tight-focus scope per the task; only the action-layer entry points into that cluster are catalogued here.
- The ~40 "simple CRUD" action files in groups I/J/M/Q not read beyond signature + collection-grep level — validation depth inside them (§5) is unconfirmed.
