/**
 * The only place SQL is written for recurring-expense templates. T-216.
 *
 * ⛔ A template is configuration, not a document: nothing here posts, and there is no
 * `journal_entry_id` for anyone to reach for.
 */
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { recordGone } from './record-gone';
import type { Tx } from '../client';
import {
  recurringExpenses,
  type RecurringInterval,
  type RecurringStatus,
} from '../../schema/recurring-expenses';
import { recurringExpenseDrafts } from '../../schema/recurring-expense-drafts';
import type { Money } from '@shareat/core/money';
import type { SafeInsert, SafeUpdate } from './numeric-input';

export interface RecurringExpenseRow {
  id: string;
  orgId: string;
  storeId: string;
  name: string;
  categoryId: string;
  /** ⚠️ Nullable: templates predate the column. The JOB refuses one that is null and says so. */
  supplierId: string | null;
  defaultAmount: string;
  defaultMoneyAccountId: string | null;
  tillIsDeliberate: boolean;
  interval: RecurringInterval;
  anchorDay: number;
  nextDueDate: string;
  status: RecurringStatus;
  lastDraftedExpenseId: string | null;
  lastDraftedAt: Date | null;
  createdBy: string | null;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<RecurringExpenseRow | undefined> {
  const [row] = await tx
    .select()
    .from(recurringExpenses)
    .where(and(eq(recurringExpenses.id, id), eq(recurringExpenses.orgId, orgId)))
    .limit(1);
  return row as RecurringExpenseRow | undefined;
}

/** Every template in the org, due-soonest first — the screen's list. */
export async function listForOrg(tx: Tx, orgId: string, opts: { storeId?: string } = {}): Promise<RecurringExpenseRow[]> {
  const rows = await tx
    .select()
    .from(recurringExpenses)
    .where(
      opts.storeId
        ? and(eq(recurringExpenses.orgId, orgId), eq(recurringExpenses.storeId, opts.storeId))
        : eq(recurringExpenses.orgId, orgId),
    )
    .orderBy(asc(recurringExpenses.nextDueDate), asc(recurringExpenses.name));
  return rows as RecurringExpenseRow[];
}

/**
 * Active templates whose cursor has come up.
 *
 * ⚠️ `<=`, not `=`. A template three months overdue must still be found — a job that only matched
 * "due today" would skip every template on any day its run was missed, silently and for ever.
 */
export async function listDue(tx: Tx, orgId: string, onOrBefore: string): Promise<RecurringExpenseRow[]> {
  const rows = await tx
    .select()
    .from(recurringExpenses)
    .where(
      and(
        eq(recurringExpenses.orgId, orgId),
        eq(recurringExpenses.status, 'active'),
        lte(recurringExpenses.nextDueDate, onOrBefore),
      ),
    )
    .orderBy(asc(recurringExpenses.nextDueDate));
  return rows as RecurringExpenseRow[];
}

/** T-371 C2 — `defaultAmount` is a `Money` brand minted by `decimal()`/`money()`, never a raw string. */
export type InsertTemplateInput = Pick<
  SafeInsert<typeof recurringExpenses>,
  'orgId' | 'storeId' | 'name' | 'categoryId' | 'interval' | 'anchorDay' | 'nextDueDate'
> & {
  supplierId: string | null;
  defaultAmount: Money;
  defaultMoneyAccountId: string | null;
  tillIsDeliberate: boolean;
  createdBy: string;
};

export async function insertTemplate(tx: Tx, input: InsertTemplateInput): Promise<{ id: string }> {
  const [row] = await tx.insert(recurringExpenses).values(input).returning({ id: recurringExpenses.id });
  return row!;
}

export async function updateTemplate(
  tx: Tx,
  orgId: string,
  id: string,
  values: Pick<
    SafeUpdate<typeof recurringExpenses>,
    | 'name'
    | 'categoryId'
    | 'supplierId'
    | 'defaultMoneyAccountId'
    | 'tillIsDeliberate'
    | 'interval'
    | 'anchorDay'
    | 'nextDueDate'
    | 'status'
  > & { defaultAmount?: Money },
): Promise<void> {
  await tx
    .update(recurringExpenses)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(recurringExpenses.id, id), eq(recurringExpenses.orgId, orgId)));
}

/**
 * ⚠️ Deleting is allowed only while a template has NEVER drafted anything — the service enforces
 * that, not this function. Once it has produced an expense it is history, and history is paused,
 * never removed.
 */
export async function deleteTemplate(tx: Tx, orgId: string, id: string): Promise<void> {
  // T-418: the "never produced" guard rides on the DELETE (the job can stamp it after the domain looked). Zero rows throws.
  const deleted = await tx
    .delete(recurringExpenses)
    .where(and(eq(recurringExpenses.id, id), eq(recurringExpenses.orgId, orgId), isNull(recurringExpenses.lastDraftedExpenseId)))
    .returning({ id: recurringExpenses.id });
  if (deleted.length === 0) {
    throw recordGone(`deleteTemplate: template ${id} does not exist in org ${orgId} or has already produced an expense`, 'recurring template');
  }
}

/**
 * Record that a template produced a draft and move its cursor.
 *
 * ⛔ ONE statement, so the cursor cannot advance without the provenance or the other way round. The
 * job must call this in the SAME transaction as the draft it created: a draft whose cursor did not
 * advance drafts again tomorrow, and every tomorrow after that.
 */
export async function stampDrafted(
  tx: Tx,
  orgId: string,
  id: string,
  input: { expenseId: string; nextDueDate: string; at: Date },
): Promise<void> {
  await tx
    .update(recurringExpenses)
    .set({
      lastDraftedExpenseId: input.expenseId,
      lastDraftedAt: input.at,
      nextDueDate: input.nextDueDate,
      updatedAt: sql`now()`,
    })
    .where(and(eq(recurringExpenses.id, id), eq(recurringExpenses.orgId, orgId)));
}

// =====================================================================================
// T-216 Part 2 — `recurring_expense_drafts`, the job's idempotency key.

/**
 * Claim (template, due date) before drafting anything.
 *
 * ⭐ **This is the invariant, not the cursor.** `next_due_date` stops the ordinary second run of
 * the day, because the first run advanced it. It cannot stop two job processes reading the same
 * cursor before either writes, or a cursor moved backwards by an edit. The UNIQUE index can, and
 * `ON CONFLICT DO NOTHING` turns the race into a no-op rather than an error.
 *
 * ⛔ **Returns `undefined` when the row already existed** — that is the "somebody already drafted
 * this date" signal and the caller must skip the template, not throw. Same shape as
 * `budgetsRepo.insertReissued`.
 *
 * ⚠️ Call it FIRST, before the invoice and the expense. Claiming after creating them would leave
 * the documents behind when the claim loses the race.
 */
export async function claimDraft(
  tx: Tx,
  input: { orgId: string; recurringExpenseId: string; dueDate: string },
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .insert(recurringExpenseDrafts)
    .values(input)
    .onConflictDoNothing({
      target: [recurringExpenseDrafts.recurringExpenseId, recurringExpenseDrafts.dueDate],
    })
    .returning({ id: recurringExpenseDrafts.id });
  return row;
}

/** Fill in what the claim produced, in the same transaction that created them. */
export async function attachDraftDocuments(
  tx: Tx,
  orgId: string,
  draftId: string,
  input: { expenseId: string; supplierInvoiceId: string },
): Promise<void> {
  await tx
    .update(recurringExpenseDrafts)
    .set({ expenseId: input.expenseId, supplierInvoiceId: input.supplierInvoiceId })
    .where(and(eq(recurringExpenseDrafts.id, draftId), eq(recurringExpenseDrafts.orgId, orgId)));
}
