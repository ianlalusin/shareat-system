import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-508 S2a - the kitchen domain: stations and routes. docs/tasks/508-kitchen-stations-and-menu-to-pos.md R1-R5, R10.
 * Real Postgres on a scratch database whose name contains "_test". Never truncates.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, RefusalError, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  clearKitchenRoute,
  createKitchenStation,
  listKitchenSetup,
  renameKitchenStation,
  retireKitchenStation,
  setKitchenRoute,
  setKitchenRoutesForCategory,
  updateKitchenStation,
} from '@shareat/domain';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function person(orgId: string, role: string, name: string, stores: string[]) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}

/** Two orgs; org 1 has stores A and B. Grill category: Pork (offered at A), Beef (no offer), Squid (offered at A). Drinks: Cola (offered at A). */
async function fixture(hint: string) {
  const code = uid(`t508s2-${hint}`);
  const mkOrg = async (suffix: string) => {
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}${suffix}`}, ${code + suffix}) returning id`;
    return org!.id;
  };
  const orgId = await mkOrg('');
  const otherOrgId = await mkOrg('-x');
  const mkStore = async (org: string, name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore(orgId, 'Store A');
  const storeB = await mkStore(orgId, 'Store B');
  const adminId = await person(orgId, 'admin', 'Admin', [storeA, storeB]);
  const managerAId = await person(orgId, 'manager', 'Manager A', [storeA]);
  const managerBId = await person(orgId, 'manager', 'Manager B', [storeB]);
  const staffId = await person(orgId, 'staff', 'Staff', [storeA, storeB]);
  const otherAdminId = await person(otherOrgId, 'admin', 'Other admin', []);

  const mkCategory = async (name: string) => {
    const [c] = await sql<{ id: string }[]>`insert into menu_categories (org_id, name, created_by) values (${orgId}, ${name}, ${adminId}) returning id`;
    return c!.id;
  };
  const grillCat = await mkCategory('Grill');
  const drinksCat = await mkCategory('Drinks');
  const mkItem = async (categoryId: string, name: string, offeredAt: string | null) => {
    const [i] = await sql<{ id: string }[]>`
      insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, created_by)
      values (${orgId}, ${categoryId}, ${name}, 'a_la_carte', true, ${adminId}) returning id`;
    const [v] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, is_default, created_by) values (${orgId}, ${i!.id}, true, ${adminId}) returning id`;
    if (offeredAt) {
      await sql`insert into menu_depletion_rules (org_id, variant_id, mode, created_by) values (${orgId}, ${v!.id}, 'no_stock', ${adminId})`;
      await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, created_by)
                values (${orgId}, ${offeredAt}, ${v!.id}, 'store', 100, ${adminId})`;
    }
    return i!.id;
  };
  const pork = await mkItem(grillCat, 'Pork belly', storeA);
  const beef = await mkItem(grillCat, 'Beef slice', null);
  const squid = await mkItem(grillCat, 'Squid', storeA);
  const cola = await mkItem(drinksCat, 'Cola', storeA);
  return {
    orgId, otherOrgId, storeA, storeB, grillCat, drinksCat, pork, beef, squid, cola,
    admin: actorOf(orgId, adminId),
    managerA: actorOf(orgId, managerAId),
    managerB: actorOf(orgId, managerBId),
    staff: actorOf(orgId, staffId),
    otherAdmin: actorOf(otherOrgId, otherAdminId),
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

interface AuditRow { action: string; store_id: string | null; entity_id: string; source: string; actor_person_id: string | null; before: unknown; after: unknown }
async function audits(f: Fx, prefix: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, store_id, entity_id, source, actor_person_id, before, after from audit_log
    where org_id = ${f.orgId} and action like ${prefix + '.%'} order by recorded_at`;
}
const stationRow = async (id: string) =>
  (await sql<{ name: string; status: string; sla_minutes: number; print_on_outage: boolean; sort_order: number }[]>`
    select name, status, sla_minutes, print_on_outage, sort_order from kitchen_stations where id = ${id}`)[0]!;
const routesOf = async (storeId: string) =>
  sql<{ menu_item_id: string; station_id: string }[]>`select menu_item_id, station_id from kitchen_routes where store_id = ${storeId}`;

async function expectRefusal(p: Promise<unknown>, sentence?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  const msg = (err as RefusalError).userMessage;
  expect(msg.length).toBeGreaterThan(10);
  expect(msg, 'no UUID in a sentence').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  if (sentence) expect(msg).toMatch(sentence);
  return msg;
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

const create = (who: Actor, storeId: string, name: string, extra: Record<string, unknown> = {}) =>
  asOrg(who.orgId, (tx) => createKitchenStation(tx, who, { storeId, name, ...extra }));

describe('T-508 S2a - every writer: admin and manager of the store succeed, one audit row each', () => {
  it.each([['admin'], ['managerA']] as const)('%s runs the whole lifecycle', async (who) => {
    const f = await fixture(`life-${who}`);
    const a = f[who];
    const { stationId } = await create(a, f.storeA, '  Grill  ', { slaMinutes: 12 });
    expect(await stationRow(stationId)).toMatchObject({ name: 'Grill', sla_minutes: 12, status: 'active' });
    const { stationId: drinks } = await create(a, f.storeA, 'Drinks');

    expect(await asOrg(f.orgId, (tx) => renameKitchenStation(tx, a, { stationId, name: 'Main grill' }))).toEqual({ wrote: true });
    expect(await asOrg(f.orgId, (tx) => updateKitchenStation(tx, a, { stationId, slaMinutes: 15, printOnOutage: true, sortOrder: 3 }))).toEqual({ wrote: true });
    expect(await stationRow(stationId)).toMatchObject({ name: 'Main grill', sla_minutes: 15, print_on_outage: true, sort_order: 3 });

    expect(await asOrg(f.orgId, (tx) => setKitchenRoute(tx, a, { storeId: f.storeA, menuItemId: f.pork, stationId }))).toEqual({ wrote: true });
    expect(await asOrg(f.orgId, (tx) => setKitchenRoute(tx, a, { storeId: f.storeA, menuItemId: f.pork, stationId: drinks }))).toEqual({ wrote: true });
    expect((await routesOf(f.storeA)).map((r) => r.station_id)).toEqual([drinks]);
    expect(await asOrg(f.orgId, (tx) => clearKitchenRoute(tx, a, { storeId: f.storeA, menuItemId: f.pork }))).toEqual({ wrote: true });
    expect(await routesOf(f.storeA)).toEqual([]);
    expect((await asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, a, { storeId: f.storeA, categoryId: f.grillCat, stationId }))).changed).toBe(3);
    // retire is refused while routes point at it, allowed on the empty one
    await expectRefusal(asOrg(f.orgId, (tx) => retireKitchenStation(tx, a, { stationId })), /3 items/);
    expect(await asOrg(f.orgId, (tx) => retireKitchenStation(tx, a, { stationId: drinks }))).toEqual({ wrote: true });
    expect((await stationRow(drinks)).status).toBe('retired');

    for (const [prefix, n] of [['kitchen_station', 5], ['kitchen_route', 4]] as const) {
      const rows = await audits(f, prefix);
      expect(rows, prefix).toHaveLength(n);
      for (const r of rows) {
        expect(r.store_id).toBe(f.storeA);
        expect(r.source).toBe('web');
        expect(r.actor_person_id).toBe(a.personId);
      }
    }
    // before / after on a real change
    const stationAudits = await audits(f, 'kitchen_station');
    const updated = stationAudits.find((r) => r.action === 'kitchen_station.updated')!;
    expect(updated.before).toMatchObject({ slaMinutes: 12, printOnOutage: false, sortOrder: 0 });
    expect(updated.after).toMatchObject({ slaMinutes: 15, printOnOutage: true, sortOrder: 3 });
    const renamed = stationAudits.find((r) => r.action === 'kitchen_station.renamed')!;
    expect([renamed.before, renamed.after]).toEqual([{ name: 'Grill' }, { name: 'Main grill' }]);
    const cat = (await audits(f, 'kitchen_route')).find((r) => r.action === 'kitchen_route.category_set')!;
    expect(cat.after).toEqual({ stationId, itemCount: 3 });
    expect(cat.entity_id).toBe(f.grillCat);
  });

  it('each writer leaves exactly ONE audit row', async () => {
    const f = await fixture('onerow');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    expect(await audits(f, 'kitchen_station')).toHaveLength(1);
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.cola, stationId }));
    expect(await audits(f, 'kitchen_route')).toHaveLength(1);
    await asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, f.admin, { storeId: f.storeA, categoryId: f.drinksCat, stationId }));
    expect(await audits(f, 'kitchen_route'), 'cola already there: category set is a no-op').toHaveLength(1);
  });
});

describe('T-508 S2a - who is refused', () => {
  it('staff is refused on every writer; nothing is written', async () => {
    const f = await fixture('staff');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    const s = f.staff;
    await expectAuthRefusal(create(s, f.storeA, 'X'));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, s, { stationId, name: 'Y' })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => updateKitchenStation(tx, s, { stationId, slaMinutes: 20 })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => retireKitchenStation(tx, s, { stationId })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => setKitchenRoute(tx, s, { storeId: f.storeA, menuItemId: f.pork, stationId })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => clearKitchenRoute(tx, s, { storeId: f.storeA, menuItemId: f.pork })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, s, { storeId: f.storeA, categoryId: f.grillCat, stationId })));
    expect((await stationRow(stationId)).name).toBe('Grill');
    expect(await routesOf(f.storeA)).toEqual([]);
    expect(await audits(f, 'kitchen_station')).toHaveLength(1); // the admin's create only
  });

  it('a manager of ANOTHER store is refused on every writer (station row and store id both)', async () => {
    const f = await fixture('othermgr');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    const m = f.managerB;
    await expectAuthRefusal(create(m, f.storeA, 'X'));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, m, { stationId, name: 'Y' })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => updateKitchenStation(tx, m, { stationId, slaMinutes: 20 })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => retireKitchenStation(tx, m, { stationId })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => setKitchenRoute(tx, m, { storeId: f.storeA, menuItemId: f.pork, stationId })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => clearKitchenRoute(tx, m, { storeId: f.storeA, menuItemId: f.pork })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, m, { storeId: f.storeA, categoryId: f.grillCat, stationId })));
    expect((await stationRow(stationId)).name).toBe('Grill');
    expect(await routesOf(f.storeA)).toEqual([]);
  });

  it('another org cannot address the rows: a refusal that names no id, nothing changes', async () => {
    const f = await fixture('otherorg');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    const o = f.otherAdmin;
    await expectRefusal(asOrg(o.orgId, (tx) => renameKitchenStation(tx, o, { stationId, name: 'Y' })), /kitchen station/i);
    await expectRefusal(asOrg(o.orgId, (tx) => updateKitchenStation(tx, o, { stationId, slaMinutes: 20 })), /kitchen station/i);
    await expectRefusal(asOrg(o.orgId, (tx) => retireKitchenStation(tx, o, { stationId })), /kitchen station/i);
    // a store of org 1 named by an org-2 actor is refused (no scope there) rather than written
    const err = await asOrg(o.orgId, (tx) => setKitchenRoute(tx, o, { storeId: f.storeA, menuItemId: f.pork, stationId })).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect((await stationRow(stationId)).name).toBe('Grill');
    expect(await routesOf(f.storeA)).toEqual([]);
  });
});

describe('T-508 S2a - rules and sentences', () => {
  it('a duplicate active name at the store is refused in a sentence; the same name at another store is fine', async () => {
    const f = await fixture('dup');
    await create(f.admin, f.storeA, 'Grill');
    await expectRefusal(create(f.admin, f.storeA, 'grill'), /already has a kitchen station called grill/);
    await create(f.admin, f.storeB, 'Grill');
  });

  it('rename onto another active station name is refused in a sentence', async () => {
    const f = await fixture('dupren');
    await create(f.admin, f.storeA, 'Grill');
    const { stationId } = await create(f.admin, f.storeA, 'Drinks');
    await expectRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, f.admin, { stationId, name: 'GRILL' })), /already has a kitchen station/);
  });

  it('SLA outside 1-240 and a blank name are refused with the rule sentence, after the gate', async () => {
    const f = await fixture('rules');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    await expectRefusal(asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.admin, { stationId, slaMinutes: 0 })), /1 to 240/);
    await expectRefusal(asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.admin, { stationId, slaMinutes: 241 })), /1 to 240/);
    await expectRefusal(create(f.admin, f.storeA, '   '), /needs a name/);
    await expectRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, f.admin, { stationId, name: '' })), /needs a name/);
    // staff with a bad value is told they may not, not that the value is wrong
    await expectAuthRefusal(asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.staff, { stationId, slaMinutes: 0 })));
    await asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.admin, { stationId, slaMinutes: 240 }));
    expect((await stationRow(stationId)).sla_minutes).toBe(240);
  });

  it('retire with routes: the sentence has the count, no id; routes untouched; a station of another store is not a valid target', async () => {
    const f = await fixture('retire');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    const { stationId: atB } = await create(f.admin, f.storeB, 'Grill B');
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork, stationId }));
    await expectRefusal(asOrg(f.orgId, (tx) => retireKitchenStation(tx, f.admin, { stationId })), /Grill still cooks 1 item/);
    expect((await stationRow(stationId)).status).toBe('active');
    expect(await routesOf(f.storeA)).toHaveLength(1);
    await expectRefusal(asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.beef, stationId: atB })), /kitchen station/);
  });

  it('an unknown item or category is refused with a sentence', async () => {
    const f = await fixture('badref');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    const fake = '00000000-0000-7000-8000-000000000001';
    await expectRefusal(asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: fake, stationId })), /menu item/);
    await expectRefusal(asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, f.admin, { storeId: f.storeA, categoryId: fake, stationId })), /menu category/);
  });
});

describe('T-508 S2a - category set', () => {
  it('routes every item in the category and nothing outside it; moves ones already routed elsewhere', async () => {
    const f = await fixture('cat');
    const { stationId: grill } = await create(f.admin, f.storeA, 'Grill');
    const { stationId: bar } = await create(f.admin, f.storeA, 'Bar');
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork, stationId: bar }));
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.squid, stationId: grill }));
    const r = await asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, f.admin, { storeId: f.storeA, categoryId: f.grillCat, stationId: grill }));
    expect(r.changed, 'squid was already on grill').toBe(2);
    const routes = new Map((await routesOf(f.storeA)).map((x) => [x.menu_item_id, x.station_id]));
    expect([routes.get(f.pork), routes.get(f.beef), routes.get(f.squid)]).toEqual([grill, grill, grill]);
    expect(routes.has(f.cola), 'Drinks untouched').toBe(false);
    expect(await routesOf(f.storeB), 'another store untouched').toEqual([]);
    const row = (await audits(f, 'kitchen_route')).filter((a) => a.action === 'kitchen_route.category_set');
    expect(row).toHaveLength(1);
    const before = (row[0]!.before as { items: { itemId: string; stationId: string | null }[] }).items;
    expect(before.find((i) => i.itemId === f.pork)!.stationId).toBe(bar);
    expect(before.find((i) => i.itemId === f.beef)!.stationId).toBeNull();
  });

  it('a retired target station refuses and no item is routed', async () => {
    const f = await fixture('catatomic');
    const { stationId } = await create(f.admin, f.storeA, 'Old');
    await asOrg(f.orgId, (tx) => retireKitchenStation(tx, f.admin, { stationId }));
    await expectRefusal(asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, f.admin, { storeId: f.storeA, categoryId: f.grillCat, stationId })), /kitchen station/);
    expect(await routesOf(f.storeA)).toEqual([]);
  });
});

describe('T-508 S2a - same value is a no-op: no write, no audit row', () => {
  it('rename, update, set, clear, retire, each repeated', async () => {
    const f = await fixture('noop');
    const { stationId } = await create(f.admin, f.storeA, 'Grill', { slaMinutes: 12 });
    const stamp = async () => (await sql<{ updated_at: Date | null }[]>`select updated_at from kitchen_stations where id = ${stationId}`)[0]!.updated_at;
    const before = await stamp();
    expect(await asOrg(f.orgId, (tx) => renameKitchenStation(tx, f.admin, { stationId, name: ' Grill ' }))).toEqual({ wrote: false });
    expect(await asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.admin, { stationId, slaMinutes: 12, printOnOutage: false, sortOrder: 0 }))).toEqual({ wrote: false });
    expect(await asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.admin, { stationId }))).toEqual({ wrote: false });
    expect(await stamp()).toEqual(before);
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork, stationId }));
    expect(await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork, stationId }))).toEqual({ wrote: false });
    expect(await asOrg(f.orgId, (tx) => clearKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.beef }))).toEqual({ wrote: false });
    await asOrg(f.orgId, (tx) => clearKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork }));
    expect(await asOrg(f.orgId, (tx) => retireKitchenStation(tx, f.admin, { stationId }))).toEqual({ wrote: true });
    expect(await asOrg(f.orgId, (tx) => retireKitchenStation(tx, f.admin, { stationId }))).toEqual({ wrote: false });
    expect((await audits(f, 'kitchen_station')).map((a) => a.action)).toEqual(['kitchen_station.created', 'kitchen_station.retired']);
    expect((await audits(f, 'kitchen_route')).map((a) => a.action)).toEqual(['kitchen_route.set', 'kitchen_route.cleared']);
  });
});

describe('T-508 S2a - listKitchenSetup (R5)', () => {
  it('lists stations, routes, and the offered items with no route', async () => {
    const f = await fixture('list');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork, stationId }));
    const s = await asOrg(f.orgId, (tx) => listKitchenSetup(tx, f.staff, { storeId: f.storeA }));
    expect(s.stations.map((x) => x.name)).toEqual(['Grill']);
    expect(s.routes).toEqual([{ menuItemId: f.pork, stationId }]);
    expect(s.offeredItems.map((o) => o.name).sort()).toEqual(['Cola', 'Pork belly', 'Squid']);
    expect(s.notOnPos.map((o) => o.name).sort(), 'Beef has no offer, Pork has a route').toEqual(['Cola', 'Squid']);
    expect(s.notOnPos.every((o) => o.stationId === null && o.categoryName)).toBe(true);
    // store B has no offers at all, and org 2 sees nothing of org 1
    expect((await asOrg(f.orgId, (tx) => listKitchenSetup(tx, f.admin, { storeId: f.storeB }))).offeredItems).toEqual([]);
    const other = await asOrg(f.otherOrgId, (tx) => listKitchenSetup(tx, f.otherAdmin, { storeId: f.storeA }));
    expect([other.stations, other.routes, other.offeredItems]).toEqual([[], [], []]);
  });

  it('a withdrawn offer is not offered', async () => {
    const f = await fixture('withdrawn');
    const [v] = await sql<{ id: string }[]>`select id from menu_item_variants where menu_item_id = ${f.cola}`;
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, withdrawn, created_by)
              values (${f.orgId}, ${f.storeA}, ${v!.id}, 'store', true, ${f.admin.personId})`;
    const s = await asOrg(f.orgId, (tx) => listKitchenSetup(tx, f.admin, { storeId: f.storeA }));
    expect(s.offeredItems.map((o) => o.name)).not.toContain('Cola');
  });
});

describe('T-508 S2a - audit gaps: the gate comes first, always', () => {
  it('staff with an INVALID name gets the authorization refusal on create and rename, not a field sentence', async () => {
    const f = await fixture('gatefirst');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    await expectAuthRefusal(create(f.staff, f.storeA, ''));
    await expectAuthRefusal(create(f.staff, f.storeA, 'x'.repeat(61), { slaMinutes: 0 }));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, f.staff, { stationId, name: '' })));
    await expectAuthRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, f.staff, { stationId, name: 'y'.repeat(61) })));
  });

  it('staff and another store manager repeating a same-value rename or retire are refused', async () => {
    const f = await fixture('noopgate');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    const { stationId: old } = await create(f.admin, f.storeA, 'Old');
    await asOrg(f.orgId, (tx) => retireKitchenStation(tx, f.admin, { stationId: old }));
    for (const who of [f.staff, f.managerB]) {
      await expectAuthRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, who, { stationId, name: 'Grill' })));
      await expectAuthRefusal(asOrg(f.orgId, (tx) => retireKitchenStation(tx, who, { stationId: old })));
    }
  });

  it('an org-2 actor is refused on create, clear and the category action; nothing is written', async () => {
    const f = await fixture('org2');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork, stationId }));
    const o = f.otherAdmin;
    const stationsBefore = (await sql`select count(*)::int as n from kitchen_stations where org_id = ${f.orgId}`)[0]!.n;
    const auditsBefore = (await audits(f, 'kitchen')).length;
    const fails = async (p: Promise<unknown>) => expect(await p.then(() => null, (e: unknown) => e)).not.toBeNull();
    await fails(create(o, f.storeA, 'Intruder'));
    await fails(asOrg(o.orgId, (tx) => clearKitchenRoute(tx, o, { storeId: f.storeA, menuItemId: f.pork })));
    await fails(asOrg(o.orgId, (tx) => setKitchenRoutesForCategory(tx, o, { storeId: f.storeA, categoryId: f.grillCat, stationId })));
    expect((await sql`select count(*)::int as n from kitchen_stations where org_id = ${f.orgId}`)[0]!.n).toBe(stationsBefore);
    expect(await routesOf(f.storeA)).toEqual([{ menu_item_id: f.pork, station_id: stationId }]);
    expect(await audits(f, 'kitchen')).toHaveLength(auditsBefore);
  });
});

describe('T-508 S2a - audit gaps: field rules and listing', () => {
  it('SLA 1.5, a sort order above 9999 and a 61-character name are refused; printOnOutage:true is stored', async () => {
    const f = await fixture('fieldrules');
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    await expectRefusal(asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.admin, { stationId, slaMinutes: 1.5 })), /1 to 240/);
    await expectRefusal(create(f.admin, f.storeA, 'Bad SLA', { slaMinutes: 1.5 }), /1 to 240/);
    await expectRefusal(asOrg(f.orgId, (tx) => updateKitchenStation(tx, f.admin, { stationId, sortOrder: 10000 })), /0 to 9999/);
    await expectRefusal(create(f.admin, f.storeA, 'Bad order', { sortOrder: 10000 }), /0 to 9999/);
    await expectRefusal(create(f.admin, f.storeA, 'n'.repeat(61)), /up to 60 characters/);
    await expectRefusal(asOrg(f.orgId, (tx) => renameKitchenStation(tx, f.admin, { stationId, name: 'n'.repeat(61) })), /up to 60 characters/);
    const { stationId: loud } = await create(f.admin, f.storeA, 'Loud', { printOnOutage: true });
    expect((await stationRow(loud)).print_on_outage).toBe(true);
  });

  it('an item offered at BOTH stores, routed differently, shows only each store\'s own station', async () => {
    const f = await fixture('twostores');
    const [v] = await sql<{ id: string }[]>`select id from menu_item_variants where menu_item_id = ${f.pork}`;
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, created_by)
              values (${f.orgId}, ${f.storeB}, ${v!.id}, 'store', 100, ${f.admin.personId})`;
    const { stationId: a } = await create(f.admin, f.storeA, 'Grill A');
    const { stationId: b } = await create(f.admin, f.storeB, 'Grill B');
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeA, menuItemId: f.pork, stationId: a }));
    await asOrg(f.orgId, (tx) => setKitchenRoute(tx, f.admin, { storeId: f.storeB, menuItemId: f.pork, stationId: b }));
    for (const [store, station] of [[f.storeA, a], [f.storeB, b]] as const) {
      const s = await asOrg(f.orgId, (tx) => listKitchenSetup(tx, f.admin, { storeId: store }));
      const rows = s.offeredItems.filter((o) => o.itemId === f.pork);
      expect(rows.map((r) => r.stationId)).toEqual([station]);
      expect(s.stations.map((x) => x.id)).toEqual([station]);
    }
  });

  it('the category action leaves a RETIRED item in the category unrouted', async () => {
    const f = await fixture('retireditem');
    await sql`update menu_items set status = 'retired' where id = ${f.beef}`;
    const { stationId } = await create(f.admin, f.storeA, 'Grill');
    const r = await asOrg(f.orgId, (tx) => setKitchenRoutesForCategory(tx, f.admin, { storeId: f.storeA, categoryId: f.grillCat, stationId }));
    expect(r.changed).toBe(2);
    expect((await routesOf(f.storeA)).map((x) => x.menu_item_id).sort()).toEqual([f.pork, f.squid].sort());
  });
});
