import { describe, expect, it } from 'vitest';
import { money, add } from '@shareat/core/money';
import { judgeDraw } from '../../src/money-accounts/overdraft';

/**
 * Bible row 154 — may this account give up this money?
 *
 * > **Ian, 2026-08-26:** *"warning for now, don't block … implement it only to cashier owned
 * > account, since only cashier owned account might experience this."*
 *
 * ⭐ **The rule is a property of the ACCOUNT, not of the feature**, which is why it is worth a
 * unit test of its own: the same input must produce the same verdict whether it arrived from an
 * expense or from a transfer.
 */
describe('judgeDraw', () => {
  // ⚠️ Every account carries an overdraft limit, but only a CASHIER one consults it — office and
  // staff balances are complete, so they block at zero regardless of what this says.
  const cashier = { name: 'Cashier drawer', custodian: 'cashier' as const, overdraftLimit: '20000.00', floatTarget: null };
  const office = { name: 'Office safe', custodian: 'office' as const, overdraftLimit: '20000.00', floatTarget: null };
  const staff = { name: 'Ana float', custodian: 'staff' as const, overdraftLimit: '20000.00', floatTarget: null };
  // ⭐ T-316 — a cashier drawer that carries a float target (the target lives on 1110 now).
  const pot = { name: 'Lipa till float', custodian: 'cashier' as const, overdraftLimit: '20000.00', floatTarget: '20000.00' };

  it('says nothing at all when the money is there', () => {
    expect(judgeDraw(cashier, money('1000.00'), money('400.00'))).toEqual({ blocked: false });
    expect(judgeDraw(office, money('1000.00'), money('1000.00'))).toEqual({ blocked: false });
  });

  it('⭐ WARNS but does not block a cashier drawer WITHIN its overdraft', () => {
    const v = judgeDraw(cashier, money('1000.00'), money('1500.00'));
    expect(v.blocked).toBe(false);
    // The message has to explain the timing, or it reads as an accusation. A cashier who can see
    // ₱40,000 in front of them will not trust a system that says the drawer is empty.
    expect(v.message).toMatch(/short 500\.00/);
    expect(v.message).toMatch(/unverified/);
  });

  it('⛔ BLOCKS a cashier drawer once it would pass its overdraft limit', () => {
    // ⭐ Ian, 2026-08-27: "it can't be unlimited, so admin can set it. If the set is 20,000 that is
    // the only allowable negative balance a cashier is allowed to."
    //
    // ⚠️ Row 154's unverified-day reasoning has no floor of its own — it justifies a drawer being
    // ₱2,000 behind and equally ₱2,000,000 behind. This is where the two stop being the same thing.
    const v = judgeDraw(cashier, money('1000.00'), money('22000.00'));
    expect(v.blocked).toBe(true);
    expect(v.message).toMatch(/would go to −21000\.00/);
    expect(v.message).toMatch(/past the 20000\.00 overdraft/);
  });

  it('⭐ the boundary is where the balance LANDS, not how big the draw is', () => {
    // Exactly at the limit is allowed — −0 to −20,000 inclusive.
    expect(judgeDraw(cashier, money('0.00'), money('20000.00')).blocked).toBe(false);
    // One peso past it is not.
    expect(judgeDraw(cashier, money('0.00'), money('20001.00')).blocked).toBe(true);
    // ⚠️ And a HUGE draw against a well-funded drawer is fine, because it lands inside the limit —
    // judging the draw instead of the resulting balance would refuse this wrongly.
    expect(judgeDraw(cashier, money('100000.00'), money('105000.00')).blocked).toBe(false);
  });

  it('⛔ a limit of ZERO means this drawer may never go below zero at all', () => {
    const strict = { ...cashier, overdraftLimit: '0.00' };
    expect(judgeDraw(strict, money('1000.00'), money('1000.00')).blocked).toBe(false);
    expect(judgeDraw(strict, money('1000.00'), money('1000.01')).blocked).toBe(true);
  });

  it('⚠️ the limit is IGNORED for office and staff — their balances are complete', () => {
    const generous = { ...office, overdraftLimit: '999999.00' };
    // A limit column exists on every account, but consulting it here would invent an overdraft for
    // an account whose balance has nothing outstanding to explain a shortfall.
    expect(judgeDraw(generous, money('1000.00'), money('1500.00')).blocked).toBe(true);
  });

  it('⛔ BLOCKS an office safe and a staff float — their balances are complete', () => {
    for (const acct of [office, staff]) {
      const v = judgeDraw(acct, money('1000.00'), money('1500.00'));
      expect(v.blocked).toBe(true);
      // ⚠️ Nothing is waiting to be posted into these, so a shortfall is real rather than a
      // timing artefact. The message says so, because "insufficient funds" alone invites the
      // same shrug the cashier case earns.
      expect(v.message).toMatch(/balance is complete/);
    }
  });

  it('⚠️ exact equality is not an overdraft', () => {
    expect(judgeDraw(office, money('1000.00'), money('1000.00')).blocked).toBe(false);
    expect(judgeDraw(office, money('1000.00'), money('1000.00')).message).toBeUndefined();
  });

  it('a cent over IS, on both paths', () => {
    expect(judgeDraw(office, money('1000.00'), money('1000.01')).blocked).toBe(true);
    expect(judgeDraw(cashier, money('1000.00'), money('1000.01')).message).toBeTruthy();
  });

  // -----------------------------------------------------------------------------------
  // T-153 — the float pot
  // -----------------------------------------------------------------------------------

  it('⭐ T-316 S1: a float-carrying cashier drawer WARNS within its overdraft (it is the takings drawer, not a side pocket)', () => {
    // Was T-153: a float pot blocked at zero. After 0184 the target lives on the 1110 takings
    // drawer, whose ledger balance is provisional, so the cashier branch governs.
    const v = judgeDraw(pot, money('1500.00'), money('2000.00'));
    expect(v.blocked).toBe(false);
    expect(v.message).toMatch(/short 500\.00/);
  });

  it('⛔ T-316 S1: floatTarget is NOT consulted — a drawer with and without a target give the same verdict', () => {
    const noTarget = judgeDraw(cashier, money('1000.00'), money('1500.00'));
    const withTarget = judgeDraw({ ...pot, name: cashier.name }, money('1000.00'), money('1500.00'));
    expect(withTarget).toEqual(noTarget); // same name, so the whole verdict (blocked + message) must match
    expect(noTarget.blocked).toBe(false);
    // control: past the limit both block, so the equality is not two warnings by accident
    expect(judgeDraw(pot, money('1000.00'), money('22000.00')).blocked).toBe(true);
  });

  it('says nothing when the float-carrying drawer covers the draw', () => {
    expect(judgeDraw(pot, money('20000.00'), money('1500.00'))).toEqual({ blocked: false });
  });

  // -----------------------------------------------------------------------------------
  // T-371 S4 — the float hazard is gone: sums of cents are judged exactly
  // -----------------------------------------------------------------------------------

  it('⭐ a draw built from summed parts is judged exactly, not as a float', () => {
    // Float: 0.1 + 0.2 === 0.30000000000000004 > 0.3 would call a balance of 0.30 SHORT by a hair.
    expect(0.1 + 0.2 > 0.3).toBe(true); // the hazard, shown
    const drawn = add(money('0.10'), money('0.20'));
    expect(judgeDraw(office, money('0.30'), drawn)).toEqual({ blocked: false });
    // 0.07 balance against a 0.07 draw summed from 0.01 x 7 (float sum is 0.07 - ~1e-17 or +, never trusted)
    const seven = add(...Array.from({ length: 7 }, () => money('0.01')));
    expect(judgeDraw(office, money('0.07'), seven)).toEqual({ blocked: false });
    expect(judgeDraw(strictCashier(), money('0.07'), seven)).toEqual({ blocked: false });
    // and one centavo more is exactly one centavo short
    expect(judgeDraw(office, money('0.30'), add(drawn, money('0.01'))).blocked).toBe(true);
  });
});
function strictCashier() {
  return { name: 'Cashier drawer', custodian: 'cashier' as const, overdraftLimit: '0.00', floatTarget: null };
}
