/**
 * sign_in_attempts - the PIN sign-in attempt log. docs/tasks/395-pin-sign-in-throttle.md.
 *
 * One row per wrong PIN charged ('miss'), one per tier-1 pause ('lockout'), one per tier-2 stop
 * ('stopped'). Successes and refusals are not logged (R8). No column can hold a PIN, a hash or a
 * prefix, and none records whether the miss was "unknown" or "real person, wrong store" (R9, I6).
 *
 * `deviceId` is the terminal's own `persons` row; null only for a caller with no terminal.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const signInAttempts = pgTable(
  'sign_in_attempts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // T-412 (migration 0199): NULL = the organisation's approval-PIN bucket.
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    // T-416 (migration 0200): the signed-in person whose approval-PIN bucket this row belongs to. At most one of store_id / actor_person_id.
    actorPersonId: uuid('actor_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    // T-464 (migration 0214): the Employee ID bucket (normalised `SE-007`) a paired POS tablet's miss was charged to; NULL for every other bucket.
    staffCode: text('staff_code'),
    deviceId: uuid('device_id').references(() => persons.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sign_in_attempts_store_time_idx').on(t.storeId, t.occurredAt),
    index('sign_in_attempts_org_time_idx').on(t.orgId, t.occurredAt),
    index('sign_in_attempts_actor_time_idx').on(t.actorPersonId, t.occurredAt),
    // NOTE: the partial index (store_id, staff_code, occurred_at) where staff_code is not null is hand-added in migration 0214.
    check('sign_in_attempts_staff_code_needs_store_check', sql`${t.staffCode} is null or ${t.storeId} is not null`),
    check('sign_in_attempts_one_key_check', sql`not (${t.storeId} is not null and ${t.actorPersonId} is not null)`),
    foreignKey({
      columns: [t.orgId, t.actorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'sign_in_attempts_actor_person_id_same_org_fk',
    }).onDelete('restrict'),
    check('sign_in_attempts_kind_check', sql`${t.kind} in ('miss', 'lockout', 'stopped')`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.deviceId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'sign_in_attempts_device_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'sign_in_attempts_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
// NOTE: ENABLE + FORCE ROW LEVEL SECURITY, the org-isolation policy and GRANT UPDATE, DELETE are
// hand-added in migration 0190.
