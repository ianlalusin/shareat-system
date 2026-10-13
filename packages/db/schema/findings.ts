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
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid, foreignKey } from 'drizzle-orm/pg-core';
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
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.acknowledgedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'finding_acknowledgements_acknowledged_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'finding_acknowledgements_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * ⭐ **T-214 — the clock a finding does not carry.**
 *
 * ## ⛔ This is an OBSERVATION log, not finding state — and the difference is the whole design
 *
 * Read this file's header first. It says there is deliberately no `findings` table, because v1
 * stored a finding's `state` and resolving one suppressed tomorrow's recompute *while the condition
 * still held*. **That rule is intact.** This table records something categorically different: *"the
 * detector reported this key on this day."*
 *
 * ⛔ **Nothing in the detection path reads this table.** `listFindings` does not join it, no
 * detector consults it, and deleting every row here changes not one finding in the feed — which is
 * asserted by a test rather than promised by this comment. It is evidence, never input.
 *
 * ## Why it has to exist at all
 *
 * A `DetectedFinding` is a pure function of current state: it carries no timestamp and cannot, and
 * almost no detector can be re-asked *"as of"* a past date because they read live balances rather
 * than an as-of ledger. So **when a finding first appeared is not recoverable from anywhere** — and
 * both surviving components of the T-214 scorecard need it. Without this table there is no
 * speed-to-clear and no denominator.
 *
 * ## ⚠️ There is no backfill, and there cannot be
 *
 * The history does not exist to recover. Findings that have held for weeks all get today's
 * `opened_on` on the first run, so the screen must state the date this record began. A number that
 * silently understates how long a problem has been ignored is worse than no number.
 */
export const findingOccurrences = pgTable(
  'finding_occurrences',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Null for an ORG-wide finding — a trial balance does not belong to one store. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    findingKey: text('finding_key').notNull(),
    /** Denormalised so the scorecard groups by kind without re-running a detector. */
    kind: text('kind').notNull(),
    /** ⭐ `firstSeen`. The whole reason the table exists. Manila date. */
    openedOn: date('opened_on').notNull(),
    /** Advanced by every run that still sees the key. */
    lastSeenOn: date('last_seen_on').notNull(),
    /**
     * ⛔ Set by the first run that asked this key's question and did NOT get it back.
     *
     * ⚠️ "asked this key's question" is load-bearing — see `recordFindingObservations`. Periodic
     * keys embed their period (`depreciationNotBooked:2026-08`), so a run asking about September
     * must NOT close August: the month stopped being asked about, nobody fixed anything.
     */
    closedOn: date('closed_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('finding_occurrences_window_check', sql`${t.lastSeenOn} >= ${t.openedOn}`),
    check(
      'finding_occurrences_closed_after_open_check',
      sql`${t.closedOn} is null or ${t.closedOn} >= ${t.openedOn}`,
    ),
    /**
     * ⭐ **At most one OPEN occurrence per key**, which is what makes the daily job idempotent and
     * safely re-runnable. A closed one may repeat freely: a finding that comes back is a regression,
     * a new occurrence, not the old one continuing.
     *
     * ⚠️ `coalesce` on `store_id` because NULL never equals NULL in a unique index, so org-wide
     * findings would otherwise be exempt from the constraint that matters most to them.
     */
    uniqueIndex('finding_occurrences_one_open_idx')
      .on(t.orgId, sql`coalesce(${t.storeId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.findingKey)
      .where(sql`${t.closedOn} is null`),
    index('finding_occurrences_period_idx').on(t.orgId, t.openedOn),
    index('finding_occurrences_store_idx').on(t.orgId, t.storeId, t.openedOn),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'finding_occurrences_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * ⭐ **T-214 — who actually looked.**
 *
 * v1 logs whether the report was opened at all (`insightViewLog`), and T-135 kept that on purpose:
 * *"a finding nobody is accountable for is a finding nobody clears."* This is the v2 equivalent,
 * pointed at `/findings` because v2 has no AI briefing to log opens against.
 *
 * ⚠️ **Recorded, deliberately NOT scored.** Scoring page-opens pays people to open pages. It is
 * shown as *"last looked at by X, N days ago"* — and a null there, meaning nobody has ever opened
 * it, is the most useful thing on the row.
 *
 * ⛔ One row per person per Manila day, so a refresh is not a second view.
 */
export const findingViews = pgTable(
  'finding_views',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    viewedOn: date('viewed_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('finding_views_person_day_idx').on(t.orgId, t.personId, t.viewedOn),
    index('finding_views_org_day_idx').on(t.orgId, t.viewedOn),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'finding_views_person_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
