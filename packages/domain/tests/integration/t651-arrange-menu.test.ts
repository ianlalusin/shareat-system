/**
 * T-651 - arrange the menu once: the four reorder functions and "a new row lands last". Against real PostgreSQL.
 * Every test has a mutant that turns it red (listed in the hand-back, applied by hand).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { addMenuVariant, addOptionValue, createMenuCategory, createMenuItem, loadStoreMenu, reorderMenuCategories, reorderMenuItems, reorderMenuOptionValues, reorderMenuVariants } from '@shareat/domain';

import { asOrg, attempt, auditCount, cast, expectSentence, rawItem, rawOption, rawRule, sql, uid, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const STALE = 'The list changed since you opened it. Reload and try again.';
const itemsOf = (c: Cast) => sql<{ id: string; sort_order: number }[]>`select id, sort_order from menu_items where category_id = ${c.categoryId} order by sort_order, lower(name), id`;
const audits = (c: Cast, action: string) => sql<{ before: { order: string[] }; after: { order: string[] }; entity_id: string }[]>`select before, after, entity_id from audit_log where org_id = ${c.orgId} and action = ${action}`;
const threeItems = async (c: Cast) => [(await rawItem(c, 'a_la_carte', 'Alpha')).itemId, (await rawItem(c, 'a_la_carte', 'Bravo')).itemId, (await rawItem(c, 'a_la_carte', 'Charlie')).itemId] as const;

describe('T-651: reorder', () => {
  it('1: items are written 10, 20, 30 in the order given, in one audit row naming the order before and after', async () => {
    const c = await cast('t651-1');
    const [a, b, d] = await threeItems(c);
    const r = await asOrg(c.orgId, (tx) => reorderMenuItems(c.admin, { categoryId: c.categoryId, ids: [d, a, b] }, tx));
    expect(r.changed).toBe(true);
    expect((await itemsOf(c)).map((x) => [x.id, x.sort_order])).toEqual([[d, 10], [a, 20], [b, 30]]);
    const rows = await audits(c, 'menu.items_reordered');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_id: c.categoryId, before: { order: [a, b, d] }, after: { order: [d, a, b] } });
  });

  it('2: the same order again writes nothing and audits nothing', async () => {
    const c = await cast('t651-2');
    const [a, b, d] = await threeItems(c);
    await asOrg(c.orgId, (tx) => reorderMenuItems(c.admin, { categoryId: c.categoryId, ids: [a, b, d] }, tx));
    const before = await auditCount(c.orgId);
    const again = await asOrg(c.orgId, (tx) => reorderMenuItems(c.admin, { categoryId: c.categoryId, ids: [a, b, d] }, tx));
    expect(again.changed).toBe(false);
    expect(await auditCount(c.orgId)).toBe(before);
  });

  it('3: a stale list (a missing, an extra, a repeated or a retired id) is refused in the sentence, with nothing written and nothing audited', async () => {
    const c = await cast('t651-3');
    const [a, b, d] = await threeItems(c);
    const gone = await rawItem(c, 'a_la_carte', 'Gone');
    await sql`update menu_items set status = 'retired' where id = ${gone.itemId}`;
    const before = await auditCount(c.orgId);
    const cases: [string, string[]][] = [
      ['missing one', [a, b]],
      ['an extra id', [a, b, d, randomUUID()]],
      ['a repeated id', [a, a, b]],
      ['a retired id in place of an active one', [a, b, gone.itemId]],
    ];
    for (const [label, ids] of cases) {
      const r = await attempt(() => asOrg(c.orgId, (tx) => reorderMenuItems(c.admin, { categoryId: c.categoryId, ids }, tx)));
      expectSentence(r, label);
      expect((r.error as { userMessage?: string }).userMessage).toBe(STALE);
    }
    expect((await itemsOf(c)).every((x) => x.sort_order === 0)).toBe(true);
    expect(await auditCount(c.orgId)).toBe(before);
  });

  it('4: refused without the capability, and for a category of another organisation, with nothing written', async () => {
    const c = await cast('t651-4');
    const o = await cast('t651-4-other');
    const [a, b, d] = await threeItems(c);
    const before = await auditCount(c.orgId);
    expectSentence(await attempt(() => asOrg(c.orgId, (tx) => reorderMenuItems(c.staff, { categoryId: c.categoryId, ids: [d, b, a] }, tx))), 'staff');
    expectSentence(await attempt(() => asOrg(c.orgId, (tx) => reorderMenuCategories(c.staff, { ids: [c.categoryId] }, tx))), 'staff, categories');
    expectSentence(await attempt(() => asOrg(c.orgId, (tx) => reorderMenuItems(c.admin, { categoryId: o.categoryId, ids: [] }, tx))), 'another organisation');
    expect((await itemsOf(c)).every((x) => x.sort_order === 0)).toBe(true);
    expect(await auditCount(c.orgId)).toBe(before);
  });

  it('5: categories, sizes and options are arranged the same way; the default size is always first', async () => {
    const c = await cast('t651-5');
    const [extra] = await sql<{ id: string }[]>`insert into menu_categories (org_id, name, sort_order, status, created_by) values (${c.orgId}, ${uid('Cat2')}, 0, 'active', ${c.admin.personId}) returning id`;
    await asOrg(c.orgId, (tx) => reorderMenuCategories(c.admin, { ids: [extra!.id, c.categoryId] }, tx));
    const cats = await sql<{ id: string; sort_order: number }[]>`select id, sort_order from menu_categories where org_id = ${c.orgId} order by sort_order`;
    expect(cats.map((x) => [x.id, x.sort_order])).toEqual([[extra!.id, 10], [c.categoryId, 20]]);

    const it1 = await rawItem(c, 'a_la_carte', 'Soda');
    const small = await asOrg(c.orgId, (tx) => addMenuVariant(c.superAdmin, { menuItemId: it1.itemId, label: 'Small' }, tx));
    const large = await asOrg(c.orgId, (tx) => addMenuVariant(c.superAdmin, { menuItemId: it1.itemId, label: 'Large' }, tx));
    await asOrg(c.orgId, (tx) => reorderMenuVariants(c.admin, { menuItemId: it1.itemId, ids: [large.id, it1.variantId, small.id] }, tx));
    const vs = await sql<{ id: string; sort_order: number }[]>`select id, sort_order from menu_item_variants where menu_item_id = ${it1.itemId} order by is_default desc, sort_order`;
    expect(vs.map((x) => x.id)).toEqual([it1.variantId, large.id, small.id]); // default first by rule, then the arranged order
    expect(vs.map((x) => x.sort_order)).toEqual([20, 10, 30]);

    const g = await rawOption(c);
    const v2 = await asOrg(c.orgId, (tx) => addOptionValue(c.admin, { optionGroupId: g.groupId, name: 'Second' }, tx));
    await asOrg(c.orgId, (tx) => reorderMenuOptionValues(c.admin, { optionGroupId: g.groupId, ids: [v2.id, g.valueId] }, tx));
    const ovs = await sql<{ id: string; sort_order: number }[]>`select id, sort_order from menu_option_values where option_group_id = ${g.groupId} order by sort_order`;
    expect(ovs.map((x) => [x.id, x.sort_order])).toEqual([[v2.id, 10], [g.valueId, 20]]);
    for (const action of ['menu.categories_reordered', 'menu.variants_reordered', 'menu.option_values_reordered']) expect(await audits(c, action), action).toHaveLength(1);
  });

  it('6: the POS menu follows the new order, and its content hash (what the tablet compares) changes with it', async () => {
    const c = await cast('t651-6');
    const [a, b, d] = await threeItems(c);
    for (const itemId of [a, b, d]) {
      const [v] = await sql<{ id: string }[]>`select id from menu_item_variants where menu_item_id = ${itemId}`;
      await rawRule(c, v!.id);
      await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${c.orgId}, ${c.storeA}, ${v!.id}, 'store', '100.00', false, ${c.admin.personId})`;
      const [st] = await sql<{ id: string }[]>`insert into kitchen_stations (org_id, store_id, name, created_by) values (${c.orgId}, ${c.storeA}, ${uid('Grill')}, ${c.admin.personId}) returning id`;
      await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${c.orgId}, ${c.storeA}, ${itemId}, ${st!.id}, ${c.admin.personId})`;
    }
    const load = () => asOrg(c.orgId, (tx) => loadStoreMenu(tx, c.orgId, c.storeA, new Date(Date.now() + 1000)));
    const first = await load();
    expect(first.menu.items.map((i) => i.id)).toEqual([a, b, d]); // all 0: by name
    await asOrg(c.orgId, (tx) => reorderMenuItems(c.admin, { categoryId: c.categoryId, ids: [d, b, a] }, tx));
    const second = await load();
    expect(second.menu.items.map((i) => i.id)).toEqual([d, b, a]);
    expect(second.contentHash).not.toBe(first.contentHash);
  });
});

describe('T-651: a new row lands last, not first', () => {
  it('7: a new category, item, size and option each take the largest number of their list plus 10', async () => {
    const c = await cast('t651-7');
    await sql`update menu_categories set sort_order = 40 where id = ${c.categoryId}`;
    const cat = await asOrg(c.orgId, (tx) => createMenuCategory(c.admin, { name: uid('New') }, tx));
    expect((await sql<{ sort_order: number }[]>`select sort_order from menu_categories where id = ${cat.id}`)[0]!.sort_order).toBe(50);

    const first = await rawItem(c, 'a_la_carte', 'Existing');
    await sql`update menu_items set sort_order = 20 where id = ${first.itemId}`;
    const made = await asOrg(c.orgId, (tx) => createMenuItem(c.superAdmin, { categoryId: c.categoryId, name: uid('Made'), itemType: 'a_la_carte' }, tx));
    expect((await sql<{ sort_order: number }[]>`select sort_order from menu_items where id = ${made.id}`)[0]!.sort_order).toBe(30);

    const v1 = await asOrg(c.orgId, (tx) => addMenuVariant(c.superAdmin, { menuItemId: made.id, label: 'Small' }, tx));
    const v2 = await asOrg(c.orgId, (tx) => addMenuVariant(c.superAdmin, { menuItemId: made.id, label: 'Large' }, tx));
    const vs = await sql<{ id: string; sort_order: number }[]>`select id, sort_order from menu_item_variants where id in (${v1.id}, ${v2.id}) order by sort_order`;
    expect(vs.map((x) => [x.id, x.sort_order])).toEqual([[v1.id, 10], [v2.id, 20]]);

    const g = await rawOption(c);
    await sql`update menu_option_values set sort_order = 70 where id = ${g.valueId}`;
    const ov = await asOrg(c.orgId, (tx) => addOptionValue(c.admin, { optionGroupId: g.groupId, name: 'Newest' }, tx));
    expect((await sql<{ sort_order: number }[]>`select sort_order from menu_option_values where id = ${ov.id}`)[0]!.sort_order).toBe(80);
  });
});
