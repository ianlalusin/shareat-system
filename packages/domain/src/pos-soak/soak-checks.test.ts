/**
 * T-601 S1 - the soak checklist's decision, with no database: facts in, 15 pass/fail rows out. Each check flipped ALONE fails
 * exactly that code. The database side (the facts read right) is `tests/integration/t601-soak-checks.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { PreflightItem, PreflightResult } from '../pos/preflight';
import { evaluateSoakChecks, type SoakExtra, type SoakMenu } from './soak-checks';

const STORE = '00000000-0000-4000-8000-000000000001';
const priced = { orderable: true, amount: '250.00' } as const;
const GREEN_MENU: SoakMenu = {
  stations: [{}],
  hours: {},
  items: [
    { itemType: 'a_la_carte', variants: [{ channels: { store: priced }, optionGroups: [] }] },
    { itemType: 'package', variants: [{ channels: { store: priced }, optionGroups: [{}] }] },
    { itemType: 'refill', variants: [{ channels: { store: { orderable: true, amount: null } }, optionGroups: [] }] },
  ],
};
const GREEN: SoakExtra = {
  storeId: STORE,
  menu: GREEN_MENU,
  mode: 'test',
  terminalLinked: true,
  approvers: new Set(['manager']),
  sellers: ['cashier', 'manager'],
  pinRuleOn: true,
  tenders: [{ kind: 'cash' }, { kind: 'wallet' }],
  identity: { businessName: 'Shareat Inc', tin: '123-456-789-001', addressLines: ['Lipa City'] },
};
const NONE: PreflightResult = { blocking: [], warnings: [] };
const item = (code: string): PreflightItem => ({ code, sentence: 'x', href: null });

const run = (patch: Partial<SoakExtra> = {}, pre: PreflightResult = NONE) => evaluateSoakChecks(pre, { ...GREEN, ...patch });
const failed = (checks: ReturnType<typeof evaluateSoakChecks>) => checks.filter((c) => !c.ok).map((c) => c.code);
const without = (type: string): SoakMenu => ({ ...GREEN_MENU, items: GREEN_MENU.items.filter((i) => i.itemType !== type) });

describe('evaluateSoakChecks', () => {
  it('a fully set-up store passes all 15, in order', () => {
    const checks = run();
    expect(checks).toHaveLength(15);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.code)).toEqual([
      'menu_items', 'menu_packages', 'menu_refills', 'menu_flavours', 'kitchen_stations', 'menu_dayparts', 'stands_presets',
      'tablet_till', 'terminal_link', 'approver', 'rules', 'test_mode', 'tenders', 'receipt_issuer', 'people',
    ]);
  });

  const alone: [string, Partial<SoakExtra>, PreflightResult?][] = [
    ['menu_items', { menu: without('a_la_carte') }],
    ['menu_packages', { menu: { ...GREEN_MENU, items: GREEN_MENU.items.map((i) => (i.itemType === 'package' ? { ...i, variants: [{ channels: { store: { orderable: true, amount: null } }, optionGroups: [{}] }] } : i)) } }],
    ['menu_refills', { menu: without('refill') }],
    ['menu_refills', {}, { blocking: [], warnings: [item('packages_without_refills')] }],
    ['menu_flavours', { menu: { ...GREEN_MENU, items: GREEN_MENU.items.map((i) => (i.itemType === 'package' ? { ...i, variants: [{ channels: { store: priced }, optionGroups: [] }] } : i)) } }],
    ['kitchen_stations', { menu: { ...GREEN_MENU, stations: [] } }],
    ['kitchen_stations', {}, { blocking: [], warnings: [item('items_without_station')] }],
    ['menu_dayparts', { menu: { ...GREEN_MENU, hours: undefined } }],
    ['stands_presets', {}, { blocking: [item('no_stands')], warnings: [] }],
    ['stands_presets', {}, { blocking: [], warnings: [item('no_discount_presets')] }],
    ['tablet_till', {}, { blocking: [item('no_linked_till')], warnings: [] }],
    ['terminal_link', { terminalLinked: false }],
    ['approver', { approvers: new Set<string>() }],
    ['rules', { pinRuleOn: false }],
    ['rules', {}, { blocking: [item('rules_not_seeded')], warnings: [] }],
    ['test_mode', { mode: 'off' }],
    ['test_mode', { mode: 'live' }],
    ['tenders', { tenders: [{ kind: 'cash' }] }],
    ['tenders', { tenders: [{ kind: 'wallet' }] }],
    ['receipt_issuer', { identity: { businessName: 'Shareat Inc', tin: null, addressLines: ['Lipa City'] } }],
    ['receipt_issuer', { identity: { businessName: 'Shareat Inc', tin: '123', addressLines: [] } }],
    ['receipt_issuer', { identity: { businessName: '', tin: '123', addressLines: ['Lipa City'] } }],
    ['people', {}, { blocking: [item('no_record_sale_person')], warnings: [] }],
    ['people', {}, { blocking: [], warnings: [item('staff_without_pin')] }],
  ];
  it.each(alone)('%s fails on its own (%#)', (code, patch, pre) => {
    const checks = run(patch, pre);
    expect(failed(checks)).toEqual([code]);
    const row = checks.find((c) => c.code === code)!;
    expect(row.sentence.length).toBeGreaterThan(10);
    expect(row.label.length).toBeGreaterThan(3);
  });

  it('a dish that has a price in the store channel but is not orderable now does not count as on sale', () => {
    const closed = { orderable: false } as const;
    const menu: SoakMenu = { ...GREEN_MENU, items: GREEN_MENU.items.map((i) => (i.itemType === 'a_la_carte' ? { ...i, variants: [{ channels: { store: closed }, optionGroups: [] }] } : i)) };
    expect(failed(run({ menu }))).toEqual(['menu_items']);
  });

  describe('approver: someone besides the cashier must be able to approve the close', () => {
    it('one approver who is also the only seller fails', () => {
      expect(failed(run({ approvers: new Set(['manager']), sellers: ['manager'] }))).toEqual(['approver']);
    });
    it('that approver plus another seller passes', () => {
      expect(failed(run({ approvers: new Set(['manager']), sellers: ['manager', 'cashier'] }))).toEqual([]);
    });
    it('two approvers pass even when both also sell', () => {
      expect(failed(run({ approvers: new Set(['a', 'b']), sellers: ['a', 'b'] }))).toEqual([]);
    });
  });

  it('the failed rows carry the screen that fixes them, where one exists', () => {
    const rows = run({ terminalLinked: false, mode: 'off' });
    expect(rows.find((c) => c.code === 'terminal_link')!.href).toBe('/admin/pos-tablets');
    expect(rows.find((c) => c.code === 'test_mode')!.href).toBe(`/admin/stores/${STORE}`);
  });
});
