/**
 * T-527b - the table's list keeps the cashier's order through the server. Lines of one event share one addedAtDevice, so the device's monotonic ids
 * (ids.ts) carry the cart order; the tablet sorts by (addedAtDevice, id) and the database by (addedAtDevice, addedAt, id), which agree. A 3-line event comes back in cart order from getSessionBill,
 * and a heads change (the per-head package line is re-made) leaves the order alone. Real Postgres on a scratch "_test" database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { getSessionBill, openStand, setHeadsCashier } from '../../../../packages/domain/src/pos';
import { asOrg, closeAll, fixture, newStand, nowIso } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { makeIdGenerator } from '../../src/app/pos/_orders/ids';

afterAll(closeAll);

describe('T-527b - line order round trip', () => {
  it('3 lines of one event come back in cart order, and a heads change keeps that order', async () => {
    const f = await fixture();
    const st = await newStand(f);
    const next = makeIdGenerator(() => Date.now());
    const base = { storeId: f.storeId, pairingId: f.pairingId };
    const sessionId = next();
    const at = nowIso(); // one time for every line of the event
    // The cart order is cola, package, pork: not the order the uuids of a v4 would give, and not alphabetical.
    const lines = [
      { lineId: next(), menuItemId: f.menu.cola.itemId, variantId: f.menu.cola.variantId, qty: 1, addedAtDevice: at },
      { lineId: next(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 3, addedAtDevice: at },
      { lineId: next(), menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 2, addedAtDevice: at },
    ];
    await asOrg(f.orgId, (tx) => openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 3, openedAtDevice: at, lines } as never));
    const billed = async () => (await asOrg(f.orgId, (tx) => getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId }))).lines.map((l) => l.menuItemId);
    const cart = [f.menu.cola.itemId, f.menu.unli.itemId, f.menu.pork.itemId];
    expect(await billed()).toEqual(cart);

    await asOrg(f.orgId, (tx) => setHeadsCashier(tx, f.counter, { ...base, sessionId, headsCashier: 5 }));
    const after = await asOrg(f.orgId, (tx) => getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId }));
    expect(after.lines.find((l) => l.menuItemId === f.menu.unli.itemId)?.qty).toBe(5); // the package line was re-made
    expect(after.lines.map((l) => l.menuItemId)).toEqual(cart); // and it is still in the same place
  });
});
