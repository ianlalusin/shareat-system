import { describe, expect, it } from 'vitest';
import { AI_DEFAULTS, MICRO, percentOfCap, pesosText, rateText, settingsOrDefaults, usageLevel } from '../../src/ai/shared';

/**
 * T-640 test 5 (the arithmetic half): the monthly cap, the warning share and the peso text, all in whole numbers. The DB-backed refusals at call time are in
 * packages/domain/tests/integration/t640-ai-router.test.ts.
 */
describe('T-640 cap arithmetic', () => {
  const cap = 1000; // pesos

  it('under the warning share is ok, at or over it warns, at or over the cap is capped [kills: an off-by-one at the cap or at 80%]', () => {
    expect(usageLevel(0, cap, 80)).toBe('ok');
    expect(usageLevel(799_999_999, cap, 80)).toBe('ok');
    expect(usageLevel(800_000_000, cap, 80)).toBe('warn');
    expect(usageLevel(999_999_999, cap, 80)).toBe('warn');
    expect(usageLevel(1_000_000_000, cap, 80)).toBe('capped');
    expect(usageLevel(5_000_000_000, cap, 80)).toBe('capped');
  });

  it('a cap of 0 refuses everything, and the warning share is a setting, not a constant [kills: a hard-coded 80, a zero cap that lets calls through]', () => {
    expect(usageLevel(0, 0, 80)).toBe('capped');
    expect(usageLevel(500_000_000, cap, 50)).toBe('warn');
    expect(usageLevel(500_000_000, cap, 51)).toBe('ok');
    expect(usageLevel(1, cap, 1)).toBe('ok');
  });

  it('percent of the cap rounds down and never exceeds 100 [kills: a progress bar past the end]', () => {
    expect(percentOfCap(0, cap)).toBe(0);
    expect(percentOfCap(799_000_000, cap)).toBe(79);
    expect(percentOfCap(1_000_000_000, cap)).toBe(100);
    expect(percentOfCap(9_000_000_000, cap)).toBe(100);
    expect(percentOfCap(5, 0)).toBe(0);
  });

  it('micro-pesos print as exact pesos and centavos, rounded to the nearest centavo, no float [kills: 0.1 + 0.2 on a bill]', () => {
    expect(pesosText(0)).toBe('0.00');
    expect(pesosText(4_999)).toBe('0.00');
    expect(pesosText(5_000)).toBe('0.01');
    expect(pesosText(15_660)).toBe('0.02');
    expect(pesosText(1_234_560_000)).toBe('1234.56');
    expect(pesosText(1000 * MICRO)).toBe('1000.00');
    expect(pesosText(-5)).toBe('0.00');
  });

  it('the peso rate prints with two places [kills: 58 shown as 58]', () => {
    expect(rateText(5800)).toBe('58.00');
    expect(rateText(5750)).toBe('57.50');
    expect(rateText(1005)).toBe('10.05');
  });

  it('with no row, the defaults are Ian\'s: 1,000 pesos a month, 30 questions a day, 58.00, warn at 80, on [kills: a changed default]', () => {
    expect(AI_DEFAULTS).toEqual({ enabled: true, monthlyCapPesos: 1000, dailyLimitPerPerson: 30, pesosPerUsdHundredths: 5800, warnAtPercent: 80 });
    expect(settingsOrDefaults(null)).toEqual({ ...AI_DEFAULTS });
    const row = { enabled: false, monthlyCapPesos: 5, dailyLimitPerPerson: 1, pesosPerUsdHundredths: 6000, warnAtPercent: 10, extra: 'x' };
    expect(settingsOrDefaults(row)).toEqual({ enabled: false, monthlyCapPesos: 5, dailyLimitPerPerson: 1, pesosPerUsdHundredths: 6000, warnAtPercent: 10 });
  });
});
