/**
 * T-423 slice T - golden comparison of the new bill math with POS v1's. Ruling 2, Ruling 3, Acceptance 2.
 *
 * CONTRACT for the builder (S1) - `apps/pos/src/lib/tax.ts`:
 *   calculateBillTotals(billLines, store, billDiscount, customAdjustments, loyaltyDiscount?)  - SAME signature as today; returns
 *       the SAME TaxAndTotals keys as peso numbers, each one produced by `toWirePesos(<integer centavos>)` (so x === Math.round(x*100)/100).
 *   calculateBillTotalsCentavos(billLines, store, billDiscount, customAdjustments, loyaltyDiscount?): TaxAndTotalsCentavos
 *       - the same eleven keys (subtotal, taxableAmount, taxTotal, lineDiscountsTotal, billDiscountTotal, loyaltyDiscountTotal,
 *       totalDiscounts, chargesTotal, grandTotal, vatableSales, vatExemptSales) as INTEGER centavos (Number.isSafeInteger).
 *       Inputs stay peso numbers as stored in Firestore; they enter via `storedPesosToCentavos`.
 *   The private `round()` in tax.ts is deleted; rounding happens only at v1's named stages (tax.ts:129-131 gross/line discounts/
 *   line charges, the VAT split, totalDiscounts, grandTotal) and percent charges on "total" use the UNROUNDED tax, as v1 does.
 *
 * How the comparison works. v1's `calculateBillTotals` (vendored at `__fixtures__/tax-v1.ts`, commit e26d0c1) rounds in floating
 * point; an exact-rational ORACLE (BigInt fractions, the very same stages, half-up at exactly the same places) says what v1
 * meant. Where v1 and the oracle differ, v1 made a float error. Rules asserted below:
 *   (a) every field of the new result is within 1 centavo of v1's (waived only for a field where v1 is itself >1 centavo from the
 *       oracle: SPEC AMBIGUITY, Ruling 3 says ">1 centavo stops the lane" but a v1 float error amplified by percent charges
 *       reaches 2 centavos on ~1 bill in 2,500; those fields are judged against the oracle and listed for Ian's sign-off);
 *   (b) every field of the new result is within 1 centavo of the oracle's;
 *   (c) `grandTotal` (what the customer pays) equals v1's, EXCEPT on bills where v1 itself differs from the oracle and the new
 *       value equals the oracle's (class "v1-float-error"); any other difference fails and is printed;
 *   (d) every peso value on the wire times 100 is an integer; the centavo function returns integers and agrees with the peso one.
 * Counts per field and the classes are printed with console.log so the builder can paste them into "Golden findings".
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as taxNs from '@/lib/tax';
import * as v1 from '@/lib/__fixtures__/tax-v1';
import type { Adjustment, Discount, LineAdjustment, SessionBillLine, Store } from '@/lib/types';

// ---------------------------------------------------------------------------------------------
// The new API, typed locally so this file typechecks before the builder has written it.
// ---------------------------------------------------------------------------------------------
const FIELDS = [
  'subtotal', 'taxableAmount', 'taxTotal', 'lineDiscountsTotal', 'billDiscountTotal', 'loyaltyDiscountTotal',
  'totalDiscounts', 'chargesTotal', 'grandTotal', 'vatableSales', 'vatExemptSales',
] as const;
type Field = (typeof FIELDS)[number];
type Totals = Record<Field, number>;
type Loyalty = { type: 'fixed' | 'percent'; value: number }[] | null;
type CalcArgs = [SessionBillLine[], Store | null, Discount | null, Adjustment[], Loyalty?];
const calcPesos = (...a: CalcArgs): Totals => (taxNs as any).calculateBillTotals(...a);
const calcCentavos = (...a: CalcArgs): Totals => {
  const fn = (taxNs as any).calculateBillTotalsCentavos;
  if (typeof fn !== 'function') throw new Error('apps/pos/src/lib/tax.ts must export calculateBillTotalsCentavos (T-423 Ruling 2)');
  return fn(...a);
};
const v1Calc = (...a: CalcArgs): Totals => (v1 as any).calculateBillTotals(...a);

// ---------------------------------------------------------------------------------------------
// Exact rational arithmetic (BigInt fractions). The oracle.
// ---------------------------------------------------------------------------------------------
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
class Fr {
  readonly n: bigint; readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g; this.d = d / g;
  }
  static of(x: number | bigint): Fr {
    if (typeof x === 'bigint') return new Fr(x);
    const s = String(x);
    if (/e/i.test(s)) throw new Error(`oracle input ${s} must be a plain decimal`);
    const [i = '0', f = ''] = s.replace('-', '').split('.');
    const v = new Fr(BigInt(i + f), 10n ** BigInt(f.length));
    return x < 0 ? v.neg() : v;
  }
  add(o: Fr) { return new Fr(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Fr) { return new Fr(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Fr) { return new Fr(this.n * o.n, this.d * o.d); }
  div(o: Fr) { return new Fr(this.n * o.d, this.d * o.n); }
  neg() { return new Fr(-this.n, this.d); }
  cmp(o: Fr) { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  lt(o: Fr) { return this.cmp(o) < 0; }
  gt(o: Fr) { return this.cmp(o) > 0; }
  min(o: Fr) { return this.lt(o) ? this : o; }
  max(o: Fr) { return this.gt(o) ? this : o; }
  isZero() { return this.n === 0n; }
  /** x exactly on a half (n/d with 2n/d odd integer). */
  isHalf() { return (2n * this.n) % this.d === 0n && ((2n * this.n) / this.d) % 2n !== 0n; }
  /** half-up to an integer (ties toward +infinity for positives, away from zero for negatives, like v1's Math.round on |x|). */
  roundInt(): bigint {
    const neg = this.n < 0n;
    const a = neg ? -this.n : this.n;
    const r = (2n * a + this.d) / (2n * this.d);
    return neg ? -r : r;
  }
}

const ZERO = Fr.of(0), ONE = Fr.of(1), HUNDRED = Fr.of(100);

interface OracleOut { centavos: Totals; tieStages: number }

function oracle(
  billLines: SessionBillLine[], store: Store, billDiscount: Discount | null, customAdjustments: Adjustment[], loyalty: Loyalty,
): OracleOut {
  let ties = 0;
  /** round to a whole centavo (a peso Fr in, centavo bigint out), counting exact half-centavo stages. */
  const rc = (pesos: Fr): bigint => { const c = pesos.mul(HUNDRED); if (c.isHalf()) ties++; return c.roundInt(); };
  const peso = (c: bigint) => new Fr(c, 100n);

  const rate = Fr.of(store.taxRatePct || 0).div(HUNDRED);
  const inclusive = store.taxType === 'VAT_INCLUSIVE';
  const exclusive = store.taxType === 'VAT_EXCLUSIVE';
  const onePlus = ONE.add(rate);

  let gross = ZERO, lineDisc = ZERO, lineChg = ZERO;
  const active = billLines.filter((l) => l.qtyOrdered - (l.voidedQty || 0) > 0);
  for (const line of active) {
    const billable = line.qtyOrdered - (line.voidedQty || 0) - (line.freeQty || 0);
    if (billable <= 0) continue;
    const base = Number.isFinite(Number(line.unitPrice)) ? Math.max(0, Number(line.unitPrice)) : 0;
    const unit = Fr.of(base).add(Fr.of(Number((line as any).modifiersTotal || 0)));
    const q = Fr.of(billable);
    gross = gross.add(q.mul(unit));
    const baseUnit = inclusive && !rate.isZero() ? unit.div(onePlus) : unit;
    const adjs = (Object.values((line as any).lineAdjustments ?? {}) as LineAdjustment[]).sort((a, b) => (a.createdAtClientMs || 0) - (b.createdAtClientMs || 0));
    const hasAdjDiscount = adjs.some((a) => a.kind === 'discount');
    let remaining = billable;
    for (const adj of adjs) {
      if (adj.kind === 'discount') {
        if (remaining <= 0) continue;
        const qty = Math.min(Number(adj.qty || 0), remaining);
        if (qty <= 0) continue;
        if (adj.type === 'percent') lineDisc = lineDisc.add(Fr.of(qty).mul(unit).mul(Fr.of(Number(adj.value || 0)).div(HUNDRED)));
        else lineDisc = lineDisc.add(unit.min(Fr.of(Number(adj.value || 0))).mul(Fr.of(qty)));
        remaining -= qty;
      } else if (adj.kind === 'charge') {
        const qty = Math.min(Number(adj.qty || 0), billable);
        if (qty <= 0) continue;
        if (adj.type === 'percent') lineChg = lineChg.add(Fr.of(qty).mul(baseUnit).mul(Fr.of(Number(adj.value || 0)).div(HUNDRED)));
        else lineChg = lineChg.add(Fr.of(Number(adj.value || 0)).mul(Fr.of(qty)));
      }
    }
    if (!hasAdjDiscount && line.discountValue && line.discountValue > 0 && line.discountQty > 0) {
      const dq = Math.min(line.discountQty, billable);
      if (line.discountType === 'percent') lineDisc = lineDisc.add(Fr.of(dq).mul(unit).mul(Fr.of(line.discountValue).div(HUNDRED)));
      else lineDisc = lineDisc.add(unit.min(Fr.of(line.discountValue)).mul(Fr.of(dq)));
    }
  }
  const grossC = rc(gross), lineDiscC = rc(lineDisc), lineChgC = rc(lineChg);
  const grossR = peso(grossC), lineDiscR = peso(lineDiscC);

  const exemptBill = !!billDiscount?.vatExempt;
  let billDiscC = 0n, loyaltyC = 0n, vatExemptC = 0n;
  let vatable = ZERO, tax = ZERO;
  if (exemptBill && billDiscount) {
    const afterLine = grossR.sub(lineDiscR);
    const netBefore = inclusive && !rate.isZero() ? afterLine.div(onePlus) : afterLine;
    const bv = Fr.of(billDiscount.value);
    const exemptDisc = billDiscount.type === 'percent' ? netBefore.mul(bv.div(HUNDRED)) : netBefore.min(bv);
    billDiscC = rc(exemptDisc);
    vatExemptC = rc(netBefore.sub(exemptDisc).max(ZERO));
  } else {
    if (billDiscount) {
      const base = grossR.sub(lineDiscR);
      const bv = Fr.of(billDiscount.value);
      billDiscC = rc(billDiscount.type === 'percent' ? base.mul(bv.div(HUNDRED)) : base.min(bv));
    } else billDiscC = rc(ZERO);
    if (Array.isArray(loyalty) && loyalty.length > 0) {
      let remaining = grossR.sub(lineDiscR).sub(peso(billDiscC));
      let sum = ZERO;
      for (const lr of loyalty) {
        if (!lr || !(lr.value > 0) || !remaining.gt(ZERO)) continue;
        const v = Fr.of(lr.value);
        const amt = lr.type === 'percent' ? remaining.mul(v.div(HUNDRED)) : remaining.min(v);
        sum = sum.add(amt);
        remaining = remaining.sub(amt);
      }
      loyaltyC = rc(sum.max(ZERO));
    }
  }
  const totalDiscC = lineDiscC + billDiscC + loyaltyC; // sum of already-rounded parts: exact, v1's round() of it is a no-op
  const net = exemptBill ? peso(vatExemptC) : grossR.sub(peso(totalDiscC));
  if (!exemptBill) {
    if (inclusive) { vatable = net.div(onePlus); tax = net.sub(vatable); }
    else if (exclusive) { vatable = net; tax = vatable.mul(rate); }
    else { vatable = net; tax = ZERO; }
  }
  const beforeCharges = exclusive && !exemptBill ? net.add(tax) : net;
  let billChg = ZERO;
  for (const c of customAdjustments) {
    const v = Fr.of(Number(c.amount || 0));
    if (c.type === 'percent') billChg = billChg.add((c.appliesTo === 'total' ? beforeCharges : net).mul(v.div(HUNDRED)));
    else billChg = billChg.add(v);
  }
  const chargesC = rc(billChg.add(peso(lineChgC)));
  const grandC = rc(beforeCharges.add(peso(chargesC)));
  const c = (x: bigint) => Number(x);
  return {
    tieStages: ties,
    centavos: {
      subtotal: c(grossC), taxableAmount: c(rc(vatable)), taxTotal: c(rc(tax)), lineDiscountsTotal: c(lineDiscC),
      billDiscountTotal: c(billDiscC), loyaltyDiscountTotal: c(loyaltyC), totalDiscounts: c(totalDiscC),
      chargesTotal: c(chargesC), grandTotal: c(grandC), vatableSales: c(rc(vatable)), vatExemptSales: c(vatExemptC),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Generator: bills that land stages on x.xx5.
// ---------------------------------------------------------------------------------------------
interface Bill { lines: SessionBillLine[]; store: Store; billDiscount: Discount | null; adjustments: Adjustment[]; loyalty: Loyalty }

/** Percents chosen so price * pct / 100 often ends in half a centavo; plus any 2dp percent. */
const pctArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(5, 7.5, 10, 12.5, 15, 20, 25, 30, 35, 50, 0.5, 2.5, 8.25, 33.33, 66.67) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 10000 }).map((n) => n / 100) },
);
/** Prices in centavos biased to endings that make half-centavo products (…5, …25, …75) and sub-peso values. */
const centsArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 60000 }).map((n) => n * 5) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 4000 }).map((n) => n * 25) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 300000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 99 }) },
);
const pesos = (cents: number) => cents / 100;

const lineAdjArb = (qtyOrdered: number, idx: number): fc.Arbitrary<LineAdjustment> =>
  fc.record({
    kind: fc.constantFrom('discount', 'discount', 'charge') as fc.Arbitrary<'discount' | 'charge'>,
    type: fc.constantFrom('fixed', 'percent') as fc.Arbitrary<'fixed' | 'percent'>,
    pct: pctArb,
    fixedC: fc.integer({ min: 1, max: 80000 }),
    qty: fc.integer({ min: 1, max: Math.max(1, qtyOrdered) }),
  }).map(({ kind, type, pct, fixedC, qty }) => ({
    id: `a${idx}`, kind, note: 'x', type, value: type === 'percent' ? pct : pesos(fixedC), qty, createdAtClientMs: 1000 + idx, createdByUid: 'u',
  }));

const lineArb = (i: number): fc.Arbitrary<SessionBillLine> =>
  fc.integer({ min: 1, max: 12 }).chain((qtyOrdered) =>
    fc.record({
      unitC: centsArb,
      modC: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 9000 }) }),
      voided: fc.integer({ min: 0, max: Math.min(2, qtyOrdered) }),
      free: fc.integer({ min: 0, max: Math.min(2, qtyOrdered) }),
      adjs: fc.array(fc.nat(2), { maxLength: 2 }).chain((slots) =>
        fc.tuple(...slots.map((_, k) => lineAdjArb(qtyOrdered, i * 10 + k))).map((a) => a as LineAdjustment[]),
      ),
      legacy: fc.record({ type: fc.constantFrom('percent', 'fixed') as fc.Arbitrary<'percent' | 'fixed'>, pct: pctArb, fixedC: fc.integer({ min: 1, max: 5000 }), qty: fc.integer({ min: 0, max: qtyOrdered }) }),
      useLegacy: fc.boolean(),
      type: fc.constantFrom('package', 'addon') as fc.Arbitrary<'package' | 'addon'>,
    }).map((r): SessionBillLine => {
      const adjs: Record<string, LineAdjustment> = {};
      r.adjs.forEach((a) => { adjs[a.id] = a; });
      const useLegacy = r.useLegacy && r.adjs.length === 0;
      return {
        id: `l${i}`, type: r.type, itemId: `i${i}`, itemName: `Item ${i}`, unitPrice: pesos(r.unitC), qtyOrdered,
        discountType: useLegacy ? r.legacy.type : null,
        discountValue: useLegacy ? (r.legacy.type === 'percent' ? r.legacy.pct : pesos(r.legacy.fixedC)) : null,
        discountQty: useLegacy ? r.legacy.qty : 0,
        freeQty: r.free, voidedQty: r.voided, lineAdjustments: adjs, modifiersTotal: pesos(r.modC), createdAt: 0, updatedAt: 0,
      } as SessionBillLine;
    }),
  );

const billArb: fc.Arbitrary<Bill> = fc
  .record({
    n: fc.integer({ min: 1, max: 5 }),
    taxType: fc.constantFrom('VAT_INCLUSIVE', 'VAT_INCLUSIVE', 'VAT_EXCLUSIVE', 'NON_VAT') as fc.Arbitrary<NonNullable<Store['taxType']>>,
    taxRatePct: fc.constantFrom(12, 12, 12, 10, 5, 7.5, 0),
    disc: fc.option(
      fc.record({ type: fc.constantFrom('percent', 'percent', 'fixed') as fc.Arbitrary<'percent' | 'fixed'>, pct: pctArb, fixedC: fc.integer({ min: 1, max: 200000 }), vatExempt: fc.boolean() }),
      { nil: null, freq: 2 },
    ),
    adjustments: fc.array(
      fc.record({
        type: fc.constantFrom('fixed', 'percent') as fc.Arbitrary<'fixed' | 'percent'>,
        pct: fc.constantFrom(5, 10, 12, 2.5, 3.5, 7.5),
        fixedC: fc.integer({ min: 1, max: 30000 }),
        appliesTo: fc.constantFrom('subtotal', 'total', undefined) as fc.Arbitrary<'subtotal' | 'total' | undefined>,
      }),
      { maxLength: 3 },
    ),
    loyalty: fc.option(
      fc.array(fc.record({ type: fc.constantFrom('fixed', 'percent') as fc.Arbitrary<'fixed' | 'percent'>, pct: pctArb, fixedC: fc.integer({ min: 1, max: 100000 }) }), { minLength: 1, maxLength: 2 }),
      { nil: null, freq: 3 },
    ),
  })
  .chain((r) =>
    fc.tuple(...Array.from({ length: r.n }, (_, i) => lineArb(i))).map((lines): Bill => ({
      lines,
      store: { id: 's1', name: 'S', code: 'SHT', taxType: r.taxType, taxRatePct: r.taxRatePct } as Store,
      billDiscount: r.disc
        ? ({ id: 'd', name: 'D', type: r.disc.type, value: r.disc.type === 'percent' ? r.disc.pct : pesos(r.disc.fixedC), scope: ['bill'], stackable: true, isEnabled: true, vatExempt: r.disc.vatExempt } as unknown as Discount)
        : null,
      adjustments: r.adjustments.map((a, i) => ({ id: `c${i}`, note: 'n', type: a.type, amount: a.type === 'percent' ? a.pct : pesos(a.fixedC), source: 'custom', appliesTo: a.appliesTo }) as Adjustment),
      loyalty: r.loyalty ? r.loyalty.map((x) => ({ type: x.type, value: x.type === 'percent' ? x.pct : pesos(x.fixedC) })) : null,
    })),
  );

const SAMPLE = 2500;
const bills = (): Bill[] => fc.sample(billArb, { numRuns: SAMPLE, seed: 423423 });
const toC = (x: number) => Math.round(x * 100);
const run = (b: Bill) => ({
  v1: v1Calc(b.lines, b.store, b.billDiscount, b.adjustments, b.loyalty),
  orc: oracle(b.lines, b.store, b.billDiscount, b.adjustments, b.loyalty),
});
const args = (b: Bill): CalcArgs => [b.lines, b.store, b.billDiscount, b.adjustments, b.loyalty];

// ---------------------------------------------------------------------------------------------
describe('harness self-check (passes before the builder starts; proves the generator and oracle are worth trusting)', () => {
  it('generates at least 2,000 bills with many stages exactly on a half centavo', () => {
    const all = bills();
    expect(all.length).toBeGreaterThanOrEqual(2000);
    const withTie = all.filter((b) => run(b).orc.tieStages > 0).length;
    console.log(`[golden] bills=${all.length} withHalfCentavoStage=${withTie}`);
    expect(withTie).toBeGreaterThanOrEqual(all.length * 0.05);
  });

  it("the oracle agrees with v1 to within 1 centavo, and v1 does make float errors on these edges", () => {
    const all = bills();
    let v1Wrong = 0, v1WrongGrand = 0, tooFar = 0;
    for (const b of all) {
      const { v1: r, orc } = run(b);
      let wrong = false;
      for (const f of FIELDS) {
        const d = Math.abs(toC(r[f]) - orc.centavos[f]);
        if (d > 1) tooFar++;
        if (d > 0) { wrong = true; if (f === 'grandTotal') v1WrongGrand++; }
      }
      if (wrong) v1Wrong++;
    }
    console.log(`[golden] v1 differs from the exact oracle on ${v1Wrong} bills (grandTotal on ${v1WrongGrand}); fields >1 centavo apart: ${tooFar}`);
    // A v1 float error in an early stage can be AMPLIFIED by a percent charge (7.5% + 10% of the total) into 2 centavos
    // (seed 423423 has one: v1 5467.91, exact 5467.89, checked independently with Python fractions). Rare, but real:
    // see SPEC AMBIGUITY in the header and the waiver below.
    expect(tooFar).toBeLessThanOrEqual(all.length * 0.005);
    expect(v1WrongGrand).toBeGreaterThan(0); // else the grandTotal rule below would be vacuous
  });
});

describe('calculateBillTotalsCentavos / calculateBillTotals versus v1 (Acceptance 2)', () => {
  it('2,500 generated bills: every field within 1 centavo of v1 and of the oracle; grandTotal differs only by v1 float error', () => {
    const all = bills();
    const diffV1: Record<string, number> = {};
    const diffOracle: Record<string, number> = {};
    const classes = { same: 0, 'v1-float-error': 0, unexplained: 0 };
    const problems: string[] = [];
    const waived: string[] = [];
    for (const b of all) {
      const { v1: r1, orc } = run(b);
      const nc = calcCentavos(...args(b));
      for (const f of FIELDS) {
        const v1c = toC(r1[f]);
        if (!Number.isSafeInteger(nc[f])) problems.push(`${f} is not an integer centavo count: ${nc[f]}`);
        if (nc[f] !== v1c) diffV1[f] = (diffV1[f] ?? 0) + 1;
        if (nc[f] !== orc.centavos[f]) diffOracle[f] = (diffOracle[f] ?? 0) + 1;
        // Ruling 3's "<= 1 centavo from v1" is waived ONLY for a field where v1 itself is more than 1 centavo away from the
        // exact oracle (v1 float error amplified by a percent charge); the field is then judged against the oracle alone.
        const v1Far = Math.abs(v1c - orc.centavos[f]) > 1;
        if (v1Far) waived.push(`${f}: v1 ${v1c}, exact ${orc.centavos[f]}, new ${nc[f]}`);
        else if (Math.abs(nc[f] - v1c) > 1) problems.push(`${f}: new ${nc[f]} vs v1 ${v1c} differ by more than 1 centavo`);
        if (Math.abs(nc[f] - orc.centavos[f]) > 1) problems.push(`${f}: new ${nc[f]} vs oracle ${orc.centavos[f]} differ by more than 1 centavo`);
      }
      const v1g = toC(r1.grandTotal), og = orc.centavos.grandTotal;
      if (nc.grandTotal === v1g) classes.same++;
      else if (v1g !== og && nc.grandTotal === og) classes['v1-float-error']++;
      else { classes.unexplained++; if (problems.length < 40) problems.push(`grandTotal unexplained: new ${nc.grandTotal}, v1 ${v1g}, oracle ${og}`); }
    }
    console.log('[golden] bills whose field differs from v1 (per field):', JSON.stringify(diffV1));
    console.log('[golden] bills whose field differs from the exact oracle (per field):', JSON.stringify(diffOracle));
    console.log('[golden] grandTotal classes:', JSON.stringify(classes));
    console.log(`[golden] fields where v1 is >1 centavo from the exact answer (for Ian's sign-off): ${waived.length}`, waived.slice(0, 5));
    expect(problems.slice(0, 10)).toEqual([]);
    expect(classes.unexplained).toBe(0);
  });

  it('every peso value on the wire is an exact centavo (x*100 is an integer), the centavo and peso functions agree (property, random seed)', () => {
    fc.assert(
      fc.property(billArb, (b) => {
        const pesosOut = calcPesos(...args(b));
        const cents = calcCentavos(...args(b));
        for (const f of FIELDS) {
          const x = pesosOut[f];
          expect(Number.isInteger(Math.round(x * 100)) && x === Math.round(x * 100) / 100, `${f}=${x}`).toBe(true);
          expect(x).toBe(cents[f] / 100);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('a null store still returns all-zero totals (v1 behaviour kept)', () => {
    const z = calcCentavos([], null, null, []);
    for (const f of FIELDS) expect(z[f]).toBe(0);
  });

  it('pinned half-centavo case: a 10% discount on a 5-centavo price', () => {
    const store = { id: 's', name: 'S', code: 'SHT', taxType: 'NON_VAT', taxRatePct: 0 } as Store;
    const line = { id: 'l', type: 'addon', itemId: 'i', itemName: 'x', unitPrice: 0.05, qtyOrdered: 1, discountType: 'percent', discountValue: 10, discountQty: 1, freeQty: 0, voidedQty: 0, createdAt: 0, updatedAt: 0 } as SessionBillLine;
    const r = calcCentavos([line], store, null, []);
    // 0.05 * 10% = 0.005 pesos = half a centavo -> half-up -> 1 centavo off; subtotal 5 - 1 = 4
    expect(r.lineDiscountsTotal).toBe(1);
    expect(r.grandTotal).toBe(4);
  });
});
