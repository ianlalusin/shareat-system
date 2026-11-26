import { describe, expect, it } from 'vitest';
import { money, type Money } from '@shareat/core/money';
import {
  isFrequencyJump,
  isOutlier,
  isSpendSpike,
  madOf,
  meanCountText,
  medianMoney,
  outlierLimit,
  ratioText,
  usualWeeklySpend,
  type ExpenseAlertThresholds,
} from '../../src/repo/expense-alerts';

/**
 * T-639 - the pure maths of the expense alerts: spike, usual week, MAD outlier, frequency, ratio text. docs/tasks/639-expense-alerts.md "Rule" and "Tests".
 * No database. Each test names the mutant (a wrong implementation) it turns red. Amounts are exact Money; no float anywhere.
 */
const m = (...xs: string[]): Money[] => xs.map((x) => money(x));
const T: ExpenseAlertThresholds = { spikeX100: 150n, minAmount: money('5000.00'), outlierX100: 500n, frequencyX100: 200n, frequencyMinCount: 4 };

describe('T-639 medianMoney', () => {
  it('odd count: the middle of the SORTED values; even count: the average of the two middles; empty: null [kills: median of the unsorted list, or the upper middle]', () => {
    expect(medianMoney(m('300', '100', '200'))).toBe('200.00');
    expect(medianMoney(m('400', '100', '300', '200'))).toBe('250.00');
    expect(medianMoney([])).toBeNull();
  });

  it('an even count that does not split to the centavo rounds half-up: 0.01 and 0.02 -> 0.02 [kills: truncation]', () => {
    expect(medianMoney(m('0.01', '0.02'))).toBe('0.02');
  });
});

describe('T-639 usualWeeklySpend - the 8-week median excludes zero weeks', () => {
  it('zero weeks are not part of the median: [100k, 0, 100k, 0, 0, 100k] is 100k [kills: counting zero weeks, which drags the median to 0]', () => {
    expect(usualWeeklySpend(m('100000', '0', '100000', '0', '0', '100000'))).toBe('100000.00');
  });

  it('the middle of the weeks that had spending: [90k, 100k, 130k, 60k, 110k] is 100k', () => {
    expect(usualWeeklySpend(m('90000', '100000', '130000', '60000', '110000'))).toBe('100000.00');
  });

  it('fewer than three weeks with any spending is no usual week yet: null, so an empty history or a brand-new category raises no alarm [kills: judging on one or two weeks]', () => {
    expect(usualWeeklySpend([])).toBeNull();
    expect(usualWeeklySpend(m('100000', '100000'))).toBeNull();
    expect(usualWeeklySpend(m('100000', '0', '0', '100000', '100000'))).not.toBeNull();
  });
});

describe('T-639 isSpendSpike - X times the usual week and the peso floor', () => {
  it('the example Ian gave: 200,000 against a usual 100,000 at 1.5 times is a spike [kills: a detector that never fires]', () => {
    expect(isSpendSpike(money('200000.00'), money('100000.00'), T)).toBe(true);
  });

  it('exactly 1.5 times is NOT a spike, one centavo over it is [kills: >= instead of >]', () => {
    expect(isSpendSpike(money('150000.00'), money('100000.00'), T)).toBe(false);
    expect(isSpendSpike(money('150000.01'), money('100000.00'), T)).toBe(true);
  });

  it('over X times but under the peso floor above usual stays quiet: usual 2,000, this 3,500 (1.75 times, only 1,500 more) [kills: ignoring the floor]', () => {
    expect(isSpendSpike(money('3500.00'), money('2000.00'), T)).toBe(false);
  });

  it('the floor is inclusive: exactly 5,000 more flags, 4,999.99 more does not [kills: > instead of >= on the floor]', () => {
    const t = { ...T, spikeX100: 120n };
    expect(isSpendSpike(money('15000.00'), money('10000.00'), t)).toBe(true);
    expect(isSpendSpike(money('14999.99'), money('10000.00'), t)).toBe(false);
  });

  it('the multiplier is a threshold, not a constant: at 3 times, 200k against 100k is quiet; at 1.5 it fires [kills: 1.5 hard-coded]', () => {
    expect(isSpendSpike(money('200000.00'), money('100000.00'), { ...T, spikeX100: 300n })).toBe(false);
    expect(isSpendSpike(money('200000.00'), money('100000.00'), { ...T, spikeX100: 150n })).toBe(true);
  });

  it('exact centavos: 33,333.33 x 1.5 is 50,000.00 (half-up of 49,999.995), so 50,000.00 is not over and 50,000.01 is [kills: a float compare, which calls 50,000.00 over 49,999.995]', () => {
    const usual = money('33333.33');
    const t = { ...T, minAmount: money('0.00') };
    expect(isSpendSpike(money('50000.00'), usual, t)).toBe(false);
    expect(isSpendSpike(money('50000.01'), usual, t)).toBe(true);
  });
});

describe('T-639 ratioText', () => {
  it('one decimal, half-up: 2.0, 1.5, 1.3 for 1.25, 0.3 for a third, 0.7 for two thirds [kills: truncation or a float toFixed]', () => {
    expect(ratioText(money('200000.00'), money('100000.00'))).toBe('2.0');
    expect(ratioText(money('150000.00'), money('100000.00'))).toBe('1.5');
    expect(ratioText(money('125.00'), money('100.00'))).toBe('1.3');
    expect(ratioText(money('100.00'), money('300.00'))).toBe('0.3');
    expect(ratioText(money('200.00'), money('300.00'))).toBe('0.7');
  });
});

describe('T-639 MAD outlier - median + k x MAD', () => {
  const history = m('10000', '10200', '9800', '10100', '9900', '10000', '10300', '9700', '10000', '10000');

  it('median and MAD of the history: median 10,000, MAD 100 [kills: MAD taken as the mean deviation or the range]', () => {
    expect(madOf(history)).toEqual({ median: '10000.00', mad: '100.00' });
    expect(madOf(m('10', '12', '14', '16', '100'))).toEqual({ median: '14.00', mad: '2.00' });
  });

  it('needs at least 10 earlier expenses: nine give no limit, ten give median + 5 x MAD = 10,500 [kills: judging on a thin history]', () => {
    expect(outlierLimit(history.slice(0, 9), 500n)).toBeNull();
    expect(outlierLimit(history, 500n)?.limit).toBe('10500.00');
  });

  it('above the limit flags, exactly at it does not [kills: >= instead of >]', () => {
    const o = outlierLimit(history, 500n)!;
    const t0 = money('0.00');
    expect(isOutlier(money('10500.01'), o, t0)).toBe(true);
    expect(isOutlier(money('10500.00'), o, t0)).toBe(false);
  });

  it('k is a threshold: 10,600 is over the limit at k=5 but not at k=10 (limit 11,000) [kills: k hard-coded]', () => {
    const t0 = money('0.00');
    expect(isOutlier(money('10600.00'), outlierLimit(history, 500n)!, t0)).toBe(true);
    expect(isOutlier(money('10600.00'), outlierLimit(history, 1000n)!, t0)).toBe(false);
  });

  it('over the limit but under the peso floor above the typical amount stays quiet; a big one fires [kills: ignoring the floor]', () => {
    const o = outlierLimit(history, 500n)!;
    expect(isOutlier(money('10600.00'), o, money('5000.00'))).toBe(false);
    expect(isOutlier(money('20000.00'), o, money('5000.00'))).toBe(true);
  });

  it('identical history has a MAD of zero: a 500-peso difference does not flag (floor), 6,000 does [kills: flagging on a zero spread]', () => {
    const flat = outlierLimit(m(...Array<string>(10).fill('20000')), 500n)!;
    expect(flat.mad).toBe('0.00');
    expect(isOutlier(money('20500.00'), flat, money('5000.00'))).toBe(false);
    expect(isOutlier(money('26000.00'), flat, money('5000.00'))).toBe(true);
  });
});

describe('T-639 isFrequencyJump - more than X times the 8-week average count, with a minimum', () => {
  it('average 2 a week (16 in 8 weeks): 5 this week is a jump at 2 times, exactly 4 is not [kills: >= instead of >]', () => {
    expect(isFrequencyJump(5, 16, T)).toBe(true);
    expect(isFrequencyJump(4, 16, T)).toBe(false);
  });

  it('below the minimum count never flags, however small the average: average 0.5, this week 3 [kills: ignoring the minimum]', () => {
    expect(isFrequencyJump(3, 4, T)).toBe(false);
    expect(isFrequencyJump(4, 4, T)).toBe(true);
  });

  it('the multiplier and the minimum are thresholds: 3 times makes 5 against 16 quiet; a minimum of 6 makes 5 quiet [kills: 2 or 4 hard-coded]', () => {
    expect(isFrequencyJump(5, 16, { ...T, frequencyX100: 300n })).toBe(false);
    expect(isFrequencyJump(5, 16, { ...T, frequencyMinCount: 6 })).toBe(false);
  });

  it('meanCountText: 16 -> 2.0, 5 -> 0.6, 4 -> 0.5, 3 -> 0.4, 0 -> 0.0 [kills: integer division of the mean]', () => {
    expect([16, 5, 4, 3, 0].map(meanCountText)).toEqual(['2.0', '0.6', '0.5', '0.4', '0.0']);
  });
});
