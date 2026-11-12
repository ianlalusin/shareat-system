/**
 * T-511 S7a (TESTER, 8 Nov 2026) - the staged day line as a settlement input, for APPROVE (the mapping of Ruling 3 and the netting of Ruling 6), and the blocker codes of
 * Ruling 4. Pure: no database. docs/tasks/511-settlement-upload-s7-spec.md.
 *
 * RED TODAY: `payoutReference` is not mapped (`reference` never set), `settledOn` is always the sales date, there is no third argument, no new blocker code exists.
 *
 * PINNED (tester's choices where the spec leaves a signature open; the builder meets these or asks BOSS to change the tests):
 *  M1  `lineToSettlementInput(line, legs?, opts?)`; the new THIRD argument is `{ willPostOn?: string | null; differenceReason?: string | null;
 *      charges?: { ids: readonly string[]; total: string } | null }` and nothing else is needed (the carrier is decided by the caller, `approveDay`, and arrives here as `charges`).
 *  M2  `reference` = the line's `payoutReference` (Grab settlement id, Foodpanda invoice number), cut to the field rule's 120 characters; a line with none has no reference
 *      (`null` or absent).
 *  M3  `settledOn` = `opts.willPostOn ?? salesDate`.
 *  M4  `acknowledgeDifference` is set ONLY from a typed reason: `{ reason }` (trimmed) when `differenceReason` has text; null or absent otherwise (blank is none).
 *  M5  `charges` given (a carrier): `settleChargeIds` = those ids (a copy) and `netDeposited` = staged net payout MINUS `charges.total`, exact centavos, 2 decimals, signed.
 *      Absent (every other day): no `settleChargeIds` (or empty) and `netDeposited` = the staged net payout, untouched.
 *  M6  `DAY_BLOCKER_CODES` holds loan_leg_problem, nothing_to_settle, sales_day_not_posted, period_charge_unbooked, after the existing eleven.
 *  M7  ONE CLOCK: `dayBlockers(..., { today })` already takes the clock (opts.today) and defaults to the Manila date of the process; approve must hand it the transaction's own
 *      date (the source scan of approve.ts pins that). The scan below pins that day-checks reads no other clock, and `settlement-input.ts` stays pure.
 *  M8  The existing S5b / S6a pins of this module still hold with no third argument (settledOn = salesDate; the deductions, legs and the pure-module scan).
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_BLOCKER_CODES } from '../../src/settlement-intake/day-checks';
import { lineToSettlementInput, loanLegsForLine } from '../../src/settlement-intake/settlement-input';

type Opts = { willPostOn?: string | null; differenceReason?: string | null; charges?: { ids: readonly string[]; total: string } | null };
const map = lineToSettlementInput as unknown as (line: unknown, legs?: unknown, opts?: Opts) => Record<string, unknown> & { deductions: Record<string, string>; netDeposited: string };

const STORE = '00000000-0000-4000-8000-0000000000a1';
const CHANNEL = '00000000-0000-4000-8000-0000000000c1';
const CHARGE = '00000000-0000-4000-8000-0000000000d1';
/** D3 of worked example 2: gross 10,000.00, fees 2,000.00, staged net 8,000.00 (the platform nets the 112.00 charge out of the invoice payout). */
const d3 = {
  storeId: STORE, channelId: CHANNEL, salesDate: '2026-10-14', orderValue: '10000.00', commission: '2000.00', marketing: '0.00', platformFee: '0.00', loanDeduction: '0.00',
  netPayout: '8000.00', payoutReference: '200777000001',
};

describe('S7a - the payout reference', () => {
  it('Foodpanda: the invoice number; Grab: the settlement id [kills: no reference (the bank line cannot be matched to the statement)]', () => {
    expect(map(d3).reference).toBe('200777000001');
    expect(map({ ...d3, payoutReference: 'SPHEX7A00001' }).reference).toBe('SPHEX7A00001');
  });
  it('no reference on the line: none on the input; a reference over 120 characters is cut to the rule 120, never refused later [kills: an input the posting refuses; a reference of "null"]', () => {
    expect(map({ ...d3, payoutReference: null }).reference ?? null).toBeNull();
    expect(map({ ...d3, payoutReference: '' }).reference ?? null).toBeNull();
    const cut = map({ ...d3, payoutReference: 'R'.repeat(200) }).reference as string;
    expect(cut.length).toBeLessThanOrEqual(120);
    expect('R'.repeat(200).startsWith(cut)).toBe(true);
    expect(map({ ...d3, payoutReference: 'R'.repeat(120) }).reference).toBe('R'.repeat(120));
  });
});

describe('S7a - the date it books on', () => {
  it('settledOn is willPostOn when the sales day month is closed, else the sales date; the businessDate stays the sales date [kills: posting into the closed month; the sales date moved]', () => {
    expect(map(d3, undefined, { willPostOn: '2026-11-01' })).toMatchObject({ settledOn: '2026-11-01', businessDate: '2026-10-14' });
    expect(map(d3, undefined, { willPostOn: null }).settledOn).toBe('2026-10-14');
    expect(map(d3, undefined, {}).settledOn).toBe('2026-10-14');
    expect(map(d3).settledOn, 'M8: with no third argument nothing changed').toBe('2026-10-14');
  });
});

describe('S7a - the acknowledgement comes only from a typed reason', () => {
  it('a reason typed by the approver becomes acknowledgeDifference { reason } (trimmed); none, blank or spaces is none [kills: a staged day auto-acknowledged; spaces accepted as a reason]', () => {
    expect(map(d3, undefined, { differenceReason: '  The customer paid us in cash  ' }).acknowledgeDifference).toEqual({ reason: 'The customer paid us in cash' });
    for (const none of [undefined, null, '', '   ']) expect(map(d3, undefined, { differenceReason: none }).acknowledgeDifference ?? null).toBeNull();
    expect(map(d3).acknowledgeDifference ?? null, 'M8: never set by default').toBeNull();
  });
});

describe('S7a - the carrier nets the charge once (Ruling 6)', () => {
  it('a carrier with one charge of 112.00: settleChargeIds is that charge and the net deposited is 8,000.00 - 112.00 = 7,888.00; gross and deductions untouched [kills: the charge subtracted from gross (4150 off); netted at a non-carrier; a float sum]', () => {
    const out = map(d3, undefined, { charges: { ids: [CHARGE], total: '112.00' } });
    expect(out.settleChargeIds).toEqual([CHARGE]);
    expect(out.netDeposited).toBe('7888.00');
    expect(out.grossAmount).toBe('10000.00');
    expect(out.deductions).toMatchObject({ commission: '2000.00', marketing: '0.00', platformFee: '0.00' });
  });
  it('no charges (every other day, or none booked): the staged net untouched and no ids [kills: the reduction applied to every day]', () => {
    for (const opts of [{}, { charges: null }, { charges: { ids: [], total: '0.00' } }] as Opts[]) {
      const out = map(d3, undefined, opts);
      expect(out.netDeposited).toBe('8000.00');
      expect(out.settleChargeIds ?? []).toEqual([]);
    }
  });
  it('exact centavos and sign: 8,000.10 - 0.07 = 8,000.03; a charge larger than the net gives a negative deposit (the negative-deposit blocker catches it), never zero [kills: float arithmetic; clamping]', () => {
    expect(map({ ...d3, netPayout: '8000.10' }, undefined, { charges: { ids: [CHARGE], total: '0.07' } }).netDeposited).toBe('8000.03');
    expect(map({ ...d3, netPayout: '100.00' }, undefined, { charges: { ids: [CHARGE], total: '110.00' } }).netDeposited).toBe('-10.00');
  });
  it('the ids are a copy: editing the result does not touch the list of the caller [kills: a shared mutable list]', () => {
    const ids = [CHARGE];
    const out = map(d3, undefined, { charges: { ids, total: '112.00' } });
    (out.settleChargeIds as string[]).push('x');
    expect(ids).toEqual([CHARGE]);
  });
});

describe('S7a - blocker codes and the loan text', () => {
  it('the four new codes exist after the eleven of S5b [kills: a blocker code approve cannot name]', () => {
    expect([...DAY_BLOCKER_CODES].slice(0, 11)).toEqual([
      'no_file', 'not_paid', 'charges_unexplained', 'store_not_matched', 'sales_day_not_verified', 'loan_check', 'no_destination_account', 'negative_net_deposit',
      'posted_settlement_exists', 'earlier_day_open', 'line_not_current',
    ]);
    for (const c of ['loan_leg_problem', 'nothing_to_settle', 'sales_day_not_posted', 'period_charge_unbooked']) expect(DAY_BLOCKER_CODES, c).toContain(c);
  });
  it('a deduction the legs cannot cover has a plain blocker sentence with no id, and a zero deduction has none (the source of the loan_leg_problem text) [kills: the text invented in day-checks instead of read from loanLegsForLine]', () => {
    const none = loanLegsForLine({ storeId: STORE, loanDeduction: '500.00' }, null);
    expect(none.legs).toEqual([]);
    expect(none.blocker).toMatch(/loan/i);
    expect(none.blocker).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(loanLegsForLine({ storeId: STORE, loanDeduction: '0.00' }, null).blocker).toBeNull();
  });
});

describe('S7a - day-checks: the blockers are one list, read from the pieces that already own each fact, on one clock', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'settlement-intake', 'day-checks.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  it('loan_leg_problem is built from the legs blocker (loanLegsForLine(...).blocker), not a second sentence [kills: a hand-written copy that drifts]', () => {
    expect(src.split("'loan_leg_problem'").length - 1, 'in the code list AND in a place that adds it').toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/\.blocker\b/);
  });
  it('the other new codes are produced here: nothing_to_settle, sales_day_not_posted, period_charge_unbooked [kills: a code in the list that nothing produces]', () => {
    for (const c of ['nothing_to_settle', 'sales_day_not_posted', 'period_charge_unbooked']) expect(src.split(`'${c}'`).length - 1, `${c}: in the code list AND in a place that adds it`).toBeGreaterThanOrEqual(2);
  });
  it('the only clock is opts.today (its default is the Manila date); no second clock was added [kills: Date.now / new Date in a blocker]', () => {
    expect(src).not.toMatch(/Date\.now\(|new Date\(|current_date/i);
    expect(src).toMatch(/opts\.today \?\? toBusinessDate\(\)/);
  });
  it('the existing open-period behaviour is unchanged: a closed month is a NOTE with willPostOn, never a blocker [kills: a closed period turned into a blocker]', () => {
    expect(src).toMatch(/willPostOn = f\.firstOpen\.date/);
    expect(src).not.toMatch(/add\(\s*'[a-z_]*(closed|period_locked)[a-z_]*'/);
  });
});

describe('S7a - settlement-input.ts stays pure', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'settlement-intake', 'settlement-input.ts'), 'utf8');
  it('no database, no posting, nothing async, no clock [kills: a read or a "today" slipped into the mapper]', () => {
    expect(src).not.toMatch(/from ['"]@shareat\/db['"]/);
    expect(src).not.toMatch(/recordChannelSettlement\s*\(/);
    expect(src).not.toMatch(/\basync\b/);
    expect(src).not.toMatch(/Date\.now\(|new Date\(|toBusinessDate|manilaToday/);
  });
});
