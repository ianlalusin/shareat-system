/**
 * stores — the single source of branch identity for all four front-ends (ERP, POS,
 * CUSTOMER, Website). docs/tasks/101-core-schema.md Contract §3.
 *
 * The Website alone has three independently-synced branch sources today (DEF-010); this
 * table retires that duplication for everything built on top of it.
 */
import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Per-store and explicit. Business-day boundaries derive from THIS column
    // (src/lib/datetime.ts) — never a global constant.
    timezone: text('timezone').notNull().default('Asia/Manila'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('stores_org_id_code_unique').on(t.orgId, t.code)],
);
