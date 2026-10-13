/**
 * T-401 S2, I12. docs/tasks/401-erp-menu-catalog-master.md section 3 "Capabilities", Q1 recommended option (a), CAPABILITY-MATRIX rule
 * "every tick needs a test proving the cross fires". TESTER, not BUILDER. Real Postgres, real authorize(), real RLS principal.
 *
 * ## Assumed contract
 *   domain  createMenuCategory(actor, { name }, tx?)                         -> { id }          gate: manage_menu (org)
 *           createMenuItem(actor, { categoryId, name, itemType }, tx?)       -> { id, defaultVariantId }   gate: manage_menu
 *           setDepletionRule(actor, { variantId, mode: 'no_stock' }, tx?)    -> { id }          gate: set_menu_depletion (org)
 *           setMenuOffer(actor, { storeId, variantId, channel, amount }, tx?) -> { id }         gate: set_menu_price (STORE-scoped, ctx.storeId = input.storeId)
 *   Refusals are an `AuthorizationError` carrying the capability name; a refused call leaves no menu row and no audit_log row.
 *   view_menu has no domain write; it is proven through authorize() itself (the repo read is gated by the caller, bible section 7).
 *
 * ## Red today
 * The four capabilities and the domain functions do not exist. Mutants this file kills: set_menu_price scoped `org` (grantedStaff
 * would pass at store B), manager allowed manage_menu, staff allowed set_menu_depletion / view_menu, a function that skips authorize().
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError, authorize, type Actor, type Capability } from '@shareat/auth';
import { createMenuCategory, createMenuItem, setDepletionRule, setMenuOffer } from '@shareat/domain';

import { asOrg, attempt, auditCount, cast, rawItem, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const cap = (c: string) => c as unknown as Capability; // the names do not exist as Capability members until the builder adds them

async function menuRows(orgId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select (select count(*) from menu_categories where org_id = ${orgId}) + (select count(*) from menu_items where org_id = ${orgId})
         + (select count(*) from menu_offers where org_id = ${orgId}) + (select count(*) from menu_depletion_rules where org_id = ${orgId}) as n`;
  return Number(r!.n);
}

/** The four gated calls, each with otherwise-valid input so a refusal can only be the capability's. */
interface Fx {
  c: Cast;
  variantId: string;
}
async function fx(hint: string): Promise<Fx> {
  const c = await cast(hint);
  const { variantId } = await rawItem(c);
  await rawRule(c, variantId); // so an offer is valid; the refusal under test is never "no depletion rule"
  return { c, variantId };
}
const calls = {
  manage_menu_category: (f: Fx, a: Actor) => asOrg(f.c.orgId, (tx) => createMenuCategory(a, { name: `Cat ${Math.random()}` }, tx)),
  manage_menu_item: (f: Fx, a: Actor) =>
    asOrg(f.c.orgId, (tx) => createMenuItem(a, { categoryId: f.c.categoryId, name: `Item ${Math.random()}`, itemType: 'a_la_carte' }, tx)),
  set_menu_depletion: async (f: Fx, a: Actor) => {
    const { variantId } = await rawItem(f.c); // a fresh variant each time: one rule per (variant, effective_from)
    return asOrg(f.c.orgId, (tx) => setDepletionRule(a, { variantId, mode: 'no_stock' }, tx));
  },
  set_menu_price_A: (f: Fx, a: Actor) =>
    asOrg(f.c.orgId, (tx) => setMenuOffer(a, { storeId: f.c.storeA, variantId: f.variantId, channel: 'store', amount: '100.00' }, tx)),
  set_menu_price_B: (f: Fx, a: Actor) =>
    asOrg(f.c.orgId, (tx) => setMenuOffer(a, { storeId: f.c.storeB, variantId: f.variantId, channel: 'store', amount: '100.00' }, tx)),
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

describe('I12 -- manage_menu: admin and super-admin only (Q1 option a); the crosses fire', () => {
  it('manager is refused createMenuCategory and createMenuItem with manage_menu (mutant: manager allowed, Q1 option c)', async () => {
    const f = await fx('i12-m');
    await expectRefused(f, () => calls.manage_menu_category(f, f.c.manager), 'manage_menu');
    await expectRefused(f, () => calls.manage_menu_item(f, f.c.manager), 'manage_menu');
  });
  it('staff is refused manage_menu too', async () => {
    const f = await fx('i12-ms');
    await expectRefused(f, () => calls.manage_menu_category(f, f.c.staff), 'manage_menu');
  });
  it('positive: admin and super_admin may', async () => {
    const f = await fx('i12-mp');
    await expectAllowed(() => calls.manage_menu_category(f, f.c.admin), 'admin createMenuCategory');
    await expectAllowed(() => calls.manage_menu_item(f, f.c.superAdmin), 'super_admin createMenuItem');
  });
});

describe('I12 -- set_menu_price: admin and super-admin; STORE-scoped', () => {
  it('manager is refused setMenuOffer at a store they are scoped to (mutant: manager allowed, Q1 option b)', async () => {
    const f = await fx('i12-p');
    await expectRefused(f, () => calls.set_menu_price_A(f, f.c.manager), 'set_menu_price');
  });
  it('plain staff is refused', async () => {
    const f = await fx('i12-ps');
    await expectRefused(f, () => calls.set_menu_price_A(f, f.c.staff), 'set_menu_price');
  });
  it('a staff member granted set_menu_price FOR STORE A BY POSITION succeeds at A and is refused at B (mutant: set_menu_price scoped org)', async () => {
    const f = await fx('i12-g');
    await expectAllowed(() => calls.set_menu_price_A(f, f.c.grantedStaff), 'grantedStaff setMenuOffer at store A');
    await expectRefused(f, () => calls.set_menu_price_B(f, f.c.grantedStaff), 'set_menu_price');
  });
  it('the price grant does not leak: grantedStaff is still refused manage_menu and set_menu_depletion', async () => {
    const f = await fx('i12-gl');
    await expectRefused(f, () => calls.manage_menu_category(f, f.c.grantedStaff), 'manage_menu');
    await expectRefused(f, () => calls.set_menu_depletion(f, f.c.grantedStaff), 'set_menu_depletion');
  });
  it('an admin with no scope for store B is refused at B but not at A (axis 2 still runs for a role-held store capability)', async () => {
    const f = await fx('i12-as');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.c.orgId}, 'Admin A only') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.c.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.c.storeA})`;
    const adminA: Actor = { personId: p!.id, orgId: f.c.orgId };
    await expectAllowed(() => calls.set_menu_price_A(f, adminA), 'admin scoped to A, at A');
    await expectRefused(f, () => calls.set_menu_price_B(f, adminA), 'set_menu_price');
  });
  it('positive: admin and super_admin may set a price at either store', async () => {
    const f = await fx('i12-pp');
    await expectAllowed(() => calls.set_menu_price_A(f, f.c.admin), 'admin at A');
    const g = await fx('i12-pp2');
    await expectAllowed(() => calls.set_menu_price_B(g, g.c.superAdmin), 'super_admin at B');
  });
});

describe('I12 -- set_menu_depletion: a manager MAY; staff may not', () => {
  it('positive: a manager may set a depletion rule (mutant: the cell wired like manage_menu)', async () => {
    const f = await fx('i12-d');
    await expectAllowed(() => calls.set_menu_depletion(f, f.c.manager), 'manager setDepletionRule');
    await expectAllowed(() => calls.set_menu_depletion(f, f.c.admin), 'admin setDepletionRule');
  });
  it('staff is refused with set_menu_depletion', async () => {
    const f = await fx('i12-ds');
    await expectRefused(f, () => calls.set_menu_depletion(f, f.c.staff), 'set_menu_depletion');
  });
});

describe('I12 -- view_menu: admin, super-admin, manager read; staff does not (proven through authorize itself)', () => {
  it('manager, admin and super_admin pass; staff is refused with view_menu', async () => {
    const f = await fx('i12-v');
    for (const [who, a] of [['manager', f.c.manager], ['admin', f.c.admin], ['super_admin', f.c.superAdmin]] as const) {
      const r = await attempt(() => asOrg(f.c.orgId, (tx) => authorize(tx, a, cap('view_menu'))));
      expect(r.failed, `${who} refused view_menu: ${r.message}`).toBe(false);
    }
    const r = await attempt(() => asOrg(f.c.orgId, (tx) => authorize(tx, f.c.staff, cap('view_menu'))));
    expect(r.failed, 'staff was allowed view_menu').toBe(true);
    expect(r.error).toBeInstanceOf(AuthorizationError);
  });
});
