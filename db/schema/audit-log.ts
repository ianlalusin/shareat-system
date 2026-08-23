/**
 * audit_log — docs/tasks/101-core-schema.md Contract §7.
 *
 * Append-only (bible §4.2 rule 9): no `updated_at`, rows are never edited. `source`
 * names the four front-ends plus the system callers — the first place this schema admits
 * it serves more than the ERP.
 */
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { persons } from './persons';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
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
    check(
      'audit_log_source_check',
      sql`${t.source} in ('web', 'pos', 'customer', 'website', 'apk', 'kiosk', 'cron', 'ingestor', 'etl')`,
    ),
  ],
);
