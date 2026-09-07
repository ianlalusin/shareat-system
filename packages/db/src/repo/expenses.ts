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
  accountCode: string | null;
  isSystem: boolean;
  isActive: boolean;
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
      accountCode: expenseCategories.accountCode,
      isSystem: expenseCategories.isSystem,
      isActive: expenseCategories.isActive,
    })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.orgId, orgId)))
    .limit(1);
  return row as ExpenseCategoryRow | undefined;
}

// -----------------------------------------------------------------------------------------
// T-229 slice 1 — the category ADMIN surface. Until this, `packages/db/seed/expense-categories.ts`
// was the only writer `expense_categories` had ever had, while T-213's `expenseCategoryUnpostable`
// reported drafts stuck behind an unmapped category and told the reader to map one. **DEF-193.**
// -----------------------------------------------------------------------------------------

// -----------------------------------------------------------------------------------------
// T-229 slice 2 — create, rename, retire. ⛔ No business rule here: who may write, what a
// seeded row may not have done to it, and what counts as a duplicate name are all
// `packages/domain/src/expenses/categories.ts`'s call. **DEF-205.**
// -----------------------------------------------------------------------------------------

export interface InsertExpenseCategoryInput {
  orgId: string;
  group: 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';
  category: string;
  accountCode: string | null;
}

/** ⚠️ Always a USER row — `is_system` defaults false and this function never sets it. The seed is
 *  the only writer of system rows (bible §4.4 rule 5, one writer per row class). */
export async function insertCategory(
  tx: Tx,
  input: InsertExpenseCategoryInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(expenseCategories)
    .values({
      orgId: input.orgId,
      group: input.group,
      category: input.category,
      accountCode: input.accountCode,
    })
    .returning({ id: expenseCategories.id });
  return row!;
}

export async function renameCategory(
  tx: Tx,
  orgId: string,
  categoryId: string,
  category: string,
): Promise<void> {
  await tx
    .update(expenseCategories)
    .set({ category, updatedAt: new Date() })
    .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.orgId, orgId)));
}

/** ⛔ There is deliberately no `deleteCategory`. `expenses.category_id` is `on delete restrict`,
 *  and bible §4.4 rule 2 is explicit: reference data is deactivated, never deleted. */
export async function setCategoryActive(
  tx: Tx,
  orgId: string,
  categoryId: string,
  isActive: boolean,
): Promise<void> {
  await tx
    .update(expenseCategories)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.orgId, orgId)));
}

/**
 * The name-collision pre-read, normalised exactly as the unique index is.
 * ⚠️ It exists ONLY to word the refusal — `expense_categories_org_id_category_unique` is the
 * authority, and a caller that skips this (or races another transaction) is still refused.
 */
export async function categoryByNormalisedName(
  tx: Tx,
  orgId: string,
  category: string,
): Promise<{ id: string; category: string } | null> {
  const [row] = (await tx.execute(sql`
    select id, category from expense_categories
     where org_id = ${orgId} and lower(trim(category)) = lower(trim(${category}))
     limit 1
  `)) as unknown as Record<string, unknown>[];
  return row ? { id: String(row.id), category: String(row.category) } : null;
}

/** One row of the admin screen: the category, the account it resolves to, and what it is blocking. */
export interface ExpenseCategoryAdminRow {
  id: string;
  group: 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';
  category: string;
  accountCode: string | null;
  /** Seeded rows may be retired but never renamed — bible §4.4 rules 2 and 5. */
  isSystem: boolean;
  isActive: boolean;
  /** The mapped account's name, resolved for display. Null when unmapped. */
  accountName: string | null;
  /** How many DRAFT expenses this category's missing mapping is holding up. */
  blockedDraftCount: number;
}

/**
 * Every category for the org, **unmapped first** — they are the only actionable rows — then by
 * group and name.
 *
 * ⚠️ **`blockedDraftCount` is deliberately NOT the detector's population.**
 * `findingsRepo.expenseCategoryUnpostable` applies a 3-day materiality threshold before it raises
 * a finding; this count applies none, because the two answer different questions. The detector
 * asks *"has this been stuck long enough to be worth an alert?"*; this screen asks *"what is stuck
 * behind this mapping right now?"* — and a draft created this morning is just as blocked as one
 * from last week. Reporting only the aged ones here would understate the consequence at the exact
 * moment somebody is deciding whether to act.
 *
 * ⛔ Derived on read, never a stored counter — bible §4.2 rule 7 (§13 row 173: *"a
 * separately-accumulated counter is forbidden even when it is called a cache"*).
 */
export async function listCategoriesForAdmin(
  tx: Tx,
  orgId: string,
): Promise<ExpenseCategoryAdminRow[]> {
  // `group` is a reserved word — every reference must be quoted, the same trap
  // `packages/db/seed/expense-categories.ts` documents in its own INSERT.
  const rows = (await tx.execute(sql`
    select ec.id::text                as id,
           ec."group"                 as "group",
           ec.category                as category,
           ec.account_code            as account_code,
           ec.is_system               as is_system,
           ec.is_active               as is_active,
           a.name                     as account_name,
           case when ec.account_code is null then (
             select count(*)::int from expenses e
              where e.org_id = ec.org_id and e.category_id = ec.id and e.status = 'draft'
           ) else 0 end               as blocked_draft_count
      from expense_categories ec
      left join accounts a on a.org_id = ec.org_id and a.code = ec.account_code
     where ec.org_id = ${orgId}
     order by ec.is_active desc, (ec.account_code is not null) asc, ec."group" asc, ec.category asc
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    group: String(r.group) as ExpenseCategoryAdminRow['group'],
    category: String(r.category),
    accountCode: r.account_code === null || r.account_code === undefined ? null : String(r.account_code),
    accountName: r.account_name === null || r.account_name === undefined ? null : String(r.account_name),
    isSystem: r.is_system === true,
    isActive: r.is_active === true,
    blockedDraftCount: Number(r.blocked_draft_count ?? 0),
  }));
}

/**
 * Whether an account code exists for this org and what state it is in. Same shape and same job as
 * `liabilitiesRepo.accountKind` — the domain layer decides what is eligible; this only reports.
 */
export async function accountForMapping(
  tx: Tx,
  orgId: string,
  code: string,
): Promise<{ code: string; name: string; isPostable: boolean; status: string } | undefined> {
  const [row] = (await tx.execute(sql`
    select code, name, is_postable, status from accounts
     where org_id = ${orgId} and code = ${code} limit 1
  `)) as unknown as Record<string, unknown>[];
  if (!row) return undefined;
  return {
    code: String(row.code),
    name: String(row.name),
    isPostable: Boolean(row.is_postable ?? row.isPostable),
    status: String(row.status),
  };
}

/**
 * The accounts a category may be mapped TO — postable and active only, mirroring
 * `liabilitiesRepo.chargeableAccounts`. ⚠️ Not filtered by type: a v2 category legitimately maps
 * to `1400 Other Prepaid` and `1510 Capital Expenditure` as well as to 5xxx/6xxx, and PERSONAL
 * maps to `3200 Owner's drawings` — `packages/db/seed/expense-categories.ts` seeds all four
 * shapes, and `packages/domain/src/expenses/routing.ts` posts whatever the category resolved to
 * without special-casing the group.
 *
 * ⚠️ **Excluding `type = 'income'` was considered and NOT done.** Debiting a revenue account from
 * an expense category would be a real mis-posting, but every legitimate mapping already spans
 * asset, equity and expense, so a type filter would be one exception away from hiding an account
 * somebody needs — and the picker shows `code · name` to an admin who holds
 * `manage_chart_of_accounts`. If this ever bites, the fix is a domain-layer refusal with a named
 * reason, not a silently shorter list.
 */
export async function mappableAccounts(
  tx: Tx,
  orgId: string,
): Promise<{ code: string; name: string }[]> {
  const rows = (await tx.execute(sql`
    select code, name from accounts
     where org_id = ${orgId} and is_postable and status = 'active'
     order by code
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ code: String(r.code), name: String(r.name) }));
}

/**
 * Set or CLEAR a category's account mapping. ⭐ `null` is a real value, not "leave alone":
 * `account_code` is nullable on purpose (schema comment, invariant 7) so that an unmapped category
 * blocks posting rather than defaulting to `6900`, and a wrong mapping must therefore be
 * removable. No business rule here — eligibility is
 * `packages/domain/src/expenses/categories.ts`'s call.
 */
export async function setCategoryAccountCode(
  tx: Tx,
  orgId: string,
  categoryId: string,
  accountCode: string | null,
): Promise<void> {
  await tx
    .update(expenseCategories)
    .set({ accountCode, updatedAt: new Date() })
    .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.orgId, orgId)));
}

/**
 * ⚠️ **`activeOnly` defaults to FALSE on purpose.** An expense already recorded against a category
 * that was later retired must still render its own category, and the filter screen must still be
 * able to filter history by it. A PICKER offering a NEW choice is the caller that passes `true`.
 */
export async function listCategories(
  tx: Tx,
  orgId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<ExpenseCategoryRow[]> {
  const rows = await tx
    .select({
      id: expenseCategories.id,
      orgId: expenseCategories.orgId,
      group: expenseCategories.group,
      category: expenseCategories.category,
      accountCode: expenseCategories.accountCode,
      isSystem: expenseCategories.isSystem,
      isActive: expenseCategories.isActive,
    })
    .from(expenseCategories)
    .where(
      opts.activeOnly
        ? and(eq(expenseCategories.orgId, orgId), eq(expenseCategories.isActive, true))
        : eq(expenseCategories.orgId, orgId),
    )
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
