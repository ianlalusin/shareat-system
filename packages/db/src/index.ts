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
export * as journalRepo from './repo/journal';
export * as etlRepo from './repo/etl';
export * as reportsRepo from './repo/reports';
export * as accessRepo from './repo/access';
export * as expensesRepo from './repo/expenses';
export * as salesDaysRepo from './repo/sales-days';
// Re-exported so a caller establishing a principal around an authorize() call (T-121) does
// not need to reach into packages/db/src/rls/registry.ts directly.
export { APP_ROLE } from './rls/registry';
