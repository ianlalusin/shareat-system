/**
 * expenses repo — the ONLY place expense SQL lives (PROJECT_BIBLE.md §4.3,
 * docs/tasks/122-expenses.md Scope). Covers all three tables: expenses, expense_payments,
 * expense_categories.
 *
 * Every function takes a `Tx`, never the base connection (same convention as
 * `repo/journal.ts` and `repo/access.ts`) — so a caller cannot write outside a
 * transaction by accident. Every function that reads or writes an org- or
 * store-scoped row filters on it EXPLICITLY in the WHERE clause (bible §7 rule 4: "Store
 * scoping is enforced in the repository layer... unconditionally") — RLS (migration
 * 0015) is the database's own backstop, never a substitute for this.
 *
 * DELIBERATELY NO ROUTING OR CAPABILITY KNOWLEDGE HERE. This file has no idea what
 * "invariant 7" or "approve_expense" mean — it only shapes rows.
 * `packages/domain/src/expenses/*.ts` composes these primitives with
 * `packages/domain/src/expenses/routing.ts` and `@shareat/auth`'s `authorize()`.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { expenseCategories, expensePayments, expenses } from '../../schema';
import type { Tx } from '../client';

/** DEF-157: the account `expense/routing.ts` credits for a reimbursable payment. Duplicated as
 *  a literal, the same way `arRepo`/`loansRepo` hardcode their own control-account codes rather
 *  than importing across the domain/db boundary. */
const REIMBURSABLE_TO_EMPLOYEES_CODE = '2130';

/**
 * The outstanding balance owed to one employee on `2130` — same shape as `arRepo.positionOf` /
 * `loansRepo.positionOf`: derived from the ledger, never a stored running total. A liability
 * account, so outstanding = credit − debit.
 */
export async function reimbursablePayableOf(
  tx: Tx,
  orgId: string,
  employeeId: string,
): Promise<{ outstanding: string }> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as outstanding
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.code = ${REIMBURSABLE_TO_EMPLOYEES_CODE}
      and jl.party_type = 'employee' and jl.party_id = ${employeeId}
  `)) as unknown as { outstanding: string }[];
  return { outstanding: Number(row?.outstanding ?? 0).toFixed(2) };
}

// -----------------------------------------------------------------------------------------
// expense_categories — read-only from this module's own point of view (seeding is
// packages/db/seed/expense-categories.ts's job, not this repo's).
// -----------------------------------------------------------------------------------------

export interface ExpenseCategoryRow {
  id: string;
  orgId: string;
  group: 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';
  category: string;
  subCategory: string | null;
  accountCode: string | null;
}

export async function getCategoryById(
  tx: Tx,
  orgId: string,
  categoryId: string,
): Promise<ExpenseCategoryRow | undefined> {
  const [row] = await tx
    .select({
      id: expenseCategories.id,
      orgId: expenseCategories.orgId,
      group: expenseCategories.group,
      category: expenseCategories.category,
      subCategory: expenseCategories.subCategory,
      accountCode: expenseCategories.accountCode,
    })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.orgId, orgId)))
    .limit(1);
  return row as ExpenseCategoryRow | undefined;
}

export async function listCategories(tx: Tx, orgId: string): Promise<ExpenseCategoryRow[]> {
  const rows = await tx
    .select({
      id: expenseCategories.id,
      orgId: expenseCategories.orgId,
      group: expenseCategories.group,
      category: expenseCategories.category,
      subCategory: expenseCategories.subCategory,
      accountCode: expenseCategories.accountCode,
    })
    .from(expenseCategories)
    .where(eq(expenseCategories.orgId, orgId))
    .orderBy(asc(expenseCategories.group), asc(expenseCategories.category));
  return rows as ExpenseCategoryRow[];
}

// -----------------------------------------------------------------------------------------
// expenses — the document header.
// -----------------------------------------------------------------------------------------

export type ExpenseStatus = 'draft' | 'posted' | 'voided';

export interface ExpenseRow {
  id: string;
  orgId: string;
  storeId: string;
  businessDate: string;
  totalAmount: string;
  categoryId: string;
  /** ⭐ T-130: NOT NULL now — every expense names a real supplier. */
  supplierId: string;
  /** ⭐ T-130: NOT NULL — the verified invoice this expense was recorded against. */
  supplierInvoiceId: string;
  /** T-127: which owner a PERSONAL expense is a drawing against. Null for every other category. */
  ownerId: string | null;
  particulars: string;
  status: ExpenseStatus;
  journalEntryId: string | null;
  createdBy: string;
  approvedBy: string | null;
  postedAt: Date | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
}

const EXPENSE_COLUMNS = {
  id: expenses.id,
  orgId: expenses.orgId,
  storeId: expenses.storeId,
  businessDate: expenses.businessDate,
  totalAmount: expenses.totalAmount,
  categoryId: expenses.categoryId,
  supplierId: expenses.supplierId,
  supplierInvoiceId: expenses.supplierInvoiceId,
  ownerId: expenses.ownerId,
  particulars: expenses.particulars,
  status: expenses.status,
  journalEntryId: expenses.journalEntryId,
  createdBy: expenses.createdBy,
  approvedBy: expenses.approvedBy,
  postedAt: expenses.postedAt,
  voidedBy: expenses.voidedBy,
  voidedAt: expenses.voidedAt,
  voidReason: expenses.voidReason,
  createdAt: expenses.createdAt,
} as const;

export interface InsertExpenseInput {
  orgId: string;
  storeId: string;
  businessDate: string;
  totalAmount: string;
  categoryId: string;
  supplierId: string;
  supplierInvoiceId: string;
  ownerId?: string | null;
  particulars: string;
  createdBy: string;
}

export async function insertExpense(tx: Tx, input: InsertExpenseInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(expenses)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      businessDate: input.businessDate,
      totalAmount: input.totalAmount,
      categoryId: input.categoryId,
      supplierId: input.supplierId,
      supplierInvoiceId: input.supplierInvoiceId,
      ownerId: input.ownerId ?? null,
      particulars: input.particulars,
      createdBy: input.createdBy,
    })
    .returning({ id: expenses.id });
  if (!row) throw new Error('insertExpense: insert returned no row');
  return row;
}

/** By id, scoped to the org — a caller passing the wrong org's id gets undefined, never
 *  another org's row (belt, alongside RLS's suspenders). */
export async function getExpenseById(tx: Tx, orgId: string, id: string): Promise<ExpenseRow | undefined> {
  const [row] = await tx
    .select(EXPENSE_COLUMNS)
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.orgId, orgId)))
    .limit(1);
  return row as ExpenseRow | undefined;
}

export interface ListExpensesInput {
  orgId: string;
  storeId?: string;
  status?: ExpenseStatus;
  limit?: number;
}

export async function listExpenses(tx: Tx, input: ListExpensesInput): Promise<ExpenseRow[]> {
  const conditions = [eq(expenses.orgId, input.orgId)];
  if (input.storeId) conditions.push(eq(expenses.storeId, input.storeId));
  if (input.status) conditions.push(eq(expenses.status, input.status));

  const rows = await tx
    .select(EXPENSE_COLUMNS)
    .from(expenses)
    .where(and(...conditions))
    .orderBy(desc(expenses.businessDate), desc(expenses.createdAt))
    .limit(input.limit ?? 100);
  return rows as ExpenseRow[];
}

export interface UpdateExpenseDraftInput {
  storeId?: string;
  businessDate?: string;
  totalAmount?: string;
  categoryId?: string;
  supplierId?: string;
  supplierInvoiceId?: string;
  ownerId?: string | null;
  particulars?: string;
}

/** Updates header fields on a DRAFT expense only — the caller (edit.ts) has already
 *  proven status === 'draft' and the 48h/role window; this just writes. Throws if the
 *  row no longer satisfies (id, orgId, status='draft') at write time — a concurrent
 *  approve()/void() between the caller's read and this write must not silently
 *  clobber the posted/voided row. */
export async function updateExpenseDraft(
  tx: Tx,
  orgId: string,
  id: string,
  patch: UpdateExpenseDraftInput,
): Promise<void> {
  const updated = await tx
    .update(expenses)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(expenses.id, id), eq(expenses.orgId, orgId), eq(expenses.status, 'draft')))
    .returning({ id: expenses.id });
  if (updated.length === 0) {
    throw new Error(`updateExpenseDraft: expense ${id} does not exist, is not in org ${orgId}, or is not a draft`);
  }
}

export interface MarkPostedInput {
  journalEntryId: string;
  approvedBy: string;
}

/** Flips draft -> posted. Only a draft may be posted — the same discipline as
 *  postDraftEntry (journal.ts): explicit in the WHERE, not re-derived. */
export async function markExpensePosted(tx: Tx, orgId: string, id: string, input: MarkPostedInput): Promise<void> {
  const updated = await tx
    .update(expenses)
    .set({
      status: 'posted',
      journalEntryId: input.journalEntryId,
      approvedBy: input.approvedBy,
      postedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(expenses.id, id), eq(expenses.orgId, orgId), eq(expenses.status, 'draft')))
    .returning({ id: expenses.id });
  if (updated.length === 0) {
    throw new Error(`markExpensePosted: expense ${id} does not exist, is not in org ${orgId}, or is not a draft`);
  }
}

export interface MarkVoidedInput {
  voidedBy: string;
  voidReason: string;
}

/** Flips posted -> voided. Only a posted expense may be voided — a draft is deleted (or
 *  simply left), never voided; an already-voided expense cannot be voided twice. */
export async function markExpenseVoided(tx: Tx, orgId: string, id: string, input: MarkVoidedInput): Promise<void> {
  const updated = await tx
    .update(expenses)
    .set({
      status: 'voided',
      voidedBy: input.voidedBy,
      voidedAt: sql`now()`,
      voidReason: input.voidReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(expenses.id, id), eq(expenses.orgId, orgId), eq(expenses.status, 'posted')))
    .returning({ id: expenses.id });
  if (updated.length === 0) {
    throw new Error(`markExpenseVoided: expense ${id} does not exist, is not in org ${orgId}, or is not posted`);
  }
}

// -----------------------------------------------------------------------------------------
// expense_payments — ONE expense, MANY payments (invariant 2).
// -----------------------------------------------------------------------------------------

export interface ExpensePaymentRow {
  id: string;
  expenseId: string;
  method: 'cash' | 'online' | 'credit' | 'other' | 'reimbursable' | 'ar_collection';
  amount: string;
  accountCode: string | null;
  staffId: string | null;
  moneyAccountId: string | null;
  cashRequestId: string | null;
}

export interface InsertPaymentInput {
  method: ExpensePaymentRow['method'];
  amount: string;
  accountCode?: string | null;
  staffId?: string | null;
  moneyAccountId?: string | null;
  cashRequestId?: string | null;
}

export async function insertPayments(tx: Tx, expenseId: string, payments: InsertPaymentInput[]): Promise<void> {
  if (payments.length === 0) return;
  await tx.insert(expensePayments).values(
    payments.map((p) => ({
      expenseId,
      method: p.method,
      amount: p.amount,
      accountCode: p.accountCode ?? null,
      staffId: p.staffId ?? null,
      moneyAccountId: p.moneyAccountId ?? null,
      cashRequestId: p.cashRequestId ?? null,
    })),
  );
}

export async function getPaymentsForExpense(tx: Tx, expenseId: string): Promise<ExpensePaymentRow[]> {
  const rows = await tx
    .select({
      id: expensePayments.id,
      expenseId: expensePayments.expenseId,
      method: expensePayments.method,
      amount: expensePayments.amount,
      accountCode: expensePayments.accountCode,
      staffId: expensePayments.staffId,
      moneyAccountId: expensePayments.moneyAccountId,
      cashRequestId: expensePayments.cashRequestId,
    })
    .from(expensePayments)
    .where(eq(expensePayments.expenseId, expenseId));
  return rows as ExpensePaymentRow[];
}

/** Wholesale replace — delete every existing payment row and insert the new set, in that
 *  order, within the caller's transaction. Used only by edit.ts on a draft (never a
 *  posted expense — postEntry already has the immutable copy). */
export async function replacePayments(tx: Tx, expenseId: string, payments: InsertPaymentInput[]): Promise<void> {
  await tx.delete(expensePayments).where(eq(expensePayments.expenseId, expenseId));
  await insertPayments(tx, expenseId, payments);
}

/**
 * Deletes a DRAFT expense and its payment rows. The caller (domain/expenses/delete.ts)
 * has already proven status === 'draft' and the edit window; this just writes.
 *
 * ⚠️ The status predicate is repeated in the WHERE clause on purpose, exactly as
 * `updateExpenseDraft` does: a concurrent approve() between the caller's read and this
 * write must NOT let a posted expense be deleted out from under its journal entry. A
 * delete that silently affected zero rows would be indistinguishable from success, so a
 * zero-row result throws.
 *
 * Payments go first — `expense_payments.expense_id` references `expenses.id` and the
 * schema does not cascade (bible §4.2 rule 3 reserves ON DELETE CASCADE for identities),
 * so the child rows must be removed explicitly or the parent delete is rejected.
 */
export async function deleteExpenseDraft(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.delete(expensePayments).where(eq(expensePayments.expenseId, id));
  const deleted = await tx
    .delete(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.orgId, orgId), eq(expenses.status, 'draft')))
    .returning({ id: expenses.id });
  if (deleted.length === 0) {
    throw new Error(`deleteExpenseDraft: expense ${id} does not exist, is not in org ${orgId}, or is not a draft`);
  }
}
