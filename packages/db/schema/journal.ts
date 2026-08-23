/**
 * journal_entries + journal_lines — the nominal ledger. docs/tasks/103-journal-tables.md.
 *
 * This is the schema bible §16.0 says the whole project exists to build: a real
 * header-plus-lines double-entry ledger, replacing the legacy "one leg per document,
 * single-leg trivially balanced" model. After this migration, a single-leg (or zero-leg,
 * or unbalanced) entry cannot be committed to this database, by any path — see the task
 * report for the full list of hand-added triggers that make that true and the two spec
 * ambiguities found while making it precise (the entry-level `store_id` bible §16.3 shows
 * but Contract §1 omits, and how far "no posting into a closed period" reaches on UPDATE).
 *
 * What Drizzle CANNOT express, and is hand-added in the generated migration (Contract §4,
 * §5, §6, §7 — the task's "the deferrable constraint trigger, the account-eligibility
 * trigger, the period-status trigger, and the posted-immutability trigger", each
 * implemented as a pair of triggers since the Contract's own rule text spans BOTH tables
 * — "insert or update of an entry OR LINE"):
 *   1. Balance (Σdebit=Σcredit) and minimum-two-lines — inherently a multi-row, multi-table
 *      rule that is only correct as of COMMIT. PostgreSQL forbids DEFERRABLE CHECK
 *      constraints ("CHECK constraints cannot be marked DEFERRABLE") — only FK / UNIQUE /
 *      PK / EXCLUDE / CONSTRAINT TRIGGER can be deferred. Implemented as a CONSTRAINT
 *      TRIGGER ... DEFERRABLE INITIALLY DEFERRED on BOTH journal_entries (AAFTER INSERT —
 *      closes a gap: an entry inserted with literally zero lines, ever, would otherwise
 *      never be checked, since a trigger anchored only to journal_lines events never fires
 *      for it) and journal_lines (AFTER INSERT OR UPDATE OR DELETE).
 *   2. Account eligibility (is_postable, status='active') — cross-table, BEFORE
 *      INSERT OR UPDATE trigger on journal_lines.
 *   3. Period-open — cross-table, BEFORE INSERT OR UPDATE triggers on BOTH journal_entries
 *      and journal_lines (a line added to an already-existing draft entry after its period
 *      closed must also be rejected, not just the entry's own initial insert).
 *   4. Posted immutability — BEFORE UPDATE OR DELETE on both journal_lines and
 *      journal_entries, matching the Contract's literal "trigger blocking UPDATE/DELETE"
 *      scope (not INSERT — see the migration file and the task report for why blocking
 *      INSERT too breaks constructing an already-posted entry's lines in the same
 *      transaction that inserts the entry as status='posted', and the residual gap that
 *      leaves for T-105 to close at the service layer).
 *
 * See the migration file for the full trigger bodies and the task report for the reasoning
 * behind each design choice above that the Contract text left ambiguous.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { fiscalPeriods } from './fiscal-periods';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // The business date this entry belongs to. NOT the same as created_at (system time of
    // the write) — an entry can be dated in the past (a correction) or, within an open
    // period, ahead of today.
    entryDate: date('entry_date').notNull(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
    memo: text('memo'),
    // NOT NULL per invariant 4 (bible §16.1) — every posting traces to a source document.
    // There are no orphan entries. A system-generated entry still names its source;
    // 'system' alone is not an acceptable source_type (Contract §1) — that discipline is
    // enforced at the service layer (T-105), not here; this table can only enforce
    // presence, not vocabulary.
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    status: text('status', { enum: ['draft', 'posted', 'reversed'] })
      .notNull()
      .default('draft'),
    reversalOfEntryId: uuid('reversal_of_entry_id').references(
      (): AnyPgColumn => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // Partial unique index — "UNIQUE per org where the key is not null" (Contract §1).
    // Same pattern as accounts.ts's legacy_code: Drizzle's uniqueIndex().where() expresses
    // a partial index directly, no hand-augmentation needed for this one.
    uniqueIndex('journal_entries_org_id_idempotency_key_unique')
      .on(t.orgId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('journal_entries_org_id_entry_date_idx').on(t.orgId, t.entryDate),
    index('journal_entries_source_type_source_id_idx').on(t.sourceType, t.sourceId),
    index('journal_entries_period_id_idx').on(t.periodId),
    check('journal_entries_status_check', sql`${t.status} in ('draft', 'posted', 'reversed')`),
    // NOTE: balance / minimum-two-lines / account-eligibility / period-open /
    // posted-immutability are all hand-added in the generated migration as triggers — see
    // this file's top comment and the migration for why each cannot be a plain CHECK.
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    // Nullable — not every line is store-scoped (Contract §2). Deliberately NOT on
    // journal_entries (bible §16.3's illustrative sketch shows store_id on the entry too;
    // this Contract's actual column list does not — see the task report for why the line
    // level is followed here).
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    // The second reporting dimension (bible §13 row 44 / Contract §2 note). Free text, no
    // FK — channels are not a table in this schema (bible §16.4: no dimension framework).
    channelId: text('channel_id'),
    debit: numeric('debit', { precision: 14, scale: 2 }).notNull().default('0'),
    credit: numeric('credit', { precision: 14, scale: 2 }).notNull().default('0'),
    lineMemo: text('line_memo'),
  },
  (t) => [
    uniqueIndex('journal_lines_entry_id_line_no_unique').on(t.entryId, t.lineNo),
    index('journal_lines_account_id_idx').on(t.accountId),
    index('journal_lines_entry_id_idx').on(t.entryId),
    index('journal_lines_store_id_idx').on(t.storeId),
    index('journal_lines_channel_id_idx').on(t.channelId),
    // Immediate, per-row CHECKs (Contract §2) — these CAN be plain CHECK constraints
    // because they only ever look at the row being written, never another row.
    check('journal_lines_amounts_nonnegative_check', sql`${t.debit} >= 0 AND ${t.credit} >= 0`),
    check('journal_lines_exactly_one_side_check', sql`(${t.debit} = 0) <> (${t.credit} = 0)`),
  ],
);
