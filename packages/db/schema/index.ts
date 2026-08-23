/**
 * Drizzle schema — the ONLY place tables are defined (PROJECT_BIBLE.md §4.3).
 *
 * T-101 laid the core schema: organizations, stores, persons + person_identities,
 * accounts, fiscal_periods, audit_log. T-103 adds journal_entries / journal_lines — the
 * nominal ledger (docs/tasks/103-journal-tables.md).
 */

export * from './organizations';
export * from './stores';
export * from './persons';
export * from './accounts';
export * from './fiscal-periods';
export * from './audit-log';
export * from './journal';
