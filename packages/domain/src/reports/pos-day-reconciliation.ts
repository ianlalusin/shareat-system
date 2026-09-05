/**
 * getPosDayReconciliation — T-210. Shows POS's live day-level sales figure beside Shareat
 * System's own `sales_days` record for the same store/date, so the reconciliation is rendered
 * rather than left to goodwill (phase-6 plan §4.1). Takes `Tx`, not `Executor` — it calls
 * `salesDaysRepo` directly (same reasoning as `ap-aging.ts`/`ar-aging.ts`, T-209b).
 *
 * `POS_API_URL`/`POS_API_KEY` are declared optional (`@shareat/core/env`) — nothing else in this
 * codebase requires POS to be reachable to do its own job, and this screen must not either. Every
 * outcome POS or the fetch itself can produce is a named, non-throwing result state.
 */
import { salesDaysRepo, type Tx } from '@shareat/db';
import { equals, money, subtract, type Money } from '@shareat/core/money';
import type { FetchPosDaySales } from '../pos/sales-pull';

export type PosSide =
  | { status: 'ok'; totalSales: Money; totalSessions: number }
  | { status: 'not_found'; message: string }
  | { status: 'not_configured'; message: string }
  | { status: 'unreachable'; message: string };

export type LedgerSide =
  | { exists: true; status: salesDaysRepo.SalesDayStatus; totalSales: Money; posSourced: boolean }
  | { exists: false };

export interface PosDayReconciliationBasis {
  orgId: string;
  storeId: string;
  businessDate: string;
}

export interface PosDayReconciliationResult {
  pos: PosSide;
  ledger: LedgerSide;
  /** Only set when both sides are 'ok'/exist — null otherwise, never a misleading zero. */
  delta: Money | null;
  matches: boolean | null;
  basis: PosDayReconciliationBasis;
}

async function fetchPosSide(fetchPosSales: FetchPosDaySales, input: { storeId: string; businessDate: string }): Promise<PosSide> {
  try {
    const snap = await fetchPosSales(input);
    if (!snap.found) {
      return { status: 'not_found', message: `No POS analytics for this store on ${input.businessDate}.` };
    }
    return { status: 'ok', totalSales: money(snap.totalSales), totalSessions: snap.totalSessions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not configured')) {
      return { status: 'not_configured', message };
    }
    return { status: 'unreachable', message };
  }
}

export async function getPosDayReconciliation(
  tx: Tx,
  fetchPosSales: FetchPosDaySales,
  input: PosDayReconciliationBasis,
): Promise<PosDayReconciliationResult> {
  const [pos, salesDay] = await Promise.all([
    fetchPosSide(fetchPosSales, input),
    salesDaysRepo.findByBusinessDate(tx, input.orgId, input.storeId, input.businessDate),
  ]);

  const ledger: LedgerSide = salesDay
    ? { exists: true, status: salesDay.status, totalSales: money(salesDay.totalSales), posSourced: salesDay.posSourced }
    : { exists: false };

  let delta: Money | null = null;
  let matches: boolean | null = null;
  if (pos.status === 'ok' && ledger.exists) {
    delta = subtract(pos.totalSales, ledger.totalSales);
    matches = equals(pos.totalSales, ledger.totalSales);
  }

  return { pos, ledger, delta, matches, basis: input };
}
