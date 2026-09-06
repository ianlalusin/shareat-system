/**
 * Drizzle schema — the ONLY place tables are defined (PROJECT_BIBLE.md §4.3).
 *
 * T-101 laid the core schema: organizations, stores, persons + person_identities,
 * accounts, fiscal_periods, audit_log. T-103 adds journal_entries / journal_lines — the
 * nominal ledger (docs/tasks/103-journal-tables.md). T-112 adds etl_runs /
 * etl_source_documents / etl_quarantine / etl_reconciliation — the ETL framework
 * (docs/tasks/112-etl-framework.md). T-110 adds the three reporting views — declared
 * here for typing only; the DDL is hand-written in migration 0010, not generated (see
 * views.ts's own top comment for why). T-121 adds person_roles / person_store_scope /
 * person_grants — the three access axes (docs/tasks/121-roles-and-access.md). T-122 adds
 * expenses / expense_payments / expense_categories — non-inventory spend
 * (docs/tasks/122-expenses.md). T-123 adds sales_days / sales_day_channels / sales_channels —
 * the ERP's record of a day's selling, per store (docs/tasks/123-sales-day.md).
 */

export * from './organizations';
export * from './payroll';
export * from './thirteenth-month';
export * from './separations';
export * from './stores';
export * from './persons';
export * from './accounts';
export * from './fiscal-periods';
export * from './audit-log';
export * from './journal';
export * from './etl';
export * from './views';
export * from './access';
export * from './expenses';
export * from './sales-days';
export * from './sessions';
export * from './fixed-assets';
export * from './money-accounts';
export * from './money-transfers';
export * from './scheduler';
export * from './remittance';
export * from './stored-files';
export * from './loans';
export * from './owners';
export * from './liabilities';
export * from './customers';
export * from './owner-drawing-closes';
export * from './cash-requests';
export * from './prepaid';
export * from './suppliers';
export * from './ap-payments';
export * from './items';
export * from './supplier-items';
export * from './ar';
export * from './trade';
export * from './channel-settlements';
export * from './findings';
export * from './cutover';
export * from './stock-locations';
export * from './stock-ledger';
export * from './stock-layers';
export * from './stock-transfers';
export * from './supplier-returns';
export * from './customer-returns';
export * from './deliveries';
export * from './stock-usage';
export * from './count-sessions';
export * from './commissary';
export * from './trade-discrepancies';
export * from './item-thresholds';
export * from './statutory-discounts';
export * from './till-shifts';

// T-154 — the staff master record: positions, employments, employment_positions.
// docs/tasks/154-positions-and-employments.md (Phase 4, lane B).
export * from './employment';

// T-155 — per-store attendance policy, effective-dated (Phase 4, lane B).
export * from './attendance-config';

// T-156 — the append-only punch, the Lane B landing table (Phase 4, lane B).
export * from './attendance-punches';

// T-157 — the adjudicated day (Phase 4, lane B).
export * from './attendance-days';

// T-158 — the manager's decisions, as attributed inputs (Phase 4, lane B).
export * from './attendance-adjustments';

// T-159 — the provisioned device identity (Phase 4, lane B).
export * from './clock-terminals';

// T-181 — the Lane A transactional outbox (Phase 4, lane B).
export * from './mirror-outbox';

// T-182 — the Lane B quarantine (Phase 4, lane B).
export * from './inbox-quarantine';

// T-185 — clock-in credentials: card and fingerprint (Phase 4, lane B).
export * from './attendance-credentials';

// T-178 — order/channel wastage disposition: order_wastages, order_wastage_allocations.
export * from './order-wastage';

// T-176 — production: slab -> slice, recipe -> batch, and the payroll lock.
export * from './production';

// T-177 — POS item mapping and the daily usage pull.
export * from './pos-mapping';

// T-215 — expense budgets: the envelope a store spends a category out of.
export * from './expense-budgets';

// T-216 — recurring-expense TEMPLATES. ⛔ No system/payroll rows, ever: read the header.
export * from './recurring-expenses';
