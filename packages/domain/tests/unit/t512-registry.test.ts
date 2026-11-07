import { describe, expect, it } from 'vitest';
// db-free leaf: the registry imports nothing from @shareat/db (it is read by the settings screen and by pure code alike).
import { RULE_REGISTRY, isBusinessRuleKey } from '../../src/business-rules/registry';

/**
 * T-512 (T-511 S5c) TESTER - the closed registry of business rules. docs/tasks/512-business-rules-s5c-spec.md "Closed registry".
 *
 * RED today: `packages/domain/src/business-rules/registry.ts` does not exist (module not found).
 *
 * ASSUMPTIONS beyond the agreed list (builders must follow them):
 *   - `min`, `max` and `default` may be strings or numbers; the tests read them through Number(...).
 *   - `namespace` is the key's first dotted segment, in any letter case ('settlement' or 'Settlement'); the screen shows the headings Settlement and Tax.
 *   - `isBusinessRuleKey` is a type guard over the OWN keys of the registry (no prototype keys such as 'toString' or '__proto__').
 */
const KEYS = [
  'settlement.variance_floor_amount',
  'settlement.variance_percent',
  'settlement.loan_final_tolerance',
  'tax.withholding_rate_percent',
  'tax.vat_percent',
] as const;

const entries = Object.entries(RULE_REGISTRY) as [string, Record<string, unknown>][];

describe('T-512 registry - closed set', () => {
  it('holds the five T-512 keys, unchanged in name (T-539 adds the two POS keys on top, pinned in t539-pos-rule-keys; T-519 adds its own later) [kills: a missing or renamed T-512 key]', () => {
    const have = Object.keys(RULE_REGISTRY);
    for (const k of KEYS) expect(have, k).toContain(k);
    expect(have.filter((k) => !(KEYS as readonly string[]).includes(k)).sort()).toEqual(['pos.business_day_start_hour', 'pos.senior_pwd_discount_percent']);
  });

  it('every entry carries label, help, unit, default, min, max, capability and namespace', () => {
    for (const [key, e] of entries) {
      for (const f of ['label', 'help', 'unit', 'default', 'min', 'max', 'capability', 'namespace']) {
        expect(e[f], `${key}.${f}`).toBeDefined();
      }
    }
  });

  it('every capability is manage_business_rules [kills: a rule that anyone with a lesser right may move]', () => {
    for (const [key, e] of entries) expect(e.capability, key).toBe('manage_business_rules');
  });

  it('units: money for the floor and the loan tolerance, percent for variance, withholding and VAT, as the spec table says', () => {
    const unit = (k: string) => (RULE_REGISTRY as Record<string, { unit: string }>)[k]!.unit;
    expect(unit('settlement.variance_floor_amount')).toBe('money');
    expect(unit('settlement.variance_percent')).toBe('percent');
    expect(unit('settlement.loan_final_tolerance')).toBe('money');
    expect(unit('tax.withholding_rate_percent')).toBe('percent');
    expect(unit('tax.vat_percent')).toBe('percent');
  });

  it('defaults reproduce today exactly: 50.00, 10, 0.01, 0.5, 12 (strings) [kills: a changed starting value]', () => {
    const d = (k: string) => (RULE_REGISTRY as Record<string, { default: unknown }>)[k]!.default;
    expect(d('settlement.variance_floor_amount')).toBe('50.00');
    expect(d('settlement.variance_percent')).toBe('10');
    expect(d('settlement.loan_final_tolerance')).toBe('0.01');
    expect(d('tax.withholding_rate_percent')).toBe('0.5');
    expect(d('tax.vat_percent')).toBe('12');
  });

  it('bounds: money 0..100000, percent 0..100, the loan tolerance at most 1.00; every default sits inside its own bounds [kills: an unbounded or inverted range]', () => {
    for (const [key, e] of entries) {
      const min = Number(e.min);
      const max = Number(e.max);
      const def = Number(e.default);
      expect(min, `${key} min`).toBe(0);
      expect(Number.isFinite(max), `${key} max finite`).toBe(true);
      expect(def, `${key} default >= min`).toBeGreaterThanOrEqual(min);
      expect(def, `${key} default <= max`).toBeLessThanOrEqual(max);
      if (e.unit === 'percent') expect(max, `${key} percent max`).toBeLessThanOrEqual(100);
      if (e.unit === 'money') expect(max, `${key} money max`).toBeLessThanOrEqual(100000);
    }
    const r = RULE_REGISTRY as Record<string, { max: unknown }>;
    expect(Number(r['settlement.variance_floor_amount']!.max)).toBe(100000);
    expect(Number(r['settlement.variance_percent']!.max)).toBe(100);
    expect(Number(r['tax.withholding_rate_percent']!.max)).toBe(100);
    expect(Number(r['tax.vat_percent']!.max)).toBe(100);
    expect(Number(r['settlement.loan_final_tolerance']!.max)).toBe(1);
  });

  it('defaults are exact: money has at most 2 decimals, percent at most 2 (so basis points are whole) [kills: a default the conversion cannot hold]', () => {
    for (const [key, e] of entries) {
      const text = String(e.default);
      expect(text, key).toMatch(/^\d+(\.\d{1,2})?$/);
    }
  });

  it('labels are plain words for a screen: not a key, no dot or underscore, no technical shorthand; distinct; help is a sentence [kills: raw keys shown to the user]', () => {
    const labels = new Set<string>();
    for (const [key, e] of entries) {
      const label = String(e.label);
      const help = String(e.help);
      expect(label.length, `${key} label`).toBeGreaterThan(3);
      expect(label, `${key} label is not the key`).not.toBe(key);
      expect(label, `${key} label has no dot or underscore`).not.toMatch(/[._]/);
      expect(label, `${key} label has no tax jargon in code form`).not.toMatch(/\b(bp|bps|centavos?|mills)\b/i);
      expect(help.length, `${key} help`).toBeGreaterThan(20);
      expect(help, `${key} help is a sentence`).toMatch(/[.?!]$/);
      labels.add(label);
    }
    expect(labels.size).toBe(entries.length);
  });

  it('namespace is the key prefix (Settlement or Tax)', () => {
    for (const [key, e] of entries) {
      expect(String(e.namespace).toLowerCase(), key).toBe(key.split('.')[0]);
    }
    // The five T-512 keys sit in Settlement or Tax; the POS namespace is T-539's two keys only.
    const ns = (keys: readonly string[]) => new Set(entries.filter(([k]) => keys.includes(k)).map(([, e]) => String(e.namespace).toLowerCase()));
    expect(ns(KEYS)).toEqual(new Set(['settlement', 'tax']));
    expect(new Set(entries.map(([, e]) => String(e.namespace).toLowerCase()))).toEqual(new Set(['settlement', 'tax', 'pos']));
  });
});

describe('T-512 registry - isBusinessRuleKey', () => {
  it('true for the five keys', () => {
    for (const k of KEYS) expect(isBusinessRuleKey(k), k).toBe(true);
  });

  it('false for a typo, a near miss, an empty string and the prototype keys [kills: `in` instead of own-key; a prefix match]', () => {
    for (const s of [
      '',
      'settlement.variance_floor',
      'settlement.variance_floor_amount ',
      'SETTLEMENT.VARIANCE_FLOOR_AMOUNT',
      'tax',
      'tax.vat',
      'payroll.deduction_cap_percent',
      'toString',
      'constructor',
      'hasOwnProperty',
      '__proto__',
      'valueOf',
    ]) {
      expect(isBusinessRuleKey(s), JSON.stringify(s)).toBe(false);
    }
  });
});
