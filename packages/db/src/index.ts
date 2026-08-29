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
export { PREPAID_CATEGORIES, PREPAID_STATUSES } from '../schema/prepaid';
export type { PrepaidCategory, PrepaidStatus } from '../schema/prepaid';
export type { PrepaidItemRow } from './repo/prepaid';
export { SCHEDULER_JOBS, SCHEDULER_OUTCOMES } from '../schema/scheduler';
export type { SchedulerJob, SchedulerOutcome, SchedulerFailure } from '../schema/scheduler';
export type { SchedulerRunRow } from './repo/scheduler';
export { REMITTANCE_STATUSES, VARIANCE_STATUSES } from '../schema/remittance';
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
export type { LiabilityRow, LiabilityPosition, LiabilityMovement } from './repo/liabilities';
export type { CustomerRow, PriceListRow, PriceListItemRow } from './repo/customers';
export { treatmentOf } from './repo/customers';
export { SUPPLIER_STATUSES, SUPPLIER_VAT_STATUSES, SUPPLIER_INVOICE_STATUSES, SUPPLIER_INVOICE_VAT_TYPES } from '../schema/suppliers';
export type { SupplierStatus, SupplierVatStatus, SupplierInvoiceStatus, SupplierInvoiceVatType } from '../schema/suppliers';
export { AP_PAYMENT_STATUSES } from '../schema/ap-payments';
export type { ApPaymentStatus } from '../schema/ap-payments';
export type {
  SupplierRow,
  SupplierInvoiceRow,
  InvoiceCapacity,
  ApPosition,
  OpenItem,
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
export * as storesRepo from './repo/stores';
export { REMITTANCE_CADENCES, CADENCE_DAYS } from '../schema/stores';
export type { RemittanceCadence } from '../schema/stores';
export type { StoreCashPolicy } from './repo/stores';
export * as filesRepo from './repo/files';
export * as loansRepo from './repo/loans';
export * as cashRequestsRepo from './repo/cash-requests';
export * as ownersRepo from './repo/owners';
export * as liabilitiesRepo from './repo/liabilities';
export * as customersRepo from './repo/customers';
export * as sessionsRepo from './repo/sessions';
export * as apRepo from './repo/ap';
export * as arRepo from './repo/ar';
export * as tradeRepo from './repo/trade';
export * as channelSettlementsRepo from './repo/channel-settlements';
export * as findingsRepo from './repo/findings';
export * as cutoverRepo from './repo/cutover';
export type { OpeningDraft, CutoverStepRow } from './repo/cutover';
export type { ArChargeRow, ArCollectionRow, ArOpenItem, ArPosition, ArAgingBucket } from './repo/ar';
export type { TradeOrderRow, TradeOrderLineRow } from './repo/trade';
export { AR_DOC_STATUSES } from '../schema/ar';
export type { ArDocStatus } from '../schema/ar';
export * as itemsRepo from './repo/items';
export * as stockLedgerRepo from './repo/stock-ledger';
export * as stockLayersRepo from './repo/stock-layers';
export type { CatalogueEntry, SimilarItem, ItemRequestRow, MergeReport, DuplicateCandidate } from './repo/items';
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
