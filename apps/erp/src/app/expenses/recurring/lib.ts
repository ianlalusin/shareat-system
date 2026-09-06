/**
 * Server-only reads for `/expenses/recurring`. T-216.
 *
 * ⛔ Reads only, under `withOrgPrincipal`, and none of them calls a domain function (DEF-189).
 */
import { moneyAccountsRepo, recurringExpensesRepo } from '@shareat/db';
import { listCategoriesGrouped, withOrgPrincipal } from '../lib';

export { peso } from '../../../lib/format';
export { listStores, listCategoriesGrouped, withOrgPrincipal } from '../lib';
export type { StoreOption } from '../lib';

export async function listTemplates(orgId: string, storeId?: string) {
  return withOrgPrincipal(orgId, (tx) =>
    recurringExpensesRepo.listForOrg(tx, orgId, storeId ? { storeId } : {}),
  );
}

export async function accountsFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId }));
}

export async function categories(orgId: string) {
  return listCategoriesGrouped(orgId);
}

export function today(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export const INTERVAL_LABEL: Record<string, string> = {
  weekly: 'Weekly',
  bi_weekly: 'Fortnightly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** How a template's anchor reads to a person: *"the 5th"* or *"every Tuesday"*. */
export function anchorLabel(interval: string, anchorDay: number): string {
  if (interval === 'weekly' || interval === 'bi_weekly') return WEEKDAYS[anchorDay] ?? `day ${anchorDay}`;
  const suffix =
    anchorDay % 10 === 1 && anchorDay !== 11
      ? 'st'
      : anchorDay % 10 === 2 && anchorDay !== 12
        ? 'nd'
        : anchorDay % 10 === 3 && anchorDay !== 13
          ? 'rd'
          : 'th';
  // ⚠️ 29/30/31 clamp rather than being refused, so the label says so — otherwise a template
  // anchored on the 31st looks broken every February to whoever reads the list.
  return anchorDay >= 29 ? `${anchorDay}${suffix} (or the month end)` : `${anchorDay}${suffix}`;
}
