import { describe, expect, it } from 'vitest';
import {
  chargeableShortages,
  nextMomentFor,
  varianceOf,
  varianceSentence,
} from '../src/app/till/lib';

/**
 * T-186's surface. The page is server-rendered against a real database, so what is worth
 * unit-testing is the three decisions it makes on its own: WHICH count to ask for next, WHICH
 * shortages to offer a charge on, and WHAT the variance sentence says.
 *
 * ⭐ Every one of these was a bug found by opening the page in a browser, not by a test.
 */
const line = (
  id: string,
  moment: 'open' | 'close',
  moneyAccountId: string,
  counted: string,
  expected: string,
) =>
  ({ id, moment, moneyAccountId, counted, expected }) as never;

const ACCOUNTS = [{ id: 'drawer' }, { id: 'float' }];

describe('which count the shift asks for next', () => {
  it('asks for the OPENING count when nothing has been counted', () => {
    expect(nextMomentFor([], ACCOUNTS)).toBe('open');
  });

  it('asks for the CLOSING count once an opening count exists', () => {
    const counts = [line('a', 'open', 'drawer', '100', '100')];
    expect(nextMomentFor(counts, ACCOUNTS)).toBe('close');
  });

  it('⭐ stops asking once every pocket counted IN has been counted OUT', () => {
    // ⚠️ This is the bug: the form kept offering a closing count that was already recorded, and
    // submitting it hit a unique constraint. The rule mirrors `closeTillShift` exactly.
    const counts = [
      line('a', 'open', 'drawer', '100', '100'),
      line('b', 'close', 'drawer', '90', '100'),
    ];
    expect(nextMomentFor(counts, ACCOUNTS)).toBeNull();
  });

  it('⛔ still asks while a SECOND pocket is counted in but not out', () => {
    const counts = [
      line('a', 'open', 'drawer', '100', '100'),
      line('b', 'open', 'float', '20000', '20000'),
      line('c', 'close', 'drawer', '90', '100'),
    ];
    expect(nextMomentFor(counts, ACCOUNTS)).toBe('close');
  });
});

describe('which shortages may still be charged', () => {
  const short = line('s1', 'close', 'drawer', '9850', '10000');
  const over = line('o1', 'close', 'drawer', '10150', '10000');
  const openShort = line('s2', 'open', 'drawer', '9850', '10000');

  it('offers a closing SHORT', () => {
    expect(chargeableShortages([short], new Set()).map((c) => c.id)).toEqual(['s1']);
  });

  it('⛔ never offers an OVER — an overage posts nothing at all', () => {
    expect(chargeableShortages([over], new Set())).toEqual([]);
  });

  it('⛔ never offers an OPENING variance — that is the previous shift’s problem', () => {
    expect(chargeableShortages([openShort], new Set())).toEqual([]);
  });

  it('⭐ never offers one that is ALREADY CHARGED', () => {
    // ⚠️ The charge is idempotent so a second click posts nothing — but a form still offering it
    // tells a manager the debt is outstanding when it is already on the books against a person.
    expect(chargeableShortages([short], new Set(['s1']))).toEqual([]);
  });
});

describe('the variance sentence — the guard T-153 §13.4 asked for', () => {
  const peso = (n: number) => `₱${n.toFixed(2)}`;

  it('⭐ says COUNTED and names who answers, so it cannot read like a LEDGER shortfall', () => {
    const s = varianceSentence(-500, peso);
    expect(s).toMatch(/physical count/i);
    expect(s).toMatch(/chargeable to the cashier/i);
  });

  it('⛔ an over says it posts nothing, and never mentions charging anyone', () => {
    const s = varianceSentence(300, peso);
    expect(s).toMatch(/Posts nothing at all/i);
    expect(s).not.toMatch(/chargeable/i);
  });

  it('⛔ the sign is a WORD, never a minus in front of the peso sign', () => {
    // ₱-500.00 is the bug this codebase has shipped three times.
    expect(varianceSentence(-500, peso)).not.toMatch(/₱-/);
    expect(varianceSentence(-500, peso)).toContain('₱500.00');
  });

  it('a match says so plainly', () => {
    expect(varianceSentence(0, peso)).toMatch(/exactly what the ledger says/i);
  });
});

describe('varianceOf', () => {
  it('is counted minus expected, negative for short', () => {
    expect(varianceOf({ counted: '9850.00', expected: '10000.00' })).toBe(-150);
    expect(varianceOf({ counted: '10150.00', expected: '10000.00' })).toBe(150);
  });
});
