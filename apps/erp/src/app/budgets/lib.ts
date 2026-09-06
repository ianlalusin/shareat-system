/**
 * Server-only reads for `/budgets`. T-215.
 *
 * ⛔ Reads only, all under `withOrgPrincipal`, and none of them calls a domain function — DEF-189:
 * calling a gated service to satisfy a page read returns HTTP 500 where a refusal is wanted.
 */
import { budgetsRepo } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export async function listBudgets(orgId: string, storeId: string, periodKey: string) {
  return withOrgPrincipal(orgId, (tx) => budgetsRepo.listForStorePeriod(tx, orgId, storeId, periodKey));
}

export async function listUncapped(orgId: string, storeId: string, periodKey: string) {
  return withOrgPrincipal(orgId, (tx) => budgetsRepo.categoriesWithoutBudget(tx, orgId, storeId, periodKey));
}

/** The current Manila period as `YYYYMM`. ⚠️ The +8 shift, never the server's local date. */
export function currentPeriodKey(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7).replace('-', '');
}

/** `202609` → `September 2026`, for a heading a person reads rather than parses. */
export function periodLabel(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6));
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-PH', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${year}`;
}

/** The six periods around now, newest first — enough to look back and one ahead to set up. */
export function periodOptions(): string[] {
  const now = new Date(Date.now() + 8 * 3_600_000);
  const base = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return [1, 0, -1, -2, -3, -4].map((offset) => {
    const zero = base + offset;
    return `${String(Math.floor(zero / 12)).padStart(4, '0')}${String((zero % 12) + 1).padStart(2, '0')}`;
  });
}

export const INTERVAL_LABEL: Record<string, string> = {
  daily: 'Daily — the window resets every day',
  weekly: 'Weekly — the window resets every 7 days',
  bi_weekly: 'Fortnightly — the window resets every 14 days',
  monthly: 'Monthly — a new cap next month',
  quarterly: 'Quarterly — a new cap next quarter',
  annually: 'Annually — a new cap next year',
};
