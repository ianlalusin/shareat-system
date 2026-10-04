import { beforeAll, describe, expect, it } from 'vitest';

/**
 * T-375 S2 - `resolvePosV1Methods` (`packages/domain/src/pos/v1-methods.ts`), tests R1-R6.
 * `docs/tasks/375-pos-v1-day-feed.md` section S2, rulings R3 and R4.
 *
 * TESTER, not BUILDER. Pure function, no I/O.
 *
 * ## Why these are red on HEAD
 * `v1-methods.ts` does not exist. The module is imported DYNAMICALLY (preloaded in `beforeAll` with a long timeout),
 * so every leg fails on "Failed to resolve import ../../src/pos/v1-methods". Once it exists, each leg fails (or
 * passes) on the assertion named in it.
 *
 * ## How the target is read where the spec is silent
 *  - `resolvePosV1Methods(byMethod: Record<string, number>, tenders)` where a tender is
 *    `{ id, kind: 'cash' | 'wallet', moneyAccountId: string | null, posV1Alias: string | null, isActive: boolean }`
 *    (the `tenders` row's own camelCase names);
 *  - Money is a decimal string, so `cash` is compared as '700.00' and `wallets` as a Map of '350.00';
 *  - R6 is asserted through `resolvePosV1Methods` (the conversion is named after the method it refuses), so the
 *    exported shape of `toCentavos` itself is not pinned here.
 */
type Tender = { id: string; kind: 'cash' | 'wallet'; moneyAccountId: string | null; posV1Alias: string | null; isActive: boolean };
type Res = { ok: true; cash: string; wallets: Map<string, string> } | { ok: false; sentence: string; raw: string };
type Mod = { resolvePosV1Methods: (by: Record<string, number>, tenders: Tender[]) => Res };

let mod: Mod;
beforeAll(async () => {
  mod = (await import('../../src/pos/v1-methods')) as unknown as Mod;
}, 120_000);
const resolve = (by: Record<string, number>, tenders: Tender[]) => mod.resolvePosV1Methods(by, tenders);

const CASH: Tender = { id: 't-cash', kind: 'cash', moneyAccountId: null, posV1Alias: 'Cash', isActive: true };
const GCASH: Tender = { id: 't-gcash', kind: 'wallet', moneyAccountId: 'acct-gcash', posV1Alias: 'GCash', isActive: true };

function okOf(r: Res) {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${r.sentence}`);
  return r;
}
function refusalOf(r: Res) {
  expect(r.ok, 'must refuse').toBe(false);
  if (r.ok) throw new Error('unreachable');
  return r;
}

describe('R1 - methods resolve by normalized explicit alias and are summed per tender', () => {
  it("{ Cash: 700, 'G·Cash': 350 } -> cash 700.00, wallets { GCash account: 350.00 }", () => {
    const r = okOf(resolve({ Cash: 700, 'G·Cash': 350 }, [CASH, GCASH]));
    expect(r.cash).toBe('700.00');
    expect([...r.wallets.entries()]).toEqual([['acct-gcash', '350.00']]);
  });

  it('control: no methods -> wallets is empty and cash is 0.00', () => {
    const r = okOf(resolve({}, [CASH, GCASH]));
    expect(r.cash).toBe('0.00');
    expect(r.wallets.size).toBe(0);
  });

  it('two wallet tenders on one money account add into ONE entry (one row per account)', () => {
    const maya: Tender = { id: 't-maya', kind: 'wallet', moneyAccountId: 'acct-gcash', posV1Alias: 'Maya', isActive: true };
    const r = okOf(resolve({ GCash: 100, Maya: 25.5 }, [CASH, GCASH, maya]));
    expect([...r.wallets.entries()]).toEqual([['acct-gcash', '125.50']]);
  });
});

describe('R2 - an unknown method with money refuses the import, naming the method and the amount', () => {
  it('{ Cash: 700, Maya: 50 } with no Maya alias -> the R2 sentence; raw carries the method too', () => {
    const r = refusalOf(resolve({ Cash: 700, Maya: 50 }, [CASH, GCASH]));
    expect(r.sentence).toBe(
      'POS took ₱50.00 as "Maya", which isn\'t set up as a tender for this store. An admin maps it under Settings › POS link, then import again.',
    );
    expect(r.raw).toContain('Maya');
  });

  it('control: { Maya: 0 } is ignored (a zero unknown method does not refuse)', () => {
    const r = okOf(resolve({ Cash: 700, Maya: 0 }, [CASH, GCASH]));
    expect(r.cash).toBe('700.00');
    expect(r.wallets.size).toBe(0);
  });

  it('control: once Maya has an active alias the same input is accepted', () => {
    const maya: Tender = { id: 't-maya', kind: 'wallet', moneyAccountId: 'acct-maya', posV1Alias: 'Maya', isActive: true };
    const r = okOf(resolve({ Cash: 700, Maya: 50 }, [CASH, GCASH, maya]));
    expect([...r.wallets.entries()]).toEqual([['acct-maya', '50.00']]);
  });
});

describe('R3 - v1 contrast: explicit alias only, no name matching, no cash whitelist', () => {
  it('"Cash" with no tender aliased Cash -> refused, naming the method and the amount', () => {
    const unaliased: Tender = { ...CASH, posV1Alias: null };
    const r = refusalOf(resolve({ Cash: 700 }, [unaliased]));
    expect(r.sentence).toContain('"Cash"');
    expect(r.sentence).toContain('₱700.00');
  });

  it('a wallet tender with a DIFFERENT alias is not matched by the method name -> refused', () => {
    const misaliased: Tender = { ...GCASH, posV1Alias: 'Globe' };
    const r = refusalOf(resolve({ GCash: 100 }, [CASH, misaliased]));
    expect(r.sentence).toContain('"GCash"');
  });

  it('control: aliasing it makes the same input accepted', () => {
    const r = okOf(resolve({ Cash: 700 }, [CASH]));
    expect(r.cash).toBe('700.00');
  });

  it('control: the alias is normalized (lowercase, a-z0-9 only) on BOTH sides: alias "g-CASH" answers to method "G Cash"', () => {
    const g: Tender = { ...GCASH, posV1Alias: 'g-CASH' };
    const r = okOf(resolve({ 'G Cash': 40 }, [CASH, g]));
    expect(r.wallets.get('acct-gcash')).toBe('40.00');
  });
});

describe('R4 - a negative method total refuses', () => {
  it('{ GCash: -20 } -> the refund sentence', () => {
    const r = refusalOf(resolve({ GCash: -20 }, [CASH, GCASH]));
    expect(r.sentence).toBe('POS shows ₱20.00 more refunded than taken as "GCash" that day, so the day can\'t be imported.');
  });

  it('control: { GCash: 20 } is accepted', () => {
    expect(okOf(resolve({ GCash: 20 }, [CASH, GCASH])).wallets.get('acct-gcash')).toBe('20.00');
  });
});

describe('R5 - methods that normalize to one alias are summed; an inactive tender is not matched', () => {
  it("{ GCash: 100, 'GCash ': 50 } -> GCash 150.00", () => {
    const r = okOf(resolve({ GCash: 100, 'GCash ': 50 }, [CASH, GCASH]));
    expect(r.wallets.get('acct-gcash')).toBe('150.00');
  });

  it("an inactive tender's alias is not matched -> refused; control: the same tender active -> accepted", () => {
    const retired: Tender = { ...GCASH, isActive: false };
    const r = refusalOf(resolve({ GCash: 100 }, [CASH, retired]));
    expect(r.sentence).toContain('"GCash"');
    expect(okOf(resolve({ GCash: 100 }, [CASH, GCASH])).wallets.get('acct-gcash')).toBe('100.00');
  });

  it('an inactive tender does not shadow an active one with the same alias', () => {
    const retired: Tender = { ...GCASH, id: 't-old', moneyAccountId: 'acct-old', isActive: false };
    const r = okOf(resolve({ GCash: 100 }, [CASH, retired, GCASH]));
    expect([...r.wallets.entries()]).toEqual([['acct-gcash', '100.00']]);
  });
});

describe('R6 - one float -> centavo conversion at the wire', () => {
  it('0.30000000000000004 -> 0.30', () => {
    expect(okOf(resolve({ Cash: 0.30000000000000004 }, [CASH])).cash).toBe('0.30');
  });

  it('round, not floor: 0.29 (28.999999999999996 centavos as a float) -> 0.29; 1.15 -> 1.15', () => {
    expect(okOf(resolve({ Cash: 0.29 }, [CASH])).cash).toBe('0.29');
    expect(okOf(resolve({ Cash: 1.15 }, [CASH])).cash).toBe('1.15');
  });

  it('10.005 is not a whole number of centavos -> refused, naming the method; control: 10.01 accepted', () => {
    const r = refusalOf(resolve({ Cash: 10.005 }, [CASH]));
    expect(r.sentence).toContain('"Cash"');
    expect(okOf(resolve({ Cash: 10.01 }, [CASH])).cash).toBe('10.01');
  });
});

describe('Gaps - resolver edges', () => {
  it('a wallet tender with NO money account refuses the day, naming the method - Mutant: skip the null-account guard (the amount would vanish)', () => {
    const broken: Tender = { ...GCASH, moneyAccountId: null };
    const r = refusalOf(resolve({ GCash: 100 }, [CASH, broken]));
    expect(r.sentence).toContain('"GCash"');
    expect(r.sentence).toMatch(/money account/i);
    // control: a zero amount on it is ignored, and with an account the same input is accepted
    expect(okOf(resolve({ GCash: 0 }, [CASH, broken])).wallets.size).toBe(0);
    expect(okOf(resolve({ GCash: 100 }, [CASH, GCASH])).wallets.get('acct-gcash')).toBe('100.00');
  });

  it('a negative sub-centavo amount (-0.004) refuses naming the method, never rounds to zero - Mutant: treat round() === 0 as ignorable', () => {
    const r = refusalOf(resolve({ Cash: -0.004 }, [CASH]));
    expect(r.sentence).toContain('"Cash"');
    // control: the positive twin is refused too, and a true zero is ignored
    refusalOf(resolve({ Cash: 0.004 }, [CASH]));
    expect(okOf(resolve({ Cash: 0 }, [CASH])).cash).toBe('0.00');
  });

  it('the tolerance edge: 10.000009 (0.0009 centavo off) is accepted as 10.00; 10.000011 (0.0011 off) is refused - Mutant: widen or drop the 0.001 tolerance', () => {
    expect(okOf(resolve({ Cash: 10.000009 }, [CASH])).cash).toBe('10.00');
    const r = refusalOf(resolve({ Cash: 10.000011 }, [CASH]));
    expect(r.sentence).toContain('"Cash"');
  });
});
