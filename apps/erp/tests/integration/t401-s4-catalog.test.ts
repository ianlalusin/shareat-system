import { afterAll, describe, expect, it, vi } from 'vitest';

import { setMenuOffer } from '@shareat/domain';
import { asOrg, cast, expectAccessRefused, expectSentenceError, fd, plain, rawItem, rawRule, render, run, sql, type Cast } from './t401-s4-common';

/**
 * T-401 S4 (TESTER) - /menu (items by category, filters, inline categories) and /menu/items/[id] (variants, option groups
 * edited inline, depletion rule, package refills, offer history). Contract: header of t401-s4-common.ts.
 * Red today: `apps/erp/src/app/menu/**` does not exist.
 *
 * Mutants: category retire only warned and then retired; the warning counts retired items; `filter=no_rule` also lists items
 * that have a rule; an admin is offered "Add item"; a manager is offered the category controls; item page of another org opens;
 * an inline group is created but not attached to the item; an empty refill selection means "all refills".
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

const MENU_ACTIONS = () => import('../../src/app/menu/actions');
const ITEM_ACTIONS = () => import('../../src/app/menu/items/[id]/actions');
const MENU_PAGE = () => import('../../src/app/menu/page');
const ITEM_PAGE = () => import('../../src/app/menu/items/[id]/page');

const n = async (q: PromiseLike<readonly Record<string, unknown>[]>): Promise<number> => Number((await q)[0]!['n']);

async function category(c: Cast, name: string): Promise<string> {
  return (await sql<{ id: string }[]>`insert into menu_categories (org_id, name, status, created_by) values (${c.orgId}, ${name}, 'active', ${c.admin.personId}) returning id`)[0]!.id;
}
async function itemIn(c: Cast, categoryId: string, name: string, type: 'a_la_carte' | 'package' | 'refill' = 'a_la_carte', status = 'active'): Promise<{ itemId: string; variantId: string }> {
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${c.orgId}, ${categoryId}, ${name}, ${type}, ${type === 'a_la_carte'}, false, true, 0, ${status}, ${c.admin.personId}) returning id`;
  const [v] = await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by) values (${c.orgId}, ${item!.id}, null, true, 0, ${status}, ${c.admin.personId}) returning id`;
  return { itemId: item!.id, variantId: v!.id };
}

/** Meat (Pork Belly a la carte WITH a rule and an offer at A, Unli Pork package, Rice Refill) and Drinks (Iced Tea, no rule). */
async function menuWorld(hint: string) {
  const c = await cast(`s4cat-${hint}`);
  const meat = await category(c, 'Meat');
  const drinks = await category(c, 'Drinks');
  const pork = await itemIn(c, meat, 'Pork Belly');
  const unli = await itemIn(c, meat, 'Unli Pork', 'package');
  const rice = await itemIn(c, meat, 'Rice Refill', 'refill');
  const tea = await itemIn(c, drinks, 'Iced Tea');
  await rawRule(c, pork.variantId);
  await rawRule(c, unli.variantId);
  await asOrg(c.orgId, (tx) => setMenuOffer(c.admin, { storeId: c.storeA, variantId: pork.variantId, channel: 'store', amount: '85.50' }, tx));
  return { c, meat, drinks, pork, unli, rice, tea };
}

// =====================================================================================================================
describe('/menu - items by category, filters, who sees which controls', () => {
  it('lists each category as a heading with its items under it, each item linking to /menu/items/<id>', async () => {
    const w = await menuWorld('list');
    const html = await render(MENU_PAGE, w.c.admin, {});
    const t = plain(html);
    for (const name of ['Meat', 'Drinks', 'Pork Belly', 'Unli Pork', 'Rice Refill', 'Iced Tea']) expect(t, name).toContain(name);
    expect(t.indexOf('Meat')).toBeLessThan(t.indexOf('Pork Belly'));
    expect(t.indexOf('Pork Belly'), 'Pork Belly is under Meat, before Drinks').toBeLessThan(t.indexOf('Drinks'));
    expect(html).toContain(`href="/menu/items/${w.pork.itemId}"`);
  });

  it('filters: type=package, filter=no_rule, filter=not_offered&store=A', async () => {
    const w = await menuWorld('filt');
    const pkg = plain(await render(MENU_PAGE, w.c.admin, { search: { type: 'package' } }));
    expect(pkg).toContain('Unli Pork');
    expect(pkg).not.toContain('Pork Belly');
    expect(pkg).not.toContain('Iced Tea');

    const noRule = plain(await render(MENU_PAGE, w.c.admin, { search: { filter: 'no_rule' } }));
    expect(noRule, 'items without any depletion rule').toContain('Iced Tea');
    expect(noRule).toContain('Rice Refill');
    expect(noRule, 'items that have a rule are hidden').not.toContain('Pork Belly');
    expect(noRule).not.toContain('Unli Pork');

    const notOffered = plain(await render(MENU_PAGE, w.c.admin, { search: { filter: 'not_offered', store: w.c.storeA } }));
    expect(notOffered, 'Pork Belly is offered at A, so it is hidden').not.toContain('Pork Belly');
    expect(notOffered).toContain('Iced Tea');
    const atB = plain(await render(MENU_PAGE, w.c.admin, { search: { filter: 'not_offered', store: w.c.storeB } }));
    expect(atB, 'at B nothing is offered, so Pork Belly shows').toContain('Pork Belly');
  });

  it('staff are shown the access-refused card naming view_menu; a manager may read', async () => {
    const w = await menuWorld('gate');
    expectAccessRefused(await render(MENU_PAGE, w.c.staff, {}), 'view_menu');
    expect(plain(await render(MENU_PAGE, w.c.manager, {}))).toContain('Pork Belly');
  });

  it('controls follow the capabilities: category controls for admin, "Add item" for super admin only, manager read-only with "Request an item"', async () => {
    const w = await menuWorld('ctl');
    const sa = plain(await render(MENU_PAGE, w.c.superAdmin, {}));
    const ad = plain(await render(MENU_PAGE, w.c.admin, {}));
    const mg = plain(await render(MENU_PAGE, w.c.manager, {}));
    expect(sa).toContain('Add category');
    expect(sa).toContain('Add item');
    expect(ad, 'admin edits categories').toContain('Add category');
    expect(ad, 'admin does NOT add items (Ian Q2)').not.toContain('Add item');
    expect(mg, 'manager has no category controls').not.toContain('Add category');
    expect(mg).not.toContain('Add item');
    expect(mg).toContain('Request an item');
  });

  it('the page warns "Holds N active items" beside a category that still holds active items, and not for an empty one', async () => {
    const w = await menuWorld('warn');
    const t = plain(await render(MENU_PAGE, w.c.admin, {}));
    expect(t).toContain('Holds 3 active items'); // Meat
    expect(t).toContain('Holds 1 active item'); // Drinks (singular)
    await category(w.c, 'Empty shelf');
    const t2 = plain(await render(MENU_PAGE, w.c.admin, {}));
    const after = t2.slice(t2.indexOf('Empty shelf'));
    expect(after.slice(0, 80), 'no warning on an empty category').not.toMatch(/Holds/);
  });
});

// =====================================================================================================================
describe('inline category edits', () => {
  it('createCategoryAction adds a category ("Category added."), refuses a duplicate name (any case) and a blank one in a sentence', async () => {
    const c = await cast('s4cat-new');
    const ok = await run(MENU_ACTIONS, 'createCategoryAction', c.admin, fd({ name: 'Soups' }));
    expect(ok.flash.ok).toBe('Category added.');
    expect(ok.path).toBe('/menu');
    expect(await n(sql`select count(*)::int as n from menu_categories where org_id = ${c.orgId} and name = 'Soups' and status = 'active'`)).toBe(1);

    const dup = await run(MENU_ACTIONS, 'createCategoryAction', c.admin, fd({ name: 'soups' }));
    expectSentenceError(dup.flash.error, 'duplicate category');
    const blank = await run(MENU_ACTIONS, 'createCategoryAction', c.admin, fd({ name: '   ' }));
    expectSentenceError(blank.flash.error, 'blank category');
    expect(await n(sql`select count(*)::int as n from menu_categories where org_id = ${c.orgId} and lower(name) = 'soups'`)).toBe(1);
  });

  it('editCategoryAction renames and re-sorts ("Category saved."); renaming onto another category is refused', async () => {
    const c = await cast('s4cat-edit');
    const id = await category(c, 'Dessert');
    await category(c, 'Drinks');
    const ok = await run(MENU_ACTIONS, 'editCategoryAction', c.admin, fd({ id, name: 'Desserts', sortOrder: '5' }));
    expect(ok.flash.ok).toBe('Category saved.');
    const [row] = await sql<{ name: string; sort_order: number }[]>`select name, sort_order from menu_categories where id = ${id}`;
    expect(row).toMatchObject({ name: 'Desserts', sort_order: 5 });
    const clash = await run(MENU_ACTIONS, 'editCategoryAction', c.admin, fd({ id, name: 'drinks' }));
    expectSentenceError(clash.flash.error, 'rename onto another');
    expect((await sql<{ name: string }[]>`select name from menu_categories where id = ${id}`)[0]!.name).toBe('Desserts');
  });

  it('retireCategoryAction retires an empty category ("Category retired.")', async () => {
    const c = await cast('s4cat-retire');
    const id = await category(c, 'Seasonal');
    // T-412: retiring a category asks for its name (the server compares it with the name it loads).
    const out = await run(MENU_ACTIONS, 'retireCategoryAction', c.admin, fd({ id, confirmName: 'Seasonal' }));
    expect(out.flash.ok).toBe('Category retired.');
    expect((await sql<{ status: string }[]>`select status from menu_categories where id = ${id}`)[0]!.status).toBe('retired');
  });

  it('retiring a category that still holds active items is refused in a sentence about the items, and it stays active (S3 ruling)', async () => {
    const w = await menuWorld('retire-held');
    const out = await run(MENU_ACTIONS, 'retireCategoryAction', w.c.admin, fd({ id: w.meat, confirmName: 'Meat' }));
    expectSentenceError(out.flash.error, 'retire a category holding items');
    expect(out.flash.error).toMatch(/item/i);
    expect((await sql<{ status: string }[]>`select status from menu_categories where id = ${w.meat}`)[0]!.status).toBe('active');
  });

  it('an item that is itself retired does not stop the retire, and "Holds" counts ACTIVE items only', async () => {
    const c = await cast('s4cat-retired-item');
    const cat = await category(c, 'Old stuff');
    await itemIn(c, cat, 'Gone Dish', 'a_la_carte', 'retired');
    const t = plain(await render(MENU_PAGE, c.admin, {}));
    expect(t.slice(t.indexOf('Old stuff'), t.indexOf('Old stuff') + 80)).not.toMatch(/Holds [1-9]/);
    const out = await run(MENU_ACTIONS, 'retireCategoryAction', c.admin, fd({ id: cat, confirmName: 'Old stuff' }));
    expect(out.flash.ok).toBe('Category retired.');
  });
});

// =====================================================================================================================
describe('createItemAction (super admin) lands on the new item', () => {
  it('creates the item and its default variant and redirects to /menu/items/<id> with "Item added."', async () => {
    const c = await cast('s4cat-additem');
    const out = await run(MENU_ACTIONS, 'createItemAction', c.superAdmin, fd({ categoryId: c.categoryId, name: 'Beef Tapa', itemType: 'a_la_carte', description: 'Cured beef' }));
    expect(out.flash.ok).toBe('Item added.');
    const [item] = await sql<{ id: string; description: string | null }[]>`select id, description from menu_items where org_id = ${c.orgId} and name = 'Beef Tapa'`;
    expect(item!.description).toBe('Cured beef');
    expect(out.path).toBe(`/menu/items/${item!.id}`);
    expect(await n(sql`select count(*)::int as n from menu_item_variants where menu_item_id = ${item!.id} and is_default`)).toBe(1);
  });

  it('a duplicate name of the same type is refused in a sentence; the same name as another type is allowed (I8)', async () => {
    const c = await cast('s4cat-additem2');
    await run(MENU_ACTIONS, 'createItemAction', c.superAdmin, fd({ categoryId: c.categoryId, name: 'Pork', itemType: 'a_la_carte' }));
    const dup = await run(MENU_ACTIONS, 'createItemAction', c.superAdmin, fd({ categoryId: c.categoryId, name: 'pork', itemType: 'a_la_carte' }));
    expectSentenceError(dup.flash.error, 'duplicate item');
    const refill = await run(MENU_ACTIONS, 'createItemAction', c.superAdmin, fd({ categoryId: c.categoryId, name: 'Pork', itemType: 'refill' }));
    expect(refill.flash.ok).toBe('Item added.');
  });
});

// =====================================================================================================================
describe('/menu/items/[id]', () => {
  it('shows the item, its variants, per-store offer history with a scheduled change, and the depletion history with the stock item NAME', async () => {
    const w = await menuWorld('item');
    const [stock] = await sql<{ name: string }[]>`select name from items where id = ${w.c.stockItemId}`;
    await sql`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by) values (${w.c.orgId}, ${w.pork.itemId}, 'Large', false, 1, 'active', ${w.c.admin.personId})`;
    await asOrg(w.c.orgId, (tx) => setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.pork.variantId, channel: 'store', amount: '90.00' }, tx));
    await asOrg(w.c.orgId, (tx) => setMenuOffer(w.c.admin, { storeId: w.c.storeA, variantId: w.pork.variantId, channel: 'store', amount: '95.00', effectiveFrom: new Date('2030-06-01T00:00:00Z') }, tx));
    await sql`
      insert into menu_depletion_rules (org_id, variant_id, mode, item_id, quantity_per_sale, created_by)
      values (${w.c.orgId}, ${w.tea.variantId}, 'direct', ${w.c.stockItemId}, 0.25, ${w.c.admin.personId})`;
    const html = await render(ITEM_PAGE, w.c.admin, { params: { id: w.pork.itemId } });
    const t = plain(html);
    expect(t).toContain('Pork Belly');
    expect(t).toContain('Large');
    for (const price of ['85.50', '90.00', '95.00']) expect(t, `offer history shows ${price}`).toContain(price);
    expect(t).toContain('Lipa');

    const tea = plain(await render(ITEM_PAGE, w.c.admin, { params: { id: w.tea.itemId } }));
    expect(tea, 'depletion history names the stock item').toContain(stock!.name);
  });

  it('an unknown id and ANOTHER org\'s item are not found; staff are refused; a manager can read', async () => {
    const w = await menuWorld('item-gate');
    const other = await menuWorld('item-other');
    await expect(render(ITEM_PAGE, w.c.admin, { params: { id: '00000000-0000-4000-8000-000000000000' } })).rejects.toThrow(/NEXT_NOT_FOUND/);
    await expect(render(ITEM_PAGE, w.c.admin, { params: { id: other.pork.itemId } })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expectAccessRefused(await render(ITEM_PAGE, w.c.staff, { params: { id: w.pork.itemId } }), 'view_menu');
    expect(plain(await render(ITEM_PAGE, w.c.manager, { params: { id: w.pork.itemId } }))).toContain('Pork Belly');
  });

  it('addVariantAction (super admin) adds a variant ("Variant added."), refuses a repeated label', async () => {
    const w = await menuWorld('variant');
    const ok = await run(ITEM_ACTIONS, 'addVariantAction', w.c.superAdmin, fd({ menuItemId: w.pork.itemId, label: 'Large' }));
    expect(ok.flash.ok).toBe('Variant added.');
    expect(ok.path).toBe(`/menu/items/${w.pork.itemId}`);
    const dup = await run(ITEM_ACTIONS, 'addVariantAction', w.c.superAdmin, fd({ menuItemId: w.pork.itemId, label: 'large' }));
    expectSentenceError(dup.flash.error, 'duplicate variant');
  });
});

// =====================================================================================================================
describe('depletion rule form (admin; the recipe)', () => {
  it('a stock-item rule from now is stored with the quantity as typed ("Depletion rule saved."); a rule scheduled for Manila midnight is stored as 16:00Z', async () => {
    const w = await menuWorld('rule');
    const ok = await run(ITEM_ACTIONS, 'setDepletionRuleAction', w.c.admin, fd({ menuItemId: w.tea.itemId, variantId: w.tea.variantId, mode: 'direct', stockItemId: w.c.stockItemId, quantityPerSale: '0.25' }));
    expect(ok.flash.ok).toBe('Depletion rule saved.');
    expect(ok.path).toBe(`/menu/items/${w.tea.itemId}`);
    const sched = await run(ITEM_ACTIONS, 'setDepletionRuleAction', w.c.admin, fd({ menuItemId: w.tea.itemId, variantId: w.tea.variantId, mode: 'direct', stockItemId: w.c.stockItemId, quantityPerSale: '0.30', effectiveFrom: '2030-12-01T00:00' }));
    expect(sched.flash.error).toBeUndefined();
    const rows = await sql<{ effective_from: Date; quantity_per_sale: string; mode: string }[]>`
      select effective_from, quantity_per_sale::text, mode from menu_depletion_rules where variant_id = ${w.tea.variantId} order by effective_from`;
    expect(rows.map((r) => r.quantity_per_sale)).toEqual(['0.250000', '0.300000']);
    expect(rows[1]!.effective_from.toISOString()).toBe('2030-11-30T16:00:00.000Z');
  });

  it('a no_stock rule and a recipe rule are accepted; seven decimals, a missing quantity, and a stock item with mode no_stock are refused in sentences', async () => {
    const w = await menuWorld('rule2');
    const base = { menuItemId: w.rice.itemId, variantId: w.rice.variantId };
    expect((await run(ITEM_ACTIONS, 'setDepletionRuleAction', w.c.admin, fd({ ...base, mode: 'no_stock' }))).flash.ok).toBe('Depletion rule saved.');
    expect((await run(ITEM_ACTIONS, 'setDepletionRuleAction', w.c.admin, fd({ ...base, mode: 'recipe', recipeId: w.c.recipeId }))).flash.ok).toBe('Depletion rule saved.');
    for (const bad of [
      { mode: 'direct', stockItemId: w.c.stockItemId, quantityPerSale: '0.1234567' },
      { mode: 'direct', stockItemId: w.c.stockItemId },
      { mode: 'no_stock', stockItemId: w.c.stockItemId },
    ]) {
      expectSentenceError((await run(ITEM_ACTIONS, 'setDepletionRuleAction', w.c.admin, fd({ ...base, ...bad }))).flash.error, JSON.stringify(bad));
    }
    expect(await n(sql`select count(*)::int as n from menu_depletion_rules where variant_id = ${w.rice.variantId}`)).toBe(2);
  });

  it('the item page offers the rule form to an admin and not to a manager (who may read)', async () => {
    const w = await menuWorld('rule-ctl');
    const admin = await render(ITEM_PAGE, w.c.admin, { params: { id: w.tea.itemId } });
    const mgr = await render(ITEM_PAGE, w.c.manager, { params: { id: w.tea.itemId } });
    expect(admin).toMatch(/name="quantityPerSale"/);
    expect(mgr).not.toMatch(/name="quantityPerSale"/);
  });
});

// =====================================================================================================================
describe('option groups edited inline', () => {
  it('createOptionGroupAction makes the group, its values AND the link to this item in one go ("Option group added.")', async () => {
    const w = await menuWorld('og');
    const out = await run(ITEM_ACTIONS, 'createOptionGroupAction', w.c.admin, fd({
      menuItemId: w.pork.itemId, name: 'Flavour', selectionMode: 'single', minSelections: '1', maxSelections: '1', values: 'Original\nSpicy\n\nGarlic\n',
    }));
    expect(out.flash.ok).toBe('Option group added.');
    expect(out.path).toBe(`/menu/items/${w.pork.itemId}`);
    const [g] = await sql<{ id: string; selection_mode: string; min_selections: number; max_selections: number }[]>`
      select id, selection_mode, min_selections, max_selections from menu_option_groups where org_id = ${w.c.orgId} and name = 'Flavour'`;
    expect(g).toMatchObject({ selection_mode: 'single', min_selections: 1, max_selections: 1 });
    const values = await sql<{ name: string }[]>`select name from menu_option_values where option_group_id = ${g!.id} order by sort_order, name`;
    expect(values.map((v) => v.name), 'blank lines are skipped').toEqual(['Original', 'Spicy', 'Garlic']);
    expect(await n(sql`select count(*)::int as n from menu_option_group_links where option_group_id = ${g!.id} and menu_item_id = ${w.pork.itemId}`), 'attached to this item').toBe(1);
    const t = plain(await render(ITEM_PAGE, w.c.admin, { params: { id: w.pork.itemId } }));
    for (const x of ['Flavour', 'Original', 'Spicy', 'Garlic']) expect(t).toContain(x);
  });

  it('a bad shape (pick-one with max 2) is refused in a sentence and writes neither the group nor the link', async () => {
    const w = await menuWorld('og-bad');
    const before = await n(sql`select count(*)::int as n from menu_option_groups where org_id = ${w.c.orgId}`);
    const out = await run(ITEM_ACTIONS, 'createOptionGroupAction', w.c.admin, fd({ menuItemId: w.pork.itemId, name: 'Broken', selectionMode: 'single', minSelections: '1', maxSelections: '2', values: 'A\nB' }));
    expectSentenceError(out.flash.error, 'single with max 2');
    expect(await n(sql`select count(*)::int as n from menu_option_groups where org_id = ${w.c.orgId}`)).toBe(before);
  });

  it('values are added, renamed and retired inline; the group is edited ("Option added." / "Option saved." / "Option group saved.")', async () => {
    const w = await menuWorld('og-edit');
    await run(ITEM_ACTIONS, 'createOptionGroupAction', w.c.admin, fd({ menuItemId: w.pork.itemId, name: 'Sauce', selectionMode: 'multi', minSelections: '0', maxSelections: '3', values: 'Soy' }));
    const [g] = await sql<{ id: string }[]>`select id from menu_option_groups where org_id = ${w.c.orgId} and name = 'Sauce'`;
    const [soy] = await sql<{ id: string }[]>`select id from menu_option_values where option_group_id = ${g!.id} and name = 'Soy'`;

    const added = await run(ITEM_ACTIONS, 'addOptionValueAction', w.c.admin, fd({ menuItemId: w.pork.itemId, optionGroupId: g!.id, name: 'Vinegar' }));
    expect(added.flash.ok).toBe('Option added.');
    const renamed = await run(ITEM_ACTIONS, 'editOptionValueAction', w.c.admin, fd({ menuItemId: w.pork.itemId, id: soy!.id, name: 'Soy Garlic' }));
    expect(renamed.flash.ok).toBe('Option saved.');
    const retired = await run(ITEM_ACTIONS, 'editOptionValueAction', w.c.admin, fd({ menuItemId: w.pork.itemId, id: soy!.id, status: 'retired' }));
    expect(retired.flash.error).toBeUndefined();
    const edited = await run(ITEM_ACTIONS, 'editOptionGroupAction', w.c.admin, fd({ menuItemId: w.pork.itemId, id: g!.id, name: 'Sauces', maxSelections: '2' }));
    expect(edited.flash.ok).toBe('Option group saved.');

    const vals = await sql<{ name: string; status: string }[]>`select name, status from menu_option_values where option_group_id = ${g!.id} order by name`;
    expect(vals).toEqual([{ name: 'Soy Garlic', status: 'retired' }, { name: 'Vinegar', status: 'active' }]);
    expect((await sql<{ name: string; max_selections: number }[]>`select name, max_selections from menu_option_groups where id = ${g!.id}`)[0]).toMatchObject({ name: 'Sauces', max_selections: 2 });

    const dup = await run(ITEM_ACTIONS, 'editOptionGroupAction', w.c.admin, fd({ menuItemId: w.pork.itemId, id: g!.id, selectionMode: 'single' }));
    expectSentenceError(dup.flash.error, 'single while max is 2');
  });

  it('a group is SHARED: attach an existing group to a second item, then detach it from that item only (flavours attach to many items, Q5)', async () => {
    const w = await menuWorld('og-share');
    await run(ITEM_ACTIONS, 'createOptionGroupAction', w.c.admin, fd({ menuItemId: w.pork.itemId, name: 'Flavour', selectionMode: 'single', minSelections: '1', maxSelections: '1', values: 'Original' }));
    const [g] = await sql<{ id: string }[]>`select id from menu_option_groups where org_id = ${w.c.orgId} and name = 'Flavour'`;

    const link = await run(ITEM_ACTIONS, 'linkOptionGroupAction', w.c.admin, fd({ menuItemId: w.tea.itemId, optionGroupId: g!.id, variantId: '' }));
    expect(link.flash.ok).toBe('Option group attached.');
    expect(link.path).toBe(`/menu/items/${w.tea.itemId}`);
    expect(await n(sql`select count(*)::int as n from menu_option_group_links where option_group_id = ${g!.id}`)).toBe(2);
    expect(plain(await render(ITEM_PAGE, w.c.admin, { params: { id: w.tea.itemId } }))).toContain('Flavour');

    const [teaLink] = await sql<{ id: string }[]>`select id from menu_option_group_links where option_group_id = ${g!.id} and menu_item_id = ${w.tea.itemId}`;
    const un = await run(ITEM_ACTIONS, 'unlinkOptionGroupAction', w.c.admin, fd({ menuItemId: w.tea.itemId, linkId: teaLink!.id }));
    expect(un.flash.ok).toBe('Option group removed.');
    expect(await n(sql`select count(*)::int as n from menu_option_group_links where option_group_id = ${g!.id} and menu_item_id = ${w.pork.itemId}`), 'the other item keeps it').toBe(1);
    expect(await n(sql`select count(*)::int as n from menu_option_groups where id = ${g!.id}`), 'the group itself survives').toBe(1);
  });

  it('a group can be attached to ONE variant (variantId given) instead of the item', async () => {
    const w = await menuWorld('og-var');
    await run(ITEM_ACTIONS, 'createOptionGroupAction', w.c.admin, fd({ menuItemId: w.pork.itemId, name: 'Doneness', selectionMode: 'single', minSelections: '0', maxSelections: '1', values: 'Rare' }));
    const [g] = await sql<{ id: string }[]>`select id from menu_option_groups where org_id = ${w.c.orgId} and name = 'Doneness'`;
    const out = await run(ITEM_ACTIONS, 'linkOptionGroupAction', w.c.admin, fd({ menuItemId: w.tea.itemId, optionGroupId: g!.id, variantId: w.tea.variantId }));
    expect(out.flash.ok).toBe('Option group attached.');
    expect(await n(sql`select count(*)::int as n from menu_option_group_links where option_group_id = ${g!.id} and variant_id = ${w.tea.variantId} and menu_item_id is null`)).toBe(1);
  });
});

// =====================================================================================================================
describe('package refills', () => {
  it('setPackageRefillsAction replaces the set ("Refills saved."); none ticked means NO refills, never all', async () => {
    const w = await menuWorld('refills');
    const rice2 = await itemIn(w.c, w.meat, 'Soup Refill', 'refill');
    const base = { menuItemId: w.unli.itemId, packageVariantId: w.unli.variantId };
    const two = await run(ITEM_ACTIONS, 'setPackageRefillsAction', w.c.admin, fd({ ...base, refillItemIds: [w.rice.itemId, rice2.itemId] }));
    expect(two.flash.ok).toBe('Refills saved.');
    expect(await n(sql`select count(*)::int as n from menu_package_refills where package_variant_id = ${w.unli.variantId}`)).toBe(2);

    await run(ITEM_ACTIONS, 'setPackageRefillsAction', w.c.admin, fd({ ...base, refillItemIds: [w.rice.itemId] }));
    expect(await n(sql`select count(*)::int as n from menu_package_refills where package_variant_id = ${w.unli.variantId}`)).toBe(1);

    const none = await run(ITEM_ACTIONS, 'setPackageRefillsAction', w.c.admin, fd({ ...base }));
    expect(none.flash.error).toBeUndefined();
    expect(await n(sql`select count(*)::int as n from menu_package_refills where package_variant_id = ${w.unli.variantId}`), 'no boxes ticked = no refills').toBe(0);
  });

  it('a non-refill item cannot be a refill of a package (sentence, nothing written)', async () => {
    const w = await menuWorld('refills-bad');
    const out = await run(ITEM_ACTIONS, 'setPackageRefillsAction', w.c.admin, fd({ menuItemId: w.unli.itemId, packageVariantId: w.unli.variantId, refillItemIds: [w.pork.itemId] }));
    expectSentenceError(out.flash.error, 'a la carte as refill');
    expect(await n(sql`select count(*)::int as n from menu_package_refills where package_variant_id = ${w.unli.variantId}`)).toBe(0);
  });
});

