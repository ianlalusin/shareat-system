/**
 * @shareat/db — the single source of truth for the schema.
 *
 * PROJECT_BIBLE.md §4.3: `schema/` is the ONLY place tables are defined and
 * `src/repo/` is the ONLY place SQL is written. Every front-end reads the
 * database through this package — never by opening its own connection.
 *
 * `journalRepo` (docs/tasks/105-posting-engine.md), `etlRepo`
 * (docs/tasks/112-etl-framework.md), and `reportsRepo`
 * (docs/tasks/110-reporting-views-and-screens.md) are namespaced, not flattened, so a
 * future repo file (e.g. an accounts repo) can be added without name collisions.
 */
export * as schema from '../schema';
export { getSql, getDb, closeDb, transaction } from './client';
// T-343 S5.0 — the refusal foundation (`refuse`, `RefusalError`, `goneSentence`, `UUID_SHAPE`) and
// `recordGone`, now surfaced: S5's groups call them from domain and app code (first caller: S5.1).
export type { RecordGoneError } from './repo/record-gone';
export { recordGone } from './repo/record-gone';
export { RefusalError, refuse, goneSentence, UUID_SHAPE } from './refusal';
// ⭐ T-332 — the one definition of "today" (`sql-time.ts`), made reachable outside the repo layer
// so a caller never has to hand-spell `(now() at time zone 'Asia/Manila')::date` again (DEF-172).
// `manilaToday` returns it as a plain string for a caller that needs a value, not a fragment.
// `daysBetweenDates` travels with both on purpose — `sql-time.ts`'s own rule is "carry
// `MANILA_TODAY` back as a column and use `daysBetweenDates` — never reach for the process clock"
// (DEF-178's worst instance was exactly this pairing broken: a SQL gate re-measured with
// `Date.now()`). Exporting one half and not the other leaves that trap half-open.
export { MANILA_TODAY, manilaToday, daysBetweenDates } from './repo/sql-time';
/**
 * `systemTransaction` ONLY, deliberately — not `getSystemSql`/`getSystemDb`/`closeSystemDb`
 * alongside it, and NOT for symmetry with the line above (T-251a, bible §13 row 185).
 *
 * The guard at `tests/unit/system-transaction-callers.test.ts` closes the caller list by
 * matching `systemTransaction(`. Re-exporting the raw accessors here would open a path to the
 * same authority that the guard does not match — a hole straight through an import-only guard,
 * which is exactly the finding T-231 contract 5 recorded. Today that costs nothing because both
 * connections resolve to `DATABASE_URL`; the moment `SYSTEM_DATABASE_URL` is set (T-251b) it
 * would be a real privilege bypass with no test watching it.
 *
 * Scripts and tests that genuinely need `closeSystemDb` import it from `./client` directly, the
 * way `scripts/bootstrap-org.ts` already imports `closeDb`/`transaction`.
 */
export { systemTransaction } from './client';
/**
 * `authTransaction` — bible §13 row 194, DEF-288. Same reasoning as the block above applies to
 * it unchanged: exported alone, never alongside a raw accessor, and closed by its own guard at
 * `tests/unit/auth-transaction-callers.test.ts`.
 *
 * ⛔ **A SEPARATE name from `systemTransaction`, on purpose.** Both resolve to the same privileged
 * connection, so this buys nothing physically — it buys that *"crosses organisations because it is
 * a scheduler"* and *"…because it is establishing who you are"* stay two greppable permissions
 * with two separate closed lists. Row 194 exists because collapsing them is how the second stops
 * being visible, and row 185 had already shown that one undifferentiated list acquires callers
 * nobody re-reads.
 */
export { authTransaction } from './client';
export type { Tx, Executor, Database } from './client';
/** Asset categories — the const list and its derived union. Exported here rather than reached
 *  through a schema subpath so `packages/domain` has one import surface for the db package. */
export { ASSET_CATEGORIES } from '../schema/fixed-assets';
export { CUSTODIANS, MONEY_INSTRUMENTS } from '../schema/money-accounts';
export type { AssetCategory } from '../schema/fixed-assets';
export { FOUNDATION_ACCOUNTS } from '../schema/money-accounts';
export type { Custodian, MoneyInstrument } from '../schema/money-accounts';
export type { MoneyTransferStatus } from '../schema/money-transfers';
export type { MoneyAccountRow } from './repo/money-accounts';
export type { MoneyTransferRow, MoneyTransferListRow } from './repo/money-transfers';
export type { ChannelSettlementStatus } from '../schema/channel-settlements';
export type {
  ChannelSettlementRow,
  SettlementChannelRow,
  SettleableChannelDayRow,
  SettlementListRow,
} from './repo/channel-settlements';
export { PREPAID_CATEGORIES, PREPAID_STATUSES } from '../schema/prepaid';
export type { PrepaidCategory, PrepaidStatus } from '../schema/prepaid';
export type { PrepaidItemRow } from './repo/prepaid';
export { SCHEDULER_JOBS, SCHEDULER_OUTCOMES } from '../schema/scheduler';
export type { SchedulerJob, SchedulerOutcome, SchedulerFailure } from '../schema/scheduler';
export type { SchedulerRunRow } from './repo/scheduler';
export { REMITTANCE_STATUSES, VARIANCE_STATUSES } from '../schema/remittance';
export { PAY_BASES, PAY_RUN_STATUSES } from '../schema/payroll';
export type { PayBasis, PayRunStatus } from '../schema/payroll';
export { TILL_SHIFT_STATUSES, COUNT_MOMENTS } from '../schema/till-shifts';
export type { TillShiftStatus, CountMoment } from '../schema/till-shifts';
export type { RemittanceStatus, VarianceStatus } from '../schema/remittance';
export type { EndDayReport } from './repo/remittance';
export { FILE_PURPOSES } from '../schema/stored-files';
export type { FilePurpose } from '../schema/stored-files';
export type { StoredFileRow } from './repo/files';
export { RATE_PERIODS, INTEREST_METHODS, PAYMENT_FREQUENCIES, LOAN_STATUSES } from '../schema/loans';
export type { RatePeriod, InterestMethod, PaymentFrequency, LoanStatus } from '../schema/loans';
export type { LoanRow, LoanPosition, LoanPaymentRow } from './repo/loans';
export { CASH_REQUEST_STATUSES } from '../schema/cash-requests';
export type { CashRequestStatus } from '../schema/cash-requests';
export type { CashRequestRow, FloatPosition } from './repo/cash-requests';
export type { OwnerRow, OwnerPosition, DrawingCloseRow, AgedReceivable } from './repo/owners';
export type { PositionRow, EmploymentRow, RosterRow, EmploymentPositionRow } from './repo/employment';
export type { AttendanceConfigRow } from './repo/attendance-config';
export type { AttendancePunchRow } from './repo/attendance-punches';
export type {
  AttendanceDayRow,
  /** T-195 — the review screen's read model. */
  ReviewDayRow,
  ReviewReason,
  QueuedDay,
} from './repo/attendance-days';
export type { AttendanceAdjustmentRow } from './repo/attendance-adjustments';
export type { ClockTerminalRow } from './repo/clock-terminals';
export type { LiabilityRow, LiabilityPosition, LiabilityMovement } from './repo/liabilities';
export type { CustomerRow, PriceListRow, PriceListItemRow } from './repo/customers';
export { treatmentOf } from './repo/customers';
export { SUPPLIER_STATUSES, SUPPLIER_VAT_STATUSES, SUPPLIER_INVOICE_STATUSES, SUPPLIER_INVOICE_VAT_TYPES, SUPPLIER_CLASSIFICATIONS } from '../schema/suppliers';
export type { SupplierClassification } from '../schema/suppliers';
export type { SupplierStatus, SupplierVatStatus, SupplierInvoiceStatus, SupplierInvoiceVatType } from '../schema/suppliers';
export { AP_PAYMENT_STATUSES } from '../schema/ap-payments';
export type { ApPaymentStatus } from '../schema/ap-payments';
export type {
  SupplierRow,
  SupplierInvoiceRow,
  InvoiceCapacity,
  ApPosition,
  OpenItem,
  ApOrderingKeys,
  AgingBucket,
  ApPaymentRow,
  ApPaymentAllocationRow,
} from './repo/ap';
export * as journalRepo from './repo/journal';
export * as etlRepo from './repo/etl';
export * as reportsRepo from './repo/reports';
export * as accessRepo from './repo/access';
export * as expensesRepo from './repo/expenses';
export * as salesDaysRepo from './repo/sales-days';
export * as fixedAssetsRepo from './repo/fixed-assets';
export * as moneyAccountsRepo from './repo/money-accounts';
export * as moneyTransfersRepo from './repo/money-transfers';
export * as prepaidRepo from './repo/prepaid';
export * as schedulerRepo from './repo/scheduler';
export * as remittanceRepo from './repo/remittance';
export * as payrollRepo from './repo/payroll';
// T-191 — 13th-month pay (Phase 5, after T-189).
export * as thirteenthMonthRepo from './repo/thirteenth-month';
// T-192 — separations, final pay, clearance (Phase 5, after T-191).
export * as separationsRepo from './repo/separations';
export type { PayRateRow, PayRunRow, PayslipRow, PayableDay } from './repo/payroll';
export * as tillShiftsRepo from './repo/till-shifts';
export type { TillShiftRow, TillCountRow, CountLineWithShift, CountedVarianceRow } from './repo/till-shifts';
export * as storesRepo from './repo/stores';
// T-187 slice 1 — the service-charge float's own per-store balance (§7 invariant 1).
export * as serviceChargeRepo from './repo/service-charge';
export { REMITTANCE_CADENCES, CADENCE_DAYS } from '../schema/stores';
export type { RemittanceCadence } from '../schema/stores';
export type { StoreCashPolicy, StoreRow } from './repo/stores';
export * as filesRepo from './repo/files';
export * as loansRepo from './repo/loans';
export * as cashRequestsRepo from './repo/cash-requests';
export * as ownersRepo from './repo/owners';
// T-154 — the staff master record (Phase 4, lane B).
export * as employmentRepo from './repo/employment';
// T-155 — per-store attendance policy, effective-dated (Phase 4, lane B).
export * as attendanceConfigRepo from './repo/attendance-config';
// T-156 — the append-only punch (Phase 4, lane B).
export * as attendancePunchesRepo from './repo/attendance-punches';
// T-157 — the adjudicated day (Phase 4, lane B).
export * as attendanceDaysRepo from './repo/attendance-days';
// T-158 — the manager's decisions (Phase 4, lane B).
export * as attendanceAdjustmentsRepo from './repo/attendance-adjustments';
// T-159 — the provisioned device identity (Phase 4, lane B).
export * as clockTerminalsRepo from './repo/clock-terminals';
// T-185 — clock-in credentials. ⛔ No listTemplates: see the repo's header.
export * as attendanceCredentialsRepo from './repo/attendance-credentials';
export type { AttendanceCredentialRow } from './repo/attendance-credentials';
// T-181/T-183 — Lane A's outbox, and the lag that says whether it is moving.
export * as mirrorOutboxRepo from './repo/mirror-outbox';
export type { OutboxRow, OutboxLag } from './repo/mirror-outbox';
// T-182/T-183 — Lane B's quarantine: the events that did not make it, and can still be recovered.
export * as inboxQuarantineRepo from './repo/inbox-quarantine';
export type { InboxQuarantineRow, ReasonCount } from './repo/inbox-quarantine';
export * as liabilitiesRepo from './repo/liabilities';
export * as customersRepo from './repo/customers';
export * as sessionsRepo from './repo/sessions';
export * as pinAttemptsRepo from './repo/pin-attempts';
export * as apRepo from './repo/ap';
export * as arRepo from './repo/ar';
export * as tradeRepo from './repo/trade';
export * as channelSettlementsRepo from './repo/channel-settlements';
export * as findingsRepo from './repo/findings';
// T-245 — the prerequisite-refusal counter. docs/tasks/245-prerequisite-refusal-counter.md.
export * as prerequisiteRefusalsRepo from './repo/prerequisite-refusals';
export type { RefusalCount } from './repo/prerequisite-refusals';
export * as cutoverRepo from './repo/cutover';
export * as statutoryDiscountsRepo from './repo/statutory-discounts';
export type {
  StatutoryDiscountRow,
  StatutoryDiscountSummary,
  StatutoryDiscountKind,
  StatutoryDiscountSource,
} from './repo/statutory-discounts';
export type { OpeningDraft, CutoverStepRow } from './repo/cutover';
export type { ArChargeRow, ArCollectionRow, ArOpenItem, ArPosition, ArAgingBucket } from './repo/ar';
export type { TradeOrderRow, TradeOrderLineRow, TradeOrderListRow } from './repo/trade';
export { AR_DOC_STATUSES } from '../schema/ar';
export type { ArDocStatus } from '../schema/ar';
export * as itemsRepo from './repo/items';
export * as stockLedgerRepo from './repo/stock-ledger';
export * as stockLayersRepo from './repo/stock-layers';
export * as stockTransfersRepo from './repo/stock-transfers';
export * as supplierReturnsRepo from './repo/supplier-returns';
export * as deliveriesRepo from './repo/deliveries';
export * as tradeDiscrepanciesRepo from './repo/trade-discrepancies';
export * as commissaryKpisRepo from './repo/commissary-kpis';
export type {
  CommissaryKpiFilter,
  InFlightStage,
  InFlightStageRow,
  OpenDisputeRow,
  OpenDisputeSummary,
  ReceivedSummary,
} from './repo/commissary-kpis';
export * as lowStockRepo from './repo/low-stock';
export type { LowStockRow, OrderMessageRow } from './repo/low-stock';
export type { TradeDiscrepancyRow } from './repo/trade-discrepancies';
export type {
  CatalogueEntry,
  SimilarItem,
  ItemRequestRow,
  MergeReport,
  DuplicateCandidate,
  ResolvedSellability,
  StoreSellabilityOverrideRow,
  ItemPricingRow,
} from './repo/items';
export { SIMILARITY_FLOOR } from './repo/items';
export { ITEM_REQUEST_STATUSES } from '../schema/items';
export type { ItemRequestStatus } from '../schema/items';
export { CATALOGUE_SOURCES } from '../schema/supplier-items';
export type { CatalogueSource } from '../schema/supplier-items';
export type {
  ItemRow,
  InvoiceLineInput,
  InvoiceLineRow,
  PriceObservation,
  PriceMonth,
  SupplierPrice,
} from './repo/items';
export { ITEM_KINDS, BASE_UNITS, PURCHASE_UNITS, ITEM_STATUSES } from '../schema/items';
export type { ItemKind, BaseUnit, PurchaseUnit, ItemStatus } from '../schema/items';
// Re-exported so a caller establishing a principal around an authorize() call (T-121) does
// not need to reach into packages/db/src/rls/registry.ts directly.
export { APP_ROLE } from './rls/registry';
// T-231 / DEF-211 — the ONE Drizzle-shaped principal helper. Replaces the copies in
// apps/erp/src/app/expenses/lib.ts and packages/domain/src/scheduler/index.ts.
export { withOrgPrincipal, withSystemOrgPrincipal } from './rls/principal';
export * as stockLocationsRepo from './repo/stock-locations';
// DEF-135 (2026-09-03) — the usage document's and the count session's SQL. Until now the only
// writers of either table were test fixtures.
export * as stockUsageRepo from './repo/stock-usage';
export * as countSessionsRepo from './repo/count-sessions';
export * as commissaryRepo from './repo/commissary';
// T-171 / DEF-129 — links, offerings and the item map: the catalogue's own SQL.
export * as commissaryCatalogueRepo from './repo/commissary-catalogue';
export * as customerReturnsRepo from './repo/customer-returns';
// T-202 / DEF-131 — the persons writer that never existed until now.
export * as personsRepo from './repo/persons';
export type { PersonRow, PersonWithAccessRow } from './repo/persons';
// T-219 / DEF-167 — the role/scope/grant rows the user-management screens render.
export type { GrantRow, ActiveRoleRow, RoleName } from './repo/access';
// T-178 — order/channel wastage disposition.
export * as orderWastageRepo from './repo/order-wastage';
export type { OrderWastageRow, AllocationRow as OrderWastageAllocationRow } from './repo/order-wastage';
export { ORDER_WASTAGE_TYPE_MODES, ORDER_WASTAGE_STATUSES, ORDER_WASTAGE_DISPOSITIONS } from '../schema/order-wastage';
export type { OrderWastageTypeMode, OrderWastageStatus, OrderWastageDisposition } from '../schema/order-wastage';
// T-176 — production: slab -> slice, recipe -> batch. Recipes and records, plus a narrow
// production-only item projection that carries parent_slab_item_id.
export * as productionRepo from './repo/production';
export type {
  ProductionItemRow,
  RecipeRow,
  RecipeLineRow,
  ProductionRecordRow,
  ProductionRecordLineRow,
} from './repo/production';
// T-177 — POS item mapping and the daily usage pull.
export * as posMappingRepo from './repo/pos-mapping';
export type {
  PosItemMapRow,
  PosMapRequestRow,
  RecipeForExplosion,
  PosUsagePullRow,
  PullLineRow,
  InsertPullLine,
} from './repo/pos-mapping';
export {
  POS_MAP_MODES,
  POS_MAP_STATUSES,
  POS_MAP_REQUEST_STATUSES,
  POS_USAGE_PULL_STATUSES,
  POS_USAGE_PULL_SECTIONS,
} from '../schema/pos-mapping';
export type {
  PosMapMode as PosItemMapMode,
  PosMapStatus,
  PosMapRequestStatus,
  PosUsagePullStatus,
  PosUsagePullSection,
} from '../schema/pos-mapping';

// T-215 — expense budgets. Consumption is DERIVED here; there is no counter to read.
export * as budgetsRepo from './repo/budgets';

// T-216 — recurring-expense templates. Configuration, not documents: nothing here posts.
export * as recurringExpensesRepo from './repo/recurring-expenses';

// T-228 / DEF-195 — the organizations writer that never existed until now. `seedReferenceData`
// applies the chart and the categories INSIDE the caller's transaction; see its header before
// changing how it reaches the driver.
export * as organizationsRepo from './repo/organizations';
export type { OrganizationRow, ReferenceDataSeeded } from './repo/organizations';

// T-264 / DEF-284 slice 1 — the fiscal_periods writer that never existed until now.
export * as fiscalPeriodsRepo from './repo/fiscal-periods';
export type { SeedCalendarMonthsInput, SeedCalendarMonthsResult } from './repo/fiscal-periods';

// T-289 — position access defaults: the spine.
export * as positionDefaultsRepo from './repo/position-defaults';

// T-345 — the missed-month catch-up link.
export * as missedMonthsRepo from './repo/missed-months';
export type { MissedMonthSchedule } from '../schema/missed-month-adjustments';
