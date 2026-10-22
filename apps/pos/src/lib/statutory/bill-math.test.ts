/**
 * T-426 slice T - the bill math with qualifying senior/PWD diners. Ruling 3, Acceptance 1, 2, 3, 4, 10 (math part), 7 (property).
 *
 * CONTRACT for the builder (S1) - `apps/pos/src/lib/tax.ts`:
 *   calculateBillTotalsCentavos(billLines, store, billDiscount, customAdjustments, loyaltyDiscount = null, statutory: StatutoryInput | null = null)
 *   calculateBillTotals(...same six arguments...)            - the same, as peso numbers (every value `toWirePesos(centavos)`)
 *     StatutoryInput = { diners: StatutoryDiner[]; heads: number | null; package?: { isBundle?: boolean; bundleMaxCap?: number } | null }
 *     (the diner record and `statutoryShares` are fixed in shares.test.ts; shares are NOT passed in, the function calls statutoryShares).
 *   The result keeps the eleven T-423 keys and ADDS:
 *     statutoryDiscountTotal: number      - sum of the statutory (20%) discount over diners who took the statutory benefit (NOT the promo)
 *     statutoryVatRemovedTotal: number    - sum over all qualifying diners of the VAT taken off their share, from the ROUNDED figures
 *     statutoryDiners: { dinerId: string; kind: 'senior'|'pwd'; share: number; discount: number; vatRemoved: number; vatExempt: number;
 *                        promoWasHigher: boolean }[]      (same order as `diners`)
 *   Meaning of the per-diner figures (all in the function's unit, centavos or pesos):
 *     share      = the diner's gross share (statutoryShares), never rounded away
 *     discount   = the amount taken off their share: the 20% when the statutory benefit applies, or the bill promo's part of their share when
 *                  the promo is higher (`promoWasHigher: true`)
 *     vatRemoved = the VAT taken off what they pay; vatExempt = share - discount - vatRemoved (so share = discount + vatRemoved + vatExempt, EXACTLY)
 *     sum(vatRemoved) = statutoryVatRemovedTotal; sum(vatExempt) = vatExemptSales; sum(discount over !promoWasHigher diners) = statutoryDiscountTotal.
 *     The per-diner discount and vatRemoved are `allocate()`d (by share) from the totals, so they add up exactly.
 *   Other keys: billDiscountTotal EXCLUDES the statutory discount (it is the promo, on the remainder, plus the promo part of promo-taking
 *     diners); totalDiscounts = lineDiscountsTotal + billDiscountTotal + loyaltyDiscountTotal + statutoryDiscountTotal;
 *     taxTotal / vatableSales / taxableAmount describe the REMAINDER only; vatExemptSales = the diners' VAT-exempt sales.
 *   With no diners (null, [], or undefined) the eleven keys equal T-423's EXACTLY and the three new keys are 0, 0, [].
 *   Rounding stages are the ones in the header of `@/test-helpers/statutoryOracle`; charges use netSales = remainder net + vatExemptSales.
 *
 * A promo that beats the 20% (Ruling 3 "Whichever is higher", the ✎R2 reading): the comparison is the promo's amount on the diner's gross share
 * versus the 20% ALONE (not 20% + VAT removed); the VAT exemption is kept either way, and then vatExempt = (share - promo) / (1 + rate).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calculateBillTotalsCentavosT423 } from '@/test-helpers/taxT423Frozen';
import {
  OLD_FIELDS, STORE_INCL, WORKED, allDinersBillArb, fixedPromo, loadMod, mkDiner, mkLine, mkStore, need, oldWholeBillSeniorDiscount,
  oracleStat, percentPromo, plainBillArb, statBillArb, workedCase, type StatBill, type StatInput, type StatOut,
} from '@/test-helpers/statutoryOracle';

const SAMPLE = 2500;
const statBills = () => fc.sample(statBillArb, { numRuns: SAMPLE, seed: 426001 });
const allDinerBills = () => fc.sample(allDinersBillArb, { numRuns: SAMPLE, seed: 426002 });
const plainBills = () => fc.sample(plainBillArb, { numRuns: SAMPLE, seed: 426003 });

async function api() {
  const m = await loadMod('@/lib/tax');
  const c = need<(...a: any[]) => StatOut>(m, 'calculateBillTotalsCentavos', 'apps/pos/src/lib/tax.ts');
  const p = need<(...a: any[]) => StatOut>(m, 'calculateBillTotals', 'apps/pos/src/lib/tax.ts');
  return { c, p };
}
const run = (fn: (...a: any[]) => StatOut, b: StatBill): StatOut => fn(b.lines, b.store, b.promo, b.adjustments, b.loyalty, b.input);
const oracleOf = (b: StatBill) =>
  oracleStat({ subtotalC: b.subtotalC, store: b.store, promoPct: b.promoPct, adjustments: b.adjustments, loyalty: b.loyalty, sharesC: b.sharesC });

// ---------------------------------------------------------------------------------------------
describe('harness self-check (passes before the builder starts; proves the generator and the oracle are worth trusting)', () => {
  it('generates at least 2,000 bills; many stages land exactly on a half centavo; shares never exceed the subtotal', () => {
    const all = statBills();
    expect(all.length).toBeGreaterThanOrEqual(2000);
    const half = all.filter((b) => oracleOf(b).halfCentavoStage).length;
    console.log(`[T-426] statutory bills=${all.length} withHalfCentavoStatutoryStage=${half}`);
    expect(half).toBeGreaterThanOrEqual(10);
    for (const b of all) {
      expect(b.sharesC.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(b.subtotalC);
      expect(b.sharesC.every((x) => x > 0)).toBe(true);
    }
  });

  it('with NO shares the oracle equals the frozen T-423 function on every field (so the remainder stage of the oracle is T-423, not a guess)', () => {
    let bad = 0;
    for (const b of statBills()) {
      const o = oracleStat({ subtotalC: b.subtotalC, store: b.store, promoPct: b.promoPct, adjustments: b.adjustments, loyalty: b.loyalty, sharesC: [] });
      const t = calculateBillTotalsCentavosT423(b.lines, b.store, b.promo, b.adjustments, b.loyalty);
      for (const f of OLD_FIELDS) if ((o as any)[f] !== (t as any)[f]) bad++;
    }
    expect(bad).toBe(0);
  });

  it('the spec numbers of Acceptance 1 equal the BigInt oracle exactly', () => {
    const { lines, store } = workedCase();
    const o = oracleStat({ subtotalC: 211400, store, promoPct: null, adjustments: [], loyalty: null, sharesC: [44900] });
    expect(o).toMatchObject({
      subtotal: WORKED.subtotal, statutoryDiscountTotal: WORKED.statutoryDiscount, statutoryVatRemovedTotal: WORKED.statutoryVatRemoved,
      vatExemptSales: WORKED.vatExemptSales, vatableSales: WORKED.vatableSales, taxTotal: WORKED.taxTotal, grandTotal: WORKED.grandTotal,
    });
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Acceptance 1: the worked case, VAT-inclusive 12%, one senior, per-head package P449 x 4 + shared P318', () => {
  it('centavo function: share P449.00; statutory discount P80.18; VAT removed P48.11; exempt sales P320.71; remainder VATable P1,486.61 + VAT P178.39; due P1,985.71', async () => {
    const { c } = await api();
    const w = workedCase();
    const r = c(w.lines, w.store, null, [], null, w.input);
    expect(r).toMatchObject({
      subtotal: 211400, lineDiscountsTotal: 0, billDiscountTotal: 0, loyaltyDiscountTotal: 0, chargesTotal: 0,
      statutoryDiscountTotal: 8018, statutoryVatRemovedTotal: 4811, vatExemptSales: 32071,
      vatableSales: 148661, taxableAmount: 148661, taxTotal: 17839, totalDiscounts: 8018, grandTotal: 198571,
    });
    expect(r.statutoryDiners).toHaveLength(1);
    expect(r.statutoryDiners[0]).toMatchObject({ dinerId: 'd1', kind: 'senior', share: 44900, discount: 8018, vatRemoved: 4811, vatExempt: 32071, promoWasHigher: false });
    // kills flaw I (the whole bill exempt): that path leaves nothing VATable
    expect(r.vatableSales).toBeGreaterThan(0);
    expect(r.taxTotal).toBeGreaterThan(0);
  });

  it('peso function: the same case, every value centavos / 100, diners in pesos', async () => {
    const { p } = await api();
    const w = workedCase();
    const r = p(w.lines, w.store, null, [], null, w.input);
    expect(r).toMatchObject({
      subtotal: 2114, statutoryDiscountTotal: 80.18, statutoryVatRemovedTotal: 48.11, vatExemptSales: 320.71,
      vatableSales: 1486.61, taxTotal: 178.39, grandTotal: 1985.71, totalDiscounts: 80.18,
    });
    expect(r.statutoryDiners[0]).toMatchObject({ share: 449, discount: 80.18, vatRemoved: 48.11, vatExempt: 320.71 });
  });

  it('the senior share is one head, so a second senior at the same table doubles the share and the exemption (2 of 4)', async () => {
    const { c } = await api();
    const w = workedCase();
    const input: StatInput = { diners: [w.diner, mkDiner(2, { kind: 'pwd' })], heads: 4, package: null };
    const r = c(w.lines, w.store, null, [], null, input);
    const o = oracleStat({ subtotalC: 211400, store: w.store, promoPct: null, adjustments: [], loyalty: null, sharesC: [44900, 44900] });
    expect(r.grandTotal).toBe(o.grandTotal);
    expect(r.statutoryDiscountTotal).toBe(o.statutoryDiscountTotal);
    expect(r.vatExemptSales).toBe(o.vatExemptSales);
    expect(r.statutoryDiners.map((d) => d.kind)).toEqual(['senior', 'pwd']);
  });

  it('a bundle diner takes bundlePrice / covered heads, not the whole bundle (the package info must be honoured)', async () => {
    const { c } = await api();
    const lines = [mkLine({ id: 'package_pk', type: 'package', name: 'Bundle', priceC: 100000, qty: 1 })];
    const input: StatInput = { diners: [mkDiner(1)], heads: 3, package: { isBundle: true, bundleMaxCap: 3 } };
    const r = c(lines, STORE_INCL, null, [], null, input);
    expect([33333, 33334]).toContain(r.statutoryDiners[0]!.share);
  });

  it('a null store still returns zero totals with the new keys at 0, 0 and []', async () => {
    const { c } = await api();
    const r = c([], null, null, [], null, { diners: [mkDiner(1)], heads: 1, package: null });
    for (const f of OLD_FIELDS) expect((r as any)[f]).toBe(0);
    expect(r.statutoryDiscountTotal).toBe(0);
    expect(r.statutoryVatRemovedTotal).toBe(0);
    expect(r.statutoryDiners).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Acceptance 2: no qualifying diners returns T-423 exactly (on 2,500 generated bills, against the frozen T-423 function)', () => {
  it('every one of the eleven fields equals T-423 for: no sixth argument, null, an empty diner list; and the new keys are 0, 0, []', async () => {
    const { c } = await api();
    const bills = plainBills();
    expect(bills.length).toBeGreaterThanOrEqual(2000);
    const problems: string[] = [];
    for (const [i, b] of bills.entries()) {
      const ref = calculateBillTotalsCentavosT423(b.lines, b.store, b.billDiscount, b.adjustments, b.loyalty);
      const variants: [string, StatOut][] = [
        ['none', c(b.lines, b.store, b.billDiscount, b.adjustments, b.loyalty)],
        ['null', c(b.lines, b.store, b.billDiscount, b.adjustments, b.loyalty, null)],
        ['empty', c(b.lines, b.store, b.billDiscount, b.adjustments, b.loyalty, { diners: [], heads: 4, package: null })],
      ];
      for (const [name, got] of variants) {
        for (const f of OLD_FIELDS) if ((got as any)[f] !== (ref as any)[f] && problems.length < 20) problems.push(`#${i} ${name} ${f}: ${(got as any)[f]} vs T-423 ${(ref as any)[f]}`);
        if (got.statutoryDiscountTotal !== 0 && problems.length < 20) problems.push(`#${i} ${name} statutoryDiscountTotal=${got.statutoryDiscountTotal}`);
        if (got.statutoryVatRemovedTotal !== 0 && problems.length < 20) problems.push(`#${i} ${name} statutoryVatRemovedTotal=${got.statutoryVatRemovedTotal}`);
        if (!Array.isArray(got.statutoryDiners) || got.statutoryDiners.length !== 0) problems.push(`#${i} ${name} statutoryDiners=${JSON.stringify(got.statutoryDiners)}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Ruling 3 against the exact BigInt oracle (2,500 generated bills: VAT incl / excl / non-VAT, 1..8 diners, shared and assigned dishes, promo, loyalty, charges)', () => {
  it('every field, including the statutory totals, equals the oracle EXACTLY (no per-diner rounding drift, one rounding over the exact sums)', async () => {
    const { c } = await api();
    const keys = [...OLD_FIELDS, 'statutoryDiscountTotal', 'statutoryVatRemovedTotal'] as const;
    const problems: string[] = [];
    let n = 0;
    for (const b of statBills()) {
      const r = run(c, b);
      const o = oracleOf(b);
      n++;
      for (const k of keys) if ((r as any)[k] !== (o as any)[k] && problems.length < 25) problems.push(`#${n} ${b.store.taxType}@${b.store.taxRatePct} diners=${b.input.diners.length} ${k}: got ${(r as any)[k]} exact ${(o as any)[k]}`);
    }
    expect(problems).toEqual([]);
  });

  it('per-diner display figures add up exactly: share = discount + VAT removed + exempt; the diners sum to the totals (property, Acceptance 7)', async () => {
    const { c } = await api();
    const problems: string[] = [];
    let n = 0;
    for (const b of statBills()) {
      n++;
      const r = run(c, b);
      const ds = r.statutoryDiners ?? [];
      const bad = (m: string) => { if (problems.length < 25) problems.push(`#${n} ${m}`); };
      if (ds.length !== b.input.diners.length) { bad(`diner count ${ds.length} vs ${b.input.diners.length}`); continue; }
      ds.forEach((d, i) => {
        if (d.dinerId !== b.input.diners[i]!.id) bad(`order: ${d.dinerId} at ${i}`);
        if (d.kind !== b.input.diners[i]!.kind) bad(`kind at ${i}`);
        if (d.share !== b.sharesC[i]) bad(`share ${d.share} vs ${b.sharesC[i]} at ${i}`);
        if (d.share !== d.discount + d.vatRemoved + d.vatExempt) bad(`share ${d.share} != ${d.discount}+${d.vatRemoved}+${d.vatExempt}`);
        if (d.promoWasHigher !== false) bad(`promoWasHigher at ${i}`);
        for (const v of [d.share, d.discount, d.vatRemoved, d.vatExempt]) if (!Number.isSafeInteger(v) || v < 0) bad(`not a whole centavo: ${v}`);
      });
      const sum = (f: 'discount' | 'vatRemoved' | 'vatExempt') => ds.reduce((s, d) => s + d[f], 0);
      if (sum('discount') !== r.statutoryDiscountTotal) bad(`sum discount ${sum('discount')} vs ${r.statutoryDiscountTotal}`);
      if (sum('vatRemoved') !== r.statutoryVatRemovedTotal) bad(`sum vatRemoved ${sum('vatRemoved')} vs ${r.statutoryVatRemovedTotal}`);
      if (sum('vatExempt') !== r.vatExemptSales) bad(`sum vatExempt ${sum('vatExempt')} vs ${r.vatExemptSales}`);
      if (r.totalDiscounts !== r.lineDiscountsTotal + r.billDiscountTotal + r.loyaltyDiscountTotal + r.statutoryDiscountTotal) bad('totalDiscounts is not line + bill + loyalty + statutory');
      if (b.store.taxType !== 'VAT_INCLUSIVE' && r.statutoryVatRemovedTotal !== 0) bad(`VAT removed ${r.statutoryVatRemovedTotal} at a ${b.store.taxType} store`);
    }
    expect(problems).toEqual([]);
  });

  it('the receipt adds up on the totals: subtotal - discounts - VAT exemption + charges = amount due (VAT-inclusive and non-VAT stores)', async () => {
    const { c } = await api();
    const problems: string[] = [];
    let n = 0;
    for (const b of statBills()) {
      if (b.store.taxType === 'VAT_EXCLUSIVE') continue;
      n++;
      const r = run(c, b);
      const want = r.subtotal - r.totalDiscounts - r.statutoryVatRemovedTotal + r.chargesTotal;
      if (r.grandTotal !== want && problems.length < 20) problems.push(`#${n} due ${r.grandTotal} vs ${want}`);
    }
    expect(problems).toEqual([]);
  });

  it('at a VAT-exclusive store VAT is added to the remainder only: subtotal - discounts + remainder VAT + charges = amount due', async () => {
    const { c } = await api();
    const problems: string[] = [];
    let n = 0;
    for (const b of statBills()) {
      if (b.store.taxType !== 'VAT_EXCLUSIVE') continue;
      n++;
      const r = run(c, b);
      const want = r.subtotal - r.totalDiscounts + r.taxTotal + r.chargesTotal;
      if (!Array.isArray(r.statutoryDiners) || r.statutoryDiners.length !== b.input.diners.length) { if (problems.length < 20) problems.push(`#${n} diners were not applied`); continue; }
      if (r.grandTotal !== want && problems.length < 20) problems.push(`#${n} due ${r.grandTotal} vs ${want}`);
    }
    expect(n).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });

  it('the peso function agrees with the centavo function (x = centavos / 100) on 300 of the bills, statutory keys included', async () => {
    const { c, p } = await api();
    for (const b of statBills().slice(0, 300)) {
      const cs = run(c, b), ps = run(p, b);
      for (const k of [...OLD_FIELDS, 'statutoryDiscountTotal', 'statutoryVatRemovedTotal'] as const) expect((ps as any)[k]).toBe((cs as any)[k] / 100);
      ps.statutoryDiners.forEach((d, i) => expect(d.share).toBe(cs.statutoryDiners[i]!.share / 100));
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('Acceptance 3: whichever is higher, never both (worked-case bill + a bill promo)', () => {
  it('a 10% promo: the senior share takes the statutory benefit; the promo hits the REMAINDER only (not the whole bill)', async () => {
    const { c } = await api();
    const w = workedCase();
    const r = c(w.lines, w.store, percentPromo(10), [], null, w.input);
    expect(r.billDiscountTotal).toBe(16650); // 10% of the P1,665.00 remainder; 10% of the whole bill would be 21,140
    expect(r.statutoryDiscountTotal).toBe(8018);
    expect(r.statutoryDiners[0]).toMatchObject({ promoWasHigher: false, discount: 8018 });
    expect(r.totalDiscounts).toBe(16650 + 8018);
    const o = oracleStat({ subtotalC: 211400, store: w.store, promoPct: 10, adjustments: [], loyalty: null, sharesC: [44900] });
    expect(r.grandTotal).toBe(o.grandTotal);
  });

  it('a 50% promo: the senior share takes the promo, promoWasHigher is true, NO statutory discount on that share, the VAT exemption is kept', async () => {
    const { c } = await api();
    const w = workedCase();
    const r = c(w.lines, w.store, percentPromo(50), [], null, w.input);
    const d = r.statutoryDiners[0]!;
    expect(d.promoWasHigher).toBe(true);
    expect(r.statutoryDiscountTotal).toBe(0);
    expect(d.discount).toBe(22450); // 50% of the P449.00 share
    expect(d.vatRemoved).toBe(2405); // VAT of what they actually pay: (44,900 - 22,450) - (44,900 - 22,450) / 1.12
    expect(d.vatExempt).toBe(20045);
    expect(d.share).toBe(d.discount + d.vatRemoved + d.vatExempt);
    expect(r.vatExemptSales).toBe(20045);
    expect(r.statutoryVatRemovedTotal).toBe(2405);
    expect(r.billDiscountTotal).toBe(105700); // the promo on the share (22,450) plus on the remainder (83,250): once each, never twice
    expect(r.totalDiscounts).toBe(105700);
    expect(r.vatableSales).toBe(74330);
    expect(r.taxTotal).toBe(8920);
    expect(r.grandTotal).toBe(83250 + 20045); // gross 211,400 - promo 105,700 - VAT exemption 2,405
    expect(r.grandTotal).toBe(r.subtotal - r.totalDiscounts - r.statutoryVatRemovedTotal);
  });

  it('a 25% promo beats the 20% ALONE (the 25% is below the 20% + VAT benefit of 28.6%): the promo wins (pins the R2 reading)', async () => {
    const { c } = await api();
    const w = workedCase();
    const r = c(w.lines, w.store, percentPromo(25), [], null, w.input);
    expect(r.statutoryDiners[0]!.promoWasHigher).toBe(true);
    expect(r.statutoryDiners[0]!.discount).toBe(11225);
    expect(r.statutoryDiscountTotal).toBe(0);
  });

  it('at a non-VAT store: 25% beats 20% (promo wins), 15% loses (statutory wins)', async () => {
    const { c } = await api();
    const store = mkStore('NON_VAT', 0);
    const lines = [mkLine({ id: 'a1', type: 'addon', priceC: 100000, qty: 1 }), mkLine({ id: 'a2', type: 'addon', priceC: 100000, qty: 1 })];
    const input: StatInput = { diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: 2, package: null };
    const high = c(lines, store, percentPromo(25), [], null, input);
    expect(high.statutoryDiners[0]).toMatchObject({ promoWasHigher: true, discount: 25000 });
    expect(high.statutoryDiscountTotal).toBe(0);
    const low = c(lines, store, percentPromo(15), [], null, input);
    expect(low.statutoryDiners[0]).toMatchObject({ promoWasHigher: false, discount: 20000 });
    expect(low.statutoryDiscountTotal).toBe(20000);
    expect(low.billDiscountTotal).toBe(15000); // the 15% promo on the other P1,000.00 only
  });

  it('a fixed P20 promo is smaller on the share than the 20%: statutory; the promo applies to the remainder (T-423 path unchanged)', async () => {
    const { c } = await api();
    const w = workedCase();
    const r = c(w.lines, w.store, fixedPromo(20), [], null, w.input);
    expect(r.statutoryDiners[0]!.promoWasHigher).toBe(false);
    expect(r.statutoryDiscountTotal).toBe(8018);
    expect(r.billDiscountTotal).toBe(2000);
  });

  it('a fixed P1,000 promo is compared pro-rata to the share (P1,000 x 449 / 2,114 = P212.39 > the 20%): the promo wins and the amount is applied ONCE across share and remainder', async () => {
    const { c } = await api();
    const w = workedCase();
    const r = c(w.lines, w.store, fixedPromo(1000), [], null, w.input);
    expect(r.statutoryDiners[0]!.promoWasHigher).toBe(true);
    expect(r.statutoryDiscountTotal).toBe(0);
    expect(r.billDiscountTotal).toBeLessThanOrEqual(100000);
    expect(r.billDiscountTotal).toBeGreaterThanOrEqual(99999);
    expect(r.statutoryDiners[0]!.vatRemoved).toBeGreaterThan(0);
    expect(r.statutoryDiners[0]!.share).toBe(r.statutoryDiners[0]!.discount + r.statutoryDiners[0]!.vatRemoved + r.statutoryDiners[0]!.vatExempt);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Acceptance 4: every diner qualifying, every dish assigned -> remainder 0, same totals as the old whole-bill branch EXACTLY', () => {
  it('2,500 generated bills: statutory discount = old 20% discount, VAT-exempt sales and amount due equal the old branch; nothing VATable; one rounding over the exact sum', async () => {
    const { c } = await api();
    const problems: string[] = [];
    let n = 0, manyDiners = 0;
    for (const b of allDinerBills()) {
      n++;
      if (b.input.diners.length >= 3) manyDiners++;
      const bill = (d: any) => [b.lines, b.store, d, b.adjustments, b.loyalty] as const;
      const old = calculateBillTotalsCentavosT423(...bill(oldWholeBillSeniorDiscount()));
      const neu = c(b.lines, b.store, b.promo, b.adjustments, b.loyalty, b.input);
      const bad = (m: string) => { if (problems.length < 25) problems.push(`#${n} ${b.store.taxType} diners=${b.input.diners.length} ${m}`); };
      if (neu.statutoryDiscountTotal !== old.billDiscountTotal) bad(`discount ${neu.statutoryDiscountTotal} vs old ${old.billDiscountTotal}`);
      if (neu.vatExemptSales !== old.vatExemptSales) bad(`exempt ${neu.vatExemptSales} vs old ${old.vatExemptSales}`);
      if (neu.grandTotal !== old.grandTotal) bad(`due ${neu.grandTotal} vs old ${old.grandTotal}`);
      if (neu.chargesTotal !== old.chargesTotal) bad(`charges ${neu.chargesTotal} vs old ${old.chargesTotal}`);
      if (neu.statutoryVatRemovedTotal !== old.subtotal - old.billDiscountTotal - old.vatExemptSales) bad(`VAT removed ${neu.statutoryVatRemovedTotal}`);
      for (const f of ['vatableSales', 'taxableAmount', 'taxTotal', 'billDiscountTotal', 'loyaltyDiscountTotal'] as const) if (neu[f] !== 0) bad(`${f} = ${neu[f]}, want 0`);
    }
    expect(manyDiners).toBeGreaterThan(200); // the drift only shows with several diners
    expect(problems).toEqual([]);
  });

  it('loyalty with nothing left to discount gives 0 points value (the guard that refuses it before payment is in capture.test.ts)', async () => {
    const { c } = await api();
    const store = mkStore('NON_VAT', 0);
    const lines = [mkLine({ id: 'a1', type: 'addon', priceC: 50000, qty: 1 })];
    const r = c(lines, store, null, [], [{ type: 'fixed', value: 100 }], { diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: 1, package: null });
    expect(r.loyaltyDiscountTotal).toBe(0);
    expect(r.grandTotal).toBe(40000);
  });
});

describe('loyalty, promo and charges touch the REMAINDER only (worked case)', () => {
  it('a P5,000 loyalty reward is capped at the remainder (P1,665.00); the diner still pays their VAT-exempt portion', async () => {
    const { c } = await api();
    const w = workedCase();
    const r = c(w.lines, w.store, null, [], [{ type: 'fixed', value: 5000 }], w.input);
    expect(r.loyaltyDiscountTotal).toBe(166500);
    expect(r.vatableSales).toBe(0);
    expect(r.taxTotal).toBe(0);
    expect(r.vatExemptSales).toBe(32071);
    expect(r.grandTotal).toBe(32071);
  });

  it('a P100 loyalty reward and a 10% service charge: matches the oracle; the charge base includes the diner exempt sales', async () => {
    const { c } = await api();
    const w = workedCase();
    const adj = [{ id: 'c0', note: 'Service', type: 'percent', amount: 10, source: 'custom', appliesTo: 'subtotal' }] as any[];
    const r = c(w.lines, w.store, null, adj, [{ type: 'fixed', value: 100 }], w.input);
    const o = oracleStat({ subtotalC: 211400, store: w.store, promoPct: null, adjustments: adj, loyalty: [{ type: 'fixed', value: 100 }], sharesC: [44900] });
    expect(r.loyaltyDiscountTotal).toBe(10000);
    expect(r.chargesTotal).toBe(o.chargesTotal);
    expect(r.grandTotal).toBe(o.grandTotal);
    // 10% of (remainder net 156,500 + exempt 32,071) = 18,857.1 -> 18,857
    expect(r.chargesTotal).toBe(18857);
  });
});
