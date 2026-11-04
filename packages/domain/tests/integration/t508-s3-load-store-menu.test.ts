/**
 * T-508 S3 - the live loader against a real PostgreSQL: station rows and routes read for the store, the projection built from them.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { kitchenRepo, withOrgPrincipal } from '@shareat/db';
import { loadStoreMenu } from '@shareat/domain';
import { insOffer, insRule, menuFixture, newItem, sql } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('loadStoreMenu', () => {
  it('routed item has its station; unrouted is listed; a rename flows into name and hash; another store sees none of it', async () => {
    const f = await menuFixture('t508s3');
    const unrouted = await newItem(f, 'a_la_carte', 'Unrouted dish');
    for (const v of [f.variantId, unrouted.variantId]) {
      await insRule(f, v);
      await insOffer(f, v, '100.00');
    }
    const st = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Grill', createdBy: f.personId }));
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.storeId, menuItemId: f.itemId, stationId: st.id, createdBy: f.personId }));

    const load = (storeId: string) => withOrgPrincipal(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, storeId, new Date(Date.now() + 1000)));
    const a = await load(f.storeId);
    expect(a.menu.schemaVersion).toBe(2);
    expect(a.menu.stations.map((s) => s.name)).toEqual(['Grill']);
    expect(a.menu.items.map((i) => [i.id, i.stationId])).toEqual([[f.itemId, st.id]]);
    expect(a.menu.notOnPos.map((n) => n.itemId)).toEqual([unrouted.itemId]);

    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.renameStation(tx, f.orgId, f.storeId, st.id, 'Hot Line'));
    const b = await load(f.storeId);
    expect(b.menu.stations.map((s) => s.name)).toEqual(['Hot Line']);
    expect(b.contentHash).not.toBe(a.contentHash);

    const other = await load(f.store2Id);
    expect(other.menu.stations).toEqual([]);
    expect(other.menu.items).toEqual([]);
  });

  it('two stores with their own stations and routes: each menu holds only its own', async () => {
    const f = await menuFixture('t508s3-two');
    const f2 = { ...f, storeId: f.store2Id };
    const itemB = await newItem(f, 'a_la_carte', 'Store B dish');
    for (const v of [f.variantId, itemB.variantId]) await insRule(f, v);
    await insOffer(f, f.variantId, '100.00');
    await insOffer(f2, itemB.variantId, '120.00');

    const stA = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Grill', createdBy: f.personId }));
    const stB = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.store2Id, name: 'Fryer', createdBy: f.personId }));
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.storeId, menuItemId: f.itemId, stationId: stA.id, createdBy: f.personId }));
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.store2Id, menuItemId: itemB.itemId, stationId: stB.id, createdBy: f.personId }));

    const load = (storeId: string) => withOrgPrincipal(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, storeId, new Date(Date.now() + 1000)));
    const a = await load(f.storeId);
    expect(a.menu.stations.map((s) => s.id)).toEqual([stA.id]);
    expect(a.menu.items.map((i) => [i.id, i.stationId])).toEqual([[f.itemId, stA.id]]);
    expect(a.menu.notOnPos).toEqual([]);

    const b = await load(f.store2Id);
    expect(b.menu.stations.map((s) => s.id)).toEqual([stB.id]);
    expect(b.menu.items.map((i) => [i.id, i.stationId])).toEqual([[itemB.itemId, stB.id]]);
    expect(b.menu.notOnPos).toEqual([]);
  });
});
