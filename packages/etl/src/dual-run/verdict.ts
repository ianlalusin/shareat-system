/** T-392 S2 - the sign-off pack over many store-week results (R12). Pure. */
import type { StoreWeekResult } from './compare';

export interface SignOffPack {
  countedWeeks: StoreWeekResult[];
  noData: StoreWeekResult[];
  open: StoreWeekResult[];
  comparedDaysTotal: number;
  comparedDaysByStore: Record<string, number>;
}

/** no_data weeks are listed apart and never counted: not in countedWeeks, not in the day totals. */
export function signOffPack(results: StoreWeekResult[]): SignOffPack {
  const noData = results.filter((r) => r.verdict === 'no_data');
  const countedWeeks = results.filter((r) => r.verdict !== 'no_data');
  const open = countedWeeks.filter((r) => r.verdict === 'open');
  const comparedDaysByStore: Record<string, number> = {};
  let comparedDaysTotal = 0;
  for (const r of countedWeeks) {
    comparedDaysTotal += r.comparedDays.length;
    comparedDaysByStore[r.storeId] = (comparedDaysByStore[r.storeId] ?? 0) + r.comparedDays.length;
  }
  return { countedWeeks, noData, open, comparedDaysTotal, comparedDaysByStore };
}
