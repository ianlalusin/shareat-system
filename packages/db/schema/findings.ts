/**
 * Integrity findings — the books watchdog. T-135.
 *
 * ⭐ **The important thing about this file is the table that is NOT in it.** There is no `findings`
 * table, and that is the design.
 *
 * v1 stores a finding's `state` per key, which is its one real defect: a manager resolves *"expense
 * missing category"*, tomorrow's recompute produces the same key, reads the stored `resolved`, and
 * suppresses it — while the expense still has no category. **Resolution suppresses the SYMPTOM
 * without requiring the CAUSE to be fixed**, and the longer it stays resolved the more confident
 * the suppression looks.
 *
 * | Condition holds? | Acknowledged? | Shows as |
 * |---|---|---|
 * | Yes | No | **Open** |
 * | Yes | Yes | **Acknowledged** — off the attention list, still counted, and the ack ages |
 * | No | — | **Gone**, and the acknowledgement becomes history |
 *
 * ⛔ **A finding cannot be "resolved" while it is still true.** The only way to clear it is to fix
 * the thing. Acknowledgement says *"I have seen this and accept it for now"* — a real statement,
 * and a different one from *"this is fixed."*
 *
 * ⚠️ This is also what makes a manager scorecard safe to keep: a score people are measured on is a
 * score people manage, and the derived model makes the obvious gaming impossible rather than
 * merely discouraged.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const findingAcknowledgements = pgTable(
  'finding_acknowledgements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Null for an ORG-wide finding — a trial balance does not belong to one store. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /** The finding's stable identity, derived by the detector and never chosen by a person. */
    findingKey: text('finding_key').notNull(),
    kind: text('kind').notNull(),
    note: text('note'),
    acknowledgedBy: uuid('acknowledged_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * ⭐ An accepted risk should be RE-accepted, not forgotten. After this the finding reopens on
     * its own, with no action from anybody.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('finding_acknowledgements_window_check', sql`${t.expiresAt} > ${t.acknowledgedAt}`),
    /**
     * ⚠️ NOT unique. Expired acknowledgements are kept, so a key legitimately has many rows over
     * time and the latest live one wins. ⛔ A partial unique index on `expires_at > now()` is not
     * possible — an index predicate must be IMMUTABLE and `now()` is only STABLE — and the query
     * form is the honest one anyway: being acknowledged is a fact about a moment, not about a row.
     */
    index('finding_acknowledgements_key_idx').on(t.orgId, t.findingKey, t.acknowledgedAt),
    index('finding_acknowledgements_org_kind_idx').on(t.orgId, t.kind),
  ],
);
