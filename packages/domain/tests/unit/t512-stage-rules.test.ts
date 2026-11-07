import { describe, expect, it } from 'vitest';
import { stageFoodpandaDays, type StagedFile } from '../../src/settlement-intake/stage';
import type { FoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { cents, fmt, readFpFixture, sum } from './t511-s4-helpers';

/**
 * T-512 (T-511 S5c) TESTER - staging takes the withholding rate and the VAT divisor from the rules instead of 5n/1000n and 112n.
 * docs/tasks/512-business-rules-s5c-spec.md "Wiring" item 4: `stageFoodpandaDays(invoice, matched, rules)` with `rules: { withholdingBp: bigint; vatBp: bigint }`;
 * divisor 10000 + vatBp (11200n at the defaults), rate withholdingBp / 10000n (5n/1000n at the defaults); defaults 50n and 1200n reproduce today EXACTLY.
 *
 * Today the third argument is ignored at run time (and a type error), so:
 *   - the DEFAULT-EQUIVALENCE tests below are GREEN today and must stay green: they are the regression guard for "defaults change nothing";
 *   - the EFFECT tests (a different rate or VAT changes the rounding line) are RED today: the argument is ignored, so the staged result does not move.
 * The oracle is the PDF rule written independently here (tries the base column R, then R / (1 + VAT); the base that reproduces EVERY order's withholding wins; the remainder is
 * the workbook's per-order withholding less the rate applied once to the summed base, half up; no match = no line and the "usual rule" warning). The five-PDF tie itself
 * is t511-s5a-pdf-tie.test.ts, which must pass unchanged after the wiring.
 */
const MATCHED = { channelId: '00000000-0000-4000-8000-0000000000c1', storeId: '00000000-0000-4000-8000-0000000000a1', storeName: 'Lipa', channelName: 'Foodpanda', platform: 'foodpanda' as const, code: 'ZZ99' };
type Rules = { withholdingBp: bigint; vatBp: bigint };
const DEFAULTS: Rules = { withholdingBp: 50n, vatBp: 1200n };
const stage = (inv: FoodpandaInvoice, rules?: Rules): StagedFile =>
  (stageFoodpandaDays as unknown as (i: FoodpandaInvoice, m: typeof MATCHED, r?: Rules) => StagedFile)(inv, MATCHED, rules);

const FIVE = [
  { name: 'Banay 8-15 Oct', file: 'foodpanda-banay-oct19-34col.zip', pdf: '12881.22', rounding: '-0.09' },
  { name: 'Lipa 23-30 Sep', file: 'foodpanda-lipa-oct5-34col.zip', pdf: '84427.39', rounding: '-0.05' },
  { name: 'Lipa 8-15 Oct', file: 'foodpanda-lipa-oct19-34col-feerow.zip', pdf: '67936.68', rounding: '-0.05' },
  { name: 'Malvar 1-7 Oct', file: 'foodpanda-malvar-oct12-34col.zip', pdf: '8135.12', rounding: '-0.13' },
  { name: 'Lipa 8-15 Jul (32 columns)', file: 'foodpanda-lipa-jul15-32col.zip', pdf: '80190.53', rounding: '-0.06' },
] as const;

const USUAL_RULE = /does not match the usual rule/i;
const roundings = (s: StagedFile) => s.days.flatMap((d) => d.otherLines.filter((l) => l.kind === 'adjustment').map((l) => ({ on: d.salesDate, amount: l.amount })));

/** round half away from zero, signed */
const rdiv = (num: bigint, den: bigint): bigint => {
  const a = num < 0n ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return num < 0n ? -q : q;
};

/** The independent oracle for the withholding rounding line. */
function oracle(inv: FoodpandaInvoice, bp: bigint, vatBp: bigint): { remainder: bigint; matched: boolean } {
  const R = inv.orders.map((o) => cents(o.revenueAfterDiscounts));
  const T = inv.orders.map((o) => cents(o.withholdingTax));
  const withheld = sum(T);
  for (const base of [R, R.map((r) => rdiv(r * 10000n, 10000n + vatBp))]) {
    if (base.every((b, i) => rdiv(b * bp, 10000n) === T[i])) return { remainder: withheld - rdiv(sum(base) * bp, 10000n), matched: true };
  }
  return { remainder: 0n, matched: false };
}

/** a copy of the invoice whose per-order withholding is what the workbook WOULD print under `bp` and `vatBp` (base R, or R / (1 + VAT) when `vatBase`) */
function reprintedWithholding(inv: FoodpandaInvoice, bp: bigint, vatBp: bigint, vatBase: boolean): FoodpandaInvoice {
  return {
    ...inv,
    orders: inv.orders.map((o) => {
      const r = cents(o.revenueAfterDiscounts);
      const base = vatBase ? rdiv(r * 10000n, 10000n + vatBp) : r;
      return { ...o, withholdingTax: fmt(rdiv(base * bp, 10000n)) as typeof o.withholdingTax };
    }),
  };
}

describe('T-512 stage - the defaults change nothing (green today, must stay green)', () => {
  for (const f of FIVE) {
    it(`${f.name}: no rules argument, and the explicit defaults 50n / 1200n, stage identically; the rounding line is ${f.rounding} and the days add up to the PDF ${f.pdf} [kills: a default that moved; a rules argument that changes the shape]`, async () => {
      const inv = await readFpFixture(f.file);
      const bare = stage(inv);
      const explicit = stage(inv, DEFAULTS);
      expect(explicit).toEqual(bare);
      expect(roundings(explicit).map((r) => r.amount)).toEqual([f.rounding]);
      expect(explicit.warnings.join(' | ')).not.toMatch(USUAL_RULE);
      expect(fmt(sum(explicit.days.map((d) => cents(d.netPayout))))).toBe(f.pdf);
    });
  }
});

describe('T-512 stage - a different withholding rate is used for the per-order check AND the summed base (red today: the argument is ignored)', () => {
  it('Banay at 1%: the workbook printed 0.5%, so no order matches, no rounding line is invented, and the "usual rule" warning appears; at the default the line is there [kills: the rate fixed at 5/1000]', async () => {
    const inv = await readFpFixture('foodpanda-banay-oct19-34col.zip');
    expect(roundings(stage(inv, DEFAULTS)).map((r) => r.amount)).toEqual(['-0.09']);
    const odd = stage(inv, { withholdingBp: 100n, vatBp: 1200n });
    expect(roundings(odd)).toEqual([]);
    expect(odd.warnings.join(' | ')).toMatch(USUAL_RULE);
  });

  it('a workbook that printed 1% (every order\'s withholding reprinted at 1% of column R): at withholdingBp 100 the line is exactly the oracle remainder and there is no warning; at the default there is no line and the warning [kills: the rate fixed; the base not following the rate]', async () => {
    let someRemainder = false;
    for (const f of FIVE) {
      const inv = reprintedWithholding(await readFpFixture(f.file), 100n, 1200n, false);
      const want = oracle(inv, 100n, 1200n);
      expect(want.matched, `${f.name} oracle matches its own reprint`).toBe(true);
      const at1 = stage(inv, { withholdingBp: 100n, vatBp: 1200n });
      expect(at1.warnings.join(' | '), f.name).not.toMatch(USUAL_RULE);
      expect(roundings(at1).map((r) => r.amount), f.name).toEqual(want.remainder === 0n ? [] : [fmt(-want.remainder)]);
      if (want.remainder !== 0n) someRemainder = true;
      const atDefault = stage(inv, DEFAULTS);
      expect(roundings(atDefault), `${f.name} at 0.5%`).toEqual([]);
      expect(atDefault.warnings.join(' | '), f.name).toMatch(USUAL_RULE);
    }
    expect(someRemainder, 'the reprint produced a non-zero rounding line for at least one invoice, so the amount check above is not vacuous').toBe(true);
  });

  it('a rate of 0 withholds nothing: orders that print no withholding match, and there is no remainder', async () => {
    const inv = reprintedWithholding(await readFpFixture('foodpanda-banay-oct19-34col.zip'), 0n, 1200n, false);
    const s = stage(inv, { withholdingBp: 0n, vatBp: 1200n });
    expect(roundings(s)).toEqual([]);
    expect(s.warnings.join(' | ')).not.toMatch(USUAL_RULE);
  });
});

describe('T-512 stage - the VAT percent sets the divisor of the second base (red today: the argument is ignored)', () => {
  it('Lipa 23-30 Sep (a column R / 1.12 invoice): at vat 0 the divisor is 1, the second base is column R itself, nothing matches, the line goes and the warning comes [kills: 112n fixed]', async () => {
    const inv = await readFpFixture('foodpanda-lipa-oct5-34col.zip');
    expect(roundings(stage(inv, DEFAULTS)).map((r) => r.amount)).toEqual(['-0.05']);
    const noVat = stage(inv, { withholdingBp: 50n, vatBp: 0n });
    expect(roundings(noVat)).toEqual([]);
    expect(noVat.warnings.join(' | ')).toMatch(USUAL_RULE);
  });

  it('a workbook that printed withholding on R / 1.10: at vatBp 1000 the line is exactly the oracle remainder, no warning; at the default 12% it does not match [kills: the divisor not following the VAT rule]', async () => {
    let someRemainder = false;
    for (const f of FIVE.slice(0, 3)) {
      const inv = reprintedWithholding(await readFpFixture(f.file), 50n, 1000n, true);
      const want = oracle(inv, 50n, 1000n);
      expect(want.matched, `${f.name} oracle matches its own reprint`).toBe(true);
      const at10 = stage(inv, { withholdingBp: 50n, vatBp: 1000n });
      expect(at10.warnings.join(' | '), f.name).not.toMatch(USUAL_RULE);
      expect(roundings(at10).map((r) => r.amount), f.name).toEqual(want.remainder === 0n ? [] : [fmt(-want.remainder)]);
      if (want.remainder !== 0n) someRemainder = true;
      expect(stage(inv, DEFAULTS).warnings.join(' | '), `${f.name} at 12%`).toMatch(USUAL_RULE);
    }
    expect(someRemainder).toBe(true);
  });

  it('both change together: 1% on R / 1.10, the staged result equals the oracle', async () => {
    const inv = reprintedWithholding(await readFpFixture('foodpanda-lipa-oct19-34col-feerow.zip'), 100n, 1000n, true);
    const want = oracle(inv, 100n, 1000n);
    expect(want.matched).toBe(true);
    const s = stage(inv, { withholdingBp: 100n, vatBp: 1000n });
    expect(roundings(s).map((r) => r.amount)).toEqual(want.remainder === 0n ? [] : [fmt(-want.remainder)]);
    expect(s.warnings.join(' | ')).not.toMatch(USUAL_RULE);
  });
});

describe('T-512 stage - what the rules must NOT touch', () => {
  it('the per-charge VAT percent still comes from the file, whatever the rules say: Appendix B VAT is the same at vatBp 0 as at 1200 [kills: the file\'s own VAT replaced by the rule]', async () => {
    const inv = await readFpFixture('foodpanda-lipa-oct5-34col.zip');
    const feeOf = (s: StagedFile) => s.days.map((d) => d.platformFee).join('|');
    const withoutRoundingLines = (s: StagedFile) => ({ ...s, days: s.days.map((d) => ({ ...d, platformFee: undefined, otherLines: d.otherLines.filter((l) => l.kind !== 'adjustment'), netPayout: undefined })) });
    const a = stage(inv, DEFAULTS);
    const b = stage(inv, { withholdingBp: 50n, vatBp: 0n });
    expect(feeOf(a).length).toBeGreaterThan(0);
    // everything but the rounding line (and what it feeds) is identical
    expect(withoutRoundingLines({ ...b, warnings: [] })).toEqual(withoutRoundingLines({ ...a, warnings: [] }));
  });
});
