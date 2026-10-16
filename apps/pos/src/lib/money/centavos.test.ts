/**
 * T-423 slice T - the one money module. `docs/tasks/423-pos-v2-money-and-numbering.md` Ruling 1, Acceptance 1, 11.
 *
 * CONTRACT for the builder (S1) - file `apps/pos/src/lib/money/centavos.ts`, exports exactly:
 *   storedPesosToCentavos(x: unknown): number   - a peso number READ FROM FIRESTORE -> integer centavos, rounded half-up.
 *                                                 NEVER throws (null/undefined/NaN/Infinity/non-numbers -> 0).
 *                                                 A value that is not already a whole number of centavos (|x*100 - round| > 1e-6)
 *                                                 increments the non-centavo counter and logs once via console.warn.
 *   getNonCentavoCount(): number / resetNonCentavoCount(): void - that counter (module-level, read by the tests).
 *   parsePesoInput(s: string): number           - what a PERSON typed -> integer centavos. Exact or it THROWS an Error with a
 *                                                 plain, non-empty message. Accepts "12", "12.3", "12.34", ".5", "0.07", surrounding
 *                                                 spaces. Refuses "", "abc", "1.005", "12.345", "1e3", "-1", "1.2.3", NaN-ish.
 *   roundHalfUp(x: number): number              - rounds to an integer, .5 goes UP: 0.5 -> 1, 2.5 -> 3, 1.4999 -> 1, 0 -> 0.
 *                                                 Exactly one rounding implementation in apps/pos (DEF-003).
 *   allocate(total: number, weights: number[]): number[]
 *                                               - largest-remainder split of an integer `total` by non-negative weights; the result
 *                                                 sums to `total` exactly; ties go to the EARLIER index. allocate(100,[1,1,1]) = [34,33,33].
 *                                                 total must be an integer (throws otherwise); empty or all-zero weights throw.
 *   toWirePesos(c: number): number              - c / 100 for an INTEGER centavo amount; throws RangeError for a non-integer or non-finite c.
 * And `apps/pos/src/lib/money.ts` keeps only re-exports (roundMoney, round2) for old imports.
 */
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allocate,
  getNonCentavoCount,
  parsePesoInput,
  resetNonCentavoCount,
  roundHalfUp,
  storedPesosToCentavos,
  toWirePesos,
} from '@/lib/money/centavos';

beforeEach(() => {
  resetNonCentavoCount();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('storedPesosToCentavos (values read from Firestore)', () => {
  it('0.1 + 0.2 is 30 centavos, not 30.000000000000004 (kills: float pass-through)', () => {
    expect(storedPesosToCentavos(0.1 + 0.2)).toBe(30);
    expect(getNonCentavoCount()).toBe(0); // float dust is not a "non-centavo value"
  });

  it('1.005 rounds half-up to 101 and is counted (kills: banker/truncate rounding, silent acceptance)', () => {
    expect(storedPesosToCentavos(1.005)).toBe(101);
    expect(getNonCentavoCount()).toBe(1);
  });

  it('99.999 does not throw, rounds to 10000 and is counted (Acceptance 11: one bad stored value must not stop the till)', () => {
    expect(() => storedPesosToCentavos(99.999)).not.toThrow();
    expect(storedPesosToCentavos(99.999)).toBe(10000);
    expect(getNonCentavoCount()).toBe(2);
  });

  it('never throws on junk and maps it to 0', () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 'abc', {}, []]) {
      expect(() => storedPesosToCentavos(bad)).not.toThrow();
      expect(storedPesosToCentavos(bad)).toBe(0);
    }
  });

  it('is exact for every whole-centavo amount up to a million pesos (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (c) => {
        resetNonCentavoCount();
        expect(storedPesosToCentavos(c / 100)).toBe(c);
        expect(getNonCentavoCount()).toBe(0);
      }),
      { numRuns: 2000 },
    );
  });

  it('negative whole-centavo amounts round-trip too (refunds/adjustments)', () => {
    expect(storedPesosToCentavos(-12.34)).toBe(-1234);
  });
});

describe('parsePesoInput (what a person typed)', () => {
  it('accepts exact amounts', () => {
    expect(parsePesoInput('12')).toBe(1200);
    expect(parsePesoInput('12.3')).toBe(1230);
    expect(parsePesoInput('12.34')).toBe(1234);
    expect(parsePesoInput('0.07')).toBe(7);
    expect(parsePesoInput('.5')).toBe(50);
    expect(parsePesoInput('  45.60 ')).toBe(4560);
  });

  it('refuses 1.005 and 12.345 with a message (kills: silently rounding typed money)', () => {
    for (const s of ['1.005', '12.345']) {
      let msg = '';
      try {
        parsePesoInput(s);
      } catch (e) {
        msg = (e as Error).message;
        expect(e).toBeInstanceOf(Error);
      }
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('refuses things that are not an amount', () => {
    for (const s of ['', ' ', 'abc', '1e3', '-1', '1.2.3', '12.', '--5', 'Infinity']) {
      expect(() => parsePesoInput(s), `"${s}"`).toThrow();
    }
  });

  it('a typed amount is exactly what the digits say (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999 }), (c) => {
        const text = `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
        expect(parsePesoInput(text)).toBe(c);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('roundHalfUp', () => {
  it('half goes up', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(1.4999)).toBe(1);
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(7)).toBe(7);
  });
  it('always returns an integer within 0.5 of the input (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e9, noNaN: true }), (x) => {
        const r = roundHalfUp(x);
        expect(Number.isInteger(r)).toBe(true);
        expect(Math.abs(r - x)).toBeLessThanOrEqual(0.5 + 1e-9);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('allocate (largest remainder)', () => {
  it('allocate(100, [1,1,1]) sums to 100 and is [34,33,33] (kills: lossy allocation)', () => {
    const out = allocate(100, [1, 1, 1]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out).toEqual([34, 33, 33]);
  });

  it('respects weights and puts zero-weight parts at zero', () => {
    expect(allocate(10, [0, 1])).toEqual([0, 10]);
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
  });

  it('refuses a non-integer total and unusable weights', () => {
    expect(() => allocate(10.5, [1, 1])).toThrow();
    expect(() => allocate(10, [])).toThrow();
    expect(() => allocate(10, [0, 0])).toThrow();
  });

  it('always sums exactly, never goes negative, stays within 1 of the exact share (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0)),
        (total, weights) => {
          const out = allocate(total, weights);
          expect(out).toHaveLength(weights.length);
          expect(out.reduce((a, b) => a + b, 0)).toBe(total);
          const W = weights.reduce((a, b) => a + b, 0);
          out.forEach((v, i) => {
            expect(Number.isInteger(v) && v >= 0).toBe(true);
            expect(Math.abs(v - (total * weights[i]!) / W)).toBeLessThan(1);
          });
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('toWirePesos', () => {
  it('is centavos / 100 and the result times 100 is an integer again', () => {
    expect(toWirePesos(1234)).toBe(12.34);
    expect(toWirePesos(0)).toBe(0);
    fc.assert(
      fc.property(fc.integer({ min: -100_000_000, max: 100_000_000 }), (c) => {
        const p = toWirePesos(c);
        expect(Math.round(p * 100)).toBe(c);
        expect(p).toBe(c / 100);
      }),
      { numRuns: 1000 },
    );
  });
  it('refuses a fractional centavo (kills: float centavos reaching the wire)', () => {
    expect(() => toWirePesos(12.5)).toThrow(RangeError);
    expect(() => toWirePesos(Number.NaN)).toThrow(RangeError);
    expect(() => toWirePesos(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
