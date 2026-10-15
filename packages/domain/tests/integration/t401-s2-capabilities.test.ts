/**
 * T-401 S2, I12 (revised for Q1/Q2 and Ian's recipes ruling; docs/tasks/401-erp-menu-catalog-master.md R14, section 3 "Capabilities", 6a).
 * TESTER, not BUILDER. Real Postgres, real authorize(), real RLS principal. Every tick has a cross that fires.
 *
 * ## Assumed contract
 *   createMenuCategory(actor, { name }, tx?)                          -> { id }                   gate: manage_menu (org)
 *   editMenuItem(actor, { id, name }, tx?)                            -> { id }                   gate: manage_menu
 *   createMenuItem(actor, { categoryId, name, itemType }, tx?)        -> { id, defaultVariantId } gate: add_menu_item (org, SUPER ADMIN ONLY)
 *   addMenuVariant(actor, { menuItemId, label }, tx?)                 -> { id }                   gate: add_menu_item
 *   requestMenuItem(actor, { storeId, name, itemType }, tx?)          -> { id, possibleDuplicates } gate: request_menu_item (store)
 *   setDepletionRule(actor, { variantId, mode: 'no_stock' }, tx?)     -> { id }                   gate: set_menu_depletion (org; SUPER ADMIN + ADMIN only - Ian: recipes)
 *   setMenuOffer(actor, { storeId, variantId, channel, amount }, tx?) -> { id }                   gate: set_menu_price (STORE-scoped, ctx.storeId = input.storeId)
 *   Refusals are an `AuthorizationError` carrying the capability name; a refused call leaves no menu row and no audit_log row.
 *   view_menu and switch_usage_source have no S2 write; they are proven through authorize() itself.
 *
 * ## Red today
 * The capabilities and domain functions do not exist. Mutants killed: set_menu_price scoped `org` (the manager prices every store);
 * add_menu_item wired like manage_menu (admin adds items); manager allowed manage_menu or set_menu_depletion (the old cell).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError, authorize, type Actor, type Capability } from '@shareat/auth';
import { addMenuVariant, createMenuCategory, createMenuItem, editMenuItem, requestMenuItem, setDepletionRule, setMenuOffer } from '@shareat/domain';

import { asOrg, attempt, auditCount, cast, rawItem, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const cap = (c: string) => c as unknown as Capability; // the names do not exist as Capability members until the builder adds them

async function menuRows(orgId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select (select count(*) from menu_categories where org_id = ${orgId}) + (select count(*) from menu_items where org_id = ${orgId})
         + (select count(*) from menu_item_variants where org_id = ${orgId})
         + (select count(*) from menu_offers where org_id = ${orgId}) + (select count(*) from menu_depletion_rules where org_id = ${orgId}) as n`;
  return Number(r!.n);
}

/** One org with an item that has a rule in force (so an offer is valid). */
interface Fx {
  c: Cast;
  variantId: string;
  itemId: string;
}
async function fx(hint: string): Promise<Fx> {
  const c = await cast(hint);
  const { variantId, itemId } = await rawItem(c);
  await rawRule(c, variantId); // so an offer is valid; the refusal under test is never "no depletion rule"
  return { c, variantId, itemId };
}
/** A fresh variant with NO rule yet, made OUTSIDE the call under test (a helper inside a refused call would add a row to the count). */
const spare = async (f: Fx) => (await rawItem(f.c)).variantId;

const calls = {
  category: (f: Fx, a: Actor) => asOrg(f.c.orgId, (tx) => createMenuCategory(a, { name: `Cat ${Math.random()}` }, tx)),
  editItem: (f: Fx, a: Actor) => asOrg(f.c.orgId, (tx) => editMenuItem(a, { id: f.itemId, name: `Renamed ${Math.random()}` }, tx)),
  createItem: (f: Fx, a: Actor) =>
    asOrg(f.c.orgId, (tx) => createMenuItem(a, { categoryId: f.c.categoryId, name: `Item ${Math.random()}`, itemType: 'a_la_carte' }, tx)),
  addVariant: (f: Fx, a: Actor) => asOrg(f.c.orgId, (tx) => addMenuVariant(a, { menuItemId: f.itemId, label: `V${Math.random()}` }, tx)),
  depletion: (f: Fx, a: Actor, variantId: string) => asOrg(f.c.orgId, (tx) => setDepletionRule(a, { variantId, mode: 'no_stock' }, tx)),
  priceA: (f: Fx, a: Actor) =>
    asOrg(f.c.orgId, (tx) => setMenuOffer(a, { storeId: f.c.storeA, variantId: f.variantId, channel: 'store', amount: '100.00' }, tx)),
  priceB: (f: Fx, a: Actor) =>
    asOrg(f.c.orgId, (tx) => setMenuOffer(a, { storeId: f.c.storeB, variantId: f.variantId, channel: 'store', amount: '100.00' }, tx)),
  request: (f: Fx, a: Actor, storeId: string) =>
    asOrg(f.c.orgId, (tx) => requestMenuItem(a, { storeId, name: `Wanted ${Math.random()}`, itemType: 'a_la_carte' }, tx)),
};

async function expectRefused(f: Fx, run: () => Promise<unknown>, capability: string) {
  const before = { menu: await menuRows(f.c.orgId), audit: await auditCount(f.c.orgId) };
  const r = await attempt(run);
  expect(r.failed, `${capability}: the call was NOT refused`).toBe(true);
  expect(r.error, `${capability}: refused, but not by authorize() (${r.message})`).toBeInstanceOf(AuthorizationError);
  expect((r.error as AuthorizationError).capability).toBe(capability);
  expect(await menuRows(f.c.orgId), 'a refused call wrote a menu row').toBe(before.menu);
  expect(await auditCount(f.c.orgId), 'a refused call wrote an audit_log row').toBe(before.audit);
}

async function expectAllowed(run: () => Promise<unknown>, what: string) {
  const r = await attempt(run);
  expect(r.failed, `${what}: refused (${r.message})`).toBe(false);
}

const authorizeAs = (f: Fx, a: Actor, capability: string, storeId?: string) =>
  attempt(() => asOrg(f.c.orgId, (tx) => authorize(tx, a, cap(capability), storeId ? { storeId } : {})));

describe('I12 -- manage_menu: super admin and admin; categories and item EDITS (Q2: editing stays manage_menu)', () => {
  it('manager is refused createMenuCategory and editMenuItem with manage_menu (mutant: manager allowed)', async () => {
    const f = await fx('i12-m');
    await expectRefused(f, () => calls.category(f, f.c.manager), 'manage_menu');
    await expectRefused(f, () => calls.editItem(f, f.c.manager), 'manage_menu');
  });
  it('staff is refused manage_menu too', async () => {
    const f = await fx('i12-ms');
    await expectRefused(f, () => calls.category(f, f.c.staff), 'manage_menu');
  });
  it('positive: admin and super_admin may create a category and edit an item', async () => {
    const f = await fx('i12-mp');
    await expectAllowed(() => calls.category(f, f.c.admin), 'admin createMenuCategory');
    await expectAllowed(() => calls.category(f, f.c.superAdmin), 'super_admin createMenuCategory');
    await expectAllowed(() => calls.editItem(f, f.c.admin), 'admin editMenuItem');
  });
});

describe('I12 -- add_menu_item: SUPER ADMIN ONLY (Q2: items are centralised)', () => {
  it('admin is refused createMenuItem and addMenuVariant with add_menu_item (mutant: add_menu_item wired like manage_menu)', async () => {
    const f = await fx('i12-a');
    await expectRefused(f, () => calls.createItem(f, f.c.admin), 'add_menu_item');
    await expectRefused(f, () => calls.addVariant(f, f.c.admin), 'add_menu_item');
  });
  it('manager and staff are refused too', async () => {
    const f = await fx('i12-a2');
    await expectRefused(f, () => calls.createItem(f, f.c.manager), 'add_menu_item');
    await expectRefused(f, () => calls.addVariant(f, f.c.staff), 'add_menu_item');
  });
  it('positive: super admin may', async () => {
    const f = await fx('i12-ap');
    await expectAllowed(() => calls.createItem(f, f.c.superAdmin), 'super_admin createMenuItem');
    await expectAllowed(() => calls.addVariant(f, f.c.superAdmin), 'super_admin addMenuVariant');
  });
});

describe('I12 -- request_menu_item: store-scoped; manager, admin and super admin may; staff may not', () => {
  it('a manager requests at a store in scope; managerA (scope A only) is refused at B; staff is refused', async () => {
    const f = await fx('i12-r');
    await expectAllowed(() => calls.request(f, f.c.manager, f.c.storeA), 'manager request at A');
    await expectAllowed(() => calls.request(f, f.c.managerA, f.c.storeA), 'managerA request at A');
    await expectRefused(f, () => calls.request(f, f.c.managerA, f.c.storeB), 'request_menu_item');
    await expectRefused(f, () => calls.request(f, f.c.staff, f.c.storeA), 'request_menu_item');
  });
  it('positive: admin and super_admin may request', async () => {
    const f = await fx('i12-rp');
    await expectAllowed(() => calls.request(f, f.c.admin, f.c.storeA), 'admin request');
    await expectAllowed(() => calls.request(f, f.c.superAdmin, f.c.storeB), 'super_admin request');
  });
});

describe('I12 -- set_menu_price: a manager prices their OWN store (Q1); store-scoped', () => {
  it('a manager scoped to A only succeeds at A and is refused at B (mutant: set_menu_price scoped org - the manager prices every store)', async () => {
    const f = await fx('i12-p');
    await expectAllowed(() => calls.priceA(f, f.c.managerA), 'managerA setMenuOffer at A');
    await expectRefused(f, () => calls.priceB(f, f.c.managerA), 'set_menu_price');
  });
  it('a manager scoped to both stores may price both (scope, not the role, was the limit)', async () => {
    const f = await fx('i12-p2');
    await expectAllowed(() => calls.priceA(f, f.c.manager), 'manager at A');
    const g = await fx('i12-p3');
    await expectAllowed(() => calls.priceB(g, g.c.manager), 'manager at B');
  });
  it('plain staff is refused', async () => {
    const f = await fx('i12-ps');
    await expectRefused(f, () => calls.priceA(f, f.c.staff), 'set_menu_price');
  });
  it('a staff member granted set_menu_price FOR STORE A BY POSITION succeeds at A and is refused at B', async () => {
    const f = await fx('i12-g');
    await expectAllowed(() => calls.priceA(f, f.c.grantedStaff), 'grantedStaff setMenuOffer at store A');
    await expectRefused(f, () => calls.priceB(f, f.c.grantedStaff), 'set_menu_price');
  });
  it('the price grant does not leak: grantedStaff is still refused manage_menu and set_menu_depletion', async () => {
    const f = await fx('i12-gl');
    const v = await spare(f);
    await expectRefused(f, () => calls.category(f, f.c.grantedStaff), 'manage_menu');
    await expectRefused(f, () => calls.depletion(f, f.c.grantedStaff, v), 'set_menu_depletion');
  });
  it('an admin with no scope for store B is refused at B but not at A (axis 2 still runs)', async () => {
    const f = await fx('i12-as');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.c.orgId}, 'Admin A only') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.c.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.c.storeA})`;
    const adminA: Actor = { personId: p!.id, orgId: f.c.orgId };
    await expectAllowed(() => calls.priceA(f, adminA), 'admin scoped to A, at A');
    await expectRefused(f, () => calls.priceB(f, adminA), 'set_menu_price');
  });
  it('positive: admin and super_admin may set a price at either store', async () => {
    const f = await fx('i12-pp');
    await expectAllowed(() => calls.priceA(f, f.c.admin), 'admin at A');
    const g = await fx('i12-pp2');
    await expectAllowed(() => calls.priceB(g, g.c.superAdmin), 'super_admin at B');
  });
});

describe('I12 -- set_menu_depletion: SUPER ADMIN and ADMIN only (Ian, recipes); manager and staff refused', () => {
  it('positive: admin and super_admin may set a depletion rule', async () => {
    const f = await fx('i12-d');
    const v1 = await spare(f);
    const v2 = await spare(f);
    await expectAllowed(() => calls.depletion(f, f.c.admin, v1), 'admin setDepletionRule');
    await expectAllowed(() => calls.depletion(f, f.c.superAdmin, v2), 'super_admin setDepletionRule');
  });
  it('a manager is refused with set_menu_depletion (mutant: the old manager-allowed cell)', async () => {
    const f = await fx('i12-dm');
    const v = await spare(f);
    await expectRefused(f, () => calls.depletion(f, f.c.manager, v), 'set_menu_depletion');
  });
  it('staff is refused with set_menu_depletion', async () => {
    const f = await fx('i12-ds');
    const v = await spare(f);
    await expectRefused(f, () => calls.depletion(f, f.c.staff, v), 'set_menu_depletion');
  });
});

describe('I12 -- view_menu and switch_usage_source (proven through authorize itself)', () => {
  it('view_menu: manager, admin and super_admin pass; staff is refused', async () => {
    const f = await fx('i12-v');
    for (const [who, a] of [['manager', f.c.manager], ['admin', f.c.admin], ['super_admin', f.c.superAdmin]] as const) {
      const r = await authorizeAs(f, a, 'view_menu');
      expect(r.failed, `${who} refused view_menu: ${r.message}`).toBe(false);
    }
    const r = await authorizeAs(f, f.c.staff, 'view_menu');
    expect(r.failed, 'staff was allowed view_menu').toBe(true);
    expect(r.error).toBeInstanceOf(AuthorizationError);
  });

  it('switch_usage_source (store-scoped): admin and super_admin pass; a manager is refused at their own store', async () => {
    const f = await fx('i12-sw3');
    for (const [who, a] of [['admin', f.c.admin], ['super_admin', f.c.superAdmin]] as const) {
      const r = await authorizeAs(f, a, 'switch_usage_source', f.c.storeA);
      expect(r.failed, `${who} refused switch_usage_source: ${r.message}`).toBe(false);
    }
    const r = await authorizeAs(f, f.c.manager, 'switch_usage_source', f.c.storeA);
    expect(r.failed, 'a manager was allowed to switch the usage source').toBe(true);
    expect(r.error).toBeInstanceOf(AuthorizationError);
    expect((r.error as AuthorizationError).capability).toBe('switch_usage_source');
  });
});
