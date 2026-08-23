/**
 * accounts — the chart of accounts. docs/tasks/101-core-schema.md Contract §5.
 *
 * `normal_balance` is a DECLARED column, never inferred from a code prefix — that was a
 * defect in the old system (bible §13 row 39; v1 inferred it from an `accountId` string
 * prefix). `is_system` rows may be deactivated but never deleted, and their `code` is
 * stable forever (bible §4.4) — nothing here deletes a row; that discipline lives in the
 * application layer that seeds and edits this table (T-102).
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', {
      enum: ['asset', 'liability', 'equity', 'income', 'expense'],
    }).notNull(),
    normalBalance: text('normal_balance', { enum: ['debit', 'credit'] }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id, {
      onDelete: 'restrict',
    }),
    isPostable: boolean('is_postable').notNull().default(true),
    isSystem: boolean('is_system').notNull().default(false),
    legacyCode: text('legacy_code'),
    status: text('status', { enum: ['active', 'reserved', 'archived'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('accounts_org_id_code_unique').on(t.orgId, t.code),
    uniqueIndex('accounts_org_id_legacy_code_unique')
      .on(t.orgId, t.legacyCode)
      .where(sql`${t.legacyCode} is not null`),
    check(
      'accounts_type_check',
      sql`${t.type} in ('asset', 'liability', 'equity', 'income', 'expense')`,
    ),
    check('accounts_normal_balance_check', sql`${t.normalBalance} in ('debit', 'credit')`),
    check('accounts_status_check', sql`${t.status} in ('active', 'reserved', 'archived')`),
    // NOTE: "a postable account may not have children" is cross-row — it depends on the
    // parent's state, not just the row being written — so it cannot be a plain CHECK. It
    // is hand-added in the generated migration as a BEFORE INSERT OR UPDATE trigger
    // (Contract §5 / §8; see the task report for why this goes beyond the three
    // hand-augmentations the spec's Method section names explicitly).
  ],
);
