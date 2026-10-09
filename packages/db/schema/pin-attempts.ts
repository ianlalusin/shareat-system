/**
 * pin_attempt_throttle — the per-store PIN brute-force counter.
 * docs/tasks/303-pin-attempt-lockout.md §THE DESIGN, ported from v1
 * (`ERP-rebuild/src/lib/actions/attendance-clock.actions.ts:440-512`).
 *
 * One row per store. Written AFTER layer 1 resolves the terminal (T-304), so `orgId` and
 * `storeId` are both known — this is what makes it an ordinary `org_column` table rather than
 * the `system_only` fifth pre-auth door T-303 §Q2 rejected.
 *
 * ⛔ `lockedUntil` in the future means further misses must NOT extend or reset it — v1's own
 * concurrency lock-clobber bug, ported forward as the invariant rather than rediscovered.
 */
import { sql } from 'drizzle-orm';
import { integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const pinAttemptThrottle = pgTable(
  'pin_attempt_throttle',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    failCount: integer('fail_count').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // T-395 tier 2: set when the daily miss budget trips; only a reopen clears it.
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: uuid('reopened_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // One counter per store — v1's key. A store belongs to one org, so this alone also fixes
    // the org (checked by the `orgId = (select org_id from stores ...)` shape at the write site,
    // never trusted from the caller — invariant 8, "never a client-supplied value").
    uniqueIndex('pin_attempt_throttle_store_id_unique').on(t.storeId),
  ],
);
