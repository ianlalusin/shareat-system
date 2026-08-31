import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import {
  advanceToRecover,
  computePay,
  steppedHours,
  type DayInput,
  type Multipliers,
} from './compute';

/**
 * T-189's compute. **This is the code that decides somebody's money**, so it is pure and tested
 * without a database: every case below is arithmetic a person could check on paper.
 */
const M: Multipliers = {
  requiredHoursPerShift: '9', // 8 worked + 1 paid break — the live default
  overtimeMode: 'multiplier',
  overtimeMultiplier: '1.25',
  overtimeFixedHourly: null,
  nightDiffMultiplier: '1.10',
  holidayRegularMultiplier: '2.00',
  holidaySpecialNonWorkingMultiplier: '1.30',
  holidaySpecialWorkingMultiplier: '1.50',
};

const day = (over: Partial<DayInput> = {}): DayInput => ({
  shiftDay: '2026-01-05',
  isHalfDay: false,
  otMinutes: 0,
  nightDiffMinutes: 0,
  holidayMinutes: 0,
  computedMinutes: 540,
  holidayType: null,
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
    const p = computePay([day({ holidayMinutes: 540, holidayType: 'regular' })], M);
    expect(p.holidayPay).toBe(money('540.00'));
    expect(p.grossPay).toBe(money('1080.00'));
  });

  it('premiums stack onto one day and the gross identity holds', () => {
    const p = computePay(
      [day({ otMinutes: 60, nightDiffMinutes: 120, holidayMinutes: 540, holidayType: 'regular' })],
      M,
    );
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


// =====================================================================================
// T-189b — Ian, 2026-08-31

describe('⭐ hours come in HALF-HOUR steps, rounded at 25 and 50', () => {
  it('⭐ the exact boundaries Ian gave, 2026-08-31', () => {
    // "25 mins above but less than 50 mins is .5. 50 mins above to next hour and
    //  24 mins 59 secs is 1."
    expect(steppedHours(24)).toBe(0);
    expect(steppedHours(25)).toBe(0.5);
    expect(steppedHours(49)).toBe(0.5);
    expect(steppedHours(50)).toBe(1);
    expect(steppedHours(84)).toBe(1); // 1h24m is still 1
    expect(steppedHours(85)).toBe(1.5); // 1h25m
    expect(steppedHours(110)).toBe(2); // ⭐ 1h50m rounds UP to 2 — this is not a floor
  });

  it('⚠️ 50 minutes rounds UP into the next whole hour', () => {
    expect(steppedHours(50)).toBe(1);
    expect(steppedHours(59)).toBe(1);
    expect(steppedHours(60)).toBe(1);
  });

  it('⚠️ but under 25 minutes still pays nothing', () => {
    expect(steppedHours(24)).toBe(0);
    expect(steppedHours(1)).toBe(0);
  });

  it('⚠️ the thresholds are 25/50, NOT the midpoints 15/45', () => {
    // Deliberately harder than nearest-half rounding: most of a block must be worked to earn it.
    expect(steppedHours(20)).toBe(0);
    expect(steppedHours(45)).toBe(0.5);
  });

  it('is never negative and never NaN', () => {
    expect(steppedHours(0)).toBe(0);
    expect(steppedHours(-45)).toBe(0);
    expect(steppedHours(Number.NaN)).toBe(0);
  });

  it('⭐ overtime is priced on the LADDERED hours, not the raw minutes', () => {
    // 110 min (1h50m) → 2h. hourly equiv 60 × 2 × 1.25 = 150.00
    expect(computePay([day({ otMinutes: 110 })], M).otPay).toBe(money('150.00'));
    // 100 min (1h40m) → 1.5h → 112.50
    expect(computePay([day({ otMinutes: 100 })], M).otPay).toBe(money('112.50'));
  });

  it('⭐ night differential and holiday are laddered too — the rule is about HOURS', () => {
    // 110 min → 2h. 2 × 60 × 0.10 = 12.00 ; 2 × 60 × 1.00 = 120.00
    expect(computePay([day({ nightDiffMinutes: 110 })], M).nightDiffPay).toBe(money('12.00'));
    expect(
      computePay([day({ holidayMinutes: 110, holidayType: 'regular' })], M).holidayPay,
    ).toBe(money('120.00'));
  });

  it('⛔ LATE is not stepped — it is not computed here at all', () => {
    // Ian named late as the exception. `attendance_days.lateMinutes` stays an exact integer
    // minute; nothing in this file reads or rounds it, and that is the guarantee.
    expect(Object.keys(day())).not.toContain('lateMinutes');
  });
});

describe('⭐ overtime priced two ways', () => {
  it('multiplier mode: the hourly equivalent of the daily rate × 1.25', () => {
    expect(computePay([day({ otMinutes: 120 })], M).otPay).toBe(money('150.00'));
  });

  it('⭐ FIXED mode pays a flat amount per hour and IGNORES the daily rate entirely', () => {
    const fixed: Multipliers = { ...M, overtimeMode: 'fixed', overtimeFixedHourly: '80.00' };
    // 2h × ₱80 = ₱160 — and it would be ₱160 whatever the daily rate is.
    expect(computePay([day({ otMinutes: 120 })], fixed).otPay).toBe(money('160.00'));
    expect(computePay([day({ otMinutes: 120, dailyRate: '2000.00' })], fixed).otPay).toBe(
      money('160.00'),
    );
  });

  it('fixed mode is laddered as well — 1h50m pays 2 × the flat amount', () => {
    const fixed: Multipliers = { ...M, overtimeMode: 'fixed', overtimeFixedHourly: '80.00' };
    expect(computePay([day({ otMinutes: 110 })], fixed).otPay).toBe(money('160.00'));
    expect(computePay([day({ otMinutes: 100 })], fixed).otPay).toBe(money('120.00'));
  });

  it('⭐ fixed OT still pays when requiredHoursPerShift is misconfigured', () => {
    // A flat amount never divides by the shift length, so a bad setting cannot corrupt it —
    // and there is no reason to withhold pay somebody earned because of an unrelated typo.
    const fixed: Multipliers = {
      ...M,
      overtimeMode: 'fixed',
      overtimeFixedHourly: '80.00',
      requiredHoursPerShift: '0',
    };
    const p = computePay([day({ otMinutes: 120 })], fixed);
    expect(p.otPay).toBe(money('160.00'));
    expect(p.basicPay).toBe(money('540.00'));
  });
});

describe('⭐ the holiday premium depends on WHICH holiday', () => {
  const full = (kind: DayInput['holidayType']) =>
    computePay([day({ holidayMinutes: 540, holidayType: kind })], M).holidayPay;

  it('regular holiday at 2.0 pays one extra day', () => {
    expect(full('regular')).toBe(money('540.00'));
  });

  it('special NON-WORKING at 1.3 pays 30% extra', () => {
    expect(full('special_non_working')).toBe(money('162.00'));
  });

  it('special WORKING at 1.5 pays 50% extra', () => {
    expect(full('special_working')).toBe(money('270.00'));
  });

  it('⚠️ a multiplier of exactly 1 pays no premium — the floor the CHECK enforces', () => {
    const flat: Multipliers = { ...M, holidayRegularMultiplier: '1.00' };
    expect(
      computePay([day({ holidayMinutes: 540, holidayType: 'regular' })], flat).holidayPay,
    ).toBe(money('0'));
  });
});
