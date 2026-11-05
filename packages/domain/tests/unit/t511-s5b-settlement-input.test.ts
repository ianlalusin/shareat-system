/**
 * T-511 S5b (TESTER, 2026-11-05) - `lineToSettlementInput`: a staged day line becomes the T-150 `RecordSettlementInput` shape. Pure. No posting.
 * docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 1; design decision 15 (file order_value is NET) and decision 3 (only three deduction kinds).
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/settlement-input.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT (tester's choices where the spec leaves a signature open; the builder must meet these or ask BOSS to change the tests):
 *  C1  `lineToSettlementInput(line, loan?)` exported from `settlement-intake/settlement-input.ts` AND reachable from `@shareat/domain`.
 *      `line` is a `DayLineRow` (or any object with storeId, channelId, salesDate, orderValue, commission, marketing, platformFee, netPayout, loanDeduction,
 *      payoutReference). Money fields of the row are numeric(14,2) TEXT ("9928.00"), and so are the money fields of the result.
 *  C2  Result fields: storeId, channelId, businessDate = salesDate, grossAmount = orderValue (the FILE figure, net of the platform discount),
 *      netDeposited = netPayout, settledOn = salesDate, recognizeGain = false, deductions = EXACTLY { commission, marketing, platformFee } passed straight
 *      through (no sign change: commission and marketing are stored positive, platformFee is signed, a credit is negative), loan.
 *  C3  `loan` (second argument, optional): { loanId, ownerStoreId? }. When given AND the line's loanDeduction is not zero, the result's `loan` is
 *      { loanId, amount: line.loanDeduction, ownerStoreId } (the settlement's single loan leg of T-150; two-loan days need migration 0229, slice 6).
 *      With no second argument, or a zero loanDeduction, `loan` is null.
 *  C4  No `salesDayId` key in the result (a staged line has none; `previewChannelSettlement` takes the input without it). The other three deduction kinds
 *      (vatOnFees, withholdingTax, penalty) are not keys of `deductions`.
 *  C5  Pure: the module imports nothing from `@shareat/db` and never calls `recordChannelSettlement` (source scan below). It returns a new object each call.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineToSettlementInput } from '../../src/settlement-intake/settlement-input';

const STORE = '00000000-0000-4000-8000-0000000000a1';
const CHANNEL = '00000000-0000-4000-8000-0000000000c1';
const LOAN = '00000000-0000-4000-8000-0000000000e1';

/** Lipa 20 Oct Grab, the figures of docs/discovery/t511-exit5-store-day-comparison.md (order value 9,928.00, commission 2,482.00, loan 591.24 + 1,771.88). */
const lipa20Oct = {
  storeId: STORE,
  channelId: CHANNEL,
  salesDate: '2026-10-20',
  orderValue: '9928.00',
  commission: '2482.00',
  marketing: '0.00',
  platformFee: '0.00',
  loanDeduction: '2363.12',
  netPayout: '5082.88',
  payoutReference: 'SPXYZ',
};

describe('T-511 S5b - lineToSettlementInput: every field', () => {
  it('Lipa 20 Oct Grab with its loan: gross = FILE order value, net deposited = net payout, settled on the sales date, no gain recognised [kills: gross from gross_info; net from the wrong column; settledOn today; recognizeGain true]', () => {
    const out = lineToSettlementInput(lipa20Oct as never, { loanId: LOAN, ownerStoreId: STORE });
    expect(out).toMatchObject({
      storeId: STORE,
      channelId: CHANNEL,
      businessDate: '2026-10-20',
      grossAmount: '9928.00',
      netDeposited: '5082.88',
      settledOn: '2026-10-20',
      recognizeGain: false,
      deductions: { commission: '2482.00', marketing: '0.00', platformFee: '0.00' },
      loan: { loanId: LOAN, amount: '2363.12', ownerStoreId: STORE },
    });
  });

  it('the figures balance the way T-150 will check them: gross - commission - marketing - platform fee - loan = net deposited (9,928.00 - 2,482.00 - 2,363.12 = 5,082.88) [kills: a column swapped]', () => {
    const out = lineToSettlementInput(lipa20Oct as never, { loanId: LOAN });
    const c = (t: string): bigint => BigInt(t.replace('.', ''));
    const d = out.deductions as Record<string, string>;
    expect(c(out.grossAmount) - c(d.commission!) - c(d.marketing!) - c(d.platformFee!) - c(out.loan!.amount)).toBe(c(out.netDeposited));
  });

  it('only the three deduction kinds of decision 3 exist; no sales day id; no tax kinds [kills: vatOnFees / withholdingTax / penalty carried over; salesDayId invented]', () => {
    const out = lineToSettlementInput(lipa20Oct as never, { loanId: LOAN }) as unknown as Record<string, unknown>;
    expect(Object.keys(out.deductions as object).sort()).toEqual(['commission', 'marketing', 'platformFee']);
    expect('salesDayId' in out).toBe(false);
  });
});

describe('T-511 S5b - lineToSettlementInput: signs', () => {
  it('a platform fee credit stays negative and a fee stays positive; commission and marketing pass through positive [kills: abs(); sign flipped on the way]', () => {
    const credit = lineToSettlementInput({ ...lipa20Oct, platformFee: '-30.00', marketing: '45.60', loanDeduction: '0.00' } as never);
    expect(credit.deductions).toMatchObject({ commission: '2482.00', marketing: '45.60', platformFee: '-30.00' });
    const cost = lineToSettlementInput({ ...lipa20Oct, platformFee: '12.34', loanDeduction: '0.00' } as never);
    expect(cost.deductions).toMatchObject({ platformFee: '12.34' });
  });

  it('a negative net payout is passed on as it is (the day check, not this function, blocks it) [kills: clamping to zero]', () => {
    const out = lineToSettlementInput({ ...lipa20Oct, netPayout: '-175.50', loanDeduction: '0.00' } as never);
    expect(out.netDeposited).toBe('-175.50');
  });

  it('the gross is the FILE order value even when it is far from anything staff recorded: nothing here reads a recorded figure [kills: gross from the snapshot]', () => {
    const out = lineToSettlementInput({ ...lipa20Oct, recordedFigure: '9474.00', difference: '454.00' } as never);
    expect(out.grossAmount).toBe('9928.00');
  });
});

describe('T-511 S5b - lineToSettlementInput: the loan leg', () => {
  it('no loan argument -> loan null; a zero loan deduction with a loan argument -> null; a loan deduction with an argument -> one leg of the whole deduction [kills: loan invented; leg of zero]', () => {
    expect(lineToSettlementInput(lipa20Oct as never).loan ?? null).toBeNull();
    expect(lineToSettlementInput({ ...lipa20Oct, loanDeduction: '0.00' } as never, { loanId: LOAN }).loan ?? null).toBeNull();
    expect(lineToSettlementInput(lipa20Oct as never, { loanId: LOAN, ownerStoreId: STORE }).loan).toEqual({ loanId: LOAN, amount: '2363.12', ownerStoreId: STORE });
  });

  it('a new object every call: editing one result does not change the next [kills: a shared mutable result]', () => {
    const a = lineToSettlementInput(lipa20Oct as never, { loanId: LOAN });
    (a.deductions as Record<string, string>).commission = '0.00';
    expect(lineToSettlementInput(lipa20Oct as never, { loanId: LOAN }).deductions).toMatchObject({ commission: '2482.00' });
  });
});

describe('T-511 S5b - lineToSettlementInput: no posting, pure', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'settlement-intake', 'settlement-input.ts'), 'utf8');
  it('the module never imports the database and never calls the posting [kills: a posting hidden in a converter]', () => {
    expect(src).not.toMatch(/from ['"]@shareat\/db['"]/);
    expect(src).not.toMatch(/recordChannelSettlement\s*\(/);
    expect(src).not.toMatch(/\basync\b/);
  });
});
