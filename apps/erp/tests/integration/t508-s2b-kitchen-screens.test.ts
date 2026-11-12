import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * T-508 S2b - the kitchen stations and routing screens: server actions (real action, real domain, real database; session
 * mocked, redirect captured) and the store page rendered by role. Spec: docs/tasks/508-kitchen-stations-and-menu-to-pos.md R5, R10, S2.
 * An admin and a manager of THIS store may act; staff and a manager of another store get the refusal banner and nothing is written.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('../../src/lib/page-access', async (orig) => ({ ...(await orig<object>()), requirePageAccess: async () => ({ actor: h.actor!, refusal: null }) }));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});
beforeEach(() => resetJar());

async function person(orgId: string, role: string, name: string, stores: string[]) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return { personId: p!.id, orgId };
}

/** Org with stores A and B; Grill: Pork + Squid offered at A; Beef not offered; Drinks: Cola offered at A. Stations Grill and Bar at A. */
async function fixture(hint: string) {
  const code = uid(`t508b-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const storeA = await mkStore('Store A');
  const storeB = await mkStore('Store B');
  const admin = await person(orgId, 'admin', 'Admin', [storeA, storeB]);
  const managerA = await person(orgId, 'manager', 'Manager A', [storeA]);
  const managerB = await person(orgId, 'manager', 'Manager B', [storeB]);
  const staff = await person(orgId, 'staff', 'Staff', [storeA, storeB]);
  const mkCategory = async (name: string) =>
    (await sql<{ id: string }[]>`insert into menu_categories (org_id, name, created_by) values (${orgId}, ${name}, ${admin.personId}) returning id`)[0]!.id;
  const grillCat = await mkCategory('Grill');
  const drinksCat = await mkCategory('Drinks');
  const mkItem = async (categoryId: string, name: string, offeredAt: string | null) => {
    const [i] = await sql<{ id: string }[]>`
      insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, created_by)
      values (${orgId}, ${categoryId}, ${name}, 'a_la_carte', true, ${admin.personId}) returning id`;
    const [v] = await sql<{ id: string }[]>`insert into menu_item_variants (org_id, menu_item_id, is_default, created_by) values (${orgId}, ${i!.id}, true, ${admin.personId}) returning id`;
    if (offeredAt) {
      await sql`insert into menu_depletion_rules (org_id, variant_id, mode, created_by) values (${orgId}, ${v!.id}, 'no_stock', ${admin.personId})`;
      await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, created_by) values (${orgId}, ${offeredAt}, ${v!.id}, 'store', 100, ${admin.personId})`;
    }
    return i!.id;
  };
  const pork = await mkItem(grillCat, 'Pork belly', storeA);
  const beef = await mkItem(grillCat, 'Beef slice', null);
  const squid = await mkItem(grillCat, 'Squid', storeA);
  const cola = await mkItem(drinksCat, 'Cola', storeA);
  const mkStation = async (name: string) =>
    (await sql<{ id: string }[]>`insert into kitchen_stations (org_id, store_id, name, created_by) values (${orgId}, ${storeA}, ${name}, ${admin.personId}) returning id`)[0]!.id;
  const grill = await mkStation('Grill');
  const bar = await mkStation('Bar');
  return { orgId, storeA, storeB, grillCat, pork, beef, squid, cola, grill, bar, admin, managerA, managerB, staff };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
type Who = { personId: string; orgId: string };

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
type Action = (fd: FormData) => Promise<void>;
async function post(who: Who, name: string, fd: FormData) {
  h.actor = who;
  const mod = (await import('../../src/app/admin/stores/kitchen-actions')) as unknown as Record<string, Action>;
  expect(typeof mod[name], `${name} must be exported from admin/stores/kitchen-actions.ts`).toBe('function');
  return outcomeOf(await captureRedirect(() => mod[name]!(fd)));
}
const stations = async (storeId: string) =>
  sql<{ id: string; name: string; sla_minutes: number; print_on_outage: boolean; sort_order: number; status: string }[]>`
    select id, name, sla_minutes, print_on_outage, sort_order, status from kitchen_stations where store_id = ${storeId} order by name`;
const routes = async (storeId: string) =>
  new Map((await sql<{ menu_item_id: string; station_id: string }[]>`select menu_item_id, station_id from kitchen_routes where store_id = ${storeId}`).map((r) => [r.menu_item_id, r.station_id]));

/** The people who may NOT write: staff, and a manager scoped to another store. Each must end in an error banner and no write. */
const refused = (f: Fx) => [['staff', f.staff], ['manager of another store', f.managerB]] as const;

describe('T-508 S2b - station actions', () => {
  it('admin and the store manager add a station', async () => {
    const f = await fixture('create');
    for (const [who, name] of [[f.admin, 'Dessert'], [f.managerA, 'Salad']] as const) {
      const o = await post(who, 'createKitchenStationAction', form({ storeId: f.storeA, name, slaMinutes: '7' }));
      expect(o.path).toBe('/kitchen');
      expect(o.flash.error).toBeUndefined();
      expect(o.flash.ok).toBeTruthy();
    }
    const rows = await stations(f.storeA);
    expect(rows.find((r) => r.name === 'Dessert')?.sla_minutes).toBe(7);
    expect(rows.some((r) => r.name === 'Salad')).toBe(true);
  });

  it('staff and a manager of another store are refused; nothing is written', async () => {
    const f = await fixture('create-no');
    for (const [label, who] of refused(f)) {
      const o = await post(who, 'createKitchenStationAction', form({ storeId: f.storeA, name: 'Sneaky' }));
      expect(o.flash.error, label).toBeTruthy();
      expect(o.flash.ok, label).toBeUndefined();
    }
    expect((await stations(f.storeA)).some((r) => r.name === 'Sneaky')).toBe(false);
  });

  it('a duplicate name shows the domain sentence', async () => {
    const f = await fixture('dup');
    const o = await post(f.admin, 'createKitchenStationAction', form({ storeId: f.storeA, name: 'grill' }));
    expect(o.flash.error ?? '').toMatch(/already has a kitchen station called/);
  });

  it('admin and the store manager rename, set minutes, print-on-outage and order in one save', async () => {
    const f = await fixture('update');
    for (const [who, name, sla] of [[f.admin, 'Main grill', '12'], [f.managerA, 'Grill 2', '15']] as const) {
      const o = await post(who, 'updateKitchenStationAction', form({ storeId: f.storeA, stationId: f.grill, name, slaMinutes: sla, printOnOutage: 'yes', sortOrder: '3' }));
      expect(o.flash.error).toBeUndefined();
      expect(o.flash.ok).toBeTruthy();
    }
    expect((await stations(f.storeA)).find((r) => r.id === f.grill)).toMatchObject({ name: 'Grill 2', sla_minutes: 15, print_on_outage: true, sort_order: 3 });
  });

  it('a refused save (staff, other-store manager, bad minutes) changes nothing', async () => {
    const f = await fixture('update-no');
    for (const [label, who] of refused(f)) {
      const o = await post(who, 'updateKitchenStationAction', form({ storeId: f.storeA, stationId: f.grill, name: 'Hacked', slaMinutes: '99', printOnOutage: 'yes', sortOrder: '9' }));
      expect(o.flash.error, label).toBeTruthy();
    }
    const bad = await post(f.admin, 'updateKitchenStationAction', form({ storeId: f.storeA, stationId: f.grill, name: 'Grill', slaMinutes: '999', printOnOutage: 'no', sortOrder: '0' }));
    expect(bad.flash.error ?? '').toMatch(/1 to 240/);
    expect((await stations(f.storeA)).find((r) => r.id === f.grill)).toMatchObject({ name: 'Grill', sla_minutes: 10, print_on_outage: false });
  });

  it('admin and the store manager retire a station; staff and another store manager cannot', async () => {
    const f = await fixture('retire');
    for (const [label, who] of refused(f)) {
      const o = await post(who, 'retireKitchenStationAction', form({ storeId: f.storeA, stationId: f.bar, confirmName: 'Bar' }));
      expect(o.flash.error, label).toBeTruthy();
    }
    expect((await stations(f.storeA)).find((r) => r.id === f.bar)?.status).toBe('active');
    expect((await post(f.managerA, 'retireKitchenStationAction', form({ storeId: f.storeA, stationId: f.bar, confirmName: 'Bar' }))).flash.ok).toBeTruthy();
    expect((await post(f.admin, 'retireKitchenStationAction', form({ storeId: f.storeA, stationId: f.grill, confirmName: 'Grill' }))).flash.ok).toBeTruthy();
    expect((await stations(f.storeA)).map((r) => r.status)).toEqual(['retired', 'retired']);
  });

  it('retire needs the station name retyped; a wrong name changes nothing', async () => {
    const f = await fixture('retire-name');
    const o = await post(f.admin, 'retireKitchenStationAction', form({ storeId: f.storeA, stationId: f.bar, confirmName: 'Nope' }));
    expect(o.flash.error).toBeTruthy();
    expect((await stations(f.storeA)).find((r) => r.id === f.bar)?.status).toBe('active');
  });

  it('retire is refused while an item cooks there, with the domain sentence', async () => {
    const f = await fixture('retire-routed');
    await post(f.admin, 'setKitchenCategoryAction', form({ storeId: f.storeA, categoryId: f.grillCat, stationId: f.grill }));
    const o = await post(f.admin, 'retireKitchenStationAction', form({ storeId: f.storeA, stationId: f.grill, confirmName: 'Grill' }));
    expect(o.flash.error ?? '').toMatch(/route|item|cook/i);
    expect((await stations(f.storeA)).find((r) => r.id === f.grill)?.status).toBe('active');
  });
});

describe('T-508 S2b - routing actions', () => {
  it('category save with nothing chosen says so, in words, and writes nothing', async () => {
    const f = await fixture('cat-empty');
    for (const fd of [form({ storeId: f.storeA }), form({ storeId: f.storeA, categoryId: f.grillCat }), form({ storeId: f.storeA, stationId: f.grill })]) {
      const o = await post(f.admin, 'setKitchenCategoryAction', fd);
      expect(o.flash.error).toBe('Choose a category and a station.');
    }
    expect((await routes(f.storeA)).size).toBe(0);
  });

  it('saves only the pickers that changed; blank clears a route', async () => {
    const f = await fixture('save');
    const o = await post(f.managerA, 'saveKitchenRoutingAction', form({ storeId: f.storeA, [`route_${f.pork}`]: f.grill, [`route_${f.cola}`]: f.bar, [`route_${f.squid}`]: '' }));
    expect(o.flash.error).toBeUndefined();
    expect(o.flash.ok).toMatch(/2 items/);
    expect(await routes(f.storeA)).toEqual(new Map([[f.pork, f.grill], [f.cola, f.bar]]));
    const o2 = await post(f.admin, 'saveKitchenRoutingAction', form({ storeId: f.storeA, [`route_${f.pork}`]: '', [`route_${f.cola}`]: f.bar }));
    expect(o2.flash.ok).toMatch(/1 item/);
    expect(await routes(f.storeA)).toEqual(new Map([[f.cola, f.bar]]));
  });

  it('staff and another store manager are refused; nothing is written', async () => {
    const f = await fixture('save-no');
    for (const [label, who] of refused(f)) {
      const o = await post(who, 'saveKitchenRoutingAction', form({ storeId: f.storeA, [`route_${f.pork}`]: f.grill }));
      expect(o.flash.error, label).toBeTruthy();
    }
    expect((await routes(f.storeA)).size).toBe(0);
  });

  it('"set every item in this category": admin and the store manager can; others are refused', async () => {
    const f = await fixture('cat');
    for (const [label, who] of refused(f)) {
      const o = await post(who, 'setKitchenCategoryAction', form({ storeId: f.storeA, categoryId: f.grillCat, stationId: f.grill }));
      expect(o.flash.error, label).toBeTruthy();
    }
    expect((await routes(f.storeA)).size).toBe(0);
    const o = await post(f.managerA, 'setKitchenCategoryAction', form({ storeId: f.storeA, categoryId: f.grillCat, stationId: f.grill }));
    expect(o.flash.ok).toBeTruthy();
    expect((await routes(f.storeA)).get(f.pork)).toBe(f.grill);
    const o2 = await post(f.admin, 'setKitchenCategoryAction', form({ storeId: f.storeA, categoryId: f.grillCat, stationId: f.grill }));
    expect(o2.flash.ok).toMatch(/already/);
  });
});

async function render(who: Who, storeId?: string): Promise<string> {
  h.actor = who;
  const Page = (await import('../../src/app/kitchen/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(storeId ? { store: storeId } : {}) })) as never);
}

describe('T-508 S2b - the /kitchen page by role', () => {
  it('admin and the store manager see the panels; the warning panel lists exactly the unrouted offered items', async () => {
    const f = await fixture('render');
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeA}, ${f.pork}, ${f.grill}, ${f.admin.personId})`;
    for (const who of [f.admin, f.managerA]) {
      const html = await render(who, f.storeA);
      expect(html).toContain('Kitchen stations');
      expect(html).toContain('Kitchen routing');
      expect(html).toContain('Not on the POS yet');
      const panel = html.split('data-testid="not-on-pos"')[1]!.split('</ul>')[0]!;
      expect(panel).toContain('Squid');
      expect(panel).toContain('Cola');
      expect(panel, 'routed item is not listed').not.toContain('Pork belly');
      expect(panel, 'an item with no offer here is not listed').not.toContain('Beef slice');
    }
  });

  it('a manager goes straight to their only store; a store they do not hold is refused', async () => {
    const f = await fixture('render-scope');
    expect(await render(f.managerA)).toContain('Kitchen stations');
    expect(await render(f.managerB, f.storeA)).toContain('This store is not available to you.');
    expect(await render(f.managerA, f.storeB)).toContain('This store is not available to you.');
    expect(await render(f.admin, f.storeB)).toContain('Kitchen stations');
  });

  it('staff and a manager of another store see no kitchen controls', async () => {
    const f = await fixture('render-no');
    for (const who of [f.staff, f.managerB]) {
      const html = await render(who, f.storeA);
      expect(html).not.toContain('Kitchen stations');
      expect(html).not.toContain('Kitchen routing');
      expect(html).not.toContain('Not on the POS yet');
    }
  });

  it('no warning panel once everything offered is routed', async () => {
    const f = await fixture('render-clear');
    await post(f.admin, 'setKitchenCategoryAction', form({ storeId: f.storeA, categoryId: f.grillCat, stationId: f.grill }));
    await post(f.admin, 'saveKitchenRoutingAction', form({ storeId: f.storeA, [`route_${f.cola}`]: f.bar }));
    expect(await render(f.admin, f.storeA)).not.toContain('Not on the POS yet');
  });
});
