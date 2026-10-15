/**
 * T-401 S5, I25 (docs/tasks/401-erp-menu-catalog-master.md section 4 and R7.6): seedLinkFromMap COPIES THE MAP EXACTLY.
 * A direct map (item, qty 0.25, location L) -> a link with location L and, the variant having no rule, a rule direct/item/0.25 from now;
 * the comparison for that key is then zero-difference. A variant that already has a different rule KEEPS it: the difference is
 * reported, never overwritten (the rule is org-wide: overwriting silently changes another switched store).
 * TESTER, not BUILDER. Real Postgres; maps and variants raw. Red today: seedLinkFromMap does not exist.
 *
 * Contract assumed: seedLinkFromMap(actor, { storeId, posItemKey, variantId }, tx?) -> anything; the tests read the database.
 * Mutants: the rule is overwritten / a second rule is appended on a variant that already has one; the link drops the map's location;
 * a recipe or no_stock map is not copied faithfully; pos_item_maps is edited; a key with no active map still gets a link.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@shareat/db';
import { asOrg, makeDay, rawMap, rawRule, rawVariant, refusalOf, s5, sold, sql, world } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const rulesOf = (variantId: string) => sql<{ mode: string; item_id: string | null; recipe_id: string | null; quantity_per_sale: string | null; in_force: boolean }[]>`
  select mode, item_id, recipe_id, quantity_per_sale::text as quantity_per_sale, (effective_from <= now()) as in_force
  from menu_depletion_rules where variant_id = ${variantId} order by effective_from, created_at`;
const linkOf = (storeId: string, key: string) => sql<{ variant_id: string; location_id: string | null; status: string }[]>`
  select variant_id, location_id, status from menu_pos_v1_links where store_id = ${storeId} and pos_item_key = ${key} and status = 'active'`;
const seed = (w: Awaited<ReturnType<typeof world>>, key: string, variantId: string) =>
  asOrg(w.orgId, (tx) => s5.seedLinkFromMap(w.admin, { storeId: w.a.storeId, posItemKey: key, variantId }, tx));

describe('I25 -- seedLinkFromMap copies the map exactly', () => {
  it('a direct map (cheese, 0.25, room Display) -> link at Display + a rule direct/cheese/0.25 from now; the comparison is then zero-difference', async () => {
    const w = await world('i25a');
    await rawMap(w, w.a.storeId, 'cheese-plate', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25', locationId: w.a.display!, name: 'Cheese Plate' });
    await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'cheese-plate', qty: 3 }]));
    const v = await rawVariant(w, 'Cheese Plate');
    expect(await rulesOf(v), 'the variant has no rule yet').toEqual([]);

    await seed(w, 'cheese-plate', v);
    expect(await linkOf(w.a.storeId, 'cheese-plate')).toEqual([{ variant_id: v, location_id: w.a.display, status: 'active' }]);
    const rules = await rulesOf(v);
    expect(rules).toEqual([{ mode: 'direct', item_id: w.cheese, recipe_id: null, quantity_per_sale: '0.250000', in_force: true }]);

    const cmp = await asOrg(w.orgId, (tx) => s5.compareDepletionSources(w.admin, { storeId: w.a.storeId }, tx));
    expect(cmp.differenceCount, JSON.stringify(cmp.differences)).toBe(0);
  }, 120_000);

  it('a variant that already has a DIFFERENT rule keeps it: one rule row, unchanged; the link is made; the comparison reports the difference (mutant: seed overwrites or appends a rule)', async () => {
    const w = await world('i25b');
    await rawMap(w, w.a.storeId, 'cheese-plate', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25', name: 'Cheese Plate' });
    await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'cheese-plate', qty: 3 }]));
    const v = await rawVariant(w, 'Cheese Plate');
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });

    await seed(w, 'cheese-plate', v);
    expect((await linkOf(w.a.storeId, 'cheese-plate')).length, 'the link is made').toBe(1);
    expect(await rulesOf(v), 'the org rule is untouched: still the one 0.5 row').toEqual([
      { mode: 'direct', item_id: w.cheese, recipe_id: null, quantity_per_sale: '0.500000', in_force: true },
    ]);
    const cmp = await asOrg(w.orgId, (tx) => s5.compareDepletionSources(w.admin, { storeId: w.a.storeId }, tx));
    expect(cmp.differences.map((d) => d.posItemKey), 'the difference is reported').toContain('cheese-plate');
    expect(cmp.differenceCount).toBeGreaterThan(0);
  }, 120_000);

  it('a recipe map and a no_stock map are copied faithfully too', async () => {
    const w = await world('i25c');
    await rawMap(w, w.a.storeId, 'box', { mode: 'recipe', recipeId: w.recipeId, name: 'Samgyup Box' });
    await rawMap(w, w.a.storeId, 'water', { mode: 'no_stock', name: 'Water' });
    const vBox = await rawVariant(w, 'Samgyup Box');
    const vWater = await rawVariant(w, 'Water');
    await seed(w, 'box', vBox);
    await seed(w, 'water', vWater);
    expect(await rulesOf(vBox)).toEqual([{ mode: 'recipe', item_id: null, recipe_id: w.recipeId, quantity_per_sale: null, in_force: true }]);
    expect(await rulesOf(vWater)).toEqual([{ mode: 'no_stock', item_id: null, recipe_id: null, quantity_per_sale: null, in_force: true }]);
    expect(await linkOf(w.a.storeId, 'box')).toEqual([{ variant_id: vBox, location_id: null, status: 'active' }]);
  }, 120_000);

  it('seeding never edits pos_item_maps; a key with no active map is refused and writes no link and no rule', async () => {
    const w = await world('i25d');
    await rawMap(w, w.a.storeId, 'cheese-plate', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25' });
    const v = await rawVariant(w, 'Cheese Plate');
    const mapsBefore = await sql`select id, status, mode, item_id, quantity_per_sale::text q, location_id, pos_item_name from pos_item_maps where org_id = ${w.orgId} order by id`;
    await seed(w, 'cheese-plate', v);
    expect(await sql`select id, status, mode, item_id, quantity_per_sale::text q, location_id, pos_item_name from pos_item_maps where org_id = ${w.orgId} order by id`).toEqual(mapsBefore);

    const v2 = await rawVariant(w, 'Ghost');
    const refusal = await refusalOf(() => seed(w, 'ghost-key', v2));
    expect(refusal, 'no active map for that key').not.toBeNull();
    expect(await linkOf(w.a.storeId, 'ghost-key')).toEqual([]);
    expect(await rulesOf(v2)).toEqual([]);
  }, 120_000);

  it('capability: manager may not seed a link (links follow manage_pos_map, which T-403 made admin-only); staff may not either', async () => {
    const w = await world('i25e');
    await rawMap(w, w.a.storeId, 'cheese-plate', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25' });
    const v = await rawVariant(w, 'Cheese Plate');
    for (const actor of [w.staff, w.manager]) {
      await expect(asOrg(w.orgId, (tx) => s5.seedLinkFromMap(actor, { storeId: w.a.storeId, posItemKey: 'cheese-plate', variantId: v }, tx))).rejects.toThrow(/may not '/);
    }
    expect(await linkOf(w.a.storeId, 'cheese-plate')).toEqual([]);
  }, 120_000);
});
