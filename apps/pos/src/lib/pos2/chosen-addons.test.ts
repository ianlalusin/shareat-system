/**
 * T-518 tester: the New Session form's chosen à-la-carte list (collect mode). Pure helpers, no DOM.
 *
 * CONTRACT (module @/lib/pos2/chosen-addons; BuiltAddonLine from @/lib/pos2/addon-line-builder):
 *   addChosen(list, line): BuiltAddonLine[]            merge by lineId, summing qty (same as mergeAddonLine)
 *   changeChosenQty(list, lineId, delta): BuiltAddonLine[]   qty + delta; result qty <= 0 removes the line; unknown id = unchanged
 *   removeChosen(list, lineId): BuiltAddonLine[]
 * All pure (never mutate the input).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('firebase/firestore', async () => (await import('@/test-helpers/fakeFirestore')).firebaseFirestoreModule());
import { buildAddonLine } from './addon-line-builder';
import { addChosen, changeChosenQty, removeChosen } from './chosen-addons';

const actor = { uid: 'u1', username: 'c' };
const mk = (id: string, qty: number) => buildAddonLine({ addon: { id, displayName: id, sellingPrice: 100, kitchenLocationId: 'k' }, qty, modifiers: [], modifiersText: '', modifiersTotal: 0 }, actor);
const qtys = (l: ReturnType<typeof mk>[]) => l.map((x) => [x.lineId, x.payload.qtyOrdered]);

describe('chosen list helpers', () => {
  it('add merges the same line and appends a new one', () => {
    let l = addChosen([], mk('a', 1));
    l = addChosen(l, mk('a', 2));
    l = addChosen(l, mk('b', 1));
    expect(qtys(l)).toEqual([['addon_a_100', 3], ['addon_b_100', 1]]);
  });
  it('qty +/- adjusts; reaching 0 removes; unknown id changes nothing', () => {
    const l = [mk('a', 2), mk('b', 1)];
    expect(qtys(changeChosenQty(l, 'addon_a_100', 1))).toEqual([['addon_a_100', 3], ['addon_b_100', 1]]);
    expect(qtys(changeChosenQty(l, 'addon_a_100', -1))).toEqual([['addon_a_100', 1], ['addon_b_100', 1]]);
    expect(qtys(changeChosenQty(l, 'addon_b_100', -1))).toEqual([['addon_a_100', 2]]);
    expect(qtys(changeChosenQty(l, 'nope', 5))).toEqual(qtys(l));
    expect(l[0].payload.qtyOrdered).toBe(2);
  });
  it('remove drops the line', () => {
    expect(qtys(removeChosen([mk('a', 1), mk('b', 1)], 'addon_a_100'))).toEqual([['addon_b_100', 1]]);
  });
});

describe('form wiring (source guards; POS tests have no DOM)', () => {
  const form = readFileSync(new URL('../../components/cashier/start-session-form.tsx', import.meta.url), 'utf8');
  const unlimited = form.slice(form.indexOf('const onSubmitUnlimited'), form.indexOf('const onSubmitAlaCarte'));
  const alacarte = form.slice(form.indexOf('const onSubmitAlaCarte'), form.indexOf('return (', form.indexOf('const onSubmitAlaCarte')));
  it('package submit passes the chosen lines to startSession as initialAddons', () => {
    expect(form).toContain('AddonsPOSModal');
    expect(form).toContain('onCollect');
    expect(form).toContain('addChosen(');
    expect(form).toContain('changeChosenQty(');
    expect(form).toContain('removeChosen(');
    expect(unlimited).toMatch(/initialAddons/);
  });
  it('the Ala Carte tab submit is untouched: no initialAddons', () => {
    expect(alacarte).toContain('startSession(');
    expect(alacarte).not.toMatch(/initialAddons/);
  });
});

describe('modal wiring (source guards)', () => {
  const src = readFileSync(new URL('../../components/shared/AddonsPOSModal.tsx', import.meta.url), 'utf8');
  const performAdd = src.slice(src.indexOf('const performAdd'), src.indexOf('const handlePickerConfirm'));
  it('builds lines with the shared builder and has a collect prop', () => {
    expect(src).toContain('@/lib/pos2/addon-line-builder');
    expect(performAdd).toContain('buildAddonLine(');
    expect(src).toContain('onCollect');
  });
  it('collect mode hands the line back BEFORE any Firestore write', () => {
    const c = performAdd.indexOf('onCollect');
    expect(c).toBeGreaterThan(-1);
    for (const w of ['runTransaction(', 'stageOfflineAddonLine(', 'createKitchenTickets(', 'commitLocalFirst(']) {
      expect(performAdd.indexOf(w)).toBeGreaterThan(c);
    }
  });
  it('normal path unchanged: still transaction online, staged batch offline, billingRevision +1', () => {
    expect(performAdd).toContain('runTransaction(db');
    expect(performAdd).toContain('stageOfflineAddonLine(');
    expect(performAdd).toContain('billingRevision: increment(1)');
    expect(performAdd).toContain('"addon"');
  });
});
