/**
 * T-533 S3 (TESTER, written FIRST) - the pre-flight's decision, with no database: facts in, items out. docs/tasks/533-pos-lipa-switch.md R3.
 * Each blocking and each warning item fires ON ITS OWN from a fully set-up store; the set-up store has none. The database side
 * (the facts being read right) is `tests/integration/t533-s3-preflight.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { evaluatePreflight, hasSeparateApprover, type PreflightFacts } from './preflight';

const STORE = '00000000-0000-4000-8000-000000000001';
const GREEN: PreflightFacts = {
  storeId: STORE,
  hasPosStoreRow: true,
  activeStands: 12,
  hasCashTender: true,
  tendersWithoutAlias: 0,
  v1Linked: true,
  bridgeDateAllowed: true,
  tillsWithLivePairing: 1,
  rulesNotSeeded: [],
  recordSalePeople: 3,
  terminalLinked: true,
  separateApprover: true,
  keyFileConfigured: true,
  itemsWithoutStation: [],
  packagesWithoutRefills: [],
  staffWithoutPin: 0,
  activePresets: 2,
};

const run = (patch: Partial<PreflightFacts>) => evaluatePreflight({ ...GREEN, ...patch });
const codes = (r: ReturnType<typeof evaluatePreflight>) => ({ blocking: r.blocking.map((i) => i.code), warnings: r.warnings.map((i) => i.code) });

describe('evaluatePreflight', () => {
  it('a fully set-up store has no blocking item and no warning', () => {
    expect(run({})).toEqual({ blocking: [], warnings: [] });
  });

  const blocking: [string, Partial<PreflightFacts>][] = [
    ['no_pos_store_row', { hasPosStoreRow: false }],
    ['no_stands', { activeStands: 0 }],
    ['no_cash_tender', { hasCashTender: false }],
    ['tender_without_alias', { tendersWithoutAlias: 2 }],
    ['no_linked_till', { tillsWithLivePairing: 0 }],
    ['rules_not_seeded', { rulesNotSeeded: ['VAT included in prices (%)'] }],
    ['no_record_sale_person', { recordSalePeople: 0 }],
    ['no_terminal_link', { terminalLinked: false }],
    ['no_approver', { separateApprover: false }],
    ['no_bridge_key_file', { keyFileConfigured: false }],
  ];
  it.each(blocking)('blocking: %s fires on its own, with a plain sentence', (code, patch) => {
    const r = run(patch);
    expect(codes(r)).toEqual({ blocking: [code], warnings: [] });
    expect(r.blocking[0]!.sentence.length).toBeGreaterThan(10);
    expect(r.blocking[0]!.sentence).not.toMatch(/pos_|_id\b|null|undefined/);
  });

  const warnings: [string, Partial<PreflightFacts>][] = [
    ['items_without_station', { itemsWithoutStation: ['Pork belly', 'Cola'] }],
    ['packages_without_refills', { packagesWithoutRefills: ['Unli Grill'] }],
    ['staff_without_pin', { staffWithoutPin: 2 }],
    ['no_discount_presets', { activePresets: 0 }],
  ];
  it.each(warnings)('warning: %s fires on its own and does not block', (code, patch) => {
    expect(codes(run(patch))).toEqual({ blocking: [], warnings: [code] });
  });

  it('the alias and key-file items apply only while the store is v1-linked and the date is on or before 2026-12-31', () => {
    expect(run({ tendersWithoutAlias: 2, keyFileConfigured: false, v1Linked: false })).toEqual({ blocking: [], warnings: [] });
    expect(run({ tendersWithoutAlias: 2, keyFileConfigured: false, bridgeDateAllowed: false })).toEqual({ blocking: [], warnings: [] });
    expect(codes(run({ tendersWithoutAlias: 2, keyFileConfigured: false }))).toEqual({ blocking: ['tender_without_alias', 'no_bridge_key_file'], warnings: [] });
  });

  it('several gaps at once are all listed, blocking and warning kept apart', () => {
    const r = run({ activeStands: 0, hasCashTender: false, activePresets: 0, staffWithoutPin: 1 });
    expect(codes(r)).toEqual({ blocking: ['no_stands', 'no_cash_tender'], warnings: ['staff_without_pin', 'no_discount_presets'] });
  });

  it('every item names a screen that fixes it, or null where none does; the names a warning lists are shown, at most five', () => {
    const r = run({ hasPosStoreRow: false, itemsWithoutStation: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] });
    expect(r.blocking[0]!.href).toBe(`/admin/stores/${STORE}`);
    expect(r.warnings[0]!.href).toBe(`/kitchen?store=${STORE}`);
    expect(r.warnings[0]!.sentence).toContain('7 menu items');
    expect(r.warnings[0]!.sentence).toContain('A, B, C, D, E');
    expect(r.warnings[0]!.sentence).not.toContain('F,');
  });

  it('the key-file item never carries a value, only the name of the setting', () => {
    const r = run({ keyFileConfigured: false });
    expect(JSON.stringify(r)).toContain('POS_FIREBASE_SA_KEY_FILE');
    expect(JSON.stringify(r)).not.toMatch(/\.json|\\\\|C:|\/srv/);
  });
});

describe('hasSeparateApprover', () => {
  const set = (...ids: string[]) => new Set(ids);
  it('nobody approves: no', () => expect(hasSeparateApprover(set(), ['a', 'b'])).toBe(false));
  it('the only approver is the only seller: no', () => expect(hasSeparateApprover(set('a'), ['a'])).toBe(false));
  it('one approver and another seller: yes', () => expect(hasSeparateApprover(set('a'), ['a', 'b'])).toBe(true));
  it('two approvers, nobody else sells: yes', () => expect(hasSeparateApprover(set('a', 'b'), ['a'])).toBe(true));
});
