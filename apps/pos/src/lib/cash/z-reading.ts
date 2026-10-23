/**
 * T-471 S1 - the Z / X reading maths (docs/tasks/471-pos-day-close-z-reading.md). PURE: no firebase, no React, no server-only, so the POS v2 server
 * (the Z is the server's record) and the tablet formatter share one definition. Money is integer centavos everywhere in the result; the only pesos are the
 * values READ from Firestore documents, turned into centavos at the edge by storedPesosToCentavos.
 *
 * Ruling 1: a business day runs from the previous Z to this one ("Z to Z"), half-open [fromMs, toMs). The first Z at a store starts at 04:00 Manila
 * (the same rule as lib/cash/handover.ts getShiftDayStartMs, restated here without that file's firebase import).
 * Bible row 391: cash refunds come off expected cash (start + cash sales + Convert net + adjustments - deductions - cash refunds).
 * Ruling 5: a receipt belongs to the window of its sale moment (createdAtClientMs). One that was rung before the last Z but only reached the server after
 * it is counted on THIS Z and listed as late; a printed Z is never recomputed.
 */
import { storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { isCashMethod } from './cash-method';
import { computeExpectedCash, negativeMethods } from './convert-net';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MANILA = 8 * HOUR; // Asia/Manila is UTC+8 all year (no daylight saving)

export interface ZWindow { fromMs: number; toMs: number; spansTwoDates: boolean; fromDate: string; toDate: string }

export interface ZMethodLine { method: string; saleCentavos: number; refundCentavos: number; convertCentavos: number; netCentavos: number }

export interface ZReading {
  receiptCount: number;
  grossCentavos: number;
  chargesCentavos: number;
  discounts: { ordinaryCentavos: number; seniorPwd: { dinerCount: number; centavos: number }; totalCentavos: number };
  refunds: { count: number; centavos: number };
  voids: { count: number; centavos: number };
  byMethod: ZMethodLine[];
  totals: { saleCentavos: number; refundCentavos: number; netCentavos: number };
  convertNetCashCentavos: number;
  cash: { startingCentavos: number; salesCentavos: number; convertNetCentavos: number; deductionsCentavos: number; expectedCentavos: number; refundsPaidCentavos: number;
    /** Cash kept on voided sales, already INSIDE salesCentavos (and so inside expected cash); the slip prints it on its own line so the cash lines add up. */
    voidCashKeptCentavos: number };
  lastHandover: { countedCentavos: number; varianceCentavos: number } | null;
  negativeMethods: string[];
  lateReceiptNumbers: string[];
}

/** The reading plus the Firestore doc ids of every receipt it counted (sales, refunds, voids, late ones). A later Z must not count a late receipt whose id is here. */
export type ZReadingWithIds = ZReading & { receiptIds: string[] };

export function formatZNo(n: number): string {
  return `Z-${String(n).padStart(4, '0')}`;
}

/** 'Z-0007' -> 7. Anything that is not Z- plus digits, or is zero, -> null. */
export function parseZNo(s: string): number | null {
  const m = /^Z-(\d+)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const manilaDate = (ms: number) => new Date(ms + MANILA).toISOString().slice(0, 10);

/** 04:00 Manila of the shift day that contains `nowMs` (before 04:00 it is the previous day's). */
function firstZStartMs(nowMs: number): number {
  const shifted = nowMs + MANILA;
  const dayIndex = Math.floor((shifted - 4 * HOUR) / DAY);
  return dayIndex * DAY + 4 * HOUR - MANILA;
}

export function zWindow(i: { lastZToMs: number | null; nowMs: number }): ZWindow {
  const fromMs = i.lastZToMs ?? firstZStartMs(i.nowMs);
  const toMs = i.nowMs;
  return { fromMs, toMs, spansTwoDates: toMs - fromMs > DAY, fromDate: manilaDate(fromMs), toDate: manilaDate(toMs) };
}

const msOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = (v as { toMillis?: () => number } | null)?.toMillis;
  if (typeof t === 'function') { const n = t.call(v); return Number.isFinite(n) ? n : null; }
  return null;
};

type Doc = Record<string, any>;

export function computeZReading(i: {
  window: ZWindow;
  lastZPrintedAtMs: number | null;
  /** Ids already counted by an earlier Z whose window reaches into the late-lookback period: such a receipt is never late again. */
  countedReceiptIds?: ReadonlySet<string>;
  receipts: readonly Doc[];
  conversions: readonly Doc[];
  handovers: readonly Doc[];
  cashNames: ReadonlySet<string>;
}): ZReadingWithIds {
  const { fromMs, toMs } = i.window;
  const isCash = (name: string) => isCashMethod(name, i.cashNames);
  const lines = new Map<string, ZMethodLine>();
  const line = (method: string) => {
    let l = lines.get(method);
    if (!l) { l = { method, saleCentavos: 0, refundCentavos: 0, convertCentavos: 0, netCentavos: 0 }; lines.set(method, l); }
    return l;
  };
  let receiptCount = 0, gross = 0, charges = 0, ordinary = 0, dinerCount = 0, seniorPwd = 0;
  let refundCount = 0, refundC = 0, voidCount = 0, voidC = 0, cashSales = 0, cashRefunds = 0;
  const late: string[] = [];
  const ids: string[] = [];
  let voidKept = 0;

  for (const r of i.receipts) {
    const saleMs = msOf(r.createdAtClientMs);
    if (saleMs === null) continue;
    const inWindow = saleMs >= fromMs && saleMs < toMs;
    if (!inWindow) {
      const arrived = msOf(r.createdAt);
      const isLate = saleMs < fromMs && i.lastZPrintedAtMs !== null && arrived !== null && arrived >= i.lastZPrintedAtMs && !i.countedReceiptIds?.has(String(r.id ?? ''));
      if (!isLate) continue;
      late.push(String(r.receiptNumber ?? r.id ?? ''));
    }
    if (r.id !== undefined && r.id !== null && r.id !== '') ids.push(String(r.id));
    if (r.isRefund === true) {
      if (r.status === 'voided') continue;
      const cents = Number.isSafeInteger(r.refundTotalCentavos) ? (r.refundTotalCentavos as number) : storedPesosToCentavos(Math.abs(Number(r.total ?? 0)));
      refundCount += 1; refundC += cents;
      const method = String(r.refundTender?.methodName ?? '');
      line(method).refundCentavos += cents;
      if (isCash(method)) cashRefunds += cents;
      continue;
    }
    const a = (r.analytics ?? {}) as Doc;
    if (r.status === 'voided') {
      voidCount += 1; voidC += storedPesosToCentavos(a.grandTotal ?? r.total);
      // Cash kept on a void is in the drawer (the same rule as computeCashSales), until a re-ring has taken it over.
      if (r.voidCashRetainedReversed !== true) { const kept = Number(r.voidCashRetained || 0); if (kept > 0) { const c = storedPesosToCentavos(kept); cashSales += c; voidKept += c; } }
      continue;
    }
    receiptCount += 1;
    gross += storedPesosToCentavos(a.subtotal);
    charges += storedPesosToCentavos(a.chargesTotal);
    // analytics.discountsTotal already INCLUDES the senior/PWD discount (statutory/totals.ts totalDiscounts), so the ordinary part is the rest.
    const statutory = storedPesosToCentavos(a.statutoryDiscountTotal);
    ordinary += storedPesosToCentavos(a.discountsTotal) - statutory;
    seniorPwd += statutory;
    dinerCount += Array.isArray(r.statutoryDiners) ? r.statutoryDiners.length : 0;
    for (const [method, pesos] of Object.entries((a.mop ?? {}) as Record<string, number>)) {
      const cents = storedPesosToCentavos(pesos);
      line(method).saleCentavos += cents;
      if (isCash(method)) cashSales += cents;
    }
  }

  let convertCash = 0;
  for (const c of i.conversions) {
    const ms = msOf(c.createdAtClientMs);
    if (c.status !== 'active' || ms === null || ms < fromMs || ms >= toMs) continue;
    const cents = storedPesosToCentavos(c.amount);
    line(String(c.fromMethod)).convertCentavos -= cents;
    line(String(c.toMethod)).convertCentavos += cents;
    convertCash += ((isCash(String(c.toMethod)) ? 1 : 0) - (isCash(String(c.fromMethod)) ? 1 : 0)) * cents;
  }

  const handovers = i.handovers
    .filter((h) => { const ms = msOf(h.periodEndMs); return ms !== null && ms >= fromMs && ms < toMs; })
    .sort((a, b) => Number(a.periodEndMs) - Number(b.periodEndMs));
  const deductions = handovers.reduce((n, h) => n + storedPesosToCentavos(h.deductionsTotal), 0);
  const manual = handovers.reduce((n, h) => n + storedPesosToCentavos(h.manualCashAdjustment ?? 0), 0);
  const starting = handovers.length ? storedPesosToCentavos(handovers[0]!.startingCash) : 0;
  const last = handovers[handovers.length - 1];
  const expected = storedPesosToCentavos(computeExpectedCash({
    startingCash: toWirePesos(starting), cashSales: toWirePesos(cashSales), convertNet: toWirePesos(convertCash),
    deductions: toWirePesos(deductions), manualCashAdjustment: toWirePesos(manual), cashRefunds: toWirePesos(cashRefunds),
  }));

  const byMethod = [...lines.values()].sort((a, b) => a.method.localeCompare(b.method));
  for (const l of byMethod) l.netCentavos = l.saleCentavos - l.refundCentavos + l.convertCentavos;
  const sum = (f: (l: ZMethodLine) => number) => byMethod.reduce((n, l) => n + f(l), 0);

  return {
    receiptCount, grossCentavos: gross, chargesCentavos: charges,
    discounts: { ordinaryCentavos: ordinary, seniorPwd: { dinerCount, centavos: seniorPwd }, totalCentavos: ordinary + seniorPwd },
    refunds: { count: refundCount, centavos: refundC }, voids: { count: voidCount, centavos: voidC },
    byMethod,
    totals: { saleCentavos: sum((l) => l.saleCentavos), refundCentavos: sum((l) => l.refundCentavos), netCentavos: sum((l) => l.netCentavos) },
    convertNetCashCentavos: convertCash,
    cash: { startingCentavos: starting, salesCentavos: cashSales, convertNetCentavos: convertCash, deductionsCentavos: deductions, expectedCentavos: expected, refundsPaidCentavos: cashRefunds, voidCashKeptCentavos: voidKept },
    lastHandover: last ? { countedCentavos: storedPesosToCentavos(last.countedCash), varianceCentavos: storedPesosToCentavos(last.variance) } : null,
    negativeMethods: negativeMethods(Object.fromEntries(byMethod.map((l) => [l.method, toWirePesos(l.netCentavos)]))),
    lateReceiptNumbers: late.sort(), receiptIds: ids.sort(),
  };
}
