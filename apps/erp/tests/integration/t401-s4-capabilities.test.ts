import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Actor } from '@shareat/auth';
import { cast, expectSentenceError, fd, rawItem, rawOption, rawRule, run, sql, uid, type Cast } from './t401-s4-common';

/**
 * T-401 S4 (TESTER) - every server action refuses an actor who lacks its capability, WRITES NOTHING, and shows a sentence;
 * and the same action succeeds for an actor who holds it (docs/decisions/CAPABILITY-MATRIX.md: every tick has a cross that fires).
 * The contract (action names, fields, paths, wording) is pinned in the header of t401-s4-common.ts.
 *
 * Red today: `apps/erp/src/app/menu/**` does not exist, so every case fails with "Failed to resolve import" / "is not exported".
 *
 * Matrix (columns super admin / admin / manager / staff, CAPABILITY-MATRIX.md rows 159-165):
 *   manage_menu          categories, item edits, option groups, links, package refills      SA admin   - -
 *   add_menu_item        createItem, addVariant, approve / duplicate / reject                SA only (admin REFUSED, Ian Q2)
 *   set_menu_depletion   depletion rule                                                       SA admin   - -   (manager REFUSED: Ian "only admin edits recipes")
 *   set_menu_price       offers, option offers (STORE scoped)                                 SA admin manager(own store) -; staff only by position grant at ONE store
 *   request_menu_item    submit / withdraw a request (STORE scoped)                           SA admin manager(own store) -
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const n = async (q: PromiseLike<readonly Record<string, unknown>[]>): Promise<number> => Number((await q)[0]!['n']);

interface Attempt {
  who: Actor;
  label: string;
  form: FormData;
}
interface Case {
  name: string;
  load: () => Promise<Record<string, unknown>>;
  action: string;
  /** the page the person lands on, success or refusal */
  path: (ctx: Ctx) => string;
  refused: (ctx: Ctx) => Attempt[];
  allowed: (ctx: Ctx) => Attempt[];
  /** the rows that must not move on a refusal and move by allowed.length on success */
  rows: (ctx: Ctx) => Promise<number>;
}

interface Ctx {
  c: Cast;
  itemId: string;
  variantId: string; // has a depletion rule
  variant2: string; // has a depletion rule
  variantNoRule: string;
  catEmpty: string;
  groupId: string;
  valueId: string;
  valueId2: string;
  pkgItem: string;
  pkgVariant: string;
  refillItem: string;
  open: { a: string[]; b: string[]; c: string[]; d: string[]; w: string[] }; // open request ids per case
}

const MENU_ACTIONS = () => import('../../src/app/menu/actions');
const ITEM_ACTIONS = () => import('../../src/app/menu/items/[id]/actions');
const PRICE_ACTIONS = () => import('../../src/app/menu/prices/actions');
const REQUEST_ACTIONS = () => import('../../src/app/menu/requests/actions');

let shared: Promise<Ctx> | null = null;
function ctx(): Promise<Ctx> {
  shared ??= (async () => {
    const c = await cast('s4cap');
    const item = await rawItem(c, 'a_la_carte', uid('Pork Belly'));
    await rawRule(c, item.variantId);
    const second = await rawItem(c, 'a_la_carte', uid('Chicken'));
    await rawRule(c, second.variantId);
    const noRule = await rawItem(c, 'a_la_carte', uid('Tea'));
    const [cat] = await sql<{ id: string }[]>`insert into menu_categories (org_id, name, status, created_by) values (${c.orgId}, ${uid('Empty')}, 'active', ${c.admin.personId}) returning id`;
    const opt = await rawOption(c);
    const [v2] = await sql<{ id: string }[]>`
      insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${c.orgId}, ${opt.groupId}, ${uid('Val2')}, 1, 'active', ${c.admin.personId}) returning id`;
    const pkg = await rawItem(c, 'package', uid('Unli'));
    const refill = await rawItem(c, 'refill', uid('Rice'));
    const mkReq = async (name: string, who: Actor, store: string): Promise<string> =>
      (await sql<{ id: string }[]>`
        insert into menu_item_requests (org_id, store_id, requested_by, name, item_type, created_by) values (${c.orgId}, ${store}, ${who.personId}, ${name}, 'a_la_carte', ${who.personId}) returning id`)[0]!.id;
    return {
      c,
      itemId: item.itemId,
      variantId: item.variantId,
      variant2: second.variantId,
      variantNoRule: noRule.variantId,
      catEmpty: cat!.id,
      groupId: opt.groupId,
      valueId: opt.valueId,
      valueId2: v2!.id,
      pkgItem: pkg.itemId,
      pkgVariant: pkg.variantId,
      refillItem: refill.itemId,
      open: {
        a: [await mkReq(uid('ReqA1'), c.manager, c.storeA), await mkReq(uid('ReqA2'), c.manager, c.storeA)],
        b: [await mkReq(uid('ReqB1'), c.manager, c.storeA), await mkReq(uid('ReqB2'), c.manager, c.storeA)],
        c: [await mkReq(uid('ReqC1'), c.manager, c.storeA), await mkReq(uid('ReqC2'), c.manager, c.storeA)],
        d: [await mkReq(uid('ReqD1'), c.manager, c.storeA), await mkReq(uid('ReqD2'), c.manager, c.storeA)],
        w: [await mkReq(uid('ReqW1'), c.manager, c.storeA), await mkReq(uid('ReqW2'), c.manager, c.storeA)],
      },
    };
  })();
  return shared;
}

const P_MENU = () => '/menu';
const P_ITEM = (x: Ctx) => `/menu/items/${x.itemId}`;
const P_PRICES = () => '/menu/prices';
const P_REQ = () => '/menu/requests';
const orgCount = (table: string) => async (x: Ctx) => n(sql`select count(*)::int as n from ${sql(table)} where org_id = ${x.c.orgId}`);

const cases: Case[] = [
  // ------------------------------------------------------------------------------------------------ manage_menu
  {
    name: 'createCategoryAction (manage_menu)',
    load: MENU_ACTIONS, action: 'createCategoryAction', path: P_MENU, rows: orgCount('menu_categories'),
    refused: (x) => [
      { who: x.c.manager, label: 'manager', form: fd({ name: uid('NoCat') }) },
      { who: x.c.staff, label: 'staff', form: fd({ name: uid('NoCat') }) },
    ],
    allowed: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ name: uid('Cat') }) },
      { who: x.c.superAdmin, label: 'super admin', form: fd({ name: uid('Cat') }) },
    ],
  },
  {
    name: 'editCategoryAction (manage_menu)',
    load: MENU_ACTIONS, action: 'editCategoryAction', path: P_MENU,
    rows: async (x) => n(sql`select count(*)::int as n from menu_categories where org_id = ${x.c.orgId} and name like 'Renamed cat%'`),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ id: x.catEmpty, name: 'Renamed cat by manager' }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ id: x.catEmpty, name: 'Renamed cat by admin' }) }],
  },
  {
    name: 'retireCategoryAction (manage_menu)',
    load: MENU_ACTIONS, action: 'retireCategoryAction', path: P_MENU,
    rows: async (x) => n(sql`select count(*)::int as n from menu_categories where org_id = ${x.c.orgId} and status = 'retired'`),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ id: x.catEmpty }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ id: x.catEmpty }) }],
  },
  {
    name: 'editItemAction (manage_menu)',
    load: ITEM_ACTIONS, action: 'editItemAction', path: P_ITEM,
    rows: async (x) => n(sql`select count(*)::int as n from menu_items where org_id = ${x.c.orgId} and description = 'edited'`),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, description: 'edited' }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, description: 'edited' }) }],
  },
  {
    name: 'createOptionGroupAction (manage_menu)',
    load: ITEM_ACTIONS, action: 'createOptionGroupAction', path: P_ITEM, rows: orgCount('menu_option_groups'),
    refused: (x) => [
      { who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, name: uid('G'), selectionMode: 'single', minSelections: '1', maxSelections: '1' }) },
    ],
    allowed: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, name: uid('G'), selectionMode: 'single', minSelections: '1', maxSelections: '1' }) },
    ],
  },
  {
    name: 'editOptionGroupAction (manage_menu)',
    load: ITEM_ACTIONS, action: 'editOptionGroupAction', path: P_ITEM,
    rows: async (x) => n(sql`select count(*)::int as n from menu_option_groups where org_id = ${x.c.orgId} and name = 'Renamed group'`),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, id: x.groupId, name: 'Renamed group' }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, id: x.groupId, name: 'Renamed group' }) }],
  },
  {
    name: 'addOptionValueAction (manage_menu)',
    load: ITEM_ACTIONS, action: 'addOptionValueAction', path: P_ITEM, rows: orgCount('menu_option_values'),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, optionGroupId: x.groupId, name: uid('V') }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, optionGroupId: x.groupId, name: uid('V') }) }],
  },
  {
    name: 'editOptionValueAction (manage_menu)',
    load: ITEM_ACTIONS, action: 'editOptionValueAction', path: P_ITEM,
    rows: async (x) => n(sql`select count(*)::int as n from menu_option_values where org_id = ${x.c.orgId} and name = 'Renamed value'`),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, id: x.valueId, name: 'Renamed value' }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, id: x.valueId, name: 'Renamed value' }) }],
  },
  {
    name: 'linkOptionGroupAction (manage_menu)',
    load: ITEM_ACTIONS, action: 'linkOptionGroupAction', path: P_ITEM, rows: orgCount('menu_option_group_links'),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, optionGroupId: x.groupId }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, optionGroupId: x.groupId }) }],
  },
  {
    name: 'setPackageRefillsAction (manage_menu)',
    load: ITEM_ACTIONS, action: 'setPackageRefillsAction', path: (x) => `/menu/items/${x.pkgItem}`, rows: orgCount('menu_package_refills'),
    refused: (x) => [{ who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.pkgItem, packageVariantId: x.pkgVariant, refillItemIds: [x.refillItem] }) }],
    allowed: (x) => [{ who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.pkgItem, packageVariantId: x.pkgVariant, refillItemIds: [x.refillItem] }) }],
  },
  // ------------------------------------------------------------------------------------------------ add_menu_item (super admin only)
  {
    name: 'createItemAction (add_menu_item: admin REFUSED, super admin allowed)',
    load: MENU_ACTIONS, action: 'createItemAction', path: P_MENU, // the success path is /menu/items/<id>; asserted separately in the catalog test
    rows: orgCount('menu_items'),
    refused: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ categoryId: x.c.categoryId, name: uid('NoItem'), itemType: 'a_la_carte' }) },
      { who: x.c.manager, label: 'manager', form: fd({ categoryId: x.c.categoryId, name: uid('NoItem'), itemType: 'a_la_carte' }) },
    ],
    allowed: (x) => [{ who: x.c.superAdmin, label: 'super admin', form: fd({ categoryId: x.c.categoryId, name: uid('Item'), itemType: 'a_la_carte' }) }],
  },
  {
    name: 'addVariantAction (add_menu_item: admin REFUSED, super admin allowed)',
    load: ITEM_ACTIONS, action: 'addVariantAction', path: P_ITEM, rows: orgCount('menu_item_variants'),
    refused: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, label: uid('NoVar') }) },
      { who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, label: uid('NoVar') }) },
    ],
    allowed: (x) => [{ who: x.c.superAdmin, label: 'super admin', form: fd({ menuItemId: x.itemId, label: uid('Large') }) }],
  },
  {
    name: 'approveItemRequestAction (add_menu_item: admin and manager REFUSED)',
    load: REQUEST_ACTIONS, action: 'approveItemRequestAction', path: P_REQ,
    rows: async (x) => n(sql`select count(*)::int as n from menu_item_requests where org_id = ${x.c.orgId} and status = 'approved'`),
    refused: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ id: x.open.a[0]!, categoryId: x.c.categoryId }) },
      { who: x.c.manager, label: 'manager', form: fd({ id: x.open.a[0]!, categoryId: x.c.categoryId }) },
    ],
    allowed: (x) => [{ who: x.c.superAdmin, label: 'super admin', form: fd({ id: x.open.a[0]!, categoryId: x.c.categoryId }) }],
  },
  {
    name: 'markItemRequestDuplicateAction (add_menu_item: admin and manager REFUSED)',
    load: REQUEST_ACTIONS, action: 'markItemRequestDuplicateAction', path: P_REQ,
    rows: async (x) => n(sql`select count(*)::int as n from menu_item_requests where org_id = ${x.c.orgId} and status = 'duplicate'`),
    refused: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ id: x.open.b[0]!, itemId: x.itemId }) },
      { who: x.c.manager, label: 'manager', form: fd({ id: x.open.b[0]!, itemId: x.itemId }) },
    ],
    allowed: (x) => [{ who: x.c.superAdmin, label: 'super admin', form: fd({ id: x.open.b[0]!, itemId: x.itemId }) }],
  },
  {
    name: 'rejectItemRequestAction (add_menu_item: admin and manager REFUSED)',
    load: REQUEST_ACTIONS, action: 'rejectItemRequestAction', path: P_REQ,
    rows: async (x) => n(sql`select count(*)::int as n from menu_item_requests where org_id = ${x.c.orgId} and status = 'rejected'`),
    refused: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ id: x.open.c[0]!, note: 'we already sell it' }) },
      { who: x.c.manager, label: 'manager', form: fd({ id: x.open.c[0]!, note: 'we already sell it' }) },
    ],
    allowed: (x) => [{ who: x.c.superAdmin, label: 'super admin', form: fd({ id: x.open.c[0]!, note: 'we already sell it' }) }],
  },
  // ------------------------------------------------------------------------------------------------ set_menu_depletion (admin yes, manager NO)
  {
    name: 'setDepletionRuleAction (set_menu_depletion: manager REFUSED)',
    load: ITEM_ACTIONS, action: 'setDepletionRuleAction', path: P_ITEM, rows: orgCount('menu_depletion_rules'),
    refused: (x) => [
      { who: x.c.manager, label: 'manager', form: fd({ menuItemId: x.itemId, variantId: x.variantNoRule, mode: 'direct', stockItemId: x.c.stockItemId, quantityPerSale: '0.25' }) },
      { who: x.c.staff, label: 'staff', form: fd({ menuItemId: x.itemId, variantId: x.variantNoRule, mode: 'direct', stockItemId: x.c.stockItemId, quantityPerSale: '0.25' }) },
    ],
    allowed: (x) => [
      { who: x.c.admin, label: 'admin', form: fd({ menuItemId: x.itemId, variantId: x.variantNoRule, mode: 'direct', stockItemId: x.c.stockItemId, quantityPerSale: '0.25' }) },
    ],
  },
  // ------------------------------------------------------------------------------------------------ set_menu_price (STORE scoped)
  {
    name: 'setPriceAction (set_menu_price: store scoped; a position grant at A does not reach B)',
    load: PRICE_ACTIONS, action: 'setPriceAction', path: P_PRICES, rows: orgCount('menu_offers'),
    refused: (x) => [
      { who: x.c.staff, label: 'staff at A', form: fd({ storeId: x.c.storeA, variantId: x.variantId, channel: 'store', amount: '50.00' }) },
      { who: x.c.managerA, label: 'manager scoped to A, at B', form: fd({ storeId: x.c.storeB, variantId: x.variantId, channel: 'store', amount: '50.00' }) },
      { who: x.c.grantedStaff, label: 'staff granted set_menu_price at A, at B', form: fd({ storeId: x.c.storeB, variantId: x.variantId, channel: 'store', amount: '50.00' }) },
    ],
    allowed: (x) => [
      { who: x.c.managerA, label: 'manager scoped to A, at A', form: fd({ storeId: x.c.storeA, variantId: x.variantId, channel: 'store', amount: '50.00' }) },
      { who: x.c.grantedStaff, label: 'staff granted at A, at A', form: fd({ storeId: x.c.storeA, variantId: x.variant2, channel: 'store', amount: '40.00' }) },
      { who: x.c.admin, label: 'admin at B', form: fd({ storeId: x.c.storeB, variantId: x.variantId, channel: 'store', amount: '55.00' }) },
    ],
  },
  {
    name: 'withdrawPriceAction (set_menu_price: store scoped)',
    load: PRICE_ACTIONS, action: 'withdrawPriceAction', path: P_PRICES,
    rows: async (x) => n(sql`select count(*)::int as n from menu_offers where org_id = ${x.c.orgId} and withdrawn`),
    refused: (x) => [
      { who: x.c.staff, label: 'staff', form: fd({ storeId: x.c.storeA, variantId: x.variantId, channel: 'store' }) },
      { who: x.c.managerA, label: 'manager scoped to A, at B', form: fd({ storeId: x.c.storeB, variantId: x.variantId, channel: 'store' }) },
    ],
    allowed: (x) => [{ who: x.c.managerA, label: 'manager at A', form: fd({ storeId: x.c.storeA, variantId: x.variantId, channel: 'store' }) }],
  },
  {
    name: 'setOptionPriceAction (set_menu_price: store scoped)',
    load: PRICE_ACTIONS, action: 'setOptionPriceAction', path: P_PRICES, rows: orgCount('menu_option_offers'),
    refused: (x) => [
      { who: x.c.staff, label: 'staff', form: fd({ storeId: x.c.storeA, optionValueId: x.valueId, channel: 'store', priceDelta: '5.00' }) },
      { who: x.c.managerA, label: 'manager scoped to A, at B', form: fd({ storeId: x.c.storeB, optionValueId: x.valueId, channel: 'store', priceDelta: '5.00' }) },
    ],
    allowed: (x) => [{ who: x.c.managerA, label: 'manager at A', form: fd({ storeId: x.c.storeA, optionValueId: x.valueId, channel: 'store', priceDelta: '5.00' }) }],
  },
  // ------------------------------------------------------------------------------------------------ request_menu_item (STORE scoped)
  {
    name: 'submitItemRequestAction (request_menu_item: store scoped; staff refused)',
    load: REQUEST_ACTIONS, action: 'submitItemRequestAction', path: P_REQ, rows: orgCount('menu_item_requests'),
    refused: (x) => [
      { who: x.c.staff, label: 'staff', form: fd({ storeId: x.c.storeA, name: uid('NoReq'), itemType: 'a_la_carte', confirmed: '1' }) },
      { who: x.c.managerA, label: 'manager scoped to A, at B', form: fd({ storeId: x.c.storeB, name: uid('NoReq'), itemType: 'a_la_carte', confirmed: '1' }) },
    ],
    allowed: (x) => [{ who: x.c.managerA, label: 'manager at A', form: fd({ storeId: x.c.storeA, name: uid('Req'), itemType: 'a_la_carte', confirmed: '1' }) }],
  },
  {
    name: 'withdrawItemRequestAction (the requester only; another manager and staff refused)',
    load: REQUEST_ACTIONS, action: 'withdrawItemRequestAction', path: P_REQ,
    rows: async (x) => n(sql`select count(*)::int as n from menu_item_requests where org_id = ${x.c.orgId} and status = 'withdrawn'`),
    refused: (x) => [
      { who: x.c.manager2, label: 'another manager', form: fd({ id: x.open.w[0]! }) },
      { who: x.c.staff, label: 'staff', form: fd({ id: x.open.w[0]! }) },
    ],
    allowed: (x) => [{ who: x.c.manager, label: 'the requester', form: fd({ id: x.open.w[0]! }) }],
  },
];

describe.each(cases)('$name', (tc) => {
  it('every actor without the capability is shown a sentence, lands back on the page, and NOTHING is written', async () => {
    const x = await ctx();
    for (const a of tc.refused(x)) {
      const before = await tc.rows(x);
      const out = await run(tc.load, tc.action, a.who, a.form);
      expectSentenceError(out.flash.error, `${tc.action} as ${a.label}`);
      expect(out.flash.ok, `${tc.action} as ${a.label}: a refusal must not also say ok`).toBeUndefined();
      expect(out.path, `${tc.action} as ${a.label}: lands on the page`).toBe(tc.path(x));
      expect(await tc.rows(x), `${tc.action} as ${a.label}: rows changed on a refusal`).toBe(before);
    }
  });

  it('control: an actor who holds the capability succeeds and exactly the expected rows are written', async () => {
    const x = await ctx();
    for (const a of tc.allowed(x)) {
      const before = await tc.rows(x);
      const out = await run(tc.load, tc.action, a.who, a.form);
      expect(out.flash.error, `${tc.action} as ${a.label}`).toBeUndefined();
      expect(out.flash.ok, `${tc.action} as ${a.label}: an ok banner`).toBeTruthy();
      // createItemAction lands on the new item's own page, everything else on the page it was submitted from
      if (tc.action !== 'createItemAction') expect(out.path).toBe(tc.path(x));
      else expect(out.path).toMatch(/^\/menu\/items\/[0-9a-f-]{36}$/);
      expect(await tc.rows(x), `${tc.action} as ${a.label}: one new row`).toBe(before + 1);
    }
  });
});

describe('information is not leaked to someone who may not ask', () => {
  it('submitItemRequestAction: staff typing the name of an existing item is refused WITHOUT the duplicate warning naming it', async () => {
    const x = await ctx();
    const [it] = await sql<{ name: string }[]>`select name from menu_items where id = ${x.itemId}`;
    const out = await run(REQUEST_ACTIONS, 'submitItemRequestAction', x.c.staff, fd({ storeId: x.c.storeA, name: it!.name, itemType: 'a_la_carte' }));
    expect(out.flash.error, 'staff are refused').toBeTruthy();
    expect(out.flash.warning, 'no match list for someone refused').toBeUndefined();
    expect(JSON.stringify(out.flash)).not.toContain(it!.name);
  });
});
