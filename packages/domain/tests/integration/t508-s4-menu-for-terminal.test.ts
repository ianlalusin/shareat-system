/**
 * T-508 S4 - what GET /api/pos2/menu serves: the store comes ONLY from the device's active terminal link.
 * Real PostgreSQL. Unlinked / unknown / non-uuid device -> AuthenticationError; the menu holds the linked store's items and stations only.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { kitchenRepo, withOrgPrincipal } from '@shareat/db';
import { AuthenticationError } from '@shareat/auth';
import { loadMenuForTerminal } from '@shareat/domain';
import { insOffer, insRule, menuFixture, newItem, sql, uid } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function linkedDevice(f: Awaited<ReturnType<typeof menuFixture>>, storeId: string) {
  const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${f.orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const posStoreId = uid('pos');
  const [link] = await sql<{ id: string }[]>`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${f.orgId}, ${storeId}, ${posStoreId}, 'POS', ${ch!.id}, 'vat_inclusive', ${f.personId}) returning id`;
  const [t] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${f.orgId}, 'Terminal', 'terminal') returning id`;
  const deviceId = crypto.randomUUID();
  await sql`insert into pos_terminal_links (org_id, store_id, pos_v1_store_link_id, terminal_no, device_id, terminal_person_id, created_by)
    values (${f.orgId}, ${storeId}, ${link!.id}, 1, ${deviceId}, ${t!.id}, ${f.personId})`;
  return { posStoreId, deviceId };
}

describe('loadMenuForTerminal', () => {
  it('serves the linked store only; unlinked, unknown and bad devices are refused', async () => {
    const f = await menuFixture('t508s4');
    const itemB = await newItem(f, 'a_la_carte', 'Store B dish');
    for (const v of [f.variantId, itemB.variantId]) await insRule(f, v);
    await insOffer(f, f.variantId, '100.00');
    await insOffer({ ...f, storeId: f.store2Id }, itemB.variantId, '120.00');
    const stA = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Grill', createdBy: f.personId }));
    const stB = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.store2Id, name: 'Fryer', createdBy: f.personId }));
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.storeId, menuItemId: f.itemId, stationId: stA.id, createdBy: f.personId }));
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId: f.store2Id, menuItemId: itemB.itemId, stationId: stB.id, createdBy: f.personId }));

    const dev = await linkedDevice(f, f.storeId);
    const load = (i: { posStoreId: string; deviceId: string }) => withOrgPrincipal(f.orgId, (tx) => loadMenuForTerminal(tx, f.orgId, i));

    const a = await load(dev);
    expect(a.menu.stations.map((s) => s.id)).toEqual([stA.id]);
    expect(a.menu.items.map((i) => i.id)).toEqual([f.itemId]);

    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.renameStation(tx, f.orgId, f.storeId, stA.id, 'Hot Line'));
    const b = await load(dev);
    expect(b.menu.stations.map((s) => s.name)).toEqual(['Hot Line']);
    expect(b.contentHash).not.toBe(a.contentHash);

    await expect(load({ ...dev, deviceId: crypto.randomUUID() })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(load({ ...dev, deviceId: 'not-a-uuid' })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(load({ posStoreId: uid('nope'), deviceId: dev.deviceId })).rejects.toBeInstanceOf(AuthenticationError);
    await sql`update pos_terminal_links set revoked_at = now(), revoked_by = ${f.personId} where org_id = ${f.orgId}`;
    await expect(load(dev)).rejects.toBeInstanceOf(AuthenticationError);
  });
});
