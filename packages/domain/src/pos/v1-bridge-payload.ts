/**
 * T-531 R5 - the December bridge to v1 (bible row 436): the PURE builder of the one Firestore document v1's `api/external/sales` reads for a store and a
 * business date. docs/tasks/531-pos-day-close.md R5 and ruling 5.
 *
 * Until 31 Dec 2026 the new POS also writes each closed day into v1 (`stores/{posStoreId}/analytics/{yyyymmdd}`) so Lipa's December books in v1 stay whole.
 * The document is a FULL overwrite (`merge: false`, v1's own rebuild precedent), built from the Z rows in the database, never from a running counter.
 *
 * Money arrives as decimal text and leaves as a JSON number with at most two decimals made from exact centavos (`Number(centavos) / 100`): v1 stores numbers.
 * Cash is keyed `'cash'`; every other tender by its v1 method name (`tenders.pos_v1_alias`, the map the T-396 import resolves with, in reverse); two tenders
 * with one v1 name are summed under it. A tender with no v1 name refuses the write. `sales.dineInSalesGross` is the unli figure the Z STATES, never a
 * residual: without it v1 books the whole day as take-out (discovery section 6).
 */
import { add, compare, money, toCentavos, type Money } from '@shareat/core/money';
import { parseBusinessDate } from '@shareat/core/datetime';
import { refuse } from '../shared/refusal';

/** The last business date the bridge writes (row 436). A later date is refused here, in code. */
export const V1_BRIDGE_LAST_DATE = '2026-12-31';

export interface V1BridgeTender {
  name: string;
  kind: 'cash' | 'wallet';
  /** `tenders.pos_v1_alias`: the v1 payment-method name. Not used for cash (cash is always `'cash'`). */
  v1Alias: string | null;
  amount: string;
}
export interface V1BridgeClose {
  receiptCount: number;
  grossTotal: string;
  discountTotal: string;
  unliSales: string;
  heads: number;
  packageSessions: number;
  tenders: V1BridgeTender[];
}
export interface V1BridgePayload {
  /** `stores/<posStoreId>/analytics/<yyyymmdd>` */
  path: string;
  /** Always false: a full overwrite. */
  merge: false;
  data: {
    payments: { totalGross: number; txCount: number; byMethod: Record<string, number>; discountsTotal: number; chargesTotal: 0; voidCashRetainedTotal: 0 };
    sales: { dineInSalesGross: number };
    guests: { guestCountFinalTotal: number; packageSessionsCount: number };
  };
}

export const v1BridgeDateAllowed = (businessDate: string): boolean => businessDate <= V1_BRIDGE_LAST_DATE;

/** A JSON number from exact centavos: 239671n -> 2396.71. */
const num = (m: Money): number => Number(toCentavos(m)) / 100;
const sum = (xs: Money[]): Money => (xs.length === 0 ? money('0') : add(...xs));

export function buildV1BridgePayload(input: { posStoreId: string; businessDate: string; closes: V1BridgeClose[] }): V1BridgePayload {
  const { posStoreId, businessDate, closes } = input;
  parseBusinessDate(businessDate);
  if (!v1BridgeDateAllowed(businessDate)) {
    throw refuse(`v1 bridge: ${businessDate} is after ${V1_BRIDGE_LAST_DATE}`, `Days after ${V1_BRIDGE_LAST_DATE} are not sent to v1.`);
  }

  const byMethod = new Map<string, Money>();
  for (const c of closes) {
    for (const t of c.tenders) {
      let key: string;
      if (t.kind === 'cash') key = 'cash';
      else if (t.v1Alias !== null && t.v1Alias.trim() !== '') key = t.v1Alias.trim();
      else throw refuse(`v1 bridge: tender "${t.name}" has no v1 alias`, `Tender ${t.name} has no v1 method mapping.`);
      byMethod.set(key, add(byMethod.get(key) ?? money('0'), money(t.amount)));
    }
  }
  const totalGross = sum(closes.map((c) => money(c.grossTotal)));
  const methods = sum([...byMethod.values()]);
  if (compare(methods, totalGross) !== 0) {
    throw refuse(
      `v1 bridge: methods ${methods} differ from the total ${totalGross} on ${businessDate}`,
      `The payments for ${businessDate} (${methods}) do not add up to the day's total (${totalGross}), so it was not sent to v1.`,
    );
  }

  const payments = {
    totalGross: num(totalGross),
    txCount: closes.reduce((a, c) => a + c.receiptCount, 0),
    byMethod: Object.fromEntries([...byMethod.entries()].map(([k, v]) => [k, num(v)])),
    discountsTotal: num(sum(closes.map((c) => money(c.discountTotal)))),
    chargesTotal: 0 as const,
    voidCashRetainedTotal: 0 as const,
  };
  return {
    path: `stores/${posStoreId}/analytics/${businessDate.replace(/-/g, '')}`,
    merge: false,
    data: {
      payments,
      sales: { dineInSalesGross: num(sum(closes.map((c) => money(c.unliSales)))) },
      guests: { guestCountFinalTotal: closes.reduce((a, c) => a + c.heads, 0), packageSessionsCount: closes.reduce((a, c) => a + c.packageSessions, 0) },
    },
  };
}
