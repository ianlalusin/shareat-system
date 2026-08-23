/**
 * organizations — the root of every scoped table in Shareat System.
 *
 * docs/tasks/101-core-schema.md Contract §2. One row today. SEBN is the reserved second
 * entity (bible §4.1 / task spec "Why this spec differs") — nothing here or downstream may
 * assume there is exactly one organization.
 */
import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
  // PostgreSQL 18 native uuidv7() — no extension needed (bible §13 row 70).
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});
