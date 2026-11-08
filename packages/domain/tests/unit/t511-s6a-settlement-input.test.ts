/**
 * T-511 S6a (TESTER, 7 Nov 2026) - the staged day line becomes a settlement input with SEVERAL loan legs. Pure. No posting, no database.
 * docs/tasks/511-settlement-upload-s6-spec.md "S6a" (staged path); docs/designs/channel-settlement-upload.md Component H items 1-2.
 * The existing `t511-s5b-settlement-input.test.ts` still pins the single `loan` shape; the builder updates it (listed in the hand-back) and this file takes over.
 *
 * RED TODAY: `loanLegsForLine` does not exist and `lineToSettlementInput` still returns one `loan` and `recognizeGain: false`.
 *
 * NAMES PINNED (the brief and the design call the function `buildSettlementInput(line, context)`; the code has always called it `lineToSettlementInput` and the
 * S5b source scan pins that name, so it stays; the "context" is the loan check):
 *  L1  `loanLegsForLine(line, check)` in settlement-input.ts: `line` = { storeId, loanDeduction }; `check` = the company-wide loan check result
 *      ({ allocations, rowStoreIds, byLoan }, as `checkLoanDay` returns) or null. Returns { legs, blocker }.
 *      legs = the allocations of THIS store's rows, merged per loan (one leg per loan, exact centavos), in the order each loan first appears, each
 *      { loanId, amount: 'N.NN', ownerStoreId: the loan's owner store }. An admin override needs no special case: `checkLoanDay` already allocates pinned rows.
 *      blocker = a plain sentence (names no id) when the line deducts something and the legs do not add up to it exactly (no check, no allocation, a partial
 *      allocation); then legs is [] - never a list that is short of the deduction. A zero deduction gives { legs: [], blocker: null } whatever the check says.
 *  L2  `lineToSettlementInput(line, loanLegs?)`: the second argument is that legs list. Result has `loanLegs` (a fresh copy; [] when no legs are given or the
 *      line deducts nothing) and none of `loan`, `recognizeGain`; `acknowledgeDifference` is not set (a staged day is never auto-acknowledged: approve asks a person).
 *  L3  the module stays pure: no `@shareat/db` import, no runtime import of ./loan-check (a type import is fine), no posting call, nothing async.
 *  L4  day-checks.ts builds the legs with `loanLegsForLine(` and hands them to `lineToSettlementInput(`.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { checkLoanDay, type OpenLoan } from '../../src/settlement-intake/loan-check';
import * as input from '../../src/settlement-intake/settlement-input';

const { lineToSettlementInput } = input;
const loanLegsForLine = (input as unknown as { loanLegsForLine: (line: { storeId: string; loanDeduction: string }, check: unknown) => { legs: { loanId: string; amount: string; ownerStoreId: string }[]; blocker: string | null } }).loanLegsForLine;

const S1 = '00000000-0000-4000-8000-0000000000a1';
const S2 = '00000000-0000-4000-8000-0000000000a2';
const CHANNEL = '00000000-0000-4000-8000-0000000000c1';
const L1 = '00000000-0000-4000-8000-0000000000e1';
const L2 = '00000000-0000-4000-8000-0000000000e2';

/** Lipa 20 Oct Grab: order value 9,928.00, commission 2,482.00, loans 590.00 + 1,770.00 = 2,360.00 (the figures of the S5b tests, split in two). */
const line = {
  storeId: S1, channelId: CHANNEL, salesDate: '2026-10-20', orderValue: '9928.00', commission: '2482.00', marketing: '0.00', platformFee: '0.00',
  loanDeduction: '2360.00', netPayout: '5086.00', payoutReference: 'SPXYZ',
};

const loans: OpenLoan[] = [
  { loanId: L1, name: 'Grab advance 1', ownerStoreId: S1, ownerStoreName: 'Lipa', startDate: '2026-09-01', repaymentAmount: money('590.00'), outstandingBefore: money('4000.00') },
  { loanId: L2, name: 'Grab advance 2', ownerStoreId: S2, ownerStoreName: 'Malvar', startDate: '2026-09-02', repaymentAmount: money('1770.00'), outstandingBefore: money('4000.00') },
];
const rows = (...r: [key: string, storeId: string, amount: string, loanId?: string][]) => r.map(([key, storeId, amount, loanId]) => ({ key, storeId, amount: money(amount), loanId: loanId ?? null }));
const check = (r: ReturnType<typeof rows>) => checkLoanDay({ salesDate: '2026-10-20', loans, rows: r, storesNeedingFile: [], storesWithFile: new Set() });
const sorted = <T extends { loanId: string }>(xs: T[]) => [...xs].sort((a, b) => a.loanId.localeCompare(b.loanId));

describe('T-511 S6a - loanLegsForLine: the legs of a staged day', () => {
  it('a two-loan Lipa day (590.00 + 1,770.00) gives two legs that sum to the deduction, each with its loan and its loan owner store [kills: one leg of the whole deduction; the owner store of the wrong loan; legs not summing]', () => {
    const { legs, blocker } = loanLegsForLine(line, check(rows(['a', S1, '590.00'], ['b', S1, '1770.00'])));
    expect(blocker).toBeNull();
    expect(legs).toEqual([
      { loanId: L1, amount: '590.00', ownerStoreId: S1 },
      { loanId: L2, amount: '1770.00', ownerStoreId: S2 },
    ]);
    expect(legs.reduce((t, l) => t + BigInt(l.amount.replace('.', '')), 0n)).toBe(BigInt(line.loanDeduction.replace('.', '')));
  });

  it('a row that splits across two loans gives a leg on each loan [kills: a split row assigned wholly to its first loan]', () => {
    // one row of 2,360.00: the loan check fills L1 (590.00) then L2 (1,770.00)
    const { legs, blocker } = loanLegsForLine(line, check(rows(['a', S1, '2360.00'])));
    expect(blocker).toBeNull();
    expect(legs).toEqual([
      { loanId: L1, amount: '590.00', ownerStoreId: S1 },
      { loanId: L2, amount: '1770.00', ownerStoreId: S2 },
    ]);
  });

  it('two rows on the SAME loan become ONE leg of their sum: (settlement, loan, owner) is unique in the database [kills: two legs on one loan, which the unique refuses at commit]', () => {
    const one = { ...line, loanDeduction: '590.00' };
    const { legs, blocker } = loanLegsForLine(one, check(rows(['a', S1, '300.00'], ['b', S1, '290.00'])));
    expect(blocker).toBeNull();
    expect(legs).toEqual([{ loanId: L1, amount: '590.00', ownerStoreId: S1 }]);
  });

  it("another store's rows of the same day are not this line's legs [kills: the company-wide allocation taken whole]", () => {
    // row order a (Lipa 590.00 -> loan 1), c (Malvar 1,000.00 -> loan 2), b (Lipa 770.00 -> the rest of loan 2): Lipa's own deduction is 1,360.00, the day's 2,360.00
    const { legs, blocker } = loanLegsForLine({ ...line, loanDeduction: '1360.00' }, check(rows(['a', S1, '590.00'], ['c', S2, '1000.00'], ['b', S1, '770.00'])));
    expect(blocker).toBeNull();
    expect(legs).toEqual([
      { loanId: L1, amount: '590.00', ownerStoreId: S1 },
      { loanId: L2, amount: '770.00', ownerStoreId: S2 },
    ]);
  });

  it('an admin override changes the legs: pinning the 1,770.00 row to loan 1 moves the money between the loans, still 2,360.00 in all [kills: the override ignored; legs rebuilt from the automatic split]', () => {
    const auto = loanLegsForLine(line, check(rows(['a', S1, '590.00'], ['b', S1, '1770.00'])));
    const pinned = loanLegsForLine(line, check(rows(['a', S1, '590.00'], ['b', S1, '1770.00', L1])));
    expect(pinned.blocker).toBeNull();
    expect(sorted(auto.legs).map((l) => [l.loanId, l.amount])).toEqual([[L1, '590.00'], [L2, '1770.00']]);
    expect(sorted(pinned.legs).map((l) => [l.loanId, l.amount])).toEqual([[L1, '1770.00'], [L2, '590.00']]);
    expect(pinned.legs.reduce((t, l) => t + BigInt(l.amount.replace('.', '')), 0n)).toBe(236000n);
  });

  it('no deduction: no legs and no blocker, whatever the check says, and a null check is fine [kills: a blocker on every Foodpanda day; a leg of zero]', () => {
    const none = { ...line, loanDeduction: '0.00' };
    expect(loanLegsForLine(none, null)).toEqual({ legs: [], blocker: null });
    expect(loanLegsForLine(none, check(rows(['c', S2, '1000.00'])))).toEqual({ legs: [], blocker: null });
  });

  it('⛔ a deduction with NO allocation is a named blocker, never silent: legs [] and a plain sentence about the loan [kills: an empty legs list that passes as "no loan"; a blocker that names an id]', () => {
    for (const c of [null, check(rows(['c', S2, '1000.00'])), check([])]) {
      const { legs, blocker } = loanLegsForLine(line, c);
      expect(legs).toEqual([]);
      expect(blocker, 'a blocker is named').not.toBeNull();
      expect(blocker).toMatch(/loan/i);
      expect(blocker).not.toContain(L1);
      expect(blocker).not.toContain(S1);
    }
  });

  it('⛔ an allocation that is short of the deduction is a blocker, and no partial legs are handed on [kills: a short list of legs reaching the preview as if it were the deduction]', () => {
    // the file deducted 2,360.00 but the loan check only placed 590.00 of this store's rows
    const { legs, blocker } = loanLegsForLine(line, check(rows(['a', S1, '590.00'], ['c', S2, '1770.00'])));
    expect(legs).toEqual([]);
    expect(blocker).toMatch(/loan/i);
    // and one that is over the deduction
    const over = loanLegsForLine({ ...line, loanDeduction: '500.00' }, check(rows(['a', S1, '590.00'])));
    expect(over.legs).toEqual([]);
    expect(over.blocker).toMatch(/loan/i);
  });
});

describe('T-511 S6a - lineToSettlementInput: loanLegs replace the single loan', () => {
  const legs = [
    { loanId: L1, amount: '590.00', ownerStoreId: S1 },
    { loanId: L2, amount: '1770.00', ownerStoreId: S2 },
  ];

  it('with its legs a two-loan day carries loanLegs, and the figures balance the way T-150 checks them: gross - commission - marketing - platform fee - the legs = net [kills: legs dropped; a deduction kept as one lump]', () => {
    const out = lineToSettlementInput(line as never, legs as never) as unknown as Record<string, unknown>;
    expect(out).toMatchObject({
      storeId: S1, channelId: CHANNEL, businessDate: '2026-10-20', grossAmount: '9928.00', netDeposited: '5086.00', settledOn: '2026-10-20',
      deductions: { commission: '2482.00', marketing: '0.00', platformFee: '0.00' },
    });
    expect(out.loanLegs).toEqual(legs);
    const c = (t: string): bigint => BigInt(t.replace('.', ''));
    const d = out.deductions as Record<string, string>;
    const sum = (out.loanLegs as { amount: string }[]).reduce((t, l) => t + c(l.amount), 0n);
    expect(c(out.grossAmount as string) - c(d.commission!) - c(d.marketing!) - c(d.platformFee!) - sum).toBe(c(out.netDeposited as string));
  });

  it('there is no `loan`, no `recognizeGain` and no acknowledgement on a staged input: approve asks a person [kills: the old single-loan key kept; a day auto-acknowledged]', () => {
    const out = lineToSettlementInput(line as never, legs as never) as unknown as Record<string, unknown>;
    expect('loan' in out).toBe(false);
    expect('recognizeGain' in out).toBe(false);
    expect(out.acknowledgeDifference ?? null).toBeNull();
    expect('salesDayId' in out).toBe(false);
  });

  it('no legs given, or a zero deduction with legs given, is an empty list [kills: legs invented; legs of a day that deducts nothing]', () => {
    expect((lineToSettlementInput(line as never) as unknown as { loanLegs: unknown }).loanLegs).toEqual([]);
    expect((lineToSettlementInput({ ...line, loanDeduction: '0.00' } as never, legs as never) as unknown as { loanLegs: unknown }).loanLegs).toEqual([]);
  });

  it('a fresh copy every call: editing one result does not change the legs passed in or the next result [kills: the caller\'s list shared with the input]', () => {
    const a = lineToSettlementInput(line as never, legs as never) as unknown as { loanLegs: { amount: string }[] };
    a.loanLegs[0]!.amount = '0.01';
    a.loanLegs.pop();
    expect(legs[0]!.amount).toBe('590.00');
    expect(legs).toHaveLength(2);
    expect((lineToSettlementInput(line as never, legs as never) as unknown as { loanLegs: unknown }).loanLegs).toEqual(legs);
  });

  it('signs and the three deduction kinds are unchanged by the slice: a platform fee credit stays negative, vat / withholding / penalty are not keys [kills: a regression in the part S5b already pinned]', () => {
    const out = lineToSettlementInput({ ...line, platformFee: '-30.00', loanDeduction: '0.00' } as never) as unknown as { deductions: Record<string, string> };
    expect(out.deductions).toMatchObject({ commission: '2482.00', platformFee: '-30.00' });
    expect(Object.keys(out.deductions).sort()).toEqual(['commission', 'marketing', 'platformFee']);
  });
});

describe('T-511 S6a - the module stays pure and day-checks uses it', () => {
  const dir = join(__dirname, '..', '..', 'src', 'settlement-intake');
  const src = readFileSync(join(dir, 'settlement-input.ts'), 'utf8');
  it('settlement-input.ts imports no database, no runtime loan-check, calls no posting and has nothing async [kills: a db read hidden in the builder; the loan check pulled in at runtime]', () => {
    expect(src).not.toMatch(/from ['"]@shareat\/db['"]/);
    expect(src).not.toMatch(/^import (?!type\b)[^;]*from ['"]\.\/loan-check['"]/m);
    expect(src).not.toMatch(/recordChannelSettlement\s*\(/);
    expect(src).not.toMatch(/\basync\b/);
    expect(src).toMatch(/export function loanLegsForLine\b/);
  });
  it('day-checks.ts builds the legs from the loan check and passes them to the builder, and no longer says a two-loan day cannot be approved [kills: the preview still fed one loan; the note kept]', () => {
    const day = readFileSync(join(dir, 'day-checks.ts'), 'utf8');
    expect(day).toMatch(/loanLegsForLine\(/);
    expect(day).toMatch(/lineToSettlementInput\(/);
    expect(day).not.toMatch(/SPLIT_NOTE|covers two loans/);
  });
});
