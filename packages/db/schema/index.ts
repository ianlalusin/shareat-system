/**
 * Drizzle schema — the ONLY place tables are defined (PROJECT_BIBLE.md §4.3).
 *
 * T-101 (this file's current contents) lays the core schema: organizations, stores,
 * persons + person_identities, accounts, fiscal_periods, audit_log.
 *
 * journal_entries / journal_lines are out of scope for T-101 — they arrive with T-103.
 * See docs/tasks/101-core-schema.md and docs/plans/phase-1-accounting-spine.md §C.
 */

export * from './organizations';
export * from './stores';
export * from './persons';
export * from './accounts';
export * from './fiscal-periods';
export * from './audit-log';
