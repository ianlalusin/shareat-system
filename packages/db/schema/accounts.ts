/**
 * accounts — the chart of accounts. docs/tasks/101-core-schema.md Contract §5.
 *
 * `normal_balance` is a DECLARED column, never inferred from a code prefix — that was a
 * defect in the old system (bible §13 row 39; v1 inferred it from an `accountId` string
 * prefix). `is_system` rows may be deactivated but never deleted, and their `code` is
 * stable forever (bible §4.4) — nothing here deletes a row; that discipline lives in the
 * application layer that seeds and edits this table (T-102).
 *
 * `requires_party` — docs/tasks/118-subledger-party-on-line.md, closing DEF-037. True on
 * exactly the nine control accounts COA-ALIGNMENT names as "CONTROL + subledger" (2110 AP,
 * 1210 AR, 1220, 1230, 1240, 2130, 1250, 2150, 2400 — see
 * packages/db/seed/chart-of-accounts.ts). Enforced both directions by a hand-added
 * cross-table trigger on journal_lines (migration 0007) — never derivable from `type` or
 * `code`, matching this file's own `normal_balance` precedent of declaring rather than
 * inferring.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
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
    // T-118 — docs/tasks/118-subledger-party-on-line.md. Whether a journal_lines row
    // targeting this account MUST carry a party_type/party_id (control accounts with a
    // subledger) or MUST NOT (every other account). Enforced both directions by a
    // trigger, not by TypeScript — see this file's top comment.
    requiresParty: boolean('requires_party').notNull().default(false),
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
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `parent_id` FK (RLS checks only this row's org_id); references `accounts_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.parentId],
      foreignColumns: [t.orgId, t.id],
      name: 'accounts_parent_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: accounts_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0212 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES accounts (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);
