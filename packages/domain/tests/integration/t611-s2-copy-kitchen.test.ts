/**
 * T-611 S2 - "Copy from another store": kitchen stations and routes. docs/tasks/611-copy-settings-between-stores.md.
 * Against real PostgreSQL. Each tick has a cross that fires (the mutants are listed in the hand-back, run by hand).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { copySettingsToStore, createKitchenStation, previewCopyToStore, setKitchenRoute } from '@shareat/domain';

import { asOrg, attempt, cast, expectSentence, rawItem, sql, uid, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

interface World extends Cast {
  storeC: string;
}
async function world(hint: string): Promise<World> {
  const c = await cast(hint);
  const [r] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${c.orgId}, ${uid('ST')}, 'Malvar') returning id`;
  for (const p of [c.admin, c.superAdmin, c.manager]) await sql`insert into person_store_scope (person_id, store_id) values (${p.personId}, ${r!.id})`;
  return { ...c, storeC: r!.id };
}
const station = (c: Cast, storeId: string, name: string, extra: { slaMinutes?: number; printOnOutage?: boolean; sortOrder?: number } = {}) =>
  asOrg(c.orgId, (tx) => createKitchenStation(tx, c.admin, { storeId, name, ...extra })).then((r) => r.stationId);
const route = (c: Cast, storeId: string, menuItemId: string, stationId: string) => asOrg(c.orgId, (tx) => setKitchenRoute(tx, c.admin, { storeId, menuItemId, stationId }));
const item = async (c: Cast, name: string) => (await rawItem(c, 'a_la_carte', name)).itemId;
const copy = (c: Cast, who: Cast['admin'], source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => copySettingsToStore(who, { kind: 'kitchen', sourceStoreId: source, targetStoreId: target, replace, approverPersonId: c.admin.personId }, tx));
const preview = (c: Cast, who: Cast['admin'], source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => previewCopyToStore(who, { kind: 'kitchen', sourceStoreId: source, targetStoreId: target, replace }, tx));
const said = (r: { error?: unknown }) => (r.error as { userMessage: string }).userMessage;

const stationsOf = (storeId: string) =>
  sql<{ id: string; name: string; sla: number; outage: boolean; ord: number; status: string }[]>`
    select id, name, sla_minutes as sla, print_on_outage as outage, sort_order as ord, status from kitchen_stations where store_id = ${storeId} order by lower(name)`;
/** item name -> station name at a store, so the answer does not depend on which store's station id the route points at. */
const routesOf = async (storeId: string) =>
  Object.fromEntries(
    (
      await sql<{ item: string; station: string }[]>`
        select i.name as item, s.name as station from kitchen_routes r join menu_items i on i.id = r.menu_item_id join kitchen_stations s on s.id = r.station_id
        where r.store_id = ${storeId} order by i.name`
    ).map((r) => [r.item, r.station]),
  );

describe('T-611 S2: copy kitchen stations and routes', () => {
  it('1: the preview counts match the apply; a missing station is created with the source settings; matching is by name, ignoring capitals; routes follow the target station BY NAME', async () => {
    const c = await world('t611-k1');
    const grillA = await station(c, c.storeA, 'Grill', { slaMinutes: 20, printOnOutage: true, sortOrder: 3 });
    const drinksA = await station(c, c.storeA, 'Drinks');
    await station(c, c.storeB, 'DRINKS'); // exists at the target under another capitalisation, with its own id
    const burger = await item(c, 'Burger');
    const cola = await item(c, 'Cola');
    await route(c, c.storeA, burger, grillA);
    await route(c, c.storeA, cola, drinksA);

    const p = await preview(c, c.admin, c.storeA, c.storeB);
    expect(p.counts).toEqual({ added: 3, replaced: 0, skipped: 1, same: 1, kept: 0 }); // Grill + 2 routes added; Drinks same
    const r = await copy(c, c.admin, c.storeA, c.storeB);
    expect(r.counts).toEqual(p.counts);

    const stations = await stationsOf(c.storeB);
    expect(stations.map((s) => s.name)).toEqual(['DRINKS', 'Grill']);
    expect(stations.find((s) => s.name === 'Grill')).toMatchObject({ sla: 20, outage: true, ord: 3, status: 'active' });
    expect(await routesOf(c.storeB)).toEqual({ Burger: 'Grill', Cola: 'DRINKS' }); // the TARGET's own stations, found by name
    expect(await routesOf(c.storeA)).toEqual({ Burger: 'Grill', Cola: 'Drinks' }); // the source is untouched
  });

  it('2: a different route is KEPT by default; with Replace it moves to the same-named station; the counts match the preview', async () => {
    const c = await world('t611-k2');
    const grillA = await station(c, c.storeA, 'Grill');
    await station(c, c.storeA, 'Fryer');
    const grillB = await station(c, c.storeB, 'Grill');
    const fryerB = await station(c, c.storeB, 'Fryer');
    const wings = await item(c, 'Wings');
    const fries = await item(c, 'Fries');
    await route(c, c.storeA, wings, grillA);
    await route(c, c.storeA, fries, grillA);
    await route(c, c.storeB, wings, fryerB); // differs
    await route(c, c.storeB, fries, grillB); // same

    const kept = await preview(c, c.admin, c.storeA, c.storeB);
    expect(kept.counts).toEqual({ added: 0, replaced: 0, skipped: 4, same: 3, kept: 1 }); // two stations and fries are the same; wings differs and is kept
    expect(kept.lines.find((l) => l.status === 'different')!.note).toBe('The store has it at Fryer.');
    await copy(c, c.admin, c.storeA, c.storeB);
    expect((await routesOf(c.storeB)).Wings).toBe('Fryer');

    const p = await preview(c, c.admin, c.storeA, c.storeB, true);
    const done = await copy(c, c.admin, c.storeA, c.storeB, true);
    expect(done.counts).toEqual(p.counts);
    expect(done.counts).toEqual({ added: 0, replaced: 1, skipped: 3, same: 3, kept: 0 });
    expect((await routesOf(c.storeB)).Wings).toBe('Grill');
  });

  it('3: copying removes nothing: a target-only station and a target-only route stay as they were', async () => {
    const c = await world('t611-k3');
    const grillA = await station(c, c.storeA, 'Grill');
    const bar = await station(c, c.storeB, 'Bar');
    const tea = await item(c, 'Tea');
    const ribs = await item(c, 'Ribs');
    await route(c, c.storeA, ribs, grillA);
    await route(c, c.storeB, tea, bar);
    await copy(c, c.admin, c.storeA, c.storeB, true);
    expect(await routesOf(c.storeB)).toEqual({ Ribs: 'Grill', Tea: 'Bar' });
    expect((await stationsOf(c.storeB)).map((s) => s.name)).toEqual(['Bar', 'Grill']);
  });

  it('4: a retired source station and a retired item are not copied, and not listed', async () => {
    const c = await world('t611-k4');
    const oldS = await station(c, c.storeA, 'Old oven');
    await station(c, c.storeA, 'Grill');
    await sql`update kitchen_stations set status = 'retired' where id = ${oldS}`;
    const gone = await item(c, 'Gone');
    const grillA = (await stationsOf(c.storeA)).find((s) => s.name === 'Grill')!.id;
    await route(c, c.storeA, gone, grillA);
    await sql`update menu_items set status = 'retired' where id = ${gone}`;
    const p = await preview(c, c.admin, c.storeA, c.storeB);
    expect(p.lines.map((l) => l.what)).toEqual(['Station Grill']);
    await copy(c, c.admin, c.storeA, c.storeB);
    expect(await routesOf(c.storeB)).toEqual({});
  });
});

describe('T-611 S2: who may copy, and where', () => {
  it('5: a store of another organisation is refused as "does not exist", before anything is read or written', async () => {
    const c = await world('t611-k5');
    const other = await cast('t611-k5-other');
    await station(c, c.storeA, 'Grill');
    const r = await attempt(() => copy(c, c.admin, c.storeA, other.storeA));
    expectSentence(r, 'foreign target');
    expect(said(r)).toMatch(/could not be found/);
    expect(await stationsOf(other.storeA)).toHaveLength(0);
    const s = await attempt(() => copy(c, c.admin, other.storeA, c.storeB));
    expectSentence(s, 'foreign source');
    expect(said(s)).toMatch(/could not be found/);
  });

  it('6: only an administrator copies; a manager is refused in a sentence and nothing is written', async () => {
    const c = await world('t611-k6');
    await station(c, c.storeA, 'Grill');
    const r = await attempt(() => preview(c, c.manager, c.storeA, c.storeB));
    expectSentence(r, 'manager preview');
    expect(said(r)).toBe('Only an administrator can copy settings from one store to another.');
    expectSentence(await attempt(() => copy(c, c.manager, c.storeA, c.storeB)), 'manager copy');
    expect(await stationsOf(c.storeB)).toHaveLength(0);
  });

  it('7: an administrator without the edit right at a target store is refused, and a closed target is refused; the other target still gets its copy', async () => {
    const c = await world('t611-k7');
    await station(c, c.storeA, 'Grill');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${c.orgId}, 'Admin of Lipa only') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${c.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${c.storeA})`;
    const narrow = { ...c.admin, personId: p!.id };
    expectSentence(await attempt(() => copy(c, narrow, c.storeA, c.storeB)), 'no right at the target');
    expect(await stationsOf(c.storeB)).toHaveLength(0);

    await sql`update stores set is_active = false where id = ${c.storeC}`;
    const closed = await attempt(() => copy(c, c.admin, c.storeA, c.storeC));
    expectSentence(closed, 'closed target');
    expect(said(closed)).toContain('closed');
    await copy(c, c.admin, c.storeA, c.storeB);
    expect((await stationsOf(c.storeB)).map((s) => s.name)).toEqual(['Grill']);
    expect(await stationsOf(c.storeC)).toHaveLength(0);
  });

  it('8: the copy is one unit in the caller transaction: if the caller fails after it, no station and no route stay at the target', async () => {
    const c = await world('t611-k8');
    const grillA = await station(c, c.storeA, 'Grill');
    const wok = await item(c, 'Wok dish');
    await route(c, c.storeA, wok, grillA);
    // The copy runs in the caller's transaction (one per target in the action): a failure after it, with Grill and its route written, leaves nothing.
    const bad = await attempt(() =>
      asOrg(c.orgId, async (tx) => {
        const r = await copySettingsToStore(c.admin, { kind: 'kitchen', sourceStoreId: c.storeA, targetStoreId: c.storeB, replace: false, approverPersonId: c.admin.personId }, tx);
        throw new Error(`forced failure after ${r.counts.added} added`);
      }),
    );
    expect(bad.failed).toBe(true);
    expect(await stationsOf(c.storeB)).toHaveLength(0);
    expect(await routesOf(c.storeB)).toEqual({});
  });
});

describe('T-611 S2: the audit trail', () => {
  it('9: one settings.copied row per target with the kind, the source and the counts; the writers leave their own rows; the preview writes nothing', async () => {
    const c = await world('t611-k9');
    const grillA = await station(c, c.storeA, 'Grill');
    const pie = await item(c, 'Pie');
    await route(c, c.storeA, pie, grillA);
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${c.orgId}`)[0]!.n;
    const n0 = await count();
    await preview(c, c.admin, c.storeA, c.storeB);
    expect(await count()).toBe(n0);
    await copy(c, c.admin, c.storeA, c.storeB);
    await copy(c, c.admin, c.storeA, c.storeC);
    const rows = await sql<{ store_id: string; after: Record<string, unknown> }[]>`
      select store_id, "after" from audit_log where org_id = ${c.orgId} and action = 'settings.copied' order by store_id`;
    expect(rows.map((r) => r.store_id).sort()).toEqual([c.storeB, c.storeC].sort());
    expect(rows[0]!.after).toMatchObject({ kind: 'kitchen', sourceStoreId: c.storeA, added: 2, replaced: 0, skipped: 0, replace: false, approverPersonId: c.admin.personId });
    const [w] = await sql<{ created: number; routed: number }[]>`
      select count(*) filter (where action = 'kitchen_station.created')::int as created, count(*) filter (where action = 'kitchen_route.set')::int as routed
      from audit_log where store_id = ${c.storeB}`;
    expect(w).toEqual({ created: 1, routed: 1 });
  });
});
