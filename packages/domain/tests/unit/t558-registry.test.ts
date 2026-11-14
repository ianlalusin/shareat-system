import { describe, expect, it } from 'vitest';
// db-free leaf, like the T-512 registry test.
import { RULE_REGISTRY, isBusinessRuleKey } from '../../src/business-rules/registry';

/**
 * T-558 R1 (TESTER) - the registry entry `pos.sale_variance_tolerance`. docs/tasks/558-pos-sale-variance-tolerance.md R1; bible row 453.
 * "The registry max is the hard ceiling": Ian, 11 Nov 2026, "may raise the tolerance up to .1".
 *
 * RED NOW: the key is not in the registry.
 */
const KEY = 'pos.sale_variance_tolerance';
const entry = () => (RULE_REGISTRY as Record<string, Record<string, unknown>>)[KEY];

describe('T-558 registry - pos.sale_variance_tolerance', () => {
  it('is a registry key', () => {
    expect(isBusinessRuleKey(KEY)).toBe(true);
    expect(Object.keys(RULE_REGISTRY)).toContain(KEY);
  });

  it('carries exactly the spec words, unit, default 0.01, min 0, max 0.10 (the ceiling), the one rules capability and the pos namespace [kills: a ceiling above 0.10; a default other than a centavo]', () => {
    expect(entry()).toEqual({
      label: 'Largest short payment on a POS sale that counts as normal (₱)',
      help: 'The most a cashier may accept below the bill without it being flagged as a shortfall. ₱0.01 covers normal rounding.',
      unit: 'money',
      default: '0.01',
      min: '0',
      max: '0.10',
      capability: 'manage_business_rules',
      namespace: 'pos',
    });
  });

  it('the POS keys are the three T-539 ones plus this one, the T-575 one and the T-576 one (nothing else crept in)', () => {
    const pos = Object.keys(RULE_REGISTRY).filter((k) => k.startsWith('pos.')).sort();
    expect(pos).toEqual(['pos.business_day_start_hour', 'pos.require_pin_line_actions', 'pos.sale_variance_tolerance', 'pos.senior_id_repeat_days', 'pos.senior_pwd_discount_percent', 'pos.table_warn_minutes']); // T-575 added pos.senior_id_repeat_days
  });
});
