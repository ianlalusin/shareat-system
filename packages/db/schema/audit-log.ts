/**
 * audit_log — docs/tasks/101-core-schema.md Contract §7.
 *
 * Append-only (bible §4.2 rule 9): no `updated_at`, rows are never edited. `source`
 * names the four front-ends plus the system callers — the first place this schema admits
 * it serves more than the ERP.
 *
 * T-350 S3 / DEF-169 — org-scoped since migration 0167, which is this table's FIRST writer
 * (`packages/domain/src/channel-settlements/index.ts`'s `setChannelPayoutDestination`, via
 * `auditLogRepo.append`). Before 0167 it had an `org_id`-less shape and was `system_only` in
 * `rls/registry.ts` — RLS enabled with no staff policy at all, so no tenant could ever read it.
 */
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // NOTE: policies (SELECT + INSERT, the latter DEF-183-shaped on actor_person_id) and the
    // append-only trigger are hand-added in migration 0167 (ADR-012 §5 item 3) — RLS ENABLE/FORCE
    // were already on since 0011.
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // Nullable ONLY so a system/cron action can be recorded. A user-initiated action
    // without an actor is a defect, not a valid state — enforced at the service layer,
    // not here (this table has no way to distinguish "system" from "forgot to pass one").
    actorPersonId: uuid('actor_person_id').references(() => persons.id, {
      onDelete: 'restrict',
    }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    source: text('source', {
      enum: [
        'web',
        'pos',
        'customer',
        'website',
        'apk',
        'kiosk',
        'cron',
        'ingestor',
        'etl',
      ],
    }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_entity_id_idx').on(t.entity, t.entityId),
    index('audit_log_occurred_at_idx').on(t.occurredAt),
    index('audit_log_org_occurred_at_idx').on(t.orgId, t.occurredAt),
    check(
      'audit_log_source_check',
      sql`${t.source} in ('web', 'pos', 'customer', 'website', 'apk', 'kiosk', 'cron', 'ingestor', 'etl')`,
    ),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.actorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'audit_log_actor_person_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
