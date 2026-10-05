/**
 * getPosDayReconciliation - T-210, converted by T-375 S6. `docs/tasks/375-pos-v1-day-feed.md` S6.
 *
 * Shows what POS said when the day was imported ("At import": the day's BASIS feed, R10) beside what the latest stored
 * check says ("Latest check"), and the sales day's own total beside them. **Nothing is fetched at render**: both sides
 * are stored feeds, so the screen works with POS down and never lets a slow POS hold a page. A fresh check is the
 * **Check POS again** button (`recheckPosDay`), which stores a batch the next render reads.
 *
 * Takes `Tx`, not `Executor` - it calls repos directly (same reasoning as `ap-aging.ts`/`ar-aging.ts`, T-209b).
 * Every outcome is a named, non-throwing result state.
 */
import { posV1Repo, salesDaysRepo, POS_V1_SALES_FIELDS as S, type Tx } from '@shareat/db';
import { equals, fromCentavos, money, subtract, type Money } from '@shareat/core/money';
import { toCentavos } from '../pos/v1-methods';

/** One stored `sales` feed read for display. `none`: no feed is stored; `not_found`: POS answered "no data" (or unreadably). */
export type PosSide =
  | { status: 'ok'; paidTotal: Money; receiptCount: number }
  | { status: 'not_found' }
  | { status: 'none' };

export type LedgerSide =
  | { exists: true; status: salesDaysRepo.SalesDayStatus; totalSales: Money; posSourced: boolean; source: salesDaysRepo.SalesDayRow['source'] }
  | { exists: false };

export interface PosDayReconciliationBasis {
  orgId: string;
  storeId: string;
  businessDate: string;
}

export interface PosDayReconciliationResult {
  /** The day's basis feed: what was posted (the import, or the latest correction's feed). */
  atImport: PosSide;
  /** The latest stored `sales` feed of the date. */
  latest: PosSide;
  ledger: LedgerSide;
  /** The date's live sales day (the Check POS again button names it); null when there is none. */
  salesDayId: string | null;
  /** `latest - atImport`; null unless both sides are 'ok' - never a misleading zero. */
  delta: Money | null;
  /** The two paid totals are equal; null unless both sides are 'ok'. */
  matches: boolean | null;
  basis: PosDayReconciliationBasis;
}

function sideOf(feed: { payload: unknown } | undefined): PosSide {
  if (!feed) return { status: 'none' };
  const p = feed.payload;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { status: 'not_found' };
  const body = p as Record<string, unknown>;
  if (body[S.found] !== true) return { status: 'not_found' };
  const paid = typeof body[S.paidTotal] === 'number' ? toCentavos(body[S.paidTotal] as number) : null;
  if (paid === null) return { status: 'not_found' };
  const receipts = body[S.receiptCount];
  return {
    status: 'ok',
    paidTotal: money(fromCentavos(paid)),
    receiptCount: typeof receipts === 'number' && Number.isInteger(receipts) ? receipts : 0,
  };
}

export async function getPosDayReconciliation(tx: Tx, input: PosDayReconciliationBasis): Promise<PosDayReconciliationResult> {
  const salesDay = await salesDaysRepo.findByBusinessDate(tx, input.orgId, input.storeId, input.businessDate);
  const [basisFeed, latestFeed] = await Promise.all([
    salesDay ? posV1Repo.basisFor(tx, input.orgId, salesDay.id) : Promise.resolve(undefined),
    posV1Repo.latestForDay(tx, input.orgId, input.storeId, input.businessDate, 'sales'),
  ]);
  const atImport = sideOf(basisFeed);
  const latest = sideOf(latestFeed);

  const ledger: LedgerSide = salesDay
    ? { exists: true, status: salesDay.status, totalSales: money(salesDay.totalSales), posSourced: salesDay.posSourced, source: salesDay.source }
    : { exists: false };

  let delta: Money | null = null;
  let matches: boolean | null = null;
  if (atImport.status === 'ok' && latest.status === 'ok') {
    delta = subtract(latest.paidTotal, atImport.paidTotal);
    matches = equals(latest.paidTotal, atImport.paidTotal);
  }
  return { atImport, latest, ledger, salesDayId: salesDay?.id ?? null, delta, matches, basis: input };
}
