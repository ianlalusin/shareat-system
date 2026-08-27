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
export * as filesRepo from './repo/files';
export * as loansRepo from './repo/loans';
export * as cashRequestsRepo from './repo/cash-requests';
export * as ownersRepo from './repo/owners';
export * as liabilitiesRepo from './repo/liabilities';
export * as sessionsRepo from './repo/sessions';
// Re-exported so a caller establishing a principal around an authorize() call (T-121) does
// not need to reach into packages/db/src/rls/registry.ts directly.
export { APP_ROLE } from './rls/registry';
