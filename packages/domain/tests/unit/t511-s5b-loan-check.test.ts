/**
 * T-511 S5b (TESTER, 2026-11-05) - the company-wide Grab loan check, pure part. docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 3; design Component F
 * ("Loan check, company-wide per day") and decisions 6, 7. Real figures from the October files (docs/discovery/grab-foodpanda-settlement-files.md B2 and the
 * redacted fixtures): 591.24 a day to 12 Oct, 2,363.12 a day 13-26 Oct (Lipa + Malvar + Banay), 2,363.11 on 27 Oct, 1,771.88 from 28 Oct.
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/loan-check.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT (tester's choices where the spec leaves a signature open; the builder must meet these or ask BOSS to change the tests):
 *  L1  `checkLoanDay(input): LoanCheckResult` and `loanCheckForViewer(result, viewer): LoanCheckViewerView`, both pure and exported from `loan-check.ts`
 *      (and reachable from `@shareat/domain`). Money values are `Money` (numeric text, "591.24").
 *  L2  input = { salesDate, loans: OpenLoan[], rows: DeductionRow[], storesNeedingFile: { storeId, storeName }[], storesWithFile: ReadonlySet<string> }
 *        OpenLoan     = { loanId, name, ownerStoreId, ownerStoreName, startDate, repaymentAmount: Money | null, outstandingBefore: Money }
 *        DeductionRow = { key, storeId, amount: Money (a magnitude), loanId?: string | null }   (a non-null loanId is an ADMIN override of that row)
 *      A loan is OPEN on the day when startDate is BEFORE salesDate (a later start is ignored; the equal-date case is not pinned) and outstandingBefore > 0
 *      (a paid-off loan is not expected: 28 Oct onwards). Rows are allocated in the order given.
 *  L3  Allocation: each non-overridden row, in order, fills the open loans oldest startDate first, each up to its repaymentAmount (less what overridden rows
 *      already put on it); a row that does not fit one loan is SPLIT across two. `allocations` = [{ rowKey, loanId, amount }], a split row has two entries.
 *      A loan with repaymentAmount null cannot absorb anything.
 *  L4  Result: { salesDate, status: 'ok' | 'mismatch' | 'waiting_for_other_stores' | 'no_matching_loan', blocking: boolean (true for every status but 'ok'),
 *      total: Money (all rows), expected: Money, allocations, byLoan: [{ loanId, loanName, ownerStoreId, ownerStoreName, expected, allocated, final: boolean }],
 *      waitingOn: [{ storeId, storeName }], sentence }.
 *      Order of decision: waiting (a store that needs a file has none) beats no_matching_loan (rows with nowhere to go, or no open loan with a repayment
 *      amount) beats mismatch beats ok. MISMATCH = some loan is allocated MORE than its expected, or the total falls SHORT of the summed expected by more than the
 *      allowed tolerance (L5). Allocated == expected on every loan, or a shortfall inside the tolerance, is OK.
 *  L5  FINAL DEDUCTION (spec "Decisions for BOSS" 5): an open loan is FINAL when outstandingBefore <= repaymentAmount + 0.01; its expected is then the remaining
 *      outstanding (outstandingBefore) instead of repaymentAmount. The allowed shortfall of the day's total is 0.01 ONLY when at least one open loan is final, else 0.00:
 *      Grab shortens the last payment by a centavo and the allocation cannot say which loan lost it. A surplus is never allowed (a loan over its expected is a mismatch).
 *  L6  Admin sentences: ok -> "Grab loan check, all stores together: <total> matches" (amounts with thousands separators, "2,363.12"); when a final loan took part:
 *      "Grab loan check, all stores together: 2,363.11 matches (last payment, rounded by Grab)". mismatch -> contains "loan amounts don't match" (or "do not match") and BOTH the
 *      amount taken and the amount expected. waiting -> "Waiting for other stores' files" (and the store names for an admin). no_matching_loan ->
 *      "No matching loan recorded". No sentence contains a UUID.
 *  L7  `loanCheckForViewer(result, { isAdmin: boolean, storeIds: ReadonlySet<string> })` -> { status, blocking, sentence, ownLines: { amount, loanName, ownerStoreName }[] }.
 *      An admin gets the full sentence and a line for every allocation. Anyone else: the sentence names no store, no foreign loan and NO company-wide amount (other
 *      stores' payments stay admin-only, design goal 7); a 'waiting' view reads exactly "Waiting for other stores' files"; `ownLines` has one entry per allocation of
 *      a row of the VIEWER'S OWN store (goal 7: a manager sees the amount, loan name and owner store of the deduction in his own store's payout, whichever store owns
 *      the loan) and nothing for any other store's rows. The serialized view contains no other store's name, no loan name that only another store's rows reach, no UUID.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { checkLoanDay, loanCheckForViewer } from '../../src/settlement-intake/loan-check';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LIPA = { storeId: '10000000-0000-4000-8000-00000000a001', storeName: 'Lipa' };
const MALVAR = { storeId: '10000000-0000-4000-8000-00000000a002', storeName: 'Malvar' };
const BANAY = { storeId: '10000000-0000-4000-8000-00000000a003', storeName: 'Banay-banay' };
const L1_ID = '20000000-0000-4000-8000-00000000b001';
const L2_ID = '20000000-0000-4000-8000-00000000b002';

const loan1 = (over: Record<string, unknown> = {}) => ({
  loanId: L1_ID, name: 'Grab loan 1', ownerStoreId: LIPA.storeId, ownerStoreName: 'Lipa', startDate: '2026-05-11',
  repaymentAmount: money('591.24'), outstandingBefore: money('50000.00'), ...over,
});
const loan2 = (over: Record<string, unknown> = {}) => ({
  loanId: L2_ID, name: 'Grab loan 2', ownerStoreId: LIPA.storeId, ownerStoreName: 'Lipa', startDate: '2026-10-12',
  repaymentAmount: money('1771.88'), outstandingBefore: money('140000.00'), ...over,
});
const row = (key: string, store: { storeId: string }, amount: string, loanId: string | null = null) => ({ key, storeId: store.storeId, amount: money(amount), loanId });
const all = new Set([LIPA.storeId, MALVAR.storeId, BANAY.storeId]);
const day = (over: Record<string, unknown>) => ({
  salesDate: '2026-10-14', loans: [loan1(), loan2()], rows: [], storesNeedingFile: [], storesWithFile: all, ...over,
}) as never;

describe('T-511 S5b loan check - allocation (oldest loan first, up to its repayment amount)', () => {
  it('1-12 Oct: only the first loan is open (the second starts 12 Oct); Lipa 591.24 matches; the row goes to the first loan [kills: a not-yet-open loan expected]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-05', rows: [row('a', LIPA, '591.24')] }));
    expect(r.status).toBe('ok');
    expect(r.blocking).toBe(false);
    expect([r.total, r.expected]).toEqual(['591.24', '591.24']);
    expect(r.allocations).toEqual([{ rowKey: 'a', loanId: L1_ID, amount: '591.24' }]);
    expect(r.sentence).toMatch(/Grab loan check, all stores together: 591\.24 matches/);
  });

  it('14 Oct, the real five rows of three stores (Lipa 509.12 + 208.50, Malvar 238.50, Banay 1,024.26 + 382.74 = 2,363.12): ok; the second Lipa row is SPLIT 82.12 to the older loan and 126.38 to the newer [kills: company sum per store; no split; wrong order]', () => {
    const rows = [row('a', LIPA, '509.12'), row('b', LIPA, '208.50'), row('c', MALVAR, '238.50'), row('d', BANAY, '1024.26'), row('e', BANAY, '382.74')];
    const r = checkLoanDay(day({ rows }));
    expect(r.status).toBe('ok');
    expect([r.total, r.expected]).toEqual(['2363.12', '2363.12']);
    expect(r.allocations).toEqual([
      { rowKey: 'a', loanId: L1_ID, amount: '509.12' },
      { rowKey: 'b', loanId: L1_ID, amount: '82.12' },
      { rowKey: 'b', loanId: L2_ID, amount: '126.38' },
      { rowKey: 'c', loanId: L2_ID, amount: '238.50' },
      { rowKey: 'd', loanId: L2_ID, amount: '1024.26' },
      { rowKey: 'e', loanId: L2_ID, amount: '382.74' },
    ]);
    expect(r.byLoan.map((l) => [l.loanId, l.allocated, l.expected])).toEqual([[L1_ID, '591.24', '591.24'], [L2_ID, '1771.88', '1771.88']]);
    expect(r.sentence).toMatch(/Grab loan check, all stores together: 2,363\.12 matches/);
  });

  it('13 Oct, Lipa 49.87 + 1,771.88 and Malvar 541.37: the 1,771.88 row is split (541.37 to the older loan, 1,230.51 to the newer); the day matches [kills: rows assumed to be whole loans]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-13', rows: [row('a', LIPA, '49.87'), row('b', LIPA, '1771.88'), row('c', MALVAR, '541.37')] }));
    expect(r.status).toBe('ok');
    expect(r.allocations.filter((x) => x.rowKey === 'b')).toEqual([{ rowKey: 'b', loanId: L1_ID, amount: '541.37' }, { rowKey: 'b', loanId: L2_ID, amount: '1230.51' }]);
  });

  it('the order the rows arrive in changes who gets which piece, never the loan totals or the answer [kills: an answer that depends on row order]', () => {
    const a = checkLoanDay(day({ salesDate: '2026-10-13', rows: [row('a', LIPA, '49.87'), row('b', LIPA, '1771.88'), row('c', MALVAR, '541.37')] }));
    const b = checkLoanDay(day({ salesDate: '2026-10-13', rows: [row('c', MALVAR, '541.37'), row('b', LIPA, '1771.88'), row('a', LIPA, '49.87')] }));
    expect(b.status).toBe(a.status);
    expect(b.byLoan.map((l) => l.allocated)).toEqual(a.byLoan.map((l) => l.allocated));
  });

  it('28 Oct onwards: the first loan has nothing outstanding and is not expected; Lipa 1,771.88 matches against the second loan alone [kills: a paid-off loan still expected]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-28', loans: [loan1({ outstandingBefore: money('0.00') }), loan2()], rows: [row('a', LIPA, '1771.88')] }));
    expect(r.status).toBe('ok');
    expect(r.expected).toBe('1771.88');
    expect(r.byLoan.map((l) => l.loanId)).toEqual([L2_ID]);
  });

  it('an admin override pins a row to a loan whatever the order would have been: the two rows swapped onto the wrong loans make the day not match [kills: override ignored]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-20', rows: [row('a', LIPA, '591.24', L2_ID), row('b', LIPA, '1771.88', L1_ID)] }));
    expect(r.status).toBe('mismatch');
    expect(r.byLoan.map((l) => [l.loanId, l.allocated])).toEqual([[L1_ID, '1771.88'], [L2_ID, '591.24']]);
    const same = checkLoanDay(day({ salesDate: '2026-10-20', rows: [row('a', LIPA, '591.24', L1_ID), row('b', LIPA, '1771.88', L2_ID)] }));
    expect(same.status).toBe('ok');
  });
});

describe('T-511 S5b loan check - no matching loan recorded (blocks)', () => {
  it('a loan with no repayment amount cannot be matched: the deduction has nowhere to go [kills: a missing amount treated as zero or as OK]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-20', loans: [loan2({ repaymentAmount: null, startDate: '2026-05-11' })], rows: [row('a', LIPA, '1771.88')] }));
    expect(r.status).toBe('no_matching_loan');
    expect(r.blocking).toBe(true);
    expect(r.sentence).toMatch(/No matching loan recorded/i);
  });

  it('no open loan at all, with a deduction in a file: no matching loan recorded [kills: OK because there is nothing to compare]', () => {
    const r = checkLoanDay(day({ loans: [], rows: [row('a', LIPA, '591.24')] }));
    expect(r.status).toBe('no_matching_loan');
    expect(r.blocking).toBe(true);
  });

  it('more deducted than the open loans can take (Lipa 1,000.00 against one loan of 591.24): never OK, always blocking [kills: surplus swallowed]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-05', rows: [row('a', LIPA, '1000.00')] }));
    expect(['mismatch', 'no_matching_loan']).toContain(r.status);
    expect(r.blocking).toBe(true);
  });
});

describe('T-511 S5b loan check - the 0.01 tolerance applies ONLY to a loan\'s final deduction', () => {
  const rows27 = [row('a', LIPA, '1235.02'), row('b', LIPA, '591.23'), row('c', MALVAR, '536.86')];

  it('27 Oct, the real case: the company sum 2,363.11 against 2,363.12, the first loan on its last payment (591.24 left): OK, said in plain words [kills: no tolerance on the last day]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-27', loans: [loan1({ outstandingBefore: money('591.24') }), loan2()], rows: rows27 }));
    expect(r.status).toBe('ok');
    expect(r.total).toBe('2363.11');
    expect(r.byLoan.find((l) => l.loanId === L1_ID)?.final).toBe(true);
    expect(r.byLoan.find((l) => l.loanId === L2_ID)?.final).toBe(false);
    expect(r.sentence).toBe('Grab loan check, all stores together: 2,363.11 matches (last payment, rounded by Grab)');
  });

  it('27 Oct when exactly 591.23 is left: the expected is the remaining outstanding and the sum is exact [kills: expected stays at the repayment amount]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-27', loans: [loan1({ outstandingBefore: money('591.23') }), loan2()], rows: rows27 }));
    expect(r.status).toBe('ok');
    expect(r.expected).toBe('2363.11');
  });

  it('the same sum 2,363.11 on a day when no loan is near its end: does NOT match [kills: tolerance on every day]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-20', rows: rows27 }));
    expect(r.status).toBe('mismatch');
    expect(r.blocking).toBe(true);
    expect(r.sentence).toMatch(/loan amounts (don't|do not) match/i);
    expect(r.sentence).toContain('2,363.11');
    expect(r.sentence).toContain('2,363.12');
  });

  it('a loan still FINAL at repayment + 0.01 (591.25 left) uses the remaining outstanding: 2,363.12 taken against 2,363.13 expected is within one centavo; at 591.26 left it is not final and 2,363.11 fails [kills: boundary off by a centavo]', () => {
    const at = checkLoanDay(day({ salesDate: '2026-10-27', loans: [loan1({ outstandingBefore: money('591.25') }), loan2()], rows: [row('a', LIPA, '591.24'), row('b', LIPA, '1771.88')] }));
    expect(at.byLoan.find((l) => l.loanId === L1_ID)?.final).toBe(true);
    expect(at.status).toBe('ok');
    const past = checkLoanDay(day({ salesDate: '2026-10-27', loans: [loan1({ outstandingBefore: money('591.26') }), loan2()], rows: rows27 }));
    expect(past.byLoan.find((l) => l.loanId === L1_ID)?.final).toBe(false);
    expect(past.status).toBe('mismatch');
  });

  it('even on a final day a gap of two centavos fails [kills: tolerance wider than 0.01]', () => {
    const r = checkLoanDay(day({ salesDate: '2026-10-27', loans: [loan1({ outstandingBefore: money('591.24') }), loan2()], rows: [row('a', LIPA, '1235.02'), row('b', LIPA, '591.22'), row('c', MALVAR, '536.86')] }));
    expect(r.status).toBe('mismatch');
  });
});

describe('T-511 S5b loan check - waiting for other stores\' files', () => {
  it('Lipa alone on 13 Oct (1,821.75 of 2,363.12) while Malvar still has no file: WAITING, not a mismatch; blocks; the admin sentence names the store [kills: a partial day shown as a mismatch]', () => {
    const r = checkLoanDay(day({
      salesDate: '2026-10-13', rows: [row('a', LIPA, '49.87'), row('b', LIPA, '1771.88')],
      storesNeedingFile: [LIPA, MALVAR], storesWithFile: new Set([LIPA.storeId]),
    }));
    expect(r.status).toBe('waiting_for_other_stores');
    expect(r.blocking).toBe(true);
    expect(r.waitingOn).toEqual([MALVAR]);
    expect(r.sentence).toMatch(/Waiting for other stores['’] files/i);
    expect(r.sentence).toContain('Malvar');
  });

  it('once every store that needs a file has one, the same rows give the real answer [kills: waiting forever]', () => {
    const rows = [row('a', LIPA, '49.87'), row('b', LIPA, '1771.88'), row('c', MALVAR, '541.37')];
    const r = checkLoanDay(day({ salesDate: '2026-10-13', rows, storesNeedingFile: [LIPA, MALVAR], storesWithFile: new Set([LIPA.storeId, MALVAR.storeId]) }));
    expect(r.status).toBe('ok');
    expect(r.waitingOn).toEqual([]);
  });
});

describe('T-511 S5b loan check - what a manager may see (loan privacy)', () => {
  const waiting = () => checkLoanDay(day({
    salesDate: '2026-10-13', loans: [loan1({ name: 'Grab loan 1' }), loan2({ name: 'Secret second loan', ownerStoreId: MALVAR.storeId, ownerStoreName: 'Malvar' })],
    rows: [row('a', LIPA, '591.24')], storesNeedingFile: [LIPA, MALVAR], storesWithFile: new Set([LIPA.storeId]),
  }));
  const mismatch = () => checkLoanDay(day({
    salesDate: '2026-10-20', loans: [loan1({ name: 'Grab loan 1' }), loan2({ name: 'Secret second loan', ownerStoreId: MALVAR.storeId, ownerStoreName: 'Malvar' })],
    rows: [row('a', LIPA, '591.24'), row('c', MALVAR, '1771.00')],
  }));
  const manager = { isAdmin: false, storeIds: new Set([LIPA.storeId]) };
  const admin = { isAdmin: true, storeIds: new Set([LIPA.storeId, MALVAR.storeId]) };

  it('a manager of Lipa, waiting on Malvar: exactly "Waiting for other stores\' files", no store name, no UUID [kills: Malvar named to a Lipa manager]', () => {
    const v = loanCheckForViewer(waiting(), manager);
    expect(v.status).toBe('waiting_for_other_stores');
    expect(v.blocking).toBe(true);
    expect(v.sentence).toMatch(/^Waiting for other stores['’] files\.?$/i);
    const text = JSON.stringify(v);
    expect(text).not.toContain('Malvar');
    expect(text).not.toContain('Banay');
    expect(text).not.toMatch(UUID);
  });

  it('a manager sees amount, loan name and owner store of the deduction in HIS OWN payout, and nothing about a loan only another store rows reach [kills: every loan listed]', () => {
    const v = loanCheckForViewer(waiting(), manager);
    expect(v.ownLines).toEqual([{ amount: '591.24', loanName: 'Grab loan 1', ownerStoreName: 'Lipa' }]);
    expect(JSON.stringify(v)).not.toContain('Secret second loan');
    const own = loanCheckForViewer(mismatch(), { isAdmin: false, storeIds: new Set([MALVAR.storeId]) });
    expect(own.ownLines).toEqual([{ amount: '1771.00', loanName: 'Secret second loan', ownerStoreName: 'Malvar' }]);
    expect(JSON.stringify(own)).not.toContain('Grab loan 1');
  });

  it('a manager on a mismatch: not OK and blocking, but no store name, no foreign loan name and none of the company-wide amounts (2,363.12 / 2,362.24) [kills: other stores\' payments leaked in the sentence]', () => {
    const full = mismatch();
    expect(full.status).toBe('mismatch');
    const v = loanCheckForViewer(full, manager);
    expect(v.status).toBe('mismatch');
    expect(v.blocking).toBe(true);
    const text = JSON.stringify(v);
    for (const secret of ['Malvar', 'Secret second loan', '2,363', '2363', '2,362', '2362']) expect(text, secret).not.toContain(secret);
    expect(text).not.toMatch(UUID);
  });

  it('an admin sees everything: the full sentence and a line for both loans [kills: the redaction applied to admins]', () => {
    const v = loanCheckForViewer(mismatch(), admin);
    expect(v.sentence).toContain('2,362.24');
    expect(v.sentence).toContain('2,363.12');
    expect(v.ownLines.map((l) => l.loanName)).toEqual(['Grab loan 1', 'Secret second loan']);
  });

  it('no sentence of any status, for anyone, contains a UUID, though ids are UUIDs here [kills: an id in a sentence]', () => {
    for (const r of [waiting(), mismatch(), checkLoanDay(day({ rows: [row('a', LIPA, '591.24')], loans: [] }))]) {
      expect(r.sentence).not.toMatch(UUID);
      expect(loanCheckForViewer(r, manager).sentence).not.toMatch(UUID);
      expect(loanCheckForViewer(r, admin).sentence).not.toMatch(UUID);
    }
  });
});

describe('T-511 S5b loan check - the module stays pure', () => {
  it('the pure functions live in a file that reads no database in checkLoanDay (source has no sql template) [kills: SQL in the check]', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'settlement-intake', 'loan-check.ts'), 'utf8');
    expect(src).not.toMatch(/\bsql`/);
    expect(src).not.toMatch(/drizzle-orm/);
  });
});
