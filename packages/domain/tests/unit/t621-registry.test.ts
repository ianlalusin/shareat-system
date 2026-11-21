import { describe, expect, it } from 'vitest';
// db-free leaves, like the T-512 / T-576 registry tests.
import { RULE_REGISTRY } from '../../src/business-rules/registry';
import { buildRuleBook } from '../../src/business-rules/book';

/**
 * T-621 S2 - the two POS offline safety-rail rules. docs/tasks/621-pos-offline-safety-rails.md S2 and test 5.
 * Values decided in bible row 276 and docs/plans/pos-v2-design.md lines 149-150, 385: PHP 50,000 unsent warns; an offline X-slip every 4 hours.
 */
const reg = RULE_REGISTRY as Record<string, { label: string; help: string; unit: string; default: string; min: string; max: string; capability: string; namespace: string }>;

describe('T-621 S2 registry', () => {
  it('pos.offline_unsent_warn_amount: pesos, default 50000, 1000 to 1000000, admin-only, POS [kills: a changed default or bound]', () => {
    const e = reg['pos.offline_unsent_warn_amount'];
    expect(e).toBeDefined();
    expect(e).toMatchObject({ unit: 'money', capability: 'manage_business_rules', namespace: 'pos', label: 'Unsent offline sales that warn the manager' });
    expect([Number(e!.default), Number(e!.min), Number(e!.max)]).toEqual([50000, 1000, 1000000]);
    expect(e!.help).toMatch(/Selling continues; it only warns\./);
  });

  it('pos.offline_xslip_hours: whole hours, default 4, 1 to 24, admin-only, POS [kills: a changed default or bound]', () => {
    const e = reg['pos.offline_xslip_hours'];
    expect(e).toBeDefined();
    expect(e).toMatchObject({ unit: 'hours', capability: 'manage_business_rules', namespace: 'pos', label: 'Hours offline between automatic X-slips' });
    expect([Number(e!.default), Number(e!.min), Number(e!.max)]).toEqual([4, 1, 24]);
  });

  it('the book reads them exactly: default 50000 pesos -> 5,000,000 centavos; default 4 hours; a stored 6.000000 -> 6 [kills: hours read through another unit]', () => {
    const book = buildRuleBook([]);
    expect(book.valueOn('pos.offline_unsent_warn_amount', '2026-12-07').centavos()).toBe(5_000_000n);
    expect(book.valueOn('pos.offline_xslip_hours', '2026-12-07').hours()).toBe(4);
    const stored = buildRuleBook([{ id: '00000000-0000-0000-0000-000000000001', key: 'pos.offline_xslip_hours', value: '6.000000', effectiveFrom: '2026-01-01', createdAt: new Date(0) }]);
    expect(stored.valueOn('pos.offline_xslip_hours', '2026-12-07').hours()).toBe(6);
  });

  it('hours() refuses another unit and a part hour; another reader refuses an hours rule', () => {
    const book = buildRuleBook([{ id: '00000000-0000-0000-0000-000000000002', key: 'pos.offline_xslip_hours', value: '1.500000', effectiveFrom: '2026-01-01', createdAt: new Date(0) }]);
    expect(() => book.valueOn('pos.offline_xslip_hours', '2026-12-07').hours()).toThrow();
    expect(() => buildRuleBook([]).valueOn('pos.offline_xslip_hours', '2026-12-07').hour()).toThrow();
    expect(() => buildRuleBook([]).valueOn('pos.table_warn_minutes', '2026-12-07').hours()).toThrow();
  });
});
