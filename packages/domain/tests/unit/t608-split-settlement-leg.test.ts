import { describe, expect, it } from 'vitest';
import { leftToPay, loanSchedule, splitSettlementLeg } from '../../src/loans/interest';

/** T-608 - the pure split. Grab Quick Cash: 150,000.00, 1,771.88 x 90 -> T = 15,946,920 centavos, I = 946,920. */
const loan = { principalAmount: '150000.00', repaymentAmount: '1771.88', termPeriods: 90 };
const S = loanSchedule(loan)!;

describe('T-608 loanSchedule', () => {
  it('is T and I in centavos for a scheduled loan, null for none [kills: a loan with no amount or term scheduled; I wrong]', () => {
    expect(S).toEqual({ total: 15_946_920n, interest: 946_920n });
    expect(loanSchedule({ ...loan, repaymentAmount: null })).toBeNull();
    expect(loanSchedule({ ...loan, termPeriods: 0 })).toBeNull();
    expect(loanSchedule({ ...loan, repaymentAmount: '1666.66', termPeriods: 90 })).toBeNull(); // repays no more than was borrowed: nothing to split
  });
});

describe('T-608 splitSettlementLeg', () => {
  it('a full first leg is 1,666.67 + 105.21 [kills: ratio inverted]', () => {
    expect(splitSettlementLeg(S, 177_188n, 0n, 0n)).toEqual({ principal: 166_667n, interest: 10_521n });
  });
  it('no schedule: all principal [kills: split without a schedule]', () => {
    expect(splitSettlementLeg(null, 177_188n, 0n, 0n)).toEqual({ principal: 177_188n, interest: 0n });
  });
  it('90 full legs add up to exactly I and the principal, whatever the rounding [kills: per-leg rounding]', () => {
    let paid = 0n;
    let interest = 0n;
    let principal = 0n;
    for (let i = 0; i < 90; i++) {
      const s = splitSettlementLeg(S, 177_188n, paid, interest);
      expect(s.principal + s.interest).toBe(177_188n);
      paid += 177_188n;
      interest += s.interest;
      principal += s.principal;
    }
    expect([interest, principal]).toEqual([946_920n, 15_000_000n]);
  });
  it('interest is clamped to the leg, never below zero, and a dock past the total takes no interest beyond I [kills: no clamp]', () => {
    expect(splitSettlementLeg(S, 5_000n, 10_000_000n, 0n)).toEqual({ principal: 0n, interest: 5_000n });
    expect(splitSettlementLeg(S, 100n, 0n, 999_999n)).toEqual({ principal: 100n, interest: 0n });
    expect(splitSettlementLeg(S, 1_000_000n, 15_946_920n, 946_920n)).toEqual({ principal: 1_000_000n, interest: 0n });
  });
});

describe('T-608 leftToPay', () => {
  it('is T less principal and interest paid, floored at zero, and nothing before the loan is drawn [kills: principal-only reading]', () => {
    expect(leftToPay(S, { disbursed: '150000.00', principalPaid: '1666.67', interestPaid: '105.21' })).toBe(15_946_920n - 177_188n);
    expect(leftToPay(S, { disbursed: '150000.00', principalPaid: '150000.00', interestPaid: '9469.20' })).toBe(0n);
    expect(leftToPay(S, { disbursed: '0.00', principalPaid: '0.00', interestPaid: '0.00' })).toBe(0n);
  });
});
