/**
 * fiscal_periods — docs/tasks/101-core-schema.md Contract §6.
 *
 * No overlapping periods per org. That is an EXCLUDE USING gist constraint, which Drizzle
 * has no builder for — it is hand-added in the generated migration, along with the
 * `CREATE EXTENSION IF NOT EXISTS btree_gist` it depends on (Contract §8).
 */
import { sql } from 'drizzle-orm';
import { check, date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';

export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status', { enum: ['open', 'closed', 'locked'] })
      .notNull()
      .default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => persons.id, { onDelete: 'restrict' }),
    // NOTE: T-344/DEF-422, migration 0160. Set only when this row was created by the admin
    // "fill a missing month inside closed books" action — null on every ordinary period. A
    // BEFORE UPDATE trigger (fiscal_periods_fill_immutable) makes both columns write-once at
    // INSERT; a CHECK (fiscal_periods_fill_shape_check) requires fillReason non-blank iff
    // createdBy/closedBy/closedAt are all set and status <> 'open'. DELETE is untouched (R1.6,
    // the 2027 cutover purge).
    createdBy: uuid('created_by').references(() => persons.id, { onDelete: 'restrict' }),
    fillReason: text('fill_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('fiscal_periods_status_check', sql`${t.status} in ('open', 'closed', 'locked')`),
    check('fiscal_periods_ends_on_check', sql`${t.endsOn} >= ${t.startsOn}`),
    // T-368 S0 / DEF-426: an OPEN period is always one whole calendar month. Migration 0174.
    check(
      'fiscal_periods_open_whole_month_check',
      sql`${t.status} <> 'open' or (${t.startsOn} = date_trunc('month', ${t.startsOn})::date and ${t.endsOn} = (date_trunc('month', ${t.startsOn}) + interval '1 month - 1 day')::date)`,
    ),
    // NOTE: the no-overlap rule — EXCLUDE USING gist (org_id WITH =,
    // daterange(starts_on, ends_on, '[]') WITH &&) — is hand-added in the generated
    // migration; it requires btree_gist, also hand-added there (Contract §8).
    // NOTE: fiscal_periods_fill_shape_check (createdBy/fillReason shape) is hand-added in
    // migration 0160, along with fiscal_periods_fill_immutable and fiscal_periods_order_guard
    // (R1.2 — an open period may never start before a closed/locked one; see migration 0160).
    // NOTE: fiscal_periods_gap_guard_trg (DEF-424 — no close or lock may leave a missing month
    // behind it) is hand-added in migration 0174; see the migration for the body.
  ],
);
