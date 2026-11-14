/**
 * T-527b P0 (row 307) - a sold-out dish (its store offer withdrawn) reaches the POS tablet in the snapshot, greyed, and nothing else moves:
 * the default `loadStoreMenu` (server pricing, terminal feed) still leaves it out, and the server still refuses to sell it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loadStoreMenu } from '@shareat/domain';
import { addLines, openStand } from '../../src/pos';
import { buildPosSnapshot } from '../../src/pos/snapshot';
import { asOrg, closeAll, fixture, nowIso, RATES, sql, uuid } from './_fixtures/t525-pos';
import { insWithdrawn } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(closeAll);

type Menu = { menu: { items: { id: string; name: string; variants: { channels: { store: Record<string, unknown> } }[] }[] } };

describe('T-527b - the snapshot keeps a sold-out dish', () => {
  it('Cola withdrawn: the snapshot lists it as store = withdrawn; the plain menu leaves it out; the server still refuses to sell it', async () => {
    const f = await fixture();
    await insWithdrawn(f, f.menu.cola.variantId);
    // the offer is stored at now() (microseconds) and the menu is read at now() cut to the millisecond: wait (at most ~2 ms, on the database clock) until the offer is past (t565, 411d50e)
    await sql`select pg_sleep(greatest(0, extract(epoch from (select max(effective_from) from menu_offers where store_id = ${f.storeId}) + interval '2 milliseconds' - clock_timestamp())))`;
    const snap = await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES));
    const cola = (snap.body.menu as Menu).menu.items.find((i) => i.id === f.menu.cola.itemId);
    expect(cola?.variants[0]?.channels.store).toEqual({ orderable: false, notOffered: 'withdrawn' });
    expect((snap.body.menu as Menu).menu.items.map((i) => i.id)).toContain(f.menu.pork.itemId); // the rest of the menu is still there

    const plain = await asOrg(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, new Date()));
    expect(plain.menu.items.map((i) => i.id)).not.toContain(f.menu.cola.itemId);

    const sessionId = uuid();
    await asOrg(f.orgId, (tx) => openStand(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: f.stand7, headsCashier: 2, openedAtDevice: nowIso() }));
    await expect(
      asOrg(f.orgId, (tx) =>
        addLines(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.cola.itemId, variantId: f.menu.cola.variantId, qty: 1, addedAtDevice: nowIso() }] }),
      ),
    ).rejects.toThrow(/item not on the store menu/);
  });
});
