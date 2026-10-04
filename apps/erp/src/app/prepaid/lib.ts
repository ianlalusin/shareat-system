/**
 * Server-only helpers for the prepaid screens. T-125.
 *
 * ⭐ Every figure here is DERIVED. `amortisedByItem` is one grouped query for the whole register
 * rather than a per-row lookup — the N+1 is what makes a derived figure look expensive and tempts
 * someone to store it again, which is the exact mistake v1 made.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { prepaidRepo, type PrepaidItemRow } from '@shareat/db';
import { prepaidSchedule } from '@shareat/domain';
import { money, subtract, type Money } from '@shareat/core/money';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface PrepaidListRow extends PrepaidItemRow {
  /** Released into the P&L so far, summed from the ledger. */
  amortised: Money;
  /** Cost less released. ⛔ There is no `remaining` column — this is arithmetic on two facts. */
  remaining: Money;
  /** How many of the scheduled months have posted. */
  monthsPosted: number;
}

export async function listRegister(orgId: string): Promise<PrepaidListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [items, amortisedMap] = await Promise.all([
      prepaidRepo.listPrepaidItems(tx, orgId),
      prepaidRepo.amortisedByItem(tx, orgId),
    ]);
    return items.map((i) => {
      const amortised = amortisedMap.get(i.id) ?? '0';
      return {
        ...i,
        // T-371 R4 — stored figures re-minted and subtracted in centavos, never through a float.
        amortised: money(amortised),
        remaining: subtract(money(i.totalCost), money(amortised)),
        monthsPosted: 0,
      };
    });
  });
}

export async function reviewCount(orgId: string): Promise<number> {
  return withOrgPrincipal(orgId, (tx) => prepaidRepo.countNeedingReview(tx, orgId));
}

export interface PrepaidDetail extends PrepaidListRow {
  schedule: { period: string; entryDate: string; amount: string; posted: boolean }[];
}

export async function getDetail(orgId: string, id: string): Promise<PrepaidDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const item = await prepaidRepo.getById(tx, orgId, id);
    if (!item) return null;
    const [amortised, posted] = await Promise.all([
      prepaidRepo.amortisedFromLedger(tx, orgId, id),
      prepaidRepo.postedPeriods(tx, orgId, id),
    ]);
    // ⭐ The schedule is rebuilt from the item's own terms every time it is shown, so it can
    // never disagree with what the runner will do — same function, same inputs.
    const schedule = prepaidSchedule(item).map((p) => ({
      period: p.period,
      entryDate: p.entryDate,
      amount: p.amount,
      posted: posted.has(p.period),
    }));
    return {
      ...item,
      amortised: money(amortised),
      remaining: subtract(money(item.totalCost), money(amortised)),
      monthsPosted: posted.size,
      schedule,
    };
  });
}

export const CATEGORY_LABEL: Record<string, string> = {
  insurance: 'Insurance',
  permits_and_licenses: 'Permits and licences',
  rent_prepaid: 'Rent paid in advance',
  software_and_subscriptions: 'Software and subscriptions',
  maintenance_contracts: 'Maintenance contracts',
  other_prepaid: 'Other',
};

export const STATUS_LABEL: Record<string, string> = {
  active: 'Amortising',
  fully_amortised: 'Fully released',
  written_off: 'Written off',
};

/** The current period as `YYYY-MM` — what the run defaults to catching up through. */
export function thisPeriod(): string {
  return toBusinessDate().slice(0, 7);
}
