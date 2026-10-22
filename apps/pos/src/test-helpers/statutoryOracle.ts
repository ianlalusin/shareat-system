/**
 * T-426 slice T - shared test helpers for the senior/PWD per-diner lane. NEW file (no production import except types).
 *
 * Holds: (1) an exact-rational ORACLE (BigInt fractions) for the statutory bill math of Ruling 3, written independently of the
 * production code and from the spec's named rounding stages; (2) bill generators; (3) small builders; (4) a loader that turns a
 * missing module into a readable failure ("T-426 module not written yet") instead of a transform error.
 *
 * ORACLE STAGES (all amounts integer centavos; "exact" = BigInt fraction; rc() = round half up):
 *   shareNet_i      = share_i / (1 + rate)  at a VAT-inclusive store with a rate, else share_i
 *   twenty_i        = shareNet_i x 20%
 *   statutoryDiscount      = rc( sum twenty_i )                                 (ONE rounding over the exact sum)
 *   vatExemptSales         = rc( sum shareNet_i - sum twenty_i )                (ONE rounding over the exact sum)
 *   statutoryVatRemoved    = sum share_i - statutoryDiscount - vatExemptSales   (from the ROUNDED figures: the receipt adds up)
 *   remainder R            = subtotal - sum share_i                             (no line adjustments in generated bills)
 *   billDiscount (promo)   = rc( R x promo% )                                   (T-423's path on the remainder only)
 *   loyalty                = T-423 loop on (R - billDiscount)                   (remainder only)
 *   remNet                 = R - billDiscount - loyalty
 *   VAT split of remNet    = T-423 (inclusive: remNet/(1+r) and the rest; exclusive: remNet and remNet x r, tax unrounded; none)
 *   netSales               = remNet + vatExemptSales                            (charge base 'subtotal' / default; Ruling 3 "Charges")
 *   totalBeforeCharges     = netSales (+ unrounded tax at an exclusive store)   (charge base 'total')
 *   chargesTotal           = rc( sum percent/fixed charges )
 *   grandTotal             = rc( totalBeforeCharges + chargesTotal )
 *   totalDiscounts         = lineDiscounts(0) + billDiscount + loyalty + statutoryDiscount
 * Generated bills never let a promo beat the 20% (promo <= 17% of the share's gross, the 20% alone is 17.86% of gross at 12% VAT),
 * so the oracle needs no promo-takes-the-diner branch; that branch has its own pinned examples in bill-math.test.ts.
 */
import fc from 'fast-check';
import type { Adjustment, Discount, SessionBillLine, Store } from '@/lib/types';

// ---------------------------------------------------------------------------------------------
// Types the production code is contracted to accept (see the header comments of the test files).
// ---------------------------------------------------------------------------------------------
export type DinerKind = 'senior' | 'pwd';
export interface Diner {
  id: string;
  kind: DinerKind;
  name: string;
  idNo: string;
  idNoNormalized: string;
  addedByUid: string;
  addedAtClientMs: number;
  dishLineIds: string[];
}
export interface PackageInfo { isBundle?: boolean; bundleMaxCap?: number }
export interface StatInput { diners: Diner[]; heads: number | null; package?: PackageInfo | null }
export type Loyalty = { type: 'fixed' | 'percent'; value: number }[] | null;

export interface StatOut {
  subtotal: number; taxableAmount: number; taxTotal: number; lineDiscountsTotal: number; billDiscountTotal: number;
  loyaltyDiscountTotal: number; totalDiscounts: number; chargesTotal: number; grandTotal: number; vatableSales: number; vatExemptSales: number;
  statutoryDiscountTotal: number; statutoryVatRemovedTotal: number;
  statutoryDiners: { dinerId?: string; kind: DinerKind; share: number; discount: number; vatRemoved: number; vatExempt: number; promoWasHigher?: boolean }[];
}
export const OLD_FIELDS = [
  'subtotal', 'taxableAmount', 'taxTotal', 'lineDiscountsTotal', 'billDiscountTotal', 'loyaltyDiscountTotal',
  'totalDiscounts', 'chargesTotal', 'grandTotal', 'vatableSales', 'vatExemptSales',
] as const;

// ---------------------------------------------------------------------------------------------
// Loader: a missing production module is a plain, named failure.
// ---------------------------------------------------------------------------------------------
export async function loadMod(path: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ path);
  } catch (e: any) {
    throw new Error(`T-426 module not written yet or broken: ${path} (${String(e?.message ?? e).slice(0, 120)})`);
  }
}
export function need<T>(mod: any, name: string, where: string): T {
  const fn = mod?.[name];
  if (fn === undefined) throw new Error(`${where} must export \`${name}\` (T-426 contract)`);
  return fn as T;
}

// ---------------------------------------------------------------------------------------------
// Exact fractions
// ---------------------------------------------------------------------------------------------
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
export class Fr {
  readonly n: bigint; readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g; this.d = d / g;
  }
  static int(x: number | bigint): Fr { return new Fr(BigInt(x)); }
  static dec(x: number): Fr {
    const s = String(x);
    if (/e/i.test(s)) throw new Error(`oracle input ${s} must be a plain decimal`);
    const [i = '0', f = ''] = s.replace('-', '').split('.');
    const v = new Fr(BigInt(i + f), 10n ** BigInt(f.length));
    return x < 0 ? new Fr(-v.n, v.d) : v;
  }
  add(o: Fr) { return new Fr(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Fr) { return new Fr(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Fr) { return new Fr(this.n * o.n, this.d * o.d); }
  div(o: Fr) { return new Fr(this.n * o.d, this.d * o.n); }
  cmp(o: Fr) { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  gt(o: Fr) { return this.cmp(o) > 0; }
  min(o: Fr) { return this.cmp(o) < 0 ? this : o; }
  max(o: Fr) { return this.cmp(o) > 0 ? this : o; }
  /** exactly on a half centavo */
  isHalf() { return (2n * this.n) % this.d === 0n && ((2n * this.n) / this.d) % 2n !== 0n; }
  rc(): number {
    const neg = this.n < 0n;
    const a = neg ? -this.n : this.n;
    const r = (2n * a + this.d) / (2n * this.d);
    return Number(neg ? -r : r);
  }
}
const ZERO = Fr.int(0), ONE = Fr.int(1), HUNDRED = Fr.int(100), TWENTY_PCT = Fr.dec(0.2);

// ---------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------
export interface OracleIn {
  subtotalC: number;
  store: Store;
  promoPct: number | null;
  adjustments: Adjustment[];
  loyalty: Loyalty;
  sharesC: number[];
}
export interface OracleOut extends Omit<StatOut, 'statutoryDiners'> { halfCentavoStage: boolean }

export function oracleStat(i: OracleIn): OracleOut {
  const rate = Fr.dec(Number(i.store.taxRatePct || 0)).div(HUNDRED);
  const inclusive = i.store.taxType === 'VAT_INCLUSIVE';
  const exclusive = i.store.taxType === 'VAT_EXCLUSIVE';
  const hasRate = rate.gt(ZERO);
  const onePlus = ONE.add(rate);
  const G = i.subtotalC;
  const S = i.sharesC.reduce((a, b) => a + b, 0);
  const R = G - S;

  let sumNet = ZERO, sumTwenty = ZERO;
  for (const s of i.sharesC) {
    const net = inclusive && hasRate ? Fr.int(s).div(onePlus) : Fr.int(s);
    sumNet = sumNet.add(net);
    sumTwenty = sumTwenty.add(net.mul(TWENTY_PCT));
  }
  const exemptExact = sumNet.sub(sumTwenty);
  const statDisc = sumTwenty.rc();
  const exemptC = exemptExact.rc();
  const statVat = S - statDisc - exemptC;
  const half = sumTwenty.isHalf() || exemptExact.isHalf();

  const billDiscC = i.promoPct ? Fr.int(R).mul(Fr.dec(i.promoPct).div(HUNDRED)).rc() : 0;
  let loyaltyC = 0;
  if (Array.isArray(i.loyalty) && i.loyalty.length > 0) {
    let remaining = Fr.int(R - billDiscC);
    let sum = ZERO;
    for (const lr of i.loyalty) {
      if (!lr || !(lr.value > 0) || !remaining.gt(ZERO)) continue;
      const amt = lr.type === 'percent' ? remaining.mul(Fr.dec(lr.value).div(HUNDRED)) : remaining.min(Fr.int(Math.round(lr.value * 100)));
      sum = sum.add(amt);
      remaining = remaining.sub(amt);
    }
    loyaltyC = sum.max(ZERO).rc();
  }
  const remNet = R - billDiscC - loyaltyC;
  let vatable: Fr, tax: Fr;
  if (inclusive) { vatable = Fr.int(remNet).div(hasRate ? onePlus : ONE); tax = Fr.int(remNet).sub(vatable); }
  else if (exclusive) { vatable = Fr.int(remNet); tax = vatable.mul(rate); }
  else { vatable = Fr.int(remNet); tax = ZERO; }
  const netSales = Fr.int(remNet + exemptC);
  const beforeCharges = exclusive ? netSales.add(tax) : netSales;
  let charges = ZERO;
  for (const c of i.adjustments) {
    if (c.type === 'percent') charges = charges.add((c.appliesTo === 'total' ? beforeCharges : netSales).mul(Fr.dec(Number(c.amount || 0)).div(HUNDRED)));
    else charges = charges.add(Fr.int(Math.round(Number(c.amount || 0) * 100)));
  }
  const chargesC = charges.rc();
  const grand = beforeCharges.add(Fr.int(chargesC)).rc();
  return {
    subtotal: G, taxableAmount: vatable.rc(), taxTotal: tax.rc(), lineDiscountsTotal: 0, billDiscountTotal: billDiscC,
    loyaltyDiscountTotal: loyaltyC, totalDiscounts: billDiscC + loyaltyC + statDisc, chargesTotal: chargesC, grandTotal: grand,
    vatableSales: vatable.rc(), vatExemptSales: exemptC, statutoryDiscountTotal: statDisc, statutoryVatRemovedTotal: statVat,
    halfCentavoStage: half,
  };
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------
export const pesos = (c: number) => c / 100;
export const mkStore = (taxType: NonNullable<Store['taxType']>, taxRatePct: number): Store =>
  ({ id: 's1', name: 'S', code: 'SHT', taxType, taxRatePct } as Store);
export const STORE_INCL: Store = mkStore('VAT_INCLUSIVE', 12);

export interface LineSpec { id: string; type: 'package' | 'addon'; name?: string; priceC: number; qty: number; voided?: number; free?: number; category?: string; adjs?: Record<string, any> }
export const mkLine = (s: LineSpec): SessionBillLine => ({
  id: s.id, type: s.type, itemId: s.id, itemName: s.name ?? s.id, unitPrice: pesos(s.priceC), qtyOrdered: s.qty,
  discountType: null, discountValue: null, discountQty: 0, freeQty: s.free ?? 0, voidedQty: s.voided ?? 0,
  ...(s.category ? { category: s.category } : {}),
  ...(s.adjs ? { lineAdjustments: s.adjs } : {}), createdAt: 0, updatedAt: 0,
} as SessionBillLine);

export const mkDiner = (n: number, over: Partial<Diner> = {}): Diner => ({
  id: `d${n}`, kind: n % 2 === 0 ? 'pwd' : 'senior', name: `Diner ${n}`, idNo: `ID-${1000 + n}`, idNoNormalized: `ID${1000 + n}`,
  addedByUid: 'u1', addedAtClientMs: 1_700_000_000_000 + n, dishLineIds: [], ...over,
});

export const percentPromo = (pct: number): Discount =>
  ({ id: 'promo', name: 'Promo', type: 'percent', value: pct, scope: ['bill'], stackable: true, isEnabled: true, vatExempt: false } as unknown as Discount);
export const fixedPromo = (pesosOff: number): Discount =>
  ({ id: 'promoF', name: 'Promo', type: 'fixed', value: pesosOff, scope: ['bill'], stackable: true, isEnabled: true, vatExempt: false } as unknown as Discount);
/** What the OLD whole-bill senior/PWD discount looked like (kept in tax.ts only for reprinting old receipts). */
export const oldWholeBillSeniorDiscount = (): Discount =>
  ({ id: 'sc20', name: 'Senior 20%', type: 'percent', value: 20, scope: ['bill'], stackable: false, isEnabled: true, vatExempt: true } as unknown as Discount);

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------
export interface StatBill {
  lines: SessionBillLine[]; store: Store; promo: Discount | null; promoPct: number | null; adjustments: Adjustment[]; loyalty: Loyalty;
  input: StatInput; sharesC: number[]; subtotalC: number; mode: 'package' | 'alacarte';
}

const priceArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 60000 }).map((n) => n * 5) },
  { weight: 2, arbitrary: fc.integer({ min: 100, max: 300000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 99 }) },
);
const adjArb = fc.array(
  fc.record({
    type: fc.constantFrom('fixed', 'percent') as fc.Arbitrary<'fixed' | 'percent'>,
    pct: fc.constantFrom(5, 10, 12, 2.5, 3.5, 7.5),
    fixedC: fc.integer({ min: 1, max: 30000 }),
    appliesTo: fc.constantFrom('subtotal', 'total', undefined) as fc.Arbitrary<'subtotal' | 'total' | undefined>,
  }),
  { maxLength: 2 },
);
const loyaltyArb = fc.option(
  fc.array(
    fc.record({ type: fc.constantFrom('fixed', 'percent') as fc.Arbitrary<'fixed' | 'percent'>, pct: fc.constantFrom(5, 10, 12.5), fixedC: fc.integer({ min: 100, max: 50000 }) }),
    { minLength: 1, maxLength: 2 },
  ),
  { nil: null, freq: 3 },
);
const storeArb = fc.record({
  taxType: fc.constantFrom('VAT_INCLUSIVE', 'VAT_INCLUSIVE', 'VAT_EXCLUSIVE', 'NON_VAT') as fc.Arbitrary<NonNullable<Store['taxType']>>,
  rate: fc.constantFrom(12, 12, 12, 10, 5, 7.5),
});
const promoArb = fc.option(fc.constantFrom(5, 7.5, 10, 12.5, 15, 17, 3.33, 16.67), { nil: null, freq: 2 });

function assemble(o: {
  mode: 'package' | 'alacarte'; taxType: NonNullable<Store['taxType']>; rate: number; headsRaw: number; pkgPriceC: number;
  addons: { priceC: number; qty: number }[]; dinerCount: number; assign: (number | null)[];
  promoPct: number | null; adj: any[]; loyalty: any; allAssigned: boolean; allDiners: boolean;
}): StatBill {
  const lines: SessionBillLine[] = [];
  let addons = o.addons;
  if (o.mode === 'alacarte' && addons.length === 0) addons = [{ priceC: o.pkgPriceC, qty: 1 }];
  let heads: number, d: number;
  if (o.mode === 'package') {
    heads = o.headsRaw;
    d = Math.min(o.dinerCount, heads);
    lines.push(mkLine({ id: 'pkg', type: 'package', name: 'Unli Pack', priceC: o.pkgPriceC, qty: heads }));
  } else {
    d = Math.max(1, Math.min(o.dinerCount, addons.length, 5));
    heads = o.allDiners ? d : d + (o.headsRaw % 4);
  }
  addons.forEach((a, j) => lines.push(mkLine({ id: `a${j}`, type: 'addon', name: `Dish ${j}`, priceC: a.priceC, qty: a.qty })));
  const diners: Diner[] = Array.from({ length: d }, (_, k) => mkDiner(k + 1));
  const dishOwner = new Map<number, number>();
  addons.forEach((_, j) => {
    if (o.mode === 'alacarte' && j < d) { dishOwner.set(j, j); return; }
    const a = o.assign[j % o.assign.length] ?? null;
    if (o.allAssigned) dishOwner.set(j, ((a ?? j) % d + d) % d);
    else if (a !== null && a < d) dishOwner.set(j, a);
  });
  const sharesC = diners.map((_, k) => (o.mode === 'package' ? o.pkgPriceC : 0));
  for (const [j, k] of dishOwner) {
    diners[k]!.dishLineIds.push(`a${j}`);
    sharesC[k]! += addons[j]!.priceC * addons[j]!.qty;
  }
  const subtotalC = lines.reduce((s, l) => s + Math.round(l.unitPrice * 100) * l.qtyOrdered, 0);
  const store = mkStore(o.taxType, o.rate);
  const adjustments = o.adj.map((a, i) =>
    ({ id: `c${i}`, note: 'n', type: a.type, amount: a.type === 'percent' ? a.pct : pesos(a.fixedC), source: 'custom', appliesTo: a.appliesTo }) as Adjustment);
  const loyalty: Loyalty = o.loyalty ? (o.loyalty as any[]).map((x) => ({ type: x.type, value: x.type === 'percent' ? x.pct : pesos(x.fixedC) })) : null;
  return {
    lines, store, promo: o.promoPct ? percentPromo(o.promoPct) : null, promoPct: o.promoPct, adjustments, loyalty,
    input: { diners, heads, package: null }, sharesC, subtotalC, mode: o.mode,
  };
}

const base = {
  headsRaw: fc.integer({ min: 2, max: 8 }),
  pkgPriceC: priceArb,
  addons: fc.array(fc.record({ priceC: priceArb, qty: fc.integer({ min: 1, max: 4 }) }), { minLength: 0, maxLength: 5 }),
  dinerCount: fc.integer({ min: 1, max: 8 }),
  assign: fc.array(fc.option(fc.nat(7), { nil: null }), { minLength: 5, maxLength: 5 }),
  adj: adjArb,
};

/** Package-per-head or à la carte sessions; 1..8 qualifying diners; some dishes assigned, some shared; promo/loyalty/charges. */
export const statBillArb: fc.Arbitrary<StatBill> = fc
  .record({ ...base, mode: fc.constantFrom('package', 'alacarte') as fc.Arbitrary<'package' | 'alacarte'>, store: storeArb, promoPct: promoArb, loyalty: loyaltyArb })
  .map((r) => assemble({ ...r, taxType: r.store.taxType, rate: r.store.rate, allAssigned: false, allDiners: false }));

/** À la carte, every dish assigned, qualifying diners = heads (Acceptance 4: remainder 0). */
export const allDinersBillArb: fc.Arbitrary<StatBill> = fc
  .record({ ...base, store: storeArb, promoPct: promoArb, loyalty: loyaltyArb })
  .map((r) => assemble({ ...r, mode: 'alacarte', taxType: r.store.taxType, rate: r.store.rate, allAssigned: true, allDiners: true }));

/** Plain bills for the no-diner regression: voided/free units, line adjustments, any bill discount (including the old vatExempt one), loyalty. */
export interface PlainBill { lines: SessionBillLine[]; store: Store; billDiscount: Discount | null; adjustments: Adjustment[]; loyalty: Loyalty }
export const plainBillArb: fc.Arbitrary<PlainBill> = fc
  .record({
    store: fc.record({
      taxType: fc.constantFrom('VAT_INCLUSIVE', 'VAT_INCLUSIVE', 'VAT_EXCLUSIVE', 'NON_VAT') as fc.Arbitrary<NonNullable<Store['taxType']>>,
      rate: fc.constantFrom(12, 12, 10, 5, 7.5, 0),
    }),
    lines: fc.array(
      fc.record({
        priceC: priceArb, qty: fc.integer({ min: 1, max: 12 }), voided: fc.integer({ min: 0, max: 2 }), free: fc.integer({ min: 0, max: 2 }),
        type: fc.constantFrom('package', 'addon') as fc.Arbitrary<'package' | 'addon'>,
        adj: fc.option(fc.record({ kind: fc.constantFrom('discount', 'charge') as fc.Arbitrary<'discount' | 'charge'>, pct: fc.constantFrom(5, 10, 12.5, 33.33), qty: fc.integer({ min: 1, max: 3 }) }), { nil: null }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    disc: fc.option(
      fc.record({ type: fc.constantFrom('percent', 'percent', 'fixed') as fc.Arbitrary<'percent' | 'fixed'>, pct: fc.constantFrom(5, 10, 20, 12.5, 50), fixedC: fc.integer({ min: 100, max: 200000 }), vatExempt: fc.boolean() }),
      { nil: null, freq: 2 },
    ),
    adj: adjArb,
    loyalty: loyaltyArb,
  })
  .map((r): PlainBill => ({
    lines: r.lines.map((l, i) => {
      const adjs = l.adj ? { x: { id: 'x', kind: l.adj.kind, note: 'n', type: 'percent', value: l.adj.pct, qty: l.adj.qty, createdAtClientMs: 1000, createdByUid: 'u' } } : undefined;
      return mkLine({ id: `l${i}`, type: l.type, priceC: l.priceC, qty: l.qty, voided: Math.min(l.voided, l.qty), free: Math.min(l.free, l.qty), ...(adjs ? { adjs } : {}) });
    }),
    store: mkStore(r.store.taxType, r.store.rate),
    billDiscount: r.disc
      ? ({ id: 'd', name: 'D', type: r.disc.type, value: r.disc.type === 'percent' ? r.disc.pct : pesos(r.disc.fixedC), scope: ['bill'], stackable: true, isEnabled: true, vatExempt: r.disc.vatExempt } as unknown as Discount)
      : null,
    adjustments: (r.adj as any[]).map((a, i) => ({ id: `c${i}`, note: 'n', type: a.type, amount: a.type === 'percent' ? a.pct : pesos(a.fixedC), source: 'custom', appliesTo: a.appliesTo }) as Adjustment),
    loyalty: r.loyalty ? (r.loyalty as any[]).map((x) => ({ type: x.type, value: x.type === 'percent' ? x.pct : pesos(x.fixedC) })) : null,
  }));

// ---------------------------------------------------------------------------------------------
// The worked case of Acceptance 1 (VAT-inclusive 12%, per-head package P449 x 4 heads + shared a la carte P318, 1 senior, no dishes assigned)
// ---------------------------------------------------------------------------------------------
export function workedCase() {
  const lines = [
    mkLine({ id: 'pkg', type: 'package', name: 'Unli Pack', priceC: 44900, qty: 4 }),
    mkLine({ id: 'a1', type: 'addon', name: 'Shared platter', priceC: 31800, qty: 1 }),
  ];
  const diner = mkDiner(1, { kind: 'senior', name: 'Lola Remedios Cruz', idNo: 'OSCA-2024-001187', idNoNormalized: 'OSCA2024001187' });
  return { lines, store: STORE_INCL, diner, input: { diners: [diner], heads: 4, package: null } as StatInput };
}
/** Spec numbers of Acceptance 1, in centavos. The test recomputes them with the oracle first. */
export const WORKED = {
  subtotal: 211400, share: 44900, statutoryDiscount: 8018, statutoryVatRemoved: 4811, vatExemptSales: 32071,
  vatableSales: 148661, taxTotal: 17839, grandTotal: 198571,
};
