'use server';

/**
 * Server action for `/settings/expense-categories`. T-229 slice 1.
 *
 * ⛔ The gate is `authorize(tx, actor, 'manage_chart_of_accounts', {})` **inside**
 * `setCategoryAccount` — this action does not re-check it, for the reason
 * `settings/attendance/actions.ts:6-9` already states: a gate here would protect only this one
 * caller, and the screen would be one new form away from a hole.
 */
import { redirect } from 'next/navigation';
import { setCategoryAccount } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(params: Record<string, string>): never {
  redirect(`/settings/expense-categories?${new URLSearchParams(params).toString()}`);
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
    back({ error: errorMessage(err) });
  }
  back({
    ok:
      accountCode === null
        ? `${label} is now unmapped — expenses in it will not post until an account is set.`
        : `${label} now posts to ${accountCode}.`,
  });
}
