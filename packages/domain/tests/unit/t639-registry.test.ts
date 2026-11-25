import { describe, expect, it } from 'vitest';
// db-free leaves, like the T-512 / T-621 registry tests.
import { RULE_REGISTRY } from '../../src/business-rules/registry';
import { buildRuleBook } from '../../src/business-rules/book';

/**
 * T-639 - the five expense-alert thresholds as business rules. docs/tasks/639-expense-alerts.md ("Thresholds have a screen").
 * Defaults are the spec's: 1.5 times, a PHP 5,000 floor, 5 times the spread, 2 times the count, at least 4 expenses.
 */
const reg = RULE_REGISTRY as Record<string, { label: string; help: string; unit: string; default: string; min: string; max: string; capability: string; namespace: string }>;
const row = (key: string, value: string) => ({ id: '00000000-0000-0000-0000-000000000001', key, value, effectiveFrom: '2026-01-01', createdAt: new Date(0) });
const DAY = '2026-12-07';

describe('T-639 registry', () => {
  it('the five keys exist in the expenses namespace, admin-only, with the spec defaults [kills: a changed default, unit or bound]', () => {
    const want: Record<string, [string, string, number, number, number]> = {
      'expenses.alert_spike_multiplier': ['times', '1.5', 1, 20, 1.5],
      'expenses.alert_min_amount': ['money', '5000.00', 0, 100000, 5000],
      'expenses.alert_outlier_multiplier': ['times', '5', 1, 50, 5],
      'expenses.alert_frequency_multiplier': ['times', '2', 1, 20, 2],
      'expenses.alert_frequency_min_count': ['count', '4', 1, 1000, 4],
    };
    for (const [key, [unit, def, min, max]] of Object.entries(want)) {
      const e = reg[key];
      expect(e, key).toBeDefined();
      expect(e, key).toMatchObject({ unit, default: def, capability: 'manage_business_rules', namespace: 'expenses' });
      expect([Number(e!.min), Number(e!.max)], key).toEqual([min, max]);
    }
    expect(Object.keys(reg).filter((k) => k.startsWith('expenses.')).sort()).toEqual(Object.keys(want).sort());
  });

  it('the book reads the defaults exactly: 1.5 -> 150n, 5000 pesos -> 500000 centavos, 5 -> 500n, 2 -> 200n, 4 [kills: a multiplier read as a percent or a float]', () => {
    const book = buildRuleBook([]);
    expect(book.valueOn('expenses.alert_spike_multiplier', DAY).times()).toBe(150n);
    expect(book.valueOn('expenses.alert_min_amount', DAY).centavos()).toBe(500_000n);
    expect(book.valueOn('expenses.alert_outlier_multiplier', DAY).times()).toBe(500n);
    expect(book.valueOn('expenses.alert_frequency_multiplier', DAY).times()).toBe(200n);
    expect(book.valueOn('expenses.alert_frequency_min_count', DAY).count()).toBe(4);
  });

  it('a stored value wins from its day: 1.75 stored -> 175n; before its day the default holds [kills: a stored multiplier ignored]', () => {
    const book = buildRuleBook([{ ...row('expenses.alert_spike_multiplier', '1.750000'), effectiveFrom: '2026-12-01' }]);
    expect(book.valueOn('expenses.alert_spike_multiplier', DAY).times()).toBe(175n);
    expect(book.valueOn('expenses.alert_spike_multiplier', '2026-11-30').times()).toBe(150n);
  });

  it('times() refuses another unit and a figure finer than a hundredth; count() refuses another unit and a part number [kills: a reader that quietly answers for the wrong unit]', () => {
    expect(() => buildRuleBook([]).valueOn('expenses.alert_min_amount', DAY).times()).toThrow();
    expect(() => buildRuleBook([row('expenses.alert_spike_multiplier', '1.505000')]).valueOn('expenses.alert_spike_multiplier', DAY).times()).toThrow();
    expect(() => buildRuleBook([]).valueOn('expenses.alert_spike_multiplier', DAY).count()).toThrow();
    expect(() => buildRuleBook([row('expenses.alert_frequency_min_count', '4.500000')]).valueOn('expenses.alert_frequency_min_count', DAY).count()).toThrow();
    expect(() => buildRuleBook([]).valueOn('expenses.alert_frequency_min_count', DAY).times()).toThrow();
  });
});
