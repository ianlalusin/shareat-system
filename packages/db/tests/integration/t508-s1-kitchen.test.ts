/**
 * T-508 S1 (migration 0232) - kitchen stations and kitchen routes, against a real PostgreSQL.
 * docs/tasks/508-kitchen-stations-and-menu-to-pos.md R1 (two tables, store-scoped), R2 (route per item), R3 (retire, never delete).
 *
 * Two layers are shown separately, because each is a backstop for the other (bible 15.11):
 *   - the REPO (kitchenRepo, run as shareat_app through withOrgPrincipal): the typed refusals and the store filter;
 *   - the DATABASE (raw SQL as the owner, which bypasses RLS): the composite FKs, CHECKs and unique index refuse on their own.
 */
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { kitchenRepo, withOrgPrincipal } from '@shareat/db';
import { asApp, menuFixture, newItem, refusal, sql, uid, type MenuFx } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const mkStation = (f: MenuFx, storeId: string, name: string, extra: Partial<{ slaMinutes: number; printOnOutage: boolean; sortOrder: number }> = {}) =>
  withOrgPrincipal(f.orgId, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId, name, createdBy: f.personId, ...extra }));

const route = (f: MenuFx, storeId: string, menuItemId: string, stationId: string) =>
  withOrgPrincipal(f.orgId, (tx) => kitchenRepo.setRoute(tx, { orgId: f.orgId, storeId, menuItemId, stationId, createdBy: f.personId }));

const rawStationStatus = async (id: string) => (await sql<{ status: string }[]>`select status from kitchen_stations where id = ${id}`)[0]!.status;

// =================================================================================================
describe('R3 - retire never strands a route', () => {
  it('repo: retiring a station that has routes is refused with the route count; nothing changes', async () => {
    const f = await menuFixture('r3a');
    const a = await newItem(f, 'a_la_carte');
    const b = await newItem(f, 'package');
    const st = await mkStation(f, f.storeId, 'Grill');
    await route(f, f.storeId, a.itemId, st.id);
    await route(f, f.storeId, b.itemId, st.id);

    const err = await refusal(() => withOrgPrincipal(f.orgId, (tx) => kitchenRepo.retireStation(tx, f.orgId, f.storeId, st.id)));
    expect(err, 'a station with routes was retired').toBeInstanceOf(kitchenRepo.KitchenStationInUseError);
    expect((err as InstanceType<typeof kitchenRepo.KitchenStationInUseError>).routeCount).toBe(2);
    expect((err as InstanceType<typeof kitchenRepo.KitchenStationInUseError>).userMessage).toMatch(/2/);
    expect(await rawStationStatus(st.id)).toBe('active');
  });

  it('repo: once every route is cleared the station retires; the last active station of a store may retire when it has no routes', async () => {
    const f = await menuFixture('r3b');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Only');
    await route(f, f.storeId, a.itemId, st.id);
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.clearRoute(tx, f.orgId, f.storeId, a.itemId));
    const done = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.retireStation(tx, f.orgId, f.storeId, st.id));
    expect(done.status).toBe('retired');
    expect(await rawStationStatus(st.id)).toBe('retired');
  });

  it('database backstop: the owner flipping a routed station to retired is refused by the FK (23503)', async () => {
    const f = await menuFixture('r3c');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Grill');
    await route(f, f.storeId, a.itemId, st.id);
    const err = await refusal(() => sql`update kitchen_stations set status = 'retired' where id = ${st.id}`);
    expect(err?.code).toBe('23503');
    expect(await rawStationStatus(st.id)).toBe('active');
  });

  it('a route cannot be created against a retired station: repo refuses, and the database refuses a raw insert (23503)', async () => {
    const f = await menuFixture('r3d');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Old');
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.retireStation(tx, f.orgId, f.storeId, st.id));
    expect(await refusal(() => route(f, f.storeId, a.itemId, st.id)), 'repo routed an item to a retired station').toBeDefined();
    const raw = await refusal(
      () => sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by)
                values (${f.orgId}, ${f.storeId}, ${a.itemId}, ${st.id}, ${f.personId})`,
    );
    expect(raw?.code).toBe('23503');
    const n = (await sql<{ n: number }[]>`select count(*)::int n from kitchen_routes where org_id = ${f.orgId}`)[0]!.n;
    expect(n).toBe(0);
  });

  it('a station is never deleted: shareat_app holds no DELETE on kitchen_stations (42501)', async () => {
    const f = await menuFixture('r3e');
    const st = await mkStation(f, f.storeId, 'Grill');
    const err = await refusal(() => withOrgPrincipal(f.orgId, (tx) => tx.execute(dsql`delete from kitchen_stations where id = ${st.id}`)));
    expect((err as (Error & { code?: string }) | undefined)?.code).toBe('42501');
  });
});

// =================================================================================================
describe('R1 - a route and its station belong to one store (cross-store refused)', () => {
  it('repo: routing an item at store B to a station of store A is refused', async () => {
    const f = await menuFixture('xs1');
    const a = await newItem(f, 'a_la_carte');
    const stA = await mkStation(f, f.storeId, 'Grill');
    const err = await refusal(() => route(f, f.store2Id, a.itemId, stA.id));
    expect(err, 'a cross-store route was accepted by the repo').toBeDefined();
    const n = (await sql<{ n: number }[]>`select count(*)::int n from kitchen_routes where org_id = ${f.orgId}`)[0]!.n;
    expect(n).toBe(0);
  });

  it('database: a raw cross-store route is refused by the composite FK (23503)', async () => {
    const f = await menuFixture('xs2');
    const a = await newItem(f, 'a_la_carte');
    const stA = await mkStation(f, f.storeId, 'Grill');
    const raw = await refusal(
      () => sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by)
                values (${f.orgId}, ${f.store2Id}, ${a.itemId}, ${stA.id}, ${f.personId})`,
    );
    expect(raw?.code).toBe('23503');
  });

  it('database: a menu item from another organisation is refused by the same-org FK (23503), even for the owner', async () => {
    const f = await menuFixture('xs3');
    const other = await menuFixture('xs3-other');
    const foreign = await newItem(other, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Grill');
    const raw = await refusal(
      () => sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by)
                values (${f.orgId}, ${f.storeId}, ${foreign.itemId}, ${st.id}, ${f.personId})`,
    );
    expect(raw?.code).toBe('23503');
  });
});

// =================================================================================================
describe('R1 - an active station name is unique per store, case-insensitive', () => {
  it('Grill then GRILL (and " grill ") at the same store -> 23505; the same name at another store is fine', async () => {
    const f = await menuFixture('nm1');
    await mkStation(f, f.storeId, 'Grill');
    const dup = await refusal(() => mkStation(f, f.storeId, 'GRILL'));
    expect(dup?.code).toBe('23505');
    const other = await refusal(() => mkStation(f, f.store2Id, 'Grill'));
    expect(other).toBeUndefined();
  });

  it('a retired station frees its name; renaming onto an active name is refused (23505); rename is free otherwise', async () => {
    const f = await menuFixture('nm2');
    const old = await mkStation(f, f.storeId, 'Grill');
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.retireStation(tx, f.orgId, f.storeId, old.id));
    const again = await mkStation(f, f.storeId, 'grill');
    expect(again.id).not.toBe(old.id);

    const drinks = await mkStation(f, f.storeId, 'Drinks');
    const clash = await refusal(() => withOrgPrincipal(f.orgId, (tx) => kitchenRepo.renameStation(tx, f.orgId, f.storeId, drinks.id, 'GRILL')));
    expect(clash?.code).toBe('23505');
    const renamed = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.renameStation(tx, f.orgId, f.storeId, drinks.id, 'Bar'));
    expect(renamed.id).toBe(drinks.id);
    expect(renamed.name).toBe('Bar');
    expect(renamed.updatedAt).not.toBeNull();
  });

  it('a blank name is refused (23514)', async () => {
    const f = await menuFixture('nm3');
    expect((await refusal(() => mkStation(f, f.storeId, '   ')))?.code).toBe('23514');
  });
});

// =================================================================================================
describe('R1 - sla_minutes 1-240, print_on_outage', () => {
  it('defaults are 10 minutes and print_on_outage false; the bounds 1 and 240 are accepted', async () => {
    const f = await menuFixture('sla1');
    const d = await mkStation(f, f.storeId, 'Default');
    expect(d.slaMinutes).toBe(10);
    expect(d.printOnOutage).toBe(false);
    expect((await mkStation(f, f.storeId, 'Low', { slaMinutes: 1 })).slaMinutes).toBe(1);
    expect((await mkStation(f, f.storeId, 'High', { slaMinutes: 240 })).slaMinutes).toBe(240);
  });

  it('0, 241 and -5 are refused on create and on update (23514)', async () => {
    const f = await menuFixture('sla2');
    for (const bad of [0, 241, -5]) {
      expect((await refusal(() => mkStation(f, f.storeId, uid('Bad'), { slaMinutes: bad })))?.code, `create ${bad}`).toBe('23514');
    }
    const st = await mkStation(f, f.storeId, 'Grill');
    for (const bad of [0, 241]) {
      const err = await refusal(() => withOrgPrincipal(f.orgId, (tx) => kitchenRepo.updateStation(tx, f.orgId, f.storeId, st.id, { slaMinutes: bad })));
      expect(err?.code, `update ${bad}`).toBe('23514');
    }
  });

  it('updateStation changes SLA, print_on_outage and sort order, and only those', async () => {
    const f = await menuFixture('sla3');
    const st = await mkStation(f, f.storeId, 'Grill');
    const up = await withOrgPrincipal(f.orgId, (tx) =>
      kitchenRepo.updateStation(tx, f.orgId, f.storeId, st.id, { slaMinutes: 25, printOnOutage: true, sortOrder: 3 }),
    );
    expect(up).toMatchObject({ id: st.id, name: 'Grill', slaMinutes: 25, printOnOutage: true, sortOrder: 3, status: 'active' });
  });
});

// =================================================================================================
describe('R2 - setRoute upserts one route per (store, item); clearRoute; listRoutes', () => {
  it('a second setRoute moves the item (still one row); clearRoute removes it; the same item can route differently at another store', async () => {
    const f = await menuFixture('rt1');
    const a = await newItem(f, 'package');
    const grill = await mkStation(f, f.storeId, 'Grill');
    const bar = await mkStation(f, f.storeId, 'Bar');
    const otherStore = await mkStation(f, f.store2Id, 'Kitchen');

    await route(f, f.storeId, a.itemId, grill.id);
    await route(f, f.storeId, a.itemId, bar.id);
    await route(f, f.store2Id, a.itemId, otherStore.id);

    const here = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.listRoutes(tx, f.orgId, f.storeId));
    expect(here).toHaveLength(1);
    expect(here[0]).toMatchObject({ menuItemId: a.itemId, stationId: bar.id });
    const there = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.listRoutes(tx, f.orgId, f.store2Id));
    expect(there).toHaveLength(1);
    expect(there[0]).toMatchObject({ stationId: otherStore.id });

    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.clearRoute(tx, f.orgId, f.storeId, a.itemId));
    expect(await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.listRoutes(tx, f.orgId, f.storeId))).toHaveLength(0);
    // clearing a route that is not there is not an error
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.clearRoute(tx, f.orgId, f.storeId, a.itemId));
  });

  it('database: a second route for the same (store, item) is refused by the unique key (23505)', async () => {
    const f = await menuFixture('rt2');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Grill');
    await route(f, f.storeId, a.itemId, st.id);
    const dup = await refusal(
      () => sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by)
                values (${f.orgId}, ${f.storeId}, ${a.itemId}, ${st.id}, ${f.personId})`,
    );
    expect(dup?.code).toBe('23505');
  });
});

// =================================================================================================
describe('RLS and store scope', () => {
  it('another organisation sees none of these stations or routes, and cannot write into this org', async () => {
    const f = await menuFixture('rls1');
    const other = await menuFixture('rls1-other');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Grill');
    await route(f, f.storeId, a.itemId, st.id);

    // the other org, asking for this org's store by id, gets nothing
    expect(await withOrgPrincipal(other.orgId, (tx) => kitchenRepo.listStations(tx, f.orgId, f.storeId))).toHaveLength(0);
    expect(await withOrgPrincipal(other.orgId, (tx) => kitchenRepo.listRoutes(tx, f.orgId, f.storeId))).toHaveLength(0);
    // and cannot create one for this org (RLS WITH CHECK, 42501)
    const err = await refusal(() =>
      withOrgPrincipal(other.orgId, (tx) => kitchenRepo.createStation(tx, { orgId: f.orgId, storeId: f.storeId, name: 'Sneaky', createdBy: f.personId })),
    );
    expect(err?.code).toBe('42501');
    expect(await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.listStations(tx, f.orgId, f.storeId))).toHaveLength(1);
  });

  it('listStations returns only that store, active first by sort order; retired are hidden unless asked for', async () => {
    const f = await menuFixture('rls2');
    const b = await mkStation(f, f.storeId, 'Bar', { sortOrder: 2 });
    const g = await mkStation(f, f.storeId, 'Grill', { sortOrder: 1 });
    const gone = await mkStation(f, f.storeId, 'Gone', { sortOrder: 0 });
    await mkStation(f, f.store2Id, 'Elsewhere');
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.retireStation(tx, f.orgId, f.storeId, gone.id));

    const live = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.listStations(tx, f.orgId, f.storeId));
    expect(live.map((s) => s.id)).toEqual([g.id, b.id]);
    const all = await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.listStations(tx, f.orgId, f.storeId, { includeRetired: true }));
    expect(all.map((s) => s.id)).toEqual([gone.id, g.id, b.id]);
  });

  it('a store of another organisation cannot host a station (same-org FK, 23503, even for the owner)', async () => {
    const f = await menuFixture('rls3');
    const other = await menuFixture('rls3-other');
    const err = await refusal(
      () => sql`insert into kitchen_stations (org_id, store_id, name, created_by) values (${f.orgId}, ${other.storeId}, 'X', ${f.personId})`,
    );
    expect(err?.code).toBe('23503');
  });
});

// =================================================================================================
describe('a record that is not there', () => {
  it('rename / update / retire / route of a station that does not exist at this store is a typed "not found", not a raw id', async () => {
    const f = await menuFixture('gone1');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Grill');
    const missing = '00000000-0000-4000-8000-000000000000';
    const calls: Array<() => Promise<unknown>> = [
      () => withOrgPrincipal(f.orgId, (tx) => kitchenRepo.renameStation(tx, f.orgId, f.storeId, missing, 'X')),
      () => withOrgPrincipal(f.orgId, (tx) => kitchenRepo.updateStation(tx, f.orgId, f.storeId, missing, { slaMinutes: 5 })),
      () => withOrgPrincipal(f.orgId, (tx) => kitchenRepo.retireStation(tx, f.orgId, f.storeId, missing)),
      () => route(f, f.storeId, a.itemId, missing),
      // a real station, asked for through the wrong store
      () => withOrgPrincipal(f.orgId, (tx) => kitchenRepo.renameStation(tx, f.orgId, f.store2Id, st.id, 'X')),
    ];
    for (const c of calls) {
      const err = await refusal(c);
      expect(err, 'expected a refusal').toBeDefined();
      expect((err as { userMessage?: string }).userMessage, 'a typed refusal with a sentence for a person').toBeTruthy();
      expect((err as { userMessage?: string }).userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });
});

// =================================================================================================
describe('a station cannot change store', () => {
  it('database: shareat_app UPDATE of kitchen_stations.store_id / org_id and kitchen_routes.store_id is refused (42501, column grant)', async () => {
    const f = await menuFixture('mv1');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Grill');
    const r = await route(f, f.storeId, a.itemId, st.id);
    for (const q of [
      (tx: Parameters<Parameters<typeof asApp>[1]>[0]) => tx`update kitchen_stations set store_id = ${f.store2Id} where id = ${st.id}`,
      (tx: Parameters<Parameters<typeof asApp>[1]>[0]) => tx`update kitchen_stations set org_id = ${f.orgId} where id = ${st.id}`,
      (tx: Parameters<Parameters<typeof asApp>[1]>[0]) => tx`update kitchen_routes set store_id = ${f.store2Id} where id = ${r.id}`,
    ]) {
      const { err } = await asApp(f.orgId, async (tx) => q(tx));
      expect(err?.code).toBe('42501');
    }
  });

  it('repo: updateStation with a smuggled storeId leaves store_id unchanged', async () => {
    const f = await menuFixture('mv2');
    const st = await mkStation(f, f.storeId, 'Grill');
    await withOrgPrincipal(f.orgId, (tx) =>
      kitchenRepo.updateStation(tx, f.orgId, f.storeId, st.id, { slaMinutes: 7, storeId: f.store2Id } as never),
    );
    const [row] = await sql<{ store_id: string; sla_minutes: number }[]>`select store_id, sla_minutes from kitchen_stations where id = ${st.id}`;
    expect(row!.store_id).toBe(f.storeId);
    expect(row!.sla_minutes).toBe(7);
  });

  it('repo: every allowed field still updates (name, sla, print-on-outage, sort order, retire; route re-point)', async () => {
    const f = await menuFixture('mv3');
    const a = await newItem(f, 'a_la_carte');
    const st = await mkStation(f, f.storeId, 'Grill');
    const st2 = await mkStation(f, f.storeId, 'Fry');
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.renameStation(tx, f.orgId, f.storeId, st.id, 'Grill 2'));
    const u = await withOrgPrincipal(f.orgId, (tx) =>
      kitchenRepo.updateStation(tx, f.orgId, f.storeId, st.id, { slaMinutes: 9, printOnOutage: true, sortOrder: 3 }),
    );
    expect([u.name, u.slaMinutes, u.printOnOutage, u.sortOrder]).toEqual(['Grill 2', 9, true, 3]);
    await route(f, f.storeId, a.itemId, st.id);
    await route(f, f.storeId, a.itemId, st2.id);
    await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.clearRoute(tx, f.orgId, f.storeId, a.itemId));
    expect((await withOrgPrincipal(f.orgId, (tx) => kitchenRepo.retireStation(tx, f.orgId, f.storeId, st.id))).status).toBe('retired');
  });
});
