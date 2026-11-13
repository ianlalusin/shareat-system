import { describe, expect, it } from 'vitest';
// db-free leaf, like the T-512 / T-558 / T-575 registry tests.
import { RULE_REGISTRY, isBusinessRuleKey } from '../../src/business-rules/registry';

/**
 * T-576 (TESTER) - the registry entry `pos.require_pin_line_actions`: when on, cancelling a line or giving a line discount needs a manager PIN.
 * docs/tasks/576-pos-manager-pin-setting-line-actions.md as amended by the planner review (13 Nov 2026): org-wide, unit `flag` (0 or 1), default 0 (off).
 */
const KEY = 'pos.require_pin_line_actions';
const entry = () => (RULE_REGISTRY as Record<string, Record<string, unknown>>)[KEY];

describe('T-576 registry - pos.require_pin_line_actions', () => {
  it('is a registry key', () => {
    expect(isBusinessRuleKey(KEY)).toBe(true);
  });

  it('is unit flag, default 0 (off), min 0, max 1, the one rules capability, the pos namespace [kills: a default of 1 (switches the rule on for every store on deploy)]', () => {
    expect(entry()).toMatchObject({ unit: 'flag', default: '0', min: '0', max: '1', capability: 'manage_business_rules', namespace: 'pos' });
  });

  it('the label and help are plain words: no key name, and the help says what a manager PIN is for [kills: a screen that shows pos.require_pin_line_actions]', () => {
    const { label, help } = entry() as { label: string; help: string };
    expect(label.length).toBeGreaterThan(10);
    expect(`${label} ${help}`).not.toMatch(/pos\.|_pin_|org_id/i);
    expect(help).toMatch(/PIN/);
  });

  it('the POS keys are the five earlier ones plus this one (nothing else crept in)', () => {
    const pos = Object.keys(RULE_REGISTRY).filter((k) => k.startsWith('pos.')).sort();
    expect(pos).toEqual(['pos.business_day_start_hour', 'pos.require_pin_line_actions', 'pos.sale_variance_tolerance', 'pos.senior_id_repeat_days', 'pos.senior_pwd_discount_percent', 'pos.table_warn_minutes']);
  });
});
