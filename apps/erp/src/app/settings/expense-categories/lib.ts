/**
 * Server-only reads for `/settings/expense-categories`. T-229 slice 1.
 *
 * ⭐ Plain reads go straight to the repo with **no capability gate** — the gate belongs to the
 * WRITE, which `setCategoryAccount` performs itself. That asymmetry is the house rule stated in
 * `apps/erp/src/app/admin/users/lib.ts:4-7` and followed by `/staff` and `/attendance/terminals`.
 * A manager who opens this screen sees it and is refused on submit, which is honest; hiding the
 * screen would be presentation, and presentation is not a control (DEF-051).
 */
import { expensesRepo } from '@shareat/db';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };

/**
 * ⚠️ Derived from the repo function rather than imported as a named type. `@shareat/db`'s barrel
 * re-exports row types one explicit line at a time (`export type { LoanRow } from './repo/loans'`,
 * and ~20 more) and `ExpenseCategoryRow` was never among them — so adding
 * `ExpenseCategoryAdminRow` there would mean editing a shared barrel that concurrent lanes also
 * touch, for a type only this screen reads. Deriving it costs one line, cannot drift from the
 * function's real return type, and needs nobody else's file.
 */
export type ExpenseCategoryAdminRow = Awaited<
  ReturnType<typeof expensesRepo.listCategoriesForAdmin>
>[number];

/** Every category, unmapped first, with what each unmapped one is blocking. */
export async function categoriesForAdmin(orgId: string): Promise<ExpenseCategoryAdminRow[]> {
  return withOrgPrincipal(orgId, (tx) => expensesRepo.listCategoriesForAdmin(tx, orgId));
}

/** The accounts a category may be mapped to — postable and active only. */
export async function mappableAccounts(orgId: string): Promise<{ code: string; name: string }[]> {
  return withOrgPrincipal(orgId, (tx) => expensesRepo.mappableAccounts(tx, orgId));
}
