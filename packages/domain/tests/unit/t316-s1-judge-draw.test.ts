import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { judgeDraw } from '../../src/money-accounts/overdraft';

/**
 * T-316 S1 — `judgeDraw` after the float branch is deleted.
 * `docs/tasks/316-till-floor-on-the-cashier-account.md` §1.1, tests T-S1-1 and T-S1-6 (mutant M1).
 *
 * After 0184 the only account that can carry a `floatTarget` is the cashier's TAKINGS drawer (1110),
 * whose ledger balance is provisional. So `floatTarget` must NOT be consulted by `judgeDraw`: a
 * float-carrying cashier drawer at ₱0 warns inside its overdraft limit, exactly like one with no
 * target. RED on HEAD: the float branch blocks at zero (`blocked: true`, "side pocket").
 */
describe('T-316 S1 — judgeDraw ignores floatTarget; the cashier branch governs', () => {
  const drawer = { name: 'Cashier cash', custodian: 'cashier' as const, overdraftLimit: '20000.00', floatTarget: '20000.00' };
  const plain = { ...drawer, floatTarget: null };
  const office = { name: 'Office cash', custodian: 'office' as const, overdraftLimit: '20000.00', floatTarget: null };
  const staff = { name: 'Staff float', custodian: 'staff' as const, overdraftLimit: '20000.00', floatTarget: null };

  it('T-S1-1: a float-carrying cashier drawer at ₱0 ledger WARNS within its overdraft and does not block', () => {
    const v = judgeDraw(drawer, money('0.00'), money('5000.00'));
    expect(v.blocked).toBe(false);
    expect(v.message).toMatch(/short 5000\.00/);
    expect(v.message).toMatch(/Allowed down to −20000\.00/);
  });

  it('T-S1-1 control: past the overdraft limit the same float-carrying drawer is BLOCKED, with the overdraft sentence', () => {
    const v = judgeDraw(drawer, money('0.00'), money('20001.00'));
    expect(v.blocked).toBe(true);
    expect(v.message).toMatch(/past the 20000\.00 overdraft/);
    // exactly at the limit still warns (boundary control)
    expect(judgeDraw(drawer, money('0.00'), money('20000.00')).blocked).toBe(false);
  });

  it('M1: floatTarget changes nothing — the verdict equals the no-target drawer verdict at every point', () => {
    for (const [avail, drawn] of [['0.00', '5000.00'], ['1000.00', '1500.00'], ['0.00', '20001.00'], ['500.00', '400.00']] as const) {
      expect(judgeDraw(drawer, money(avail), money(drawn))).toEqual(judgeDraw(plain, money(avail), money(drawn)));
    }
    // and the no-target drawer really does warn here (the equality is not two blocks agreeing)
    expect(judgeDraw(plain, money('0.00'), money('5000.00')).blocked).toBe(false);
  });

  it('T-S1-6: office and staff accounts still block at zero', () => {
    for (const acct of [office, staff]) {
      const v = judgeDraw(acct, money('0.00'), money('1.00'));
      expect(v.blocked).toBe(true);
      expect(v.message).toMatch(/complete/);
    }
  });

  it('T-S1-6 control: the same draw on a cashier drawer warns (the office/staff block is the custodian, not the amount)', () => {
    expect(judgeDraw(plain, money('0.00'), money('1.00')).blocked).toBe(false);
    expect(judgeDraw(office, money('1.00'), money('1.00'))).toEqual({ blocked: false });
  });
});
