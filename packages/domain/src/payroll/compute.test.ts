import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { advanceToRecover, computePay, type DayInput, type Multipliers } from './compute';

/**
 * T-189's compute. **This is the code that decides somebody's money**, so it is pure and tested
 * without a database: every case below is arithmetic a person could check on paper.
 */
const M: Multipliers = {
  requiredHoursPerShift: '9', // 8 worked + 1 paid break — the live default
  overtimeMultiplier: '1.25',
  nightDiffMultiplier: '1.10',
  holidayMultiplier: '2.0',
};

const day = (over: Partial<DayInput> = {}): DayInput => ({
  shiftDay: '2026-01-05',
  isHalfDay: false,
  otMinutes: 0,
  nightDiffMinutes: 0,
  holidayMinutes: 0,
  computedMinutes: 540,
  dailyRate: '540.00',
  ...over,
});

describe('basic pay — daily basis', () => {
  it('pays the daily rate once per full day', () => {
    const p = computePay([day(), day(), day()], M);
    expect(p.daysWorked).toBe(3);
    expect(p.basicPay).toBe(money('1620.00'));
    expect(p.grossPay).toBe(money('1620.00'));
  });

  it('⭐ a HALF day pays HALF THE DAILY RATE, never the hours covered', () => {
    // ⛔ The locked v1 decision, and it was a FIX: hourly half-days used to pay
    // `computedHours × rate` — 5h against a 9h day — which paid half the unpaid break twice.
    const p = computePay([day({ isHalfDay: true, computedMinutes: 300 })], M);
    expect(p.daysWorked).toBe(0.5);
    expect(p.basicPay).toBe(money('270.00'));
  });

  it('⭐ resolves the rate PER DAY — a mid-period raise pays both', () => {
    const p = computePay(
      [day({ dailyRate: '500.00' }), day({ dailyRate: '500.00' }), day({ dailyRate: '600.00' })],
      M,
    );
    expect(p.basicPay).toBe(money('1600.00'));
  });

  it('an empty period is zero, not a crash', () => {
    const p = computePay([], M);
    expect(p.grossPay).toBe(money('0'));
    expect(p.daysWorked).toBe(0);
  });
});

describe('premiums', () => {
  it('overtime pays the FULL multiplier — those minutes are outside the shift', () => {
    // hourly equiv = 540 / 9 = 60. 2h OT × 60 × 1.25 = 150
    const p = computePay([day({ otMinutes: 120 })], M);
    expect(p.otPay).toBe(money('150.00'));
    expect(p.grossPay).toBe(money('690.00'));
  });

  it('⚠️ night differential is an ADD-ON — × (multiplier − 1), never × multiplier', () => {
    // The hour is already paid once inside the daily rate. 3h × 60 × 0.10 = 18
    const p = computePay([day({ nightDiffMinutes: 180 })], M);
    expect(p.nightDiffPay).toBe(money('18.00'));
    // ⛔ NOT 198.00 — that would pay the base hour a second time.
    expect(p.grossPay).toBe(money('558.00'));
  });

  it('⚠️ holiday is an ADD-ON too — 2.0 means one EXTRA day, not two days', () => {
    // 9h × 60 × (2.0 − 1) = 540 on top of the 540 already in basic
    const p = computePay([day({ holidayMinutes: 540 })], M);
    expect(p.holidayPay).toBe(money('540.00'));
    expect(p.grossPay).toBe(money('1080.00'));
  });

  it('premiums stack onto one day and the gross identity holds', () => {
    const p = computePay([day({ otMinutes: 60, nightDiffMinutes: 120, holidayMinutes: 540 })], M);
    expect(p.grossPay).toBe(
      money(
        (
          Number(p.basicPay) +
          Number(p.otPay) +
          Number(p.nightDiffPay) +
          Number(p.holidayPay)
        ).toFixed(2),
      ),
    );
  });
});

describe('⛔ misconfiguration must not become Infinity pay', () => {
  it('a store with zero required hours pays basic and NO premiums', () => {
    // Dividing by zero would make every premium Infinity, and the payslip CHECK would then
    // complain about an identity instead of about the setting that caused it.
    const p = computePay([day({ otMinutes: 120, nightDiffMinutes: 60 })], {
      ...M,
      requiredHoursPerShift: '0',
    });
    expect(p.basicPay).toBe(money('540.00'));
    expect(p.otPay).toBe(money('0'));
    expect(p.nightDiffPay).toBe(money('0'));
    expect(p.grossPay).toBe(money('540.00'));
  });
});

describe('⛔ recovering an advance', () => {
  it('recovers the whole advance when the pay covers it', () => {
    expect(advanceToRecover(money('5000.00'), money('1200.00'))).toBe(money('1200.00'));
  });

  it('⭐ is CAPPED at gross — net reaches zero and never goes below', () => {
    expect(advanceToRecover(money('800.00'), money('3000.00'))).toBe(money('800.00'));
  });

  it('⚠️ what is still owed stays owed — a thin payslip does not forgive the debt', () => {
    const gross = money('800.00');
    const owed = money('3000.00');
    const recovered = advanceToRecover(gross, owed);
    expect(Number(owed) - Number(recovered)).toBe(2200);
  });

  it('recovers nothing when nothing is owed, or when the advance is already repaid', () => {
    expect(advanceToRecover(money('5000.00'), money('0'))).toBe(money('0'));
    expect(advanceToRecover(money('5000.00'), money('-450.00'))).toBe(money('0'));
  });

  it('recovers nothing from a zero payslip', () => {
    expect(advanceToRecover(money('0'), money('1200.00'))).toBe(money('0'));
  });
});

describe('money discipline', () => {
  it('⚠️ every figure is an exact 2dp string — never a float', () => {
    // A rate that does not divide cleanly by the shift length: 555 / 9 = 61.666…
    const p = computePay([day({ dailyRate: '555.00', otMinutes: 100 })], M);
    for (const v of [p.basicPay, p.otPay, p.nightDiffPay, p.holidayPay, p.grossPay]) {
      expect(v).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('a long period does not accumulate rounding drift', () => {
    const days = Array.from({ length: 26 }, () => day({ dailyRate: '333.33' }));
    expect(computePay(days, M).basicPay).toBe(money('8666.58'));
  });
});
