/**
 * What a recurring-expense template has already produced, one row per (template, due date).
 * T-216 Part 2, `docs/tasks/216-recurring-expense-automation.md` §J5.2.
 *
 * ## ⭐ This table IS the idempotency rule
 *
 * `recurring_expenses.next_due_date` is the job's cursor, and on its own it already stops the
 * ordinary second run of the day: the first run advanced it, so the second finds nothing due. What
 * a cursor cannot stop is everything that does not go through it —
 *
 * - two job processes racing (both read the same cursor before either writes),
 * - a cursor moved **backwards** by a template edit or a hand correction,
 * - a catch-up run and a manual run overlapping.
 *
 * ⛔ So the guarantee lives in `recurring_expense_drafts_once_idx`, a UNIQUE index, and the writer
 * is `ON CONFLICT DO NOTHING`. A zero-row return means somebody already drafted that date and the
 * template is skipped without an error — the same "idempotent as a database FACT, not as a promise"
 * idiom as `budgetsRepo.insertReissued` (T-215).
 *
 * ## ⛔ Two keys that were proposed and are WRONG, recorded so they are not re-proposed
 *
 * 1. **The invoice number.** `RECUR-<template>-<date>` looks unique, and
 *    `supplier_invoices.invoice_no` says in its own schema that it is *"read by the warn-only
 *    duplicate check, **never a unique constraint**"*. There is no unique index on it, so duplicates
 *    are created silently — the key would look like it was working for exactly as long as nothing
 *    went wrong.
 * 2. **The period (`YYYY-MM`).** A **weekly** template has four or five due dates inside one month.
 *    A per-period key would draft a weekly bill once a month and look correct doing it.
 *
 * The due DATE is the only grain that matches what "already drafted" actually means.
 *
 * ## ⚠️ Cutover class `purge`, and both document FKs are SET NULL
 *
 * This table is provenance *about expenses*; when they go on 1 January it has nothing left to
 * describe, so it goes with them. The SET NULLs are 0132's lesson applied a second time: it is
 * reached from a KEEP table (`recurring_expenses`) but points at PURGE ones, and a `restrict` would
 * let a KEEP-side row BLOCK the purge of a PURGE-side one.
 */
import { sql } from 'drizzle-orm';
import { date, foreignKey, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { expenses } from './expenses';
import { organizations } from './organizations';
import { recurringExpenses } from './recurring-expenses';
import { supplierInvoices } from './suppliers';

export const recurringExpenseDrafts = pgTable(
  'recurring_expense_drafts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⛔ CASCADE: this row is provenance about ONE template and means nothing without it. */
    recurringExpenseId: uuid('recurring_expense_id')
      .notNull()
      .references(() => recurringExpenses.id, { onDelete: 'cascade' }),
    /**
     * The date this draft was created **for** — the template's cursor at the moment it drafted,
     * never "today". ⚠️ A catch-up run drafts for a date in the past, and this is that date; using
     * the run date would make a caught-up template look as though it had drafted twice for today.
     */
    dueDate: date('due_date').notNull(),
    expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'set null' }),
    supplierInvoiceId: uuid('supplier_invoice_id').references(() => supplierInvoices.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** ⭐ The invariant itself. Read this file's header before changing its columns. */
    uniqueIndex('recurring_expense_drafts_once_idx').on(t.recurringExpenseId, t.dueDate),
    index('recurring_expense_drafts_expense_idx').on(t.expenseId),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `expense_id` FK (RLS checks only this row's org_id); references `expenses_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.expenseId],
      foreignColumns: [expenses.orgId, expenses.id],
      name: 'recurring_expense_drafts_expense_id_same_org_fk',
    }).onDelete('set null'), // the SQL is ON DELETE SET NULL ("expense_id") (column-list form: org_id is NOT NULL)
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `recurring_expense_id` FK (RLS checks only this row's org_id); references `recurring_expenses_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.recurringExpenseId],
      foreignColumns: [recurringExpenses.orgId, recurringExpenses.id],
      name: 'recurring_expense_drafts_recurring_expense_id_same_org_fk',
    }).onDelete('cascade'),
    // T-398 S3 / DEF-491, migration 0212 - same-org twin of the single-column `supplier_invoice_id` FK (RLS checks only this row's org_id); references `supplier_invoices_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.supplierInvoiceId],
      foreignColumns: [supplierInvoices.orgId, supplierInvoices.id],
      name: 'recurring_expense_drafts_supplier_invoice_id_same_org_fk',
    }).onDelete('set null'), // the SQL is ON DELETE SET NULL ("supplier_invoice_id") (column-list form: org_id is NOT NULL)
  ],
);
