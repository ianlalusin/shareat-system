/**
 * Expense-category administration — T-229 slice 1.
 * `docs/tasks/229-reference-data-administration.md`, discovery
 * `docs/discovery/28-reference-data-administration.md` §1.
 *
 * ## Why this file exists — DEF-193
 *
 * `expense_categories` is a real, FK-referenced table whose **only writer that has ever existed**
 * is `packages/db/seed/expense-categories.ts`. Meanwhile T-213 ships `expenseCategoryUnpostable`
 * (`packages/db/src/repo/findings.ts:1538`), which reports a draft expense stuck behind a category
 * with no mapped account and ends its message *"cannot post until one is."* **There was no screen
 * and no function on which anyone could map one.** A detector reporting a condition nobody can
 * remedy is worse than no detector: it teaches people that findings are noise.
 *
 * ## Scope, and what is deliberately absent
 *
 * ⛔ **Mapping only. No create, no rename, no delete, no deactivate — those are slice 2**, and the
 * reason is a constraint, not a schedule. Bible §4.4 rule 3 specifies uniqueness on **normalised**
 * identity (`lower(trim(category))`) and calls it *"the actual fix"* for the duplicated-Rent
 * problem; the shipped index is `unique (org_id, category)`, case- and whitespace-**sensitive**
 * (`packages/db/schema/expenses.ts:85`), so `Rent`, `rent` and `Rent ` are three different rows
 * today. That is harmless while the seed is the only writer and becomes live the moment anything
 * can create a category — so creation waits for the migration that fixes the index, and this slice
 * needs no migration at all.
 *
 * ## The read half is deliberately ungated
 *
 * Only the WRITE is in this file. Listing categories goes straight to `expensesRepo` from the
 * screen's `lib.ts`, matching the asymmetry `apps/erp/src/app/admin/users/lib.ts:4-7` states for
 * every admin screen here: *"the gate belongs to the WRITE, not to looking at a roster."* Hiding a
 * screen is presentation (DEF-051); the control is the mutation.
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, transaction, type Tx } from '@shareat/db';

export interface SetCategoryAccountInput {
  categoryId: string;
  /**
   * ⭐ `null` **CLEARS** the mapping — it is a real value, never "leave this alone".
   * `account_code` is nullable on purpose (`packages/db/schema/expenses.ts:66-68`: *"a category
   * with no account mapped blocks posting rather than defaulting to 6900"*), so a wrong mapping
   * has to be removable. A set-only surface would make one permanent — and a wrong account posts
   * **silently** where an absent one refuses loudly.
   */
  accountCode: string | null;
}

/**
 * Point a category at the account its spend debits, or clear that mapping.
 *
 * ⚠️ **Eligibility IS checked here, unlike `journalRepo.resolveAccountId`, and the difference is
 * not an inconsistency.** That function deliberately does not check `is_postable` or `status`
 * because the very next thing it does is insert a journal line, and T-103's trigger rejects an
 * ineligible account on that insert — checking twice would be the second source of truth the
 * bible forbids. **Nothing validates this write.** A category mapped to a header or a `reserved`
 * account is stored happily and fails days later, at posting time, in front of somebody who did
 * not choose it and cannot see why. So the check belongs at the moment of the decision, which is
 * here.
 */
export async function setCategoryAccount(
  tx: Tx | null,
  actor: Actor,
  input: SetCategoryAccountInput,
): Promise<void> {
  if (tx) return run(tx, actor, input);
  return transaction((trx) => run(trx, actor, input));
}

async function run(tx: Tx, actor: Actor, input: SetCategoryAccountInput): Promise<void> {
  // Bible §7 rule 1 — the first statement. Org-scoped, so no storeId: the category list belongs
  // to the organisation, not to a branch. `manage_chart_of_accounts` rather than a new row,
  // because deciding which account a kind of spend debits IS a chart decision — the matrix's own
  // words for it are "the technical residue. Exactly what Ian was right not to hand over" — and
  // it matches v1's gate exactly (every mutation in v1's `expense-entry.actions.ts` is
  // `ctx.isAdmin`).
  await authorize(tx, actor, 'manage_chart_of_accounts', {});

  const category = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
  if (!category) {
    // Covers a bad id and another org's id identically, and that is correct: under RLS the second
    // is simply invisible, and reporting "not yours" would confirm the row exists.
    throw new Error(
      `setCategoryAccount: category ${input.categoryId} does not exist in org ${actor.orgId}`,
    );
  }

  // A blank submission from a form means "unmapped", never the empty-string account code. Same
  // family as DEF-087's `Number('')` being `0` — the nullable-means-chosen distinction has to
  // survive the round trip through an HTML input.
  const code = input.accountCode === null ? null : input.accountCode.trim() || null;

  if (code !== null) {
    const account = await expensesRepo.accountForMapping(tx, actor.orgId, code);
    if (!account) {
      throw new Error(
        `setCategoryAccount: no account with code '${code}' exists in org ${actor.orgId}`,
      );
    }
    if (!account.isPostable) {
      throw new Error(
        `setCategoryAccount: account '${code}' (${account.name}) is a header and cannot be posted ` +
          'to — only leaf accounts are postable (bible §16.9). Map to one of its children instead.',
      );
    }
    if (account.status !== 'active') {
      throw new Error(
        `setCategoryAccount: account '${code}' (${account.name}) is ${account.status}, not active. ` +
          'A reserved account is defined but deliberately not postable and not in pickers ' +
          '(bible §16.9); activate it first if this mapping is really wanted.',
      );
    }
  }

  await expensesRepo.setCategoryAccountCode(tx, actor.orgId, input.categoryId, code);
}
