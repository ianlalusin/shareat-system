/**
 * @shareat/db — the single source of truth for the schema.
 *
 * PROJECT_BIBLE.md §4.3: `schema/` is the ONLY place tables are defined and
 * `src/repo/` will be the ONLY place SQL is written. Every front-end reads the
 * database through this package — never by opening its own connection.
 */
export * as schema from '../schema';
export { getSql, getDb, closeDb } from './client';
