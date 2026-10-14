/**
 * T-401 S5, I27 (docs/tasks/401-erp-menu-catalog-master.md section 4 and R7.8): a stock item that a SWITCHED store still depletes
 * through the menu cannot be retired. `itemsRepo.retireReadout(...).activeMenuRules` counts depletion rules IN FORCE OR SCHEDULED naming the
 * item (directly, or through a recipe that uses it) on a variant with an ACTIVE link at a store whose latest switch is menu_rules;
 * `setItemStatus(.., 'inactive')` refuses while it is > 0. Switched back, or link inactive, or store never switched -> 0 and allowed.
 * TESTER, not BUILDER. Real Postgres; rules, links and switches raw. Red today: the readout has no activeMenuRules and retire is allowed.
 *
 * Contract assumed: RetireReadout gains `activeMenuRules: number`; setItemStatus keeps its signature (tx, actor, {itemId, status}) and the
 * refusal is a RefusalError (a sentence) thrown from it; the actor is a super admin (approve_item is super-admin only), so a refusal here is the active-menu-rule one, never the capability (refusalOf rethrows an AuthorizationError). Nothing else in the readout changes.
 * Mutants: the readout counts pos_item_maps only; ignores the switch (counts at an unswitched store); ignores the link status; ignores
 * scheduled rules; ignores the recipe leg; retire still allowed while the count is > 0.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@shareat/db';
import { asOrg, rawLink, rawRule, rawSwitch, rawVariant, refusalOf, repoS5, s5, sql, world, type World } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const DAYMS = 86_400_000;
const readout = (w: World, itemId: string) => asOrg(w.orgId, (tx) => repoS5.itemsRepo.retireReadout(tx, w.orgId, itemId));
const retire = (w: World, itemId: string) => refusalOf(() => asOrg(w.orgId, (tx) => s5.setItemStatus(tx, w.superAdmin, { itemId, status: 'inactive' })));
const statusOf = async (itemId: string) => (await sql<{ status: string }[]>`select status from items where id = ${itemId}`)[0]!.status;

/** A variant with a direct rule on `itemId`, linked at store A. */
async function linked(w: World, itemId: string, key = 'dish') {
  const v = await rawVariant(w, `Dish ${key}`);
  await rawRule(w, v, { mode: 'direct', itemId, quantityPerSale: '1' });
  const linkId = await rawLink(w, w.a.storeId, key, v);
  return { v, linkId };
}

describe('I27 -- a stock item a switched store still depletes through the menu cannot be retired', () => {
  it('switched store + active link + rule on item X: activeMenuRules = 1 and retire is refused; switched back -> 0 and retire allowed (mutant: readout counts maps only)', async () => {
    const w = await world('i27a');
    await linked(w, w.pork);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    expect((await readout(w, w.pork)).activeMenuRules).toBe(1);
    const refusal = await retire(w, w.pork);
    expect(refusal, 'refused').not.toBeNull();
    expect(await statusOf(w.pork), 'still active').toBe('active');

    await rawSwitch(w, w.a.storeId, 'v1_pos_map', null, null);
    expect((await readout(w, w.pork)).activeMenuRules).toBe(0);
    expect(await retire(w, w.pork), 'allowed once the store is switched back').toBeNull();
    expect(await statusOf(w.pork)).toBe('inactive');
  }, 120_000);

  it('a store that was never switched counts 0 even with an active link (mutant: the switch is ignored)', async () => {
    const w = await world('i27b');
    await linked(w, w.pork);
    expect((await readout(w, w.pork)).activeMenuRules).toBe(0);
    expect(await retire(w, w.pork)).toBeNull();
  }, 120_000);

  it('an INACTIVE link counts 0 even at a switched store (mutant: link status ignored)', async () => {
    const w = await world('i27c');
    const { linkId } = await linked(w, w.pork);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    expect((await readout(w, w.pork)).activeMenuRules).toBe(1);
    await sql`update menu_pos_v1_links set status = 'inactive' where id = ${linkId}`;
    expect((await readout(w, w.pork)).activeMenuRules).toBe(0);
    expect(await retire(w, w.pork)).toBeNull();
  }, 120_000);

  it('a rule only SCHEDULED for the item also counts (mutant: only the rule in force is read)', async () => {
    const w = await world('i27d');
    const { v } = await linked(w, w.pork);            // rule in force on Pork (needed for the link)
    await rawRule(w, v, { mode: 'direct', itemId: w.rice, quantityPerSale: '1', effectiveFrom: new Date(Date.now() + 2 * DAYMS) });
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    expect((await readout(w, w.rice)).activeMenuRules, 'Rice is named only by the scheduled rule').toBe(1);
    expect(await retire(w, w.rice)).not.toBeNull();
    expect((await readout(w, w.pork)).activeMenuRules, 'Pork is named by the rule in force').toBe(1);
  }, 120_000);

  it('a rule that names the item THROUGH A RECIPE counts too (mutant: the recipe leg is missing)', async () => {
    const w = await world('i27e');
    const v = await rawVariant(w, 'Samgyup Box');
    await rawRule(w, v, { mode: 'recipe', recipeId: w.recipeId }); // recipe lines: Cheese 0.2, Rice 0.1
    await rawLink(w, w.a.storeId, 'box', v);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    expect((await readout(w, w.rice)).activeMenuRules).toBe(1);
    expect((await readout(w, w.cheese)).activeMenuRules).toBe(1);
    expect((await readout(w, w.sauce)).activeMenuRules, 'an item the recipe does not use').toBe(0);
    expect(await retire(w, w.rice)).not.toBeNull();
  }, 120_000);

  it('only the switched store counts: a link at store B (never switched) does not hold the item while A is switched', async () => {
    const w = await world('i27f');
    const v = await rawVariant(w, 'Pork Dish');
    await rawRule(w, v, { mode: 'direct', itemId: w.pork, quantityPerSale: '1' });
    await rawLink(w, w.b.storeId, 'dish', v);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    expect((await readout(w, w.pork)).activeMenuRules).toBe(0);
  }, 120_000);
});
