import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFakeFirestore, setActiveFake, type FakeFirestore } from '@/test-helpers/fakeFirestore';
vi.mock('firebase/firestore', async () => (await import('@/test-helpers/fakeFirestore')).firebaseFirestoreModule());
import { stageOfflineAddonLine } from './addon-line';
let fs: FakeFirestore;
const base = 'stores/test/sessions/session/sessionBillLines';
const payload = { id: 'addon_dish_100', itemId: 'dish', unitPrice: 100, qtyOrdered: 2, freeQty: 0,
  modifiers: [{ valueId: 'spicy', priceDelta: 10 }], modifiersText: 'Spicy', note: 'No onion' };
beforeEach(() => { fs = createFakeFirestore(); setActiveFake(fs); });
describe('DEF-741 fresh offline add intent', () => {
  it('does not read an uncached document before staging the line', async () => {
    vi.spyOn(fs, 'getDoc').mockRejectedValue(Object.assign(new Error('client is offline'), { code: 'unavailable' }));
    const staged = await stageOfflineAddonLine(fs.db as never, 'test', 'session', payload);
    await staged.batch.commit();
    expect(fs.getDoc).not.toHaveBeenCalled();
    expect(fs.get(`${base}/${staged.lineId}`)).toMatchObject({ ...payload, id: staged.lineId });
  });
  it('preserves an unseen grouped line, including its discount and quantity', async () => {
    const old = { ...payload, qtyOrdered: 7, freeQty: 1, discountQty: 2, discountValue: 20 };
    fs.seed(`${base}/${payload.id}`, old);
    const staged = await stageOfflineAddonLine(fs.db as never, 'test', 'session', payload);
    await staged.batch.commit();
    expect(staged.lineId).not.toBe(payload.id);
    expect(fs.get(`${base}/${payload.id}`)).toEqual(old);
  });
  it('gives separate intents separate ids and retains their own modifiers and notes', async () => {
    const a = await stageOfflineAddonLine(fs.db as never, 'test', 'session', payload);
    const b = await stageOfflineAddonLine(fs.db as never, 'test', 'session', { ...payload, qtyOrdered: 1, note: 'Extra hot' });
    await a.batch.commit(); await b.batch.commit();
    expect(a.lineId).not.toBe(b.lineId);
    expect(fs.get(`${base}/${a.lineId}`)).toMatchObject({ qtyOrdered: 2, note: 'No onion', modifiers: payload.modifiers });
    expect(fs.get(`${base}/${b.lineId}`)).toMatchObject({ qtyOrdered: 1, note: 'Extra hot' });
  });
  it('wires the returned fresh id through the modal before its ticket and optimistic writes', () => {
    const src = readFileSync(new URL('../../components/shared/AddonsPOSModal.tsx', import.meta.url), 'utf8');
    expect(src).toContain('stageOfflineAddonLine(');
    expect(src).toContain('lineId = staged.lineId');
    expect(src).not.toContain('await getDoc(lineRef)');
    expect(src).toContain('billLineId: lineId');
  });
});
