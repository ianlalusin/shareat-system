import { describe, expect, it } from 'vitest';
// db-free leaf, like the T-512 / T-558 registry tests.
import { RULE_REGISTRY, isBusinessRuleKey } from '../../src/business-rules/registry';

/**
 * T-575 (TESTER) - the registry entry `pos.senior_id_repeat_days`: how many business days back a senior/PWD card number counts as "used before".
 * docs/tasks/575-pos-repeat-senior-id-warning.md as amended by the planner review (13 Nov 2026): org-wide, unit `days`, default 1 (= the same business day, Ian's ruling (a)), 1..30.
 *
 * RED NOW: the key is not in the registry.
 */
const KEY = 'pos.senior_id_repeat_days';
const entry = () => (RULE_REGISTRY as Record<string, Record<string, unknown>>)[KEY];

describe('T-575 registry - pos.senior_id_repeat_days', () => {
  it('is a registry key', () => {
    expect(isBusinessRuleKey(KEY)).toBe(true);
    expect(Object.keys(RULE_REGISTRY)).toContain(KEY);
  });

  it('is unit days, default 1, min 1, max 30, the one rules capability, the pos namespace [kills: a default of 0 (never warns) or above 1 (changes Ian ruling (a)); a ceiling above 30]', () => {
    expect(entry()).toMatchObject({ unit: 'days', default: '1', min: '1', max: '30', capability: 'manage_business_rules', namespace: 'pos' });
  });

  it('the label and help are plain words: no key name, no jargon, and the help says it never blocks a sale [kills: a screen that shows pos.senior_id_repeat_days]', () => {
    const { label, help } = entry() as { label: string; help: string };
    expect(label.length).toBeGreaterThan(10);
    expect(`${label} ${help}`).not.toMatch(/pos\.|_days|statutory|org_id/i);
    expect(help).toMatch(/never block|not block|still/i);
  });

  it('the POS keys are the four earlier ones plus this one and the T-576 one (nothing else crept in)', () => {
    const pos = Object.keys(RULE_REGISTRY).filter((k) => k.startsWith('pos.')).sort();
    expect(pos).toEqual(['pos.business_day_start_hour', 'pos.require_pin_line_actions', 'pos.sale_variance_tolerance', 'pos.senior_id_repeat_days', 'pos.senior_pwd_discount_percent', 'pos.table_warn_minutes']);
  });
});
