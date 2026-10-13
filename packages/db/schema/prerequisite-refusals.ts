/**
 * prerequisite_refusals — T-245. docs/tasks/245-prerequisite-refusal-counter.md §2.
 *
 * ⛔ **An OBSERVATION log, not a stored counter** — same shape as `finding_occurrences`
 * (`./findings.ts`, T-214, bible row 177), the sanctioned escape hatch from §4.2 rule 7 / row 173.
 * Every row is immutable once written (append-only, bible §4.2 rule 9): no `updated_at`, no
 * unique constraint — hitting the same wall twice is two data points, not one row to dedupe. "How
 * many times has X happened" is always `count(*)`/`max(occurred_at)` computed at read time, never
 * a value carried forward.
 *
 * ⚠️ **Message text is deliberately NOT stored.** The rendered sentence belongs to the domain
 * layer and is free to be reworded without a migration; `reason_code` is the stable identity a
 * report groups on, chosen once at the throw site — `finding_occurrences.finding_key`'s exact role.
 *
 * ⛔ **Written on an INDEPENDENT transaction, never the caller's `tx`** — see
 * `packages/domain/src/attendance/credentials.ts`'s `recordPrerequisiteRefusal`. A domain function
 * calls this repo's `record()` immediately before throwing the refusal it just detected; the
 * transaction that throw aborts must not be the one this INSERT lives on, or the row rolls back
 * with it and the counter counts nothing, forever, silently.
 */
import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const prerequisiteRefusals = pgTable(
  'prerequisite_refusals',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Null for a refusal with no store context yet (e.g. no store scope at all). */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /** Stable machine key, chosen at the throw site — never the rendered message. */
    reasonCode: text('reason_code').notNull(),
    /** Denormalised coarse grouping so the read-back page doesn't need to parse reasonCode. */
    domain: text('domain').notNull(),
    /** Nullable — who hit the wall is a bonus, not the point; the count is the point. */
    actorPersonId: uuid('actor_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('prerequisite_refusals_org_occurred_idx').on(t.orgId, t.occurredAt),
    index('prerequisite_refusals_org_reason_idx').on(t.orgId, t.reasonCode),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.actorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'prerequisite_refusals_actor_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'prerequisite_refusals_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
