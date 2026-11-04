/**
 * T-518 tester: the pure add-on line builder extracted from AddonsPOSModal.performAdd.
 * docs/tasks/518-pos-alacarte-at-table-start.md ruling 3.
 *
 * CONTRACT for the builder (module @/lib/pos2/addon-line-builder):
 *   export type AddonLineInput = { addon: { id: string; displayName: string; subCategory?: string | null; barcode?: string | null;
 *       sellingPrice: number | string; kitchenLocationId?: string | null; kitchenLocationName?: string | null };
 *     qty: number; modifiers: SelectedModifier[]; modifiersText: string; modifiersTotal: number; note?: string };
 *   export type BuiltAddonLine = { lineId: string; payload: Record<string, unknown> };
 *   export function buildAddonLine(input: AddonLineInput, actor: { uid: string; username: string }): BuiltAddonLine
 *     payload = exactly the object performAdd passes to stripUndefined(...) today (createdAt/updatedAt = serverTimestamp()).
 *   export function mergeAddonLine(lines: BuiltAddonLine[], next: BuiltAddonLine): BuiltAddonLine[]
 *     pure; same lineId => ONE entry with payload.qtyOrdered summed (position kept); else appended.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('firebase/firestore', async () => (await import('@/test-helpers/fakeFirestore')).firebaseFirestoreModule());
import { buildAddonLine, mergeAddonLine } from './addon-line-builder';

const actor = { uid: 'u1', username: 'cashier1' };
const TS = { __s: 'serverTimestamp' };
const wings = { id: 'it1', displayName: 'Wings', subCategory: 'Chicken', barcode: 'B1', sellingPrice: 150, kitchenLocationId: 'kl-fry', kitchenLocationName: 'Fry' };

describe('buildAddonLine golden cases (copied from performAdd today)', () => {
  it('plain item: key addon_{id}_{price}, every field as performAdd builds it', () => {
    const { lineId, payload } = buildAddonLine({ addon: wings, qty: 2, modifiers: [], modifiersText: '', modifiersTotal: 0 }, actor);
    expect(lineId).toBe('addon_it1_150');
    expect(payload).toEqual({
      id: 'addon_it1_150', type: 'addon', itemId: 'it1', itemName: 'Wings', category: 'Chicken', barcode: 'B1',
      unitPrice: 150, qtyOrdered: 2, discountType: null, discountValue: 0, discountQty: 0, freeQty: 0, voidedQty: 0,
      createdAt: TS, updatedAt: TS, updatedByUid: 'u1', updatedByName: 'cashier1',
      kitchenLocationId: 'kl-fry', kitchenLocationName: 'Fry', modifiers: null, modifiersText: null, modifiersTotal: null, note: null,
    });
  });
  it('modifiers: key gets sorted valueIds joined by "-"; unitPrice stays the base price; totals/text stored', () => {
    const modifiers = [
      { groupId: 'g1', valueId: 'v-b', name: 'Hot', priceDelta: 10 },
      { groupId: 'g1', valueId: 'v-a', name: 'Cheese', priceDelta: 5 },
    ] as any[];
    const { lineId, payload } = buildAddonLine({ addon: wings, qty: 1, modifiers, modifiersText: 'Hot, Cheese', modifiersTotal: 15, note: '  no onion  ' }, actor);
    expect(lineId).toBe('addon_it1_150_v-a-v-b');
    expect(payload).toMatchObject({ id: lineId, unitPrice: 150, modifiers, modifiersText: 'Hot, Cheese', modifiersTotal: 15, note: 'no onion' });
  });
  it('missing station and non-numeric price: billed with null station, price 0 (as performAdd)', () => {
    const { lineId, payload } = buildAddonLine({ addon: { id: 'it2', displayName: 'Rice', sellingPrice: 'x' as any }, qty: 3, modifiers: [], modifiersText: '', modifiersTotal: 0 }, actor);
    expect(lineId).toBe('addon_it2_0');
    expect(payload).toMatchObject({ kitchenLocationId: null, kitchenLocationName: null, category: null, barcode: null, unitPrice: 0, qtyOrdered: 3 });
  });
  it('same item, different modifier picks, different keys', () => {
    const a = buildAddonLine({ addon: wings, qty: 1, modifiers: [{ valueId: 'v1' }] as any[], modifiersText: 'a', modifiersTotal: 0 }, actor);
    const b = buildAddonLine({ addon: wings, qty: 1, modifiers: [{ valueId: 'v2' }] as any[], modifiersText: 'b', modifiersTotal: 0 }, actor);
    expect(a.lineId).not.toBe(b.lineId);
  });
});

describe('mergeAddonLine', () => {
  const mk = (qty: number, id = 'it1') => buildAddonLine({ addon: { ...wings, id }, qty, modifiers: [], modifiersText: '', modifiersTotal: 0 }, actor);
  it('same item+price+modifiers twice = ONE line, qty summed (kills two lines for one item)', () => {
    const out = mergeAddonLine([mk(2)], mk(3));
    expect(out).toHaveLength(1);
    expect(out[0].payload.qtyOrdered).toBe(5);
  });
  it('different item appends; input array is not mutated', () => {
    const first = [mk(2)];
    const out = mergeAddonLine(first, mk(1, 'it9'));
    expect(out.map((l) => l.lineId)).toEqual(['addon_it1_150', 'addon_it9_150']);
    expect(first[0].payload.qtyOrdered).toBe(2);
  });
});

describe('keyByNote (start-form collect mode: notes must not be lost)', () => {
  const mk = (note: string, keyByNote = true) => buildAddonLine({ addon: wings, qty: 1, modifiers: [], modifiersText: '', modifiersTotal: 0, note, keyByNote }, actor);
  it('different notes = different keys, each keeps its note; same note = one line, qty 2', () => {
    const a = mk('no onion'); const b = mk('extra spicy'); const c = mk(' no onion ');
    expect(a.lineId).not.toBe(b.lineId);
    expect(a.payload.note).toBe('no onion'); expect(b.payload.note).toBe('extra spicy');
    const merged = mergeAddonLine(mergeAddonLine([a], b), c);
    expect(merged).toHaveLength(2);
    expect(merged[0].payload.qtyOrdered).toBe(2);
  });
  it('no note, or flag off (the modal): key unchanged', () => {
    expect(mk('').lineId).toBe('addon_it1_150');
    expect(mk('no onion', false).lineId).toBe('addon_it1_150');
  });
});
