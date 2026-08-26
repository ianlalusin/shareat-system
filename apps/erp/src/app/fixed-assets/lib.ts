/**
 * Server-only helpers for the fixed-asset screens.
 * docs/tasks/124-fixed-assets-and-depreciation.md §6.
 *
 * `withOrgPrincipal` and the store list are imported from the expenses screens rather than
 * duplicated — two copies of the RLS-principal wrapper is two places to get wrong.
 */
import { fixedAssetsRepo, transaction, type AssetCategory } from '@shareat/db';
import { money, subtract } from '@shareat/core/money';
import { withOrgPrincipal } from '../expenses/lib';

export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

/** An asset as the register shows it — the row, plus the two figures that are DERIVED from the
 *  ledger and exist nowhere else. */
export interface RegisterRow {
  id: string;
  name: string;
  category: AssetCategory;
  storeId: string;
  acquiredOn: string | null;
  cost: string | null;
  salvageValue: string | null;
  usefulLifeMonths: number;
  interval: string;
  status: string;
  needsReview: boolean;
  /** ⭐ Summed from the journal on every render. There is no column holding this. */
  accumulated: string;
  /** cost − accumulated. Also derived; also has no column. */
  bookValue: string;
}

/**
 * The register.
 *
 * ⚠️ Uses `accumulatedByAsset` — ONE grouped query for every asset — rather than calling
 * `accumulatedFromLedger` per row. The N+1 version works and is the reason somebody eventually
 * argues that deriving is too slow and the figure should be stored again. It is one join.
 */
export async function listRegister(
  orgId: string,
  filter: { storeId?: string; status?: fixedAssetsRepo.AssetStatus; needsReviewOnly?: boolean },
): Promise<RegisterRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [assets, accumulated] = await Promise.all([
      fixedAssetsRepo.listAssets(tx, orgId, filter),
      fixedAssetsRepo.accumulatedByAsset(tx, orgId),
    ]);

    return assets.map((a) => {
      const acc = accumulated.get(a.id) ?? '0';
      const cost = a.cost ?? '0';
      return {
        id: a.id,
        name: a.name,
        category: a.category,
        storeId: a.storeId,
        acquiredOn: a.acquiredOn,
        cost: a.cost,
        salvageValue: a.salvageValue,
        usefulLifeMonths: a.usefulLifeMonths,
        interval: a.interval,
        status: a.status,
        needsReview: a.needsReview,
        accumulated: acc,
        bookValue: String(subtract(money(cost), money(acc))),
      };
    });
  });
}

export async function getAsset(orgId: string, id: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const asset = await fixedAssetsRepo.getById(tx, orgId, id);
    if (!asset) return null;
    const accumulated = await fixedAssetsRepo.accumulatedFromLedger(tx, orgId, id);
    const periods = await fixedAssetsRepo.postedDepreciationPeriods(tx, orgId, id);
    return { asset, accumulated, periods: periods.sort() };
  });
}

/** The org's policy, for display. Never used to decide anything — the domain reads it again
 *  inside the transaction that needs it, because a policy read is a refusal point (spec §8). */
export async function readPolicyForDisplay(orgId: string) {
  return transaction((tx) => fixedAssetsRepo.findPolicy(tx, orgId));
}

export const CATEGORY_LABEL: Record<string, string> = {
  building: 'Building',
  machinery: 'Machinery',
  equipment: 'Equipment',
  furniture_and_fixture: 'Furniture & fixture',
  appliances: 'Appliances',
  vehicles: 'Vehicles',
  smallwares: 'Smallwares',
};

export const INTERVAL_LABEL: Record<string, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Semi-annual',
  annually: 'Annual',
};

/** `YYYY-MM` for "now" in the business timezone — the default the run form offers. */
export function currentPeriod(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }).slice(0, 7);
}
