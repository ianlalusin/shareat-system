import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { drawScopeKey, judgeDrawers } from '../../src/expenses/approve';

/**
 * T-503 (DEF-807) - the pure grouping: accounts that share one balance pool are judged once, on the pool's total.
 * docs/tasks/503-def807-split-draw-scope.md rulings R1-R3, tests U1-U3.
 */
type Row = Parameters<typeof judgeDrawers>[0][number];
const acct = (id: string, o: Partial<Row['account']> = {}): Row['account'] =>
  ({ id, name: `Acct ${id}`, storeId: 's1', glAccountCode: '1130', custodian: 'office', overdraftLimit: '20000.00', floatTarget: null, ...o }) as Row['account'];
const row = (account: Row['account'], available: string, drawn: string): Row => ({ account, available: money(available), drawn: money(drawn) });

describe('T-503 judgeDrawers', () => {
  it('U1: one account per pool is judged exactly as before (its own name, its own figures)', () => {
    const out = judgeDrawers([row(acct('a'), '1000.00', '1200.00')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.verdict.blocked).toBe(true);
    expect(out[0]!.verdict.message).toBe('"Acct a" holds 1000.00 and this takes 1200.00. Unlike a cashier drawer, this balance is complete — nothing is waiting to be posted into it — so record the money coming in first, or draw it from somewhere that holds it.');
  });

  it('U2: two accounts in one (store, GL code) pool add up: 700 + 700 over 1,000 is blocked, 500 + 500 is not', () => {
    const blocked = judgeDrawers([row(acct('a'), '1000.00', '700.00'), row(acct('b'), '1000.00', '700.00')]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.verdict.blocked).toBe(true);
    expect(blocked[0]!.verdict.message).toMatch(/"Acct a \+ Acct b" holds 1000\.00 and this takes 1400\.00/);
    const ok = judgeDrawers([row(acct('a'), '1000.00', '500.00'), row(acct('b'), '1000.00', '500.00')]);
    expect(ok[0]!.verdict.blocked).toBe(false);
  });

  it('U2b: the same code at another store, or a 1140 wallet, is a separate pool', () => {
    const otherStore = judgeDrawers([row(acct('a'), '1000.00', '700.00'), row(acct('b', { storeId: 's2' }), '1000.00', '700.00')]);
    expect(otherStore).toHaveLength(2);
    expect(otherStore.every((o) => !o.verdict.blocked)).toBe(true);
    const wallets = judgeDrawers([
      row(acct('w1', { glAccountCode: '1140', custodian: 'cashier' }), '1000.00', '700.00'),
      row(acct('w2', { glAccountCode: '1140', custodian: 'cashier' }), '1000.00', '700.00'),
    ]);
    expect(wallets).toHaveLength(2);
    expect(wallets.every((o) => !o.verdict.blocked)).toBe(true);
  });

  it('U3: a cashier pool uses the SMALLEST overdraft limit among its accounts (never widened)', () => {
    const cash = (id: string, limit: string) => acct(id, { glAccountCode: '1110', custodian: 'cashier', overdraftLimit: limit });
    // pool holds 0; together they take 1,500; limits 2,000 and 1,000: lands at -1,500, past the smaller limit => blocked.
    const out = judgeDrawers([row(cash('a', '2000.00'), '0.00', '700.00'), row(cash('b', '1000.00'), '0.00', '800.00')]);
    expect(out[0]!.verdict.blocked).toBe(true);
    expect(out[0]!.verdict.message).toMatch(/past the 1000\.00 overdraft/);
  });

  it('U3b: a pool containing a non-cashier account blocks like an office balance', () => {
    const out = judgeDrawers([
      row(acct('a', { glAccountCode: '1110', custodian: 'cashier' }), '100.00', '60.00'),
      row(acct('b', { glAccountCode: '1110', custodian: 'office' }), '100.00', '60.00'),
    ]);
    expect(out[0]!.verdict.blocked).toBe(true);
  });

  it('U4: what an earlier draft carries on a pool-mate account counts against the pool (the verify cascade)', () => {
    const a = acct('a');
    const b = acct('b');
    const carried = new Map([[drawScopeKey(a), money('700.00')]]);
    const out = judgeDrawers([row(b, '1000.00', '700.00')], carried);
    expect(out[0]!.verdict.blocked).toBe(true);
    expect(out[0]!.verdict.message).toMatch(/holds 1000\.00 and this takes 1400\.00/);
    expect(judgeDrawers([row(b, '1000.00', '300.00')], carried)[0]!.verdict.blocked).toBe(false);
  });
});
