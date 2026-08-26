import { describe, expect, it } from 'vitest';
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
  const cashier = { name: 'Cashier drawer', custodian: 'cashier' as const };
  const office = { name: 'Office safe', custodian: 'office' as const };
  const staff = { name: 'Ana float', custodian: 'staff' as const };

  it('says nothing at all when the money is there', () => {
    expect(judgeDraw(cashier, 1000, 400)).toEqual({ blocked: false });
    expect(judgeDraw(office, 1000, 1000)).toEqual({ blocked: false });
  });

  it('⭐ WARNS but does not block a cashier drawer', () => {
    const v = judgeDraw(cashier, 1000, 1500);
    expect(v.blocked).toBe(false);
    // The message has to explain the timing, or it reads as an accusation. A cashier who can see
    // ₱40,000 in front of them will not trust a system that says the drawer is empty.
    expect(v.message).toMatch(/short 500\.00/);
    expect(v.message).toMatch(/unverified/);
  });

  it('⛔ BLOCKS an office safe and a staff float — their balances are complete', () => {
    for (const acct of [office, staff]) {
      const v = judgeDraw(acct, 1000, 1500);
      expect(v.blocked).toBe(true);
      // ⚠️ Nothing is waiting to be posted into these, so a shortfall is real rather than a
      // timing artefact. The message says so, because "insufficient funds" alone invites the
      // same shrug the cashier case earns.
      expect(v.message).toMatch(/balance is complete/);
    }
  });

  it('⚠️ exact equality is not an overdraft', () => {
    expect(judgeDraw(office, 1000, 1000).blocked).toBe(false);
    expect(judgeDraw(office, 1000, 1000).message).toBeUndefined();
  });

  it('a cent over IS, on both paths', () => {
    expect(judgeDraw(office, 1000, 1000.01).blocked).toBe(true);
    expect(judgeDraw(cashier, 1000, 1000.01).message).toBeTruthy();
  });
});
