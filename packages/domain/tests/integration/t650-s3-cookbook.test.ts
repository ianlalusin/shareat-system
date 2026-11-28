import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-650 S3 - the Cookbook: kitchen recipes (ingredients + method, no stock output). MIGRATION 0291. Real Postgres, on the T-401 S5 world.
 *
 * MUTANTS (each goes red): the output-item rule dropped from `validateRecipeShape` (the "product recipe without an item" test); `deriveCookInputs` not refusing a kitchen
 * recipe (both production tests: the draft AND the post); `checkRecipe` letting a kitchen recipe carry a "Made at" list or a labour (the cookbook-has-no-labour test);
 * `requireUsableRuleTarget` refusing a kitchen recipe (the depletion test); the per-serving scale ignoring the portions (the depletion quantities).
 * The two CHECKs are the database's own: proven with raw SQL.
 */
import { buildPlan, createProductionDraft, createRecipe, editRecipe, postProduction, setDepletionRule } from '@shareat/domain';
import { closeDb, productionRepo } from '@shareat/db';
import { planOnly } from './t401-s5-golden-scenario';
import { asOrg, makeDay, rawLink, rawSwitch, rawVariant, sold, sql, stockUp, uid, world, type World } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const SENTENCE = 'A cookbook recipe is not produced into stock; a dish that uses it takes its ingredients when sold.';
void buildPlan;

async function kitchenRecipe(w: World, over: { portions?: string; method?: string } = {}) {
  const name = `Fishcake ${uid('k')}`;
  const r = await asOrg(w.orgId, (tx) =>
    createRecipe(tx, w.admin, {
      orgId: w.orgId, name, purpose: 'kitchen', outputQuantity: over.portions ?? '2', method: over.method ?? 'Mix, shape, fry.',
      lines: [{ itemId: w.cheese, quantity: '0.2' }, { itemId: w.rice, quantity: '0.1' }],
    }),
  );
  if (!r.ok) throw new Error(r.reason);
  return { id: r.recipeId, name };
}
const row = async (id: string) =>
  (await sql<{ purpose: string; output_item_id: string | null; method: string | null; output_quantity: string }[]>`
    select purpose, output_item_id::text, method, output_quantity::text from production_recipes where id = ${id}`)[0]!;

describe('T-650 S3 - the cookbook', () => {
  it('1. a kitchen recipe with NO output item saves: purpose kitchen, no item, a method, and "makes N portions"', async () => {
    const w = await world('s3a');
    const k = await kitchenRecipe(w, { portions: '4', method: 'Mix, shape, fry for 3 minutes a side.' });
    expect(await row(k.id)).toEqual({ purpose: 'kitchen', output_item_id: null, method: 'Mix, shape, fry for 3 minutes a side.', output_quantity: '4.000' });
    const kitchen = await asOrg(w.orgId, (tx) => productionRepo.listRecipes(tx, w.orgId, true, 'kitchen'));
    const product = await asOrg(w.orgId, (tx) => productionRepo.listRecipes(tx, w.orgId, true, 'product'));
    expect(kitchen.map((r) => r.id)).toContain(k.id);
    expect(product.map((r) => r.id)).not.toContain(k.id);
    expect(kitchen.find((r) => r.id === k.id)).toMatchObject({ outputItemId: null, purpose: 'kitchen' });
  });

  it('2. a PRODUCT recipe without an output item is refused (domain, and the database CHECK underneath)', async () => {
    const w = await world('s3b');
    const r = await asOrg(w.orgId, (tx) => createRecipe(tx, w.admin, { orgId: w.orgId, name: uid('NoOut'), outputQuantity: '2', lines: [{ itemId: w.cheese, quantity: '0.2' }] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('Pick the item this recipe makes.');
    await expect(
      sql`insert into production_recipes (org_id, name, output_quantity, created_by) values (${w.orgId}, ${uid('raw')}, 1, ${w.admin.personId})`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`insert into production_recipes (org_id, name, purpose, output_quantity, created_by) values (${w.orgId}, ${uid('raw')}, 'bogus', 1, ${w.admin.personId})`,
    ).rejects.toMatchObject({ code: '23514' });
    const k = await kitchenRecipe(w);
    await expect(sql`update production_recipes set method = ${'x'.repeat(4001)} where id = ${k.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('3. a cookbook recipe has no "Made at" list and no labour per batch; its method can be edited and cleared; its purpose never changes', async () => {
    const w = await world('s3c');
    const bad = await asOrg(w.orgId, (tx) =>
      createRecipe(tx, w.admin, { orgId: w.orgId, name: uid('K'), purpose: 'kitchen', outputQuantity: '2', lines: [{ itemId: w.cheese, quantity: '0.2' }], storeIds: [w.a.storeId] }),
    );
    expect(!bad.ok && bad.reason).toMatch(/no "Made at" list/);
    const bad2 = await asOrg(w.orgId, (tx) =>
      createRecipe(tx, w.admin, { orgId: w.orgId, name: uid('K'), purpose: 'kitchen', outputQuantity: '2', lines: [{ itemId: w.cheese, quantity: '0.2' }], standardLabourCost: '10.00' }),
    );
    expect(!bad2.ok && bad2.reason).toMatch(/no labour per batch/);
    const long = await asOrg(w.orgId, (tx) =>
      createRecipe(tx, w.admin, { orgId: w.orgId, name: uid('K'), purpose: 'kitchen', outputQuantity: '2', lines: [{ itemId: w.cheese, quantity: '0.2' }], method: 'x'.repeat(4001) }),
    );
    expect(!long.ok && long.reason).toMatch(/at most 4000/);

    const k = await kitchenRecipe(w);
    const edit = (method?: string) =>
      asOrg(w.orgId, (tx) =>
        editRecipe(tx, w.admin, { recipeId: k.id, name: k.name, outputQuantity: '3', lines: [{ itemId: w.cheese, quantity: '0.3' }], ...(method === undefined ? {} : { method }) }),
      );
    expect((await edit('Fry first.')).ok).toBe(true);
    expect(await row(k.id)).toMatchObject({ purpose: 'kitchen', output_item_id: null, method: 'Fry first.', output_quantity: '3.000' });
    expect((await edit()).ok).toBe(true); // omitted = unchanged
    expect((await row(k.id)).method).toBe('Fry first.');
    expect((await edit('  ')).ok).toBe(true); // blank clears
    expect((await row(k.id)).method).toBeNull();
  });

  it('4. a kitchen recipe can NOT be produced: the draft is refused (no record), and a post of a record whose recipe became a cookbook recipe is refused too', async () => {
    const w = await world('s3d');
    const k = await kitchenRecipe(w);
    const draft = await asOrg(w.orgId, (tx) =>
      createProductionDraft(tx, w.manager, {
        orgId: w.orgId, storeId: w.a.storeId, locationId: w.a.kitchen, kind: 'cook', recipeId: k.id, producedOn: '2026-08-20', inputs: [], outputs: [{ itemId: w.cheese, quantity: '2', unit: 'kg' }],
      }),
    );
    expect(draft.ok).toBe(false);
    expect(!draft.ok && draft.reason).toBe(SENTENCE);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from production_records where org_id = ${w.orgId}`)[0]!.n)).toBe(0);

    // a PRODUCT recipe + a saved draft, then the recipe is turned into a cookbook recipe underneath it: post refuses with the same sentence
    const product = await asOrg(w.orgId, (tx) =>
      createRecipe(tx, w.admin, { orgId: w.orgId, name: uid('Prod'), outputItemId: w.sauce, outputQuantity: '1', lines: [{ itemId: w.cheese, quantity: '0.2' }] }),
    );
    if (!product.ok) throw new Error(product.reason);
    const ok = await asOrg(w.orgId, (tx) =>
      createProductionDraft(tx, w.manager, {
        orgId: w.orgId, storeId: w.a.storeId, locationId: w.a.kitchen, kind: 'cook', recipeId: product.recipeId, producedOn: '2026-08-20', inputs: [], outputs: [{ itemId: w.sauce, quantity: '1', unit: 'pcs' }],
      }),
    );
    if (!ok.ok) throw new Error(ok.reason);
    await sql`update production_recipes set purpose = 'kitchen', output_item_id = null where id = ${product.recipeId}`;
    const posted = await asOrg(w.orgId, (tx) => postProduction(tx, w.manager, { recordId: ok.recordId }));
    expect(posted.ok).toBe(false);
    expect(!posted.ok && posted.reason).toBe(SENTENCE);
  });

  it('5. a menu depletion rule can target a kitchen recipe, and a sale uses its ingredients scaled per serving (2 portions: 0.2 cheese + 0.1 rice; 4 sold -> 0.4 + 0.2)', async () => {
    const w = await world('s3e');
    const k = await kitchenRecipe(w, { portions: '2' });
    const v = await rawVariant(w, 'Fishcake');
    const rule = await setDepletionRule(w.admin, { variantId: v, mode: 'recipe', recipeId: k.id });
    expect(rule.id).toBeTruthy();
    await rawLink(w, w.a.storeId, 'fishcake', v);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'cookbook', 0);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, '10');
    await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, '10');
    const d = await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'fishcake', qty: 4 }]));
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    const lines = plan.lines.filter((l) => l.posItemKey === 'fishcake').map((l) => ({ section: l.section, item: l.itemId, qty: l.quantity })).sort((a, b) => String(a.item).localeCompare(String(b.item)));
    expect(lines).toEqual(
      [
        { section: 'recipe', item: w.cheese, qty: '0.400' },
        { section: 'recipe', item: w.rice, qty: '0.200' },
      ].sort((a, b) => String(a.item).localeCompare(String(b.item))),
    );
  }, 120_000);

  it('6. a RETIRED kitchen recipe cannot be picked for a rule (as any retired recipe)', async () => {
    const w = await world('s3f');
    const k = await kitchenRecipe(w);
    await sql`update production_recipes set status = 'inactive' where id = ${k.id}`;
    const v = await rawVariant(w, 'Fishcake');
    await expect(setDepletionRule(w.admin, { variantId: v, mode: 'recipe', recipeId: k.id })).rejects.toMatchObject({ message: expect.stringContaining('is inactive') });
  });
});
