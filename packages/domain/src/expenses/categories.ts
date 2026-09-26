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
import { RefusalError, refuse, gone } from '../shared/refusal';

/**
 * Org-scoped, admin-only. ⭐ **One capability for the whole screen — create, map, rename and
 * retire alike.** Splitting create from map would let a manager create a category they cannot make
 * postable, which manufactures DEF-193's condition deliberately (T-229 open question 1, answered
 * 2026-09-07). It matches v1's own gate: every mutation in its `expense-entry.actions.ts` is
 * `ctx.isAdmin`.
 */
const CAPABILITY = 'manage_chart_of_accounts' as const;

/**
 * ⭐ **The one place account eligibility is decided**, shared by mapping (slice 1) and creating
 * with a mapping (slice 2) — a second copy would be a second answer to "is this account usable?",
 * and the two would drift.
 *
 * Bible §16.9: only leaf accounts are postable, and `reserved` is "No" in the postable, picker and
 * report columns alike. A category mapped to a header or a reserved account stores happily and
 * fails days later, at posting time, in front of somebody who did not choose it and cannot see
 * why — so the check belongs at the moment of the decision.
 */
async function assertMappableAccount(tx: Tx, orgId: string, code: string): Promise<void> {
  const account = await expensesRepo.accountForMapping(tx, orgId, code);
  if (!account) {
    throw refuse(`no account with code '${code}' exists in org ${orgId}`, `There is no account with code ${code}.`);
  }
  if (!account.isPostable) {
    throw refuse(
      `account '${code}' (${account.name}) is a header and cannot be posted to — only leaf ` +
        'accounts are postable (bible §16.9). Map to one of its children instead.',
      `Account '${code}' (${account.name}) is a header and cannot be posted to — only leaf accounts are postable. Map to one of its children instead.`,
    );
  }
  if (account.status !== 'active') {
    throw refuse(
      `account '${code}' (${account.name}) is ${account.status}, not active. A reserved account ` +
        'is defined but deliberately not postable and not in pickers (bible §16.9); activate it ' +
        'first if this mapping is really wanted.',
      `Account '${code}' (${account.name}) is ${account.status}, not active. A reserved account is defined but deliberately not postable and not in pickers; activate it first if this mapping is really wanted.`,
    );
  }
}

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
  await authorize(tx, actor, CAPABILITY, {});

  const category = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
  if (!category) {
    // Covers a bad id and another org's id identically, and that is correct: under RLS the second
    // is simply invisible, and reporting "not yours" would confirm the row exists.
    throw gone(
      `setCategoryAccount: category ${input.categoryId} does not exist in org ${actor.orgId}`,
      'expense category',
    );
  }

  // A blank submission from a form means "unmapped", never the empty-string account code. Same
  // family as DEF-087's `Number('')` being `0` — the nullable-means-chosen distinction has to
  // survive the round trip through an HTML input.
  const code = input.accountCode === null ? null : input.accountCode.trim() || null;

  // ⚠️ Extracted to `assertMappableAccount` in slice 2 so creating-with-a-mapping cannot answer
  // "is this account usable?" differently from mapping an existing one. The message is prefixed
  // here so the thrown sentence still names the operation.
  if (code !== null) {
    try {
      await assertMappableAccount(tx, actor.orgId, code);
    } catch (err) {
      // Rewrap: keeps the inner userMessage (rule 5) rather than re-deriving one from `.message`.
      // A non-RefusalError rethrows AS-IS (S1's fallback handles it) — wrapping it here would put
      // an internal diagnostic on screen (code-review item 4, 2026-09-26).
      if (!(err instanceof RefusalError)) throw err;
      throw refuse(`setCategoryAccount: ${err.message}`, err.userMessage);
    }
  }

  await expensesRepo.setCategoryAccountCode(tx, actor.orgId, input.categoryId, code);
}

// -----------------------------------------------------------------------------------------
// T-229 slice 2 — create, rename, retire. **DEF-205.**
//
// ⭐ **The migration is what made this slice possible, and it is the whole point.** Slice 1's
// header explains why creation waited: the shipped index was `(org_id, category)`, case- and
// whitespace-SENSITIVE, so `Rent`, `rent` and `Rent ` were three different rows and a human create
// path would have re-opened the duplicated-Rent defect bible §4.4 exists to close. Migration 0134
// replaces it with `(org_id, lower(trim(category)))` — *"the actual fix"* — and creation ships in
// the same migration, never after.
//
// ⚠️ **`manage_chart_of_accounts`, the same capability as slice 1, and the whole screen or none of
// it.** Splitting create from map across two capabilities would let a manager create a category
// they cannot make postable, which manufactures DEF-193's condition deliberately.
// -----------------------------------------------------------------------------------------

export type ExpenseCategoryGroup = 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';

export interface CreateCategoryInput {
  readonly group: ExpenseCategoryGroup;
  readonly category: string;
  /** Optional at creation — an unmapped category blocks posting rather than guessing, which is a
   *  legitimate state to create one in and then map (invariant 3). */
  readonly accountCode?: string | null;
}

function cleanCategoryName(raw: string): string {
  const name = raw.trim();
  if (!name) throw refuse('createCategory: a category needs a name.', 'A category needs a name.');
  return name;
}

/**
 * ⚠️ Only to WORD the refusal. `expense_categories_org_id_category_unique` — now on
 * `lower(trim(category))` — is what actually refuses a collision, including one this pre-read
 * raced. Bible §4.4 rule 3: *"rejected BY THE DATABASE, with an error naming the existing row."*
 *
 * ⛔ **The check is org-wide, not per group.** `group` is deliberately absent from the key: with
 * it, "Rent" in OPEX and "rent" in COGS would both insert — one keystroke apart, and exactly the
 * duplicate the index exists to refuse.
 */
async function refuseDuplicateName(
  tx: Tx,
  orgId: string,
  category: string,
  exceptCategoryId?: string,
): Promise<void> {
  const existing = await expensesRepo.categoryByNormalisedName(tx, orgId, category);
  if (existing && existing.id !== exceptCategoryId) {
    throw refuse(
      `This organisation already has a category called "${existing.category}" — names are ` +
        'compared ignoring case and spacing, so it would be the same category twice.',
      `This organisation already has a category called "${existing.category}" — names are compared ignoring case and spacing, so it would be the same category twice.`,
    );
  }
}

export async function createCategory(
  tx: Tx,
  actor: Actor,
  input: CreateCategoryInput,
): Promise<{ categoryId: string }> {
  await authorize(tx, actor, CAPABILITY, {});
  const category = cleanCategoryName(input.category);
  await refuseDuplicateName(tx, actor.orgId, category);

  const accountCode = input.accountCode ?? null;
  if (accountCode !== null) await assertMappableAccount(tx, actor.orgId, accountCode);

  const { id } = await expensesRepo.insertCategory(tx, {
    orgId: actor.orgId,
    group: input.group,
    category,
    accountCode,
  });
  return { categoryId: id };
}

/**
 * ⛔ **A seeded row may never be renamed.** Bible §4.4 rule 2 — seeded rows *"may be deactivated
 * but never deleted, and their `code` is stable forever"* — and rule 5, one writer per row class:
 * the seed owns system rows, the screen owns user rows, neither writes the other's. Renaming a
 * seeded row here would also make the next `seedExpenseCategories` re-insert the original name
 * beside it, since the seed matches on the name.
 */
export async function renameCategory(
  tx: Tx,
  actor: Actor,
  input: { categoryId: string; category: string },
): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  const existing = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
  if (!existing) throw gone('renameCategory: that category does not exist in this organisation.', 'expense category');
  if (existing.isSystem) {
    throw refuse(
      `"${existing.category}" is a seeded category, so its name is fixed — the seed owns it, and ` +
        'renaming it here would have the next seed re-create the original beside it. Retire it and ' +
        'add your own if it is wrong for this business.',
      `"${existing.category}" is a seeded category, so its name is fixed — the seed owns it, and renaming it here would have the next seed re-create the original beside it. Retire it and add your own if it is wrong for this business.`,
    );
  }

  const category = cleanCategoryName(input.category);
  await refuseDuplicateName(tx, actor.orgId, category, input.categoryId);
  await expensesRepo.renameCategory(tx, actor.orgId, input.categoryId, category);
}

/**
 * ⭐ Retire, never delete — bible §4.4 rule 2, and `expenses.category_id` is `on delete restrict`
 * so a delete is impossible anyway. A retired category stays readable on every expense already
 * posted against it; it simply stops being offered for new ones.
 *
 * ⚠️ **A SEEDED row may be retired.** That is rule 2's own wording, and it is what makes the
 * 38-row seed survivable for a business that does not use all of it.
 */
export async function setCategoryActive(
  tx: Tx,
  actor: Actor,
  input: { categoryId: string; isActive: boolean },
): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  const existing = await expensesRepo.getCategoryById(tx, actor.orgId, input.categoryId);
  if (!existing) throw gone('setCategoryActive: that category does not exist in this organisation.', 'expense category');
  await expensesRepo.setCategoryActive(tx, actor.orgId, input.categoryId, input.isActive);
}
