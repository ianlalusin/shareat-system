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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('fiscal_periods_status_check', sql`${t.status} in ('open', 'closed', 'locked')`),
    check('fiscal_periods_ends_on_check', sql`${t.endsOn} >= ${t.startsOn}`),
    // NOTE: the no-overlap rule — EXCLUDE USING gist (org_id WITH =,
    // daterange(starts_on, ends_on, '[]') WITH &&) — is hand-added in the generated
    // migration; it requires btree_gist, also hand-added there (Contract §8).
  ],
);
