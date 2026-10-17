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
export * from './statutory';
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
export * from './pin-attempts';
export * from './sign-in-attempts';
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
export * from './v1-master-links';
export * from './supplier-items';
export * from './ar';
export * from './trade';
export * from './channel-settlements';
export * from './findings';
export * from './prerequisite-refusals';
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
// T-216 Part 2 — what each template has already drafted. ⭐ The UNIQUE (template, due date) index
// here is the job's idempotency rule; the cursor alone cannot be it.
export * from './recurring-expense-drafts';

// T-264 slice 3 — who invoked the fiscal-period override, for which entry, and why.
// ⛔ A row means "the override_period_lock capability was INVOKED for this entry", NOT "the period
// lock was bypassed": those differ when period_status_at_post = 'open'. Read the file header before
// counting anything out of this table.
export * from './period-overrides';

// T-289 — position access defaults: per (position, store) capability defaults, additive to the
// role matrix. Not in the spec's file list (a gap reported in the task report); required so
// `tests/unit/cutover-classification.test.ts` and `tests/unit/rls-registry.test.ts` — both of
// which enumerate tables from THIS barrel via `Object.values(schema)` — can see the table their
// own required entries (classification.ts, rls/registry.ts) refer to.
export * from './position-capability-defaults';

// T-345 — the link between a missed month's catch-up journal entry and the period it counts as
// booked for.
export * from './missed-month-adjustments';

// T-375 S1 - the POS v1 day feed: store links, the immutable feed, the tender master, POS corrections.
export * from './pos-v1';

// T-424 S5 - which POS v2 tablet is which ERP terminal person (the manager-approval bucket owner).
export * from './pos-terminal-links';

// T-392 S3 - the dual-run comparator: reports (one per store-week version), their lines, and dispositions.
export * from './dual-run';

// T-401 S1 - the ERP menu and catalog master: categories, items, variants, option groups, links, refills, depletion rules, offers.
export * from './menu';

// T-436 - leave and absence tracking: kinds, caps, requests, per-date days, the year-end SIL payout.
export * from './leave';
