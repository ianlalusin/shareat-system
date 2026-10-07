/**
 * T-375 S0 - the census of live POS data: counters (a)-(h) and the gate. `docs/tasks/375-pos-v1-day-feed.md` S0.
 *
 * PURE: no I/O. `scripts/pos-v1-feed-census.ts` fetches; this classifies one parsed `sales` body into counters and
 * decides the gate. It reuses R4's own pieces (`toCentavos`, the wire field names, the rounding band `X <= N`
 * centavos) so a day is read here exactly as `deriveSalesDay` reads it. It keeps NO body: counts and maxima only.
 *
 * No tenders exist at census time, so "cash methods" for (e2)'s second count is the method(s) whose normalized
 * name is `cash`; that is an approximation of the store's cash tender, and the report says so.
 */
import { POS_V1_SALES_FIELDS as S } from '@shareat/db';
import { normalizePosV1Alias, toCentavos } from './v1-methods';

/** What one day was, for counting. Centavos as bigint. */
export interface DayClass {
  readonly found: boolean;
  /** A figure was missing, not a number, or the receipt count was unusable. */
  readonly unreadable: boolean;
  /** A non-centavo value anywhere, or a negative P/D/C/K. */
  readonly nonCentavo: boolean;
  readonly negativeMethod: boolean;
  readonly short: boolean;
  readonly refund: boolean;
  readonly refundOverCash: boolean;
  /** P + D + refunds - C < 0: the derivation refuses it. */
  readonly negativeTotal: boolean;
  /** 0 < X <= N centavos: booked as rounding. */
  readonly rounding: boolean;
  readonly x: bigint;
  readonly capExcess: bigint;
  readonly hasCharges: boolean;
  readonly methodNames: readonly string[];
}

const NOT_FOUND: DayClass = {
  found: false, unreadable: false, nonCentavo: false, negativeMethod: false, short: false, refund: false,
  refundOverCash: false, negativeTotal: false, rounding: false, x: 0n, capExcess: 0n, hasCharges: false, methodNames: [],
};

export function classifyDay(payload: unknown): DayClass {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ...NOT_FOUND, unreadable: true };
  const body = payload as Record<string, unknown>;
  if (body[S.found] !== true) return NOT_FOUND;

  let nonCentavo = false;
  let unreadable = false;
  const fig = (key: string): bigint => {
    const v = body[key];
    if (typeof v !== 'number') { unreadable = true; return 0n; }
    const c = toCentavos(v);
    if (c === null || c < 0n) { nonCentavo = true; return 0n; }
    return c;
  };
  const P = fig(S.paidTotal);
  const D = fig(S.discounts);
  const C = fig(S.charges);
  const K = fig(S.packageOnly);
  const n = body[S.receiptCount];
  const countOk = typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (!countOk) unreadable = true;
  const N = countOk ? BigInt(n) : 0n;

  const rawMethods = body[S.methods];
  let methods: Record<string, unknown> = {};
  if (typeof rawMethods === 'object' && rawMethods !== null && !Array.isArray(rawMethods)) methods = rawMethods as Record<string, unknown>;
  else unreadable = true;

  let M = 0n;
  let cash = 0n;
  let negativeMethod = false;
  const methodNames: string[] = [];
  for (const [name, amount] of Object.entries(methods)) {
    const c = typeof amount === 'number' ? toCentavos(amount) : null;
    if (c === null) { nonCentavo = true; continue; }
    if (c === 0n) continue;
    if (c < 0n) { negativeMethod = true; continue; }
    methodNames.push(name);
    M += c;
    if (normalizePosV1Alias(name) === 'cash') cash += c;
  }

  const base = { found: true, unreadable, nonCentavo, negativeMethod, hasCharges: C > 0n, methodNames };
  // The arithmetic needs every figure readable and every method non-negative, as the derivation's refusals do.
  if (unreadable || nonCentavo || negativeMethod) return { ...NOT_FOUND, ...base };
  const x = M - P;
  if (x < 0n) return { ...NOT_FOUND, ...base, short: true, x };
  const rounding = x > 0n && x <= N;
  const refund = x > 0n && !rounding;
  const refunds = refund ? x : 0n;
  const total = P + D + refunds - C;
  if (total < 0n) return { ...NOT_FOUND, ...base, refund, rounding, x, refundOverCash: refund && refunds > cash, negativeTotal: true };
  const capExcess = K > total ? K - total : 0n;
  return { ...NOT_FOUND, ...base, refund, rounding, x, refundOverCash: refund && refunds > cash, capExcess };
}

export interface Census {
  days: number;
  found: number;
  unreadableDays: number;
  shortDays: number;
  refundDays: number;
  refundsOverCashDays: number;
  roundingDays: number;
  roundingMax: bigint;
  capDays: number;
  capMax: bigint;
  nonCentavoDays: number;
  negativeMethodDays: number;
  negativeTotalDays: number;
  chargeDays: number;
  methodNames: Set<string>;
  /** Days POS did not answer (non-2xx / not JSON): no figures, and the gate cannot pass over a hole. */
  failedDays: number;
}

export function emptyCensus(): Census {
  return {
    days: 0, found: 0, unreadableDays: 0, shortDays: 0, refundDays: 0, refundsOverCashDays: 0, roundingDays: 0,
    roundingMax: 0n, capDays: 0, capMax: 0n, nonCentavoDays: 0, negativeMethodDays: 0, negativeTotalDays: 0, chargeDays: 0,
    methodNames: new Set(), failedDays: 0,
  };
}

export function addDay(c: Census, d: DayClass): void {
  c.days += 1;
  if (d.unreadable) c.unreadableDays += 1;
  if (!d.found) return;
  c.found += 1;
  if (d.nonCentavo) c.nonCentavoDays += 1;
  if (d.negativeMethod) c.negativeMethodDays += 1;
  if (d.short) c.shortDays += 1;
  if (d.negativeTotal) c.negativeTotalDays += 1;
  if (d.refund) c.refundDays += 1;
  if (d.refundOverCash) c.refundsOverCashDays += 1;
  if (d.rounding) {
    c.roundingDays += 1;
    if (d.x > c.roundingMax) c.roundingMax = d.x;
  }
  if (d.capExcess > 0n) {
    c.capDays += 1;
    if (d.capExcess > c.capMax) c.capMax = d.capExcess;
  }
  if (d.hasCharges) c.chargeDays += 1;
  for (const m of d.methodNames) c.methodNames.add(m);
}

/** The gate: (e1), (d), (e) and (e2)'s second count are 0; an unreadable day or one POS would not answer also fails. */
export function censusGate(c: Census): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (c.shortDays > 0) failed.push(`(e1) days with methods short of the total: ${c.shortDays}`);
  if (c.nonCentavoDays > 0) failed.push(`(d) days with a non-centavo or negative figure: ${c.nonCentavoDays}`);
  if (c.negativeMethodDays > 0) failed.push(`(e) days with a negative method total: ${c.negativeMethodDays}`);
  if (c.refundsOverCashDays > 0) failed.push(`(e2) days where refunds exceed cash: ${c.refundsOverCashDays}`);
  if (c.negativeTotalDays > 0) failed.push(`(n) days with a negative total (charges exceed sales): ${c.negativeTotalDays}`);
  if (c.unreadableDays > 0) failed.push(`unreadable days (a figure or the receipt count missing): ${c.unreadableDays}`);
  if (c.failedDays > 0) failed.push(`days POS did not answer: ${c.failedDays}`);
  return { pass: failed.length === 0, failed };
}

function pesos(centavos: bigint): string {
  const s = centavos.toString().padStart(3, '0');
  return `${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${s.slice(-2)}`;
}

export function formatCensus(label: string, c: Census, days: number): string {
  const gate = censusGate(c);
  return [
    `store ${label}: ${c.days} days checked (window ${days}), counts only`,
    `(a) days found: ${c.found}`,
    `(e1) X < 0 (methods short of total): ${c.shortDays}`,
    `(e2) days with refunds (X > 0.01 x N): ${c.refundDays}; of those, refunds exceed cash methods: ${c.refundsOverCashDays} (cash = method named "cash")`,
    `(r) days 0 < X <= 0.01 x N (booked as rounding): ${c.roundingDays}; largest X: ${pesos(c.roundingMax)}`,
    `(c) days K > P + D - C + refunds (W1 cap fires): ${c.capDays}; largest excess: ${pesos(c.capMax)}`,
    `(d) non-centavo or negative figure: ${c.nonCentavoDays}`,
    `(e) negative method: ${c.negativeMethodDays}`,
    `(f) distinct method names (${c.methodNames.size}): ${[...c.methodNames].sort().join(', ') || '-'}`,
    `(n) days with a negative total (charges exceed sales; the import refuses these): ${c.negativeTotalDays}`,
    `(g) days with charges > 0: ${c.chargeDays}`,
    `(h) DEF-061 gross-or-net basis: not measurable through the bridge`,
    gate.pass ? 'GATE PASS' : `GATE FAIL: ${gate.failed.join('; ')}`,
  ].join('\n');
}
