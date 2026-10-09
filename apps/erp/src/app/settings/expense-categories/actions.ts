'use server';

/**
 * Server action for `/settings/expense-categories`. T-229 slice 1.
 *
 * ⛔ The gate is `authorize(tx, actor, 'manage_chart_of_accounts', {})` **inside**
 * `setCategoryAccount` — this action does not re-check it, for the reason
 * `settings/attendance/actions.ts:6-9` already states: a gate here would protect only this one
 * caller, and the screen would be one new form away from a hole.
 */
import {
  createCategory,
  renameCategory,
  setCategoryAccount,
  setCategoryActive,
} from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal } from './lib';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { EXPENSE_CATEGORY_ACCOUNT, EXPENSE_CATEGORY_RENAME } from './typed-forms';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function setCategoryAccountAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/settings/expense-categories');
  const categoryId = str(formData, 'categoryId');
  const label = str(formData, 'categoryLabel') || 'Category';
  // ⭐ The blank option is a REAL choice — "no account, so this category blocks posting" — not an
  // absent field. `''` becomes `null`, never the empty-string account code; the
  // nullable-means-chosen distinction has to survive the round trip through an HTML select
  // (DEF-087's failure shape, one type over).
  const raw = str(formData, 'accountCode');
  const accountCode = raw === '' ? null : raw;

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setCategoryAccount(tx, actor, { categoryId, accountCode }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/expense-categories', {}, { error: errorMessage(err), typed: keepTyping(formData, EXPENSE_CATEGORY_ACCOUNT, categoryId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash('/settings/expense-categories', {}, {
    ok:
      accountCode === null
        ? `${label} is now unmapped — expenses in it will not post until an account is set.`
        : `${label} now posts to ${accountCode}.`,
  });
}

/**
 * T-229 slice 2 — create, rename, retire. **DEF-205.**
 *
 * ⛔ Same gate as the mapping action above, and it is the SAME capability by design: splitting
 * create from map would let a manager create a category they cannot make postable, which
 * manufactures DEF-193's condition deliberately. Every function authorises itself.
 */
export async function createCategoryAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/settings/expense-categories');
  const name = str(formData, 'category');
  const group = str(formData, 'group') as 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';
  const raw = str(formData, 'accountCode');

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      createCategory(tx, actor, { group, category: name, accountCode: raw === '' ? null : raw }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/expense-categories', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/settings/expense-categories', {}, {
    ok:
      raw === ''
        ? `"${name}" added. It has no account yet, so expenses in it will not post until one is set.`
        : `"${name}" added, posting to ${raw}.`,
  });
}

export async function renameCategoryAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/settings/expense-categories');
  const categoryId = str(formData, 'categoryId');
  const name = str(formData, 'category');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      renameCategory(tx, actor, { categoryId, category: name }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/expense-categories', {}, { error: errorMessage(err), typed: keepTyping(formData, EXPENSE_CATEGORY_RENAME, categoryId, { actorId: actor.personId }) });
  }
  // ⚠️ Stated plainly: a rename does not touch history, because `expenses.category_id` is an id.
  return await redirectWithFlash('/settings/expense-categories', {}, { ok: `Renamed to "${name}". Everything already recorded in it stays where it is.` });
}

export async function setCategoryActiveAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/settings/expense-categories');
  const categoryId = str(formData, 'categoryId');
  const label = str(formData, 'categoryLabel') || 'That category';
  const isActive = str(formData, 'isActive') === 'true';
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setCategoryActive(tx, actor, { categoryId, isActive }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/expense-categories', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/settings/expense-categories', {}, {
    ok: isActive
      ? `${label} is available again.`
      : `${label} is retired. It stays on every expense already recorded in it, and stops being offered for new ones.`,
  });
}
