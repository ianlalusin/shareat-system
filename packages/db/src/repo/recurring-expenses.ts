/**
 * The only place SQL is written for recurring-expense templates. T-216.
 *
 * ⛔ A template is configuration, not a document: nothing here posts, and there is no
 * `journal_entry_id` for anyone to reach for.
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  recurringExpenses,
  type RecurringInterval,
  type RecurringStatus,
} from '../../schema/recurring-expenses';

export interface RecurringExpenseRow {
  id: string;
  orgId: string;
  storeId: string;
  name: string;
  categoryId: string;
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

export async function insertTemplate(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    name: string;
    categoryId: string;
    defaultAmount: string;
    defaultMoneyAccountId: string | null;
    tillIsDeliberate: boolean;
    interval: RecurringInterval;
    anchorDay: number;
    nextDueDate: string;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(recurringExpenses).values(input).returning({ id: recurringExpenses.id });
  return row!;
}

export async function updateTemplate(
  tx: Tx,
  orgId: string,
  id: string,
  values: Partial<{
    name: string;
    categoryId: string;
    defaultAmount: string;
    defaultMoneyAccountId: string | null;
    tillIsDeliberate: boolean;
    interval: RecurringInterval;
    anchorDay: number;
    nextDueDate: string;
    status: RecurringStatus;
  }>,
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
  await tx.delete(recurringExpenses).where(and(eq(recurringExpenses.id, id), eq(recurringExpenses.orgId, orgId)));
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
