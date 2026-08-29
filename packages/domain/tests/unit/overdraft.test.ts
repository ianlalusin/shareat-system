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
  // ⚠️ Every account carries an overdraft limit, but only a CASHIER one consults it — office and
  // staff balances are complete, so they block at zero regardless of what this says.
  const cashier = { name: 'Cashier drawer', custodian: 'cashier' as const, overdraftLimit: '20000.00', floatTarget: null };
  const office = { name: 'Office safe', custodian: 'office' as const, overdraftLimit: '20000.00', floatTarget: null };
  const staff = { name: 'Ana float', custodian: 'staff' as const, overdraftLimit: '20000.00', floatTarget: null };
  // ⭐ T-153 — custodian 'cashier', but a SIDE POCKET rather than a drawer that runs behind.
  const pot = { name: 'Lipa till float', custodian: 'cashier' as const, overdraftLimit: '20000.00', floatTarget: '20000.00' };

  it('says nothing at all when the money is there', () => {
    expect(judgeDraw(cashier, 1000, 400)).toEqual({ blocked: false });
    expect(judgeDraw(office, 1000, 1000)).toEqual({ blocked: false });
  });

  it('⭐ WARNS but does not block a cashier drawer WITHIN its overdraft', () => {
    const v = judgeDraw(cashier, 1000, 1500);
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
    const v = judgeDraw(cashier, 1000, 22000);
    expect(v.blocked).toBe(true);
    expect(v.message).toMatch(/would go to −21000\.00/);
    expect(v.message).toMatch(/past the 20000\.00 overdraft/);
  });

  it('⭐ the boundary is where the balance LANDS, not how big the draw is', () => {
    // Exactly at the limit is allowed — −0 to −20,000 inclusive.
    expect(judgeDraw(cashier, 0, 20000).blocked).toBe(false);
    // One peso past it is not.
    expect(judgeDraw(cashier, 0, 20001).blocked).toBe(true);
    // ⚠️ And a HUGE draw against a well-funded drawer is fine, because it lands inside the limit —
    // judging the draw instead of the resulting balance would refuse this wrongly.
    expect(judgeDraw(cashier, 100000, 105000).blocked).toBe(false);
  });

  it('⛔ a limit of ZERO means this drawer may never go below zero at all', () => {
    const strict = { ...cashier, overdraftLimit: '0.00' };
    expect(judgeDraw(strict, 1000, 1000).blocked).toBe(false);
    expect(judgeDraw(strict, 1000, 1000.01).blocked).toBe(true);
  });

  it('⚠️ the limit is IGNORED for office and staff — their balances are complete', () => {
    const generous = { ...office, overdraftLimit: '999999.00' };
    // A limit column exists on every account, but consulting it here would invent an overdraft for
    // an account whose balance has nothing outstanding to explain a shortfall.
    expect(judgeDraw(generous, 1000, 1500).blocked).toBe(true);
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

  // -----------------------------------------------------------------------------------
  // T-153 — the float pot
  // -----------------------------------------------------------------------------------

  it('⭐ a FLOAT POT blocks at zero, even though its custodian is the cashier', () => {
    // Ian, 2026-08-29: "we guard all accounts to never go negative, all stops at 0 never below."
    const v = judgeDraw(pot, 1500, 2000);
    expect(v.blocked).toBe(true);
    expect(v.message).toMatch(/side pocket/);
  });

  it('⛔ and it does NOT consult the overdraft limit, which a drawer of the same custodian does', () => {
    // Same custodian, same limit, same numbers — opposite verdicts. ⭐ The warn-vs-block split is
    // about whether the ledger can see the WHOLE balance, not about who holds it: a takings drawer
    // is provisional until the day is verified, a float pot only ever moves by transfer.
    expect(judgeDraw(cashier, 1000, 1500).blocked).toBe(false);
    expect(judgeDraw(pot, 1000, 1500).blocked).toBe(true);
  });

  it('says nothing when the float covers the draw — spending it IS allowed', () => {
    // ⚠️ Drawing on the float is ordinary: Ian's worked example pays a delivery from the takings
    // drawer and then from the float when the drawer is exhausted. What is refused is going BELOW
    // zero; the pot then reads under target and the finding asks for it to be topped back up.
    expect(judgeDraw(pot, 20000, 1500)).toEqual({ blocked: false });
  });
});
