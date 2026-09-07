/**
 * Server-only reads for `/expenses/recurring`. T-216.
 *
 * ⛔ Reads only, under `withOrgPrincipal`, and none of them calls a domain function (DEF-189).
 */
import { apRepo, moneyAccountsRepo, recurringExpensesRepo } from '@shareat/db';
import { listActiveCategoriesGrouped, withOrgPrincipal } from '../lib';
import { nextDueDate, type RecurrenceInterval } from '@shareat/domain';

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

/** Active suppliers only — a template may not name one the business has stopped buying from. */
export async function suppliersFor(orgId: string) {
  return withOrgPrincipal(orgId, (tx) => apRepo.listSuppliers(tx, orgId));
}

export async function categories(orgId: string) {
  return listActiveCategoriesGrouped(orgId);
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

/**
 * How many due dates a template has missed, counting the one it is sitting on.
 *
 * ⭐ Exists so a normal catch-up is not read as a stuck job. The job drafts ONE period per nightly
 * run (v1's "never pre-create" in mirror image), so a template three months overdue takes three
 * nights — correct behaviour that looks identical to a broken cursor unless the screen says which
 * it is.
 *
 * ⚠️ Capped at 24 hops for the same reason `runBudgetReissue` caps its loop: beyond two years the
 * data is wrong, and a page that spins counting to infinity is worse than an approximate number.
 */
export function periodsBehind(interval: string, anchorDay: number, nextDue: string, today: string): number {
  if (nextDue > today) return 0;
  let cursor = nextDue;
  let n = 0;
  while (cursor <= today && n < 24) {
    cursor = nextDueDate(cursor, interval as RecurrenceInterval, anchorDay);
    n += 1;
  }
  return n;
}
