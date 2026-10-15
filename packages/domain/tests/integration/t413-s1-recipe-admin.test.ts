import { afterAll, describe, expect, it } from 'vitest';
import { transaction, APP_ROLE, productionRepo, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domainModule from '@shareat/domain';
import { createProductionDraft, editPostedProduction, postProduction, voidProduction } from '@shareat/domain';
import { asOrg, makeDay, rawMap, rawRule, rawVariant, refusalOf, sql, stockUp, uid, world, type World } from './t401-s5-setup';
import { attempt } from './_fixtures/t401-s2-menu';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-413 S1 (integration half) - invariants 1-10. `docs/tasks/413-production-recipe-admin.md` R1-R5, built with Q1 = (a), Q2 = (a)
 * and the 10,000 cap on ingredient lines too. TESTER, not BUILDER.
 *
 * CONTRACT THE BUILDER MUST MEET (names from the spec's Contract table; everything else is the tester's assumption, listed
 * in the report):
 *   createRecipe(tx, actor, { orgId, name, outputItemId, outputQuantity, lines: [{ itemId, quantity, unit? }] })   unit optional
 *   editRecipe(tx, actor, { recipeId, name, outputItemId, outputQuantity, lines })
 *   retireRecipe(tx, actor, { recipeId })     restoreRecipe(tx, actor, { recipeId })
 *   all four return { ok: true, recipeId } or { ok: false, reason } (a refusal), and throw AuthorizationError (.capability
 *   'manage_recipes') BEFORE any read. A refusal may also be thrown as a presentable error with `userMessage`: both count.
 *   Audit rows: action production.recipe_{create,edit,retire,restore}, entity production_recipes, entity_id = the recipe id.
 *
 * RED ON HEAD for the right reason: editRecipe / retireRecipe / restoreRecipe are not exported (TypeError "is not a function",
 * rethrown, never counted as a refusal); createRecipe's new rules (units, line cap, name length, duplicates...) and its audit row
 * fail as assertions. Controls (the plain admin create, the unchanged-recipe cook edit) are green on HEAD where HEAD supports them.
 * Every refusal leg asserts: no row changed AND no production.recipe_* audit row written (invariant 9's second half).
 *
 * Fixture: S5's `world` (two stores 'Lipa' (A) / 'Malvar' (B) with a Kitchen each; admin / manager / staff; items Cheese, Sauce(pcs),
 * Pork, Rice, Coke) plus 'Stew' (kg, the recipe output). Recipe 'Stew': 2 kg from Rice 1.5 kg + Pork 1 kg (2.5 kg in for 2 kg out: a cook's output may not exceed its input), by raw SQL.
 */

interface Line { itemId: string; quantity: string; unit?: string }
interface RecipeInput { orgId?: string; recipeId?: string; name: string; outputItemId: string; outputQuantity: string; lines: Line[] }
type Outcome = { ok: true; recipeId: string } | { ok: false; reason: string };
const api = domainModule as unknown as {
  createRecipe(tx: Tx, actor: Actor, input: RecipeInput): Promise<Outcome>;
  editRecipe(tx: Tx, actor: Actor, input: RecipeInput & { recipeId: string }): Promise<Outcome>;
  retireRecipe(tx: Tx, actor: Actor, input: { recipeId: string }): Promise<Outcome>;
  restoreRecipe(tx: Tx, actor: Actor, input: { recipeId: string }): Promise<Outcome>;
};

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

interface F extends World { stew: string; storeNameA: string }

async function newItem(w: World, name: string, unit = 'kg', kind = 'raw_material'): Promise<string> {
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${w.orgId}, ${testItemCode()}, ${name}, ${kind}, ${unit}, ${w.admin.personId}) returning id`;
  return i!.id;
}
async function fixture(hint: string): Promise<F> {
  const w = await world(hint);
  const stew = await newItem(w, 'Stew');
  // S5's world seeds one recipe of its own; this file counts recipes, so it starts from none.
  await sql`delete from production_recipe_lines where recipe_id = ${w.recipeId}`;
  await sql`delete from production_recipes where id = ${w.recipeId}`;
  return { ...w, stew, storeNameA: 'Lipa' };
}
/** Recipe 'Stew' by raw SQL: 2 kg from Rice 1 kg + Pork 0.5 kg (unless lines are given). */
async function seedRecipe(f: F, name = 'Stew', over: { status?: string; lines?: { itemId: string; quantity: string; unit: string }[]; outputQuantity?: string } = {}): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by, status)
    values (${f.orgId}, ${name}, ${f.stew}, ${over.outputQuantity ?? '2'}, ${f.admin.personId}, ${over.status ?? 'active'}) returning id`;
  for (const l of over.lines ?? [{ itemId: f.rice, quantity: '1.5', unit: 'kg' }, { itemId: f.pork, quantity: '1', unit: 'kg' }]) {
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${l.itemId}, ${l.quantity}, ${l.unit})`;
  }
  return r!.id;
}

const stewLines = (f: F): Line[] => [{ itemId: f.rice, quantity: '1' }, { itemId: f.pork, quantity: '0.5' }];
const input = (f: F, over: Partial<RecipeInput> = {}): RecipeInput => ({ orgId: f.orgId, name: 'Goulash', outputItemId: f.stew, outputQuantity: '2', lines: stewLines(f), ...over });
/** Fills a missing unit with the item's real base unit (kg; Sauce is pcs) so a test about something else fails for that thing only. */
const fill = (f: F, ls: Line[]): Line[] => ls.map((l) => ({ unit: l.itemId === f.sauce ? 'pcs' : 'kg', ...l }));
const createRaw = (f: F, who: Actor, over: Partial<RecipeInput> = {}) => asOrg(f.orgId, (tx) => api.createRecipe(tx, who, input(f, over)));
const editRaw = (f: F, who: Actor, recipeId: string, over: Partial<RecipeInput> = {}) =>
  asOrg(f.orgId, (tx) => api.editRecipe(tx, who, { ...input(f, { name: 'Stew' }), recipeId, ...over }));
const create = (f: F, who: Actor, over: Partial<RecipeInput> = {}) => createRaw(f, who, { ...over, lines: fill(f, over.lines ?? stewLines(f)) });
const edit = (f: F, who: Actor, recipeId: string, over: Partial<RecipeInput> = {}) => editRaw(f, who, recipeId, { ...over, lines: fill(f, over.lines ?? stewLines(f)) });
const retire = (f: F, who: Actor, recipeId: string) => asOrg(f.orgId, (tx) => api.retireRecipe(tx, who, { recipeId }));
const restore = (f: F, who: Actor, recipeId: string) => asOrg(f.orgId, (tx) => api.restoreRecipe(tx, who, { recipeId }));

interface Snap { name: string; status: string; outputItemId: string; outputQuantity: string; updatedAt: string | null; lines: string[] }
async function snap(recipeId: string): Promise<Snap> {
  const [h] = await sql<{ name: string; status: string; output_item_id: string; q: string; u: string | null }[]>`
    select name, status, output_item_id, output_quantity::text as q, updated_at::text as u from production_recipes where id = ${recipeId}`;
  const ls = await sql<{ item_id: string; q: string; unit: string }[]>`select item_id, quantity::text as q, unit from production_recipe_lines where recipe_id = ${recipeId} order by item_id`;
  return { name: h!.name, status: h!.status, outputItemId: h!.output_item_id, outputQuantity: h!.q, updatedAt: h!.u, lines: ls.map((l) => `${l.item_id}|${l.q}|${l.unit}`) };
}
const recipeCount = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text n from production_recipes where org_id = ${orgId}`)[0]!.n);
const recipeAudit = async (orgId: string) =>
  sql<{ action: string; entity: string; entity_id: string; actor_person_id: string; before: unknown; after: unknown }[]>`
    select action, entity, entity_id, actor_person_id, before, after from audit_log
    where org_id = ${orgId} and action like 'production.recipe_%' order by occurred_at, id`;
const recipeAuditCount = async (orgId: string) => (await recipeAudit(orgId)).length;

/** A refusal as a sentence (ok:false or a thrown presentable error). Fails when the call SUCCEEDED. */
async function mustRefuse(run: () => Promise<unknown>, what: string): Promise<string> {
  const s = await refusalOf(run);
  expect(s, `${what}: was accepted`).not.toBeNull();
  expect(s as string, `${what}: a database word leaked`).not.toMatch(/violates|duplicate key|unique constraint|check constraint|SQLSTATE|relation "|_fkey|_key\b/i);
  return s as string;
}

async function asserCap(run: () => Promise<unknown>, capability: string, who: string): Promise<void> {
  const r = await attempt(run);
  expect(r.failed, `${who}: the write was allowed`).toBe(true);
  expect(r.error, `${who}: not an AuthorizationError (${r.message})`).toBeInstanceOf(AuthorizationError);
  expect((r.error as AuthorizationError).capability).toBe(capability);
}

// =====================================================================================================================
describe('invariant 1 - all four writes are admin-only (manage_recipes): manager and staff refused, admin succeeds', () => {
  it('createRecipe: manager and staff refused with capability manage_recipes, no row, no audit row; admin creates. Mutant: manage_items', async () => {
    const f = await fixture('i1c');
    for (const [who, a] of [['manager', f.manager], ['staff', f.staff]] as const) await asserCap(() => create(f, a), 'manage_recipes', who);
    expect(await recipeCount(f.orgId)).toBe(0);
    expect(await recipeAuditCount(f.orgId)).toBe(0);
    const ok = await create(f, f.admin);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it('editRecipe: manager and staff refused, recipe untouched; admin edits. Mutant: editRecipe authorizes manage_items', async () => {
    const f = await fixture('i1e');
    const id = await seedRecipe(f);
    const before = await snap(id);
    for (const [who, a] of [['manager', f.manager], ['staff', f.staff]] as const) await asserCap(() => edit(f, a, id, { outputQuantity: '3' }), 'manage_recipes', who);
    expect(await snap(id)).toEqual(before);
    expect(await recipeAuditCount(f.orgId)).toBe(0);
    const ok = await edit(f, f.admin, id, { outputQuantity: '3' });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect((await snap(id)).outputQuantity).toBe('3.000');
  });

  it('retireRecipe and restoreRecipe: manager and staff refused, status unchanged; admin does both', async () => {
    const f = await fixture('i1r');
    const id = await seedRecipe(f);
    for (const [who, a] of [['manager', f.manager], ['staff', f.staff]] as const) await asserCap(() => retire(f, a, id), 'manage_recipes', `${who} retire`);
    expect((await snap(id)).status).toBe('active');
    expect((await retire(f, f.admin, id)).ok).toBe(true);
    expect((await snap(id)).status).toBe('inactive');
    for (const [who, a] of [['manager', f.manager], ['staff', f.staff]] as const) await asserCap(() => restore(f, a, id), 'manage_recipes', `${who} restore`);
    expect((await snap(id)).status).toBe('inactive');
    expect((await restore(f, f.admin, id)).ok).toBe(true);
    expect((await snap(id)).status).toBe('active');
  });

  it('super_admin may too (the matrix grants it): create succeeds', async () => {
    const f = await fixture('i1s');
    expect((await create(f, f.superAdmin)).ok).toBe(true);
  });
});

// =====================================================================================================================
describe('invariant 2 - quantity bounds 0 < qty <= 10,000, at most 3 decimals: output AND every ingredient line', () => {
  const BAD = ['0', '-1', '10000.001', '', 'abc', '1.2345'];
  const GOOD = ['10000', '0.001'];

  it('create: a bad OUTPUT quantity is refused in a sentence, no row; 10000 and 0.001 are accepted. Mutants: < for <=; cap dropped', async () => {
    const f = await fixture('i2o');
    for (const bad of BAD) {
      await mustRefuse(() => create(f, f.admin, { outputQuantity: bad }), `create output '${bad}'`);
      expect(await recipeCount(f.orgId), `output '${bad}' left a row`).toBe(0);
    }
    expect(await recipeAuditCount(f.orgId)).toBe(0);
    for (const [i, good] of GOOD.entries()) {
      const r = await create(f, f.admin, { name: `Goulash ${i}`, outputQuantity: good });
      expect(r.ok, `output '${good}': ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it('create: a bad INGREDIENT quantity is refused, no row; 10000 and 0.001 accepted. Mutant: cap dropped on lines', async () => {
    const f = await fixture('i2l');
    for (const bad of BAD) {
      await mustRefuse(() => create(f, f.admin, { lines: [{ itemId: f.rice, quantity: bad }, { itemId: f.pork, quantity: '0.5' }] }), `create line '${bad}'`);
      expect(await recipeCount(f.orgId), `line '${bad}' left a row`).toBe(0);
    }
    expect(await recipeAuditCount(f.orgId)).toBe(0);
    for (const [i, good] of GOOD.entries()) {
      const r = await create(f, f.admin, { name: `Goulash ${i}`, lines: [{ itemId: f.rice, quantity: good }, { itemId: f.pork, quantity: '0.5' }] });
      expect(r.ok, `line '${good}': ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it('edit: same bounds for output and lines; a refused edit leaves header and lines unchanged', async () => {
    const f = await fixture('i2e');
    const id = await seedRecipe(f);
    const before = await snap(id);
    for (const bad of BAD) {
      await mustRefuse(() => edit(f, f.admin, id, { outputQuantity: bad }), `edit output '${bad}'`);
      await mustRefuse(() => edit(f, f.admin, id, { lines: [{ itemId: f.rice, quantity: bad }, { itemId: f.pork, quantity: '0.5' }] }), `edit line '${bad}'`);
      expect(await snap(id), `'${bad}' changed the recipe`).toEqual(before);
    }
    expect(await recipeAuditCount(f.orgId)).toBe(0);
    for (const good of GOOD) {
      const r = await edit(f, f.admin, id, { outputQuantity: good, lines: [{ itemId: f.rice, quantity: good }, { itemId: f.pork, quantity: '0.5' }] });
      expect(r.ok, `'${good}': ${JSON.stringify(r)}`).toBe(true);
    }
  });
});

// =====================================================================================================================
describe('invariant 3 - units: an omitted unit stores the item\'s base unit; a different unit is refused (not converted)', () => {
  it('create: lines sent with no unit store kg / pcs (each item\'s own base unit). Mutant: unit passed through (blank or wrong)', async () => {
    const f = await fixture('i3a');
    const r = await createRaw(f, f.admin, { lines: [{ itemId: f.rice, quantity: '1' }, { itemId: f.sauce, quantity: '3' }] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const ls = await sql<{ item_id: string; unit: string }[]>`select item_id, unit from production_recipe_lines where recipe_id = ${r.recipeId}`;
    expect(Object.fromEntries(ls.map((l) => [l.item_id, l.unit]))).toEqual({ [f.rice]: 'kg', [f.sauce]: 'pcs' });
  });

  it('create: unit equal to the base unit is accepted; "g" for a kg item is refused, no row. Mutant: unit passed through', async () => {
    const f = await fixture('i3b');
    expect((await create(f, f.admin, { name: 'Same unit', lines: [{ itemId: f.rice, quantity: '1', unit: 'kg' }] })).ok).toBe(true);
    const before = await recipeCount(f.orgId);
    await mustRefuse(() => create(f, f.admin, { lines: [{ itemId: f.rice, quantity: '500', unit: 'g' }] }), 'create g for kg');
    await mustRefuse(() => create(f, f.admin, { lines: [{ itemId: f.sauce, quantity: '1', unit: 'kg' }] }), 'create kg for pcs');
    expect(await recipeCount(f.orgId)).toBe(before);
    expect(await recipeAuditCount(f.orgId)).toBe(1);
  });

  it('edit: a "g" line is refused (recipe unchanged); a legacy "g" line is rewritten to the base unit when its quantity is re-sent in kg', async () => {
    const f = await fixture('i3c');
    const id = await seedRecipe(f, 'Stew', { lines: [{ itemId: f.rice, quantity: '500', unit: 'g' }, { itemId: f.pork, quantity: '0.5', unit: 'kg' }] });
    const before = await snap(id);
    await mustRefuse(() => edit(f, f.admin, id, { lines: [{ itemId: f.rice, quantity: '500', unit: 'g' }, { itemId: f.pork, quantity: '0.5' }] }), 'edit g');
    expect(await snap(id)).toEqual(before);
    const ok = await editRaw(f, f.admin, id, { lines: [{ itemId: f.rice, quantity: '0.5' }, { itemId: f.pork, quantity: '0.5' }] });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const after = await snap(id);
    expect(after.lines.sort()).toEqual([`${f.rice}|0.500|kg`, `${f.pork}|0.500|kg`].sort());
  });
});

// =====================================================================================================================
describe('invariant 4 - shape guards (create and edit): each refused in a sentence, no row, no audit row', () => {
  async function cases(f: F) {
    const retiredItem = await newItem(f, 'Old Spice');
    await sql`update items set status = 'inactive' where id = ${retiredItem}`;
    const many: Line[] = [];
    for (let i = 0; i < 51; i++) many.push({ itemId: await newItem(f, `Bulk ${i}`), quantity: '1' });
    const other = await world(`${uid('o')}`);
    const foreign = await newItem(other, 'Foreign Salt');
    await seedRecipe(f, 'Old Chowder', { status: 'inactive' });
    return [
      ['duplicate ingredient', { lines: [{ itemId: f.rice, quantity: '1' }, { itemId: f.rice, quantity: '2' }] }],
      ['output as its own ingredient', { lines: [{ itemId: f.stew, quantity: '1' }, { itemId: f.rice, quantity: '1' }] }],
      ['retired ingredient', { lines: [{ itemId: retiredItem, quantity: '1' }, { itemId: f.rice, quantity: '1' }] }],
      ['retired output item', { outputItemId: retiredItem }],
      ['no ingredient lines', { lines: [] }],
      ['51 ingredient lines', { lines: many }],
      ['ingredient from another org', { lines: [{ itemId: foreign, quantity: '1' }, { itemId: f.rice, quantity: '1' }] }],
      ['output item from another org', { outputItemId: foreign }],
      ['blank name', { name: '   ' }],
      ['81-character name', { name: 'x'.repeat(81) }],
      ['name collides by case with a recipe', { name: 'STEW' }],
      ['name collides with a RETIRED recipe', { name: 'old chowder' }],
    ] as [string, Partial<RecipeInput>][];
  }

  it('create: every guard refuses, in turn, with zero new rows and zero audit rows. Mutants: each guard removed', async () => {
    const f = await fixture('i4c');
    await seedRecipe(f, 'Stew');
    const list = await cases(f);
    const rows = await recipeCount(f.orgId);
    for (const [what, over] of list) {
      await mustRefuse(() => create(f, f.admin, over), `create: ${what}`);
      expect(await recipeCount(f.orgId), `create: ${what} left a row`).toBe(rows);
    }
    expect(await recipeAuditCount(f.orgId)).toBe(0);
  });

  it('create: the retired-name collision says the name is held by a retired recipe; control: 80 characters and surrounding spaces are fine, saved trimmed', async () => {
    const f = await fixture('i4n');
    await seedRecipe(f, 'Old Chowder', { status: 'inactive' });
    const s = await mustRefuse(() => create(f, f.admin, { name: 'Old Chowder' }), 'retired name');
    expect(s).toMatch(/retired/i);
    const long = 'y'.repeat(80);
    const r = await create(f, f.admin, { name: `  ${long}  ` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect((await snap(r.recipeId)).name).toBe(long);
  });

  it('edit: every guard refuses with the recipe unchanged and zero audit rows (a name equal to its OWN is fine)', async () => {
    const f = await fixture('i4e');
    const id = await seedRecipe(f, 'Stew');
    const list = (await cases(f)).filter(([what]) => what !== 'name collides by case with a recipe');
    const before = await snap(id);
    for (const [what, over] of list) {
      await mustRefuse(() => edit(f, f.admin, id, over), `edit: ${what}`);
      expect(await snap(id), `edit: ${what} changed the recipe`).toEqual(before);
    }
    await seedRecipe(f, 'Gumbo');
    await mustRefuse(() => edit(f, f.admin, id, { name: 'gumbo' }), 'edit: collides with another recipe');
    expect(await snap(id)).toEqual(before);
    expect(await recipeAuditCount(f.orgId)).toBe(0);
    const own = await edit(f, f.admin, id, { name: 'STEW' });
    expect(own.ok, `renaming to its own name in another case: ${JSON.stringify(own)}`).toBe(true);
  });
});

// =====================================================================================================================
describe('invariant 5 - E1: an edit is refused while a DRAFT cook on the recipe exists', () => {
  const draftCook = (f: F, recipeId: string, storeId: string, kitchen: string, qty = '4', date = '2026-08-10') =>
    asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.manager, {
        orgId: f.orgId, storeId, locationId: kitchen, kind: 'cook', recipeId, producedOn: date, labourCost: '0',
        inputs: [], outputs: [{ itemId: f.stew, quantity: qty, unit: 'kg' }],
      }),
    );

  it('a draft at store A refuses the edit naming the store and the date; recipe and lines unchanged; no audit row. Mutant: E1 filters posted instead of draft', async () => {
    const f = await fixture('i5a');
    const id = await seedRecipe(f);
    const d = await draftCook(f, id, f.a.storeId, f.a.kitchen);
    expect(d.ok, JSON.stringify(d)).toBe(true);
    const before = await snap(id);
    const s = await mustRefuse(() => edit(f, f.admin, id, { outputQuantity: '3' }), 'edit with a draft');
    expect(s).toMatch(/Post or void the cook/i);
    expect(s).toContain('Lipa');
    expect(s, 'the date').toMatch(/2026-08-10|Aug(ust)?\.? 10|10 Aug/i);
    expect(await snap(id)).toEqual(before);
    expect(await recipeAuditCount(f.orgId)).toBe(0);
  });

  it('two drafts at two stores: the sentence counts the rest "(and 1 more)"', async () => {
    const f = await fixture('i5b');
    const id = await seedRecipe(f);
    expect((await draftCook(f, id, f.a.storeId, f.a.kitchen)).ok).toBe(true);
    expect((await draftCook(f, id, f.b.storeId, f.b.kitchen, '4', '2026-08-11')).ok).toBe(true);
    const s = await mustRefuse(() => edit(f, f.admin, id, { outputQuantity: '3' }), 'edit with two drafts');
    expect(s).toMatch(/and 1 more/i);
  });

  it('a draft of ANOTHER recipe does not block (control); a voided draft stops blocking; a POSTED cook does not block', async () => {
    const f = await fixture('i5c');
    const id = await seedRecipe(f);
    const other = await seedRecipe(f, 'Gumbo');
    expect((await draftCook(f, other, f.a.storeId, f.a.kitchen)).ok).toBe(true);
    expect((await edit(f, f.admin, id, { outputQuantity: '3' })).ok, 'a draft of another recipe blocked this one').toBe(true);

    const d = await draftCook(f, id, f.a.storeId, f.a.kitchen, '4', '2026-08-12');
    if (!d.ok) throw new Error(d.reason);
    await mustRefuse(() => edit(f, f.admin, id, { outputQuantity: '2' }), 'edit with a draft');
    // the domain has no "discard a draft" door (spec gap); the row is voided by SQL, which is what voiding a draft means.
    await sql`update production_records set status = 'void', voided_at = now(), voided_by = ${f.admin.personId}, void_reason = 'test' where id = ${d.recordId}`;
    // 2.5 kg in for 2 kg out: a cook may not output more than its inputs (production rule), so the later post can succeed.
    const enough: Line[] = [{ itemId: f.rice, quantity: '1.5' }, { itemId: f.pork, quantity: '1' }];
    expect((await edit(f, f.admin, id, { outputQuantity: '2', lines: fill(f, enough) })).ok, 'a voided draft still blocked').toBe(true);

    await stockUp(f, f.a.storeId, f.a.kitchen, f.rice, '20');
    await stockUp(f, f.a.storeId, f.a.kitchen, f.pork, '20');
    const d2 = await draftCook(f, id, f.a.storeId, f.a.kitchen, '2', '2026-08-13');
    if (!d2.ok) throw new Error(d2.reason);
    await mustRefuse(() => edit(f, f.admin, id, { outputQuantity: '2' }), 'edit with a fresh draft');
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.manager, { recordId: d2.recordId }));
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect((await edit(f, f.admin, id, { outputQuantity: '2', lines: fill(f, enough) })).ok, 'a posted cook blocked the edit').toBe(true);
  });
});

// =====================================================================================================================
describe('invariant 6 - E2: an edit is refused while a store whose map names the recipe has a planned usage pull', () => {
  const plannedPull = async (f: F, storeId: string, kitchen: string, date: string, status = 'planned') => {
    const dayId = await makeDay(f, storeId, date, []);
    if (status === 'void') {
      await sql`insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at, status, voided_at, voided_by, void_reason)
        values (${f.orgId}, ${storeId}, ${dayId}, ${kitchen}, now(), 'void', now(), ${f.admin.personId}, 'test')`;
    } else {
      await sql`insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at, status)
        values (${f.orgId}, ${storeId}, ${dayId}, ${kitchen}, now(), ${status})`;
    }
  };

  it('planned pull at A (map names the recipe) refuses, naming the store and the date; recipe unchanged. Mutant: E2 removed', async () => {
    const f = await fixture('i6a');
    const id = await seedRecipe(f);
    await rawMap(f, f.a.storeId, 'stew-box', { mode: 'recipe', recipeId: id });
    await plannedPull(f, f.a.storeId, f.a.kitchen, '2026-08-10');
    const before = await snap(id);
    const s = await mustRefuse(() => edit(f, f.admin, id, { outputQuantity: '3' }), 'edit with a planned pull');
    expect(s).toContain('Lipa');
    expect(s).toMatch(/usage pull/i);
    expect(await snap(id)).toEqual(before);
    expect(await recipeAuditCount(f.orgId)).toBe(0);
  });

  it('a planned pull at B (which does not use the recipe) does not block, even though A uses it. Mutant: E2 ignores the store filter', async () => {
    const f = await fixture('i6b');
    const id = await seedRecipe(f);
    await rawMap(f, f.a.storeId, 'stew-box', { mode: 'recipe', recipeId: id });
    await plannedPull(f, f.b.storeId, f.b.kitchen, '2026-08-10');
    const r = await edit(f, f.admin, id, { outputQuantity: '3' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('finalized/void pulls at A, or a map that is inactive, do not block (control: only PLANNED + ACTIVE map do)', async () => {
    const f = await fixture('i6c');
    const id = await seedRecipe(f);
    const m = await rawMap(f, f.a.storeId, 'stew-box', { mode: 'recipe', recipeId: id });
    await plannedPull(f, f.a.storeId, f.a.kitchen, '2026-08-10', 'void');
    expect((await edit(f, f.admin, id, { outputQuantity: '3' })).ok, 'a void pull blocked').toBe(true);
    await plannedPull(f, f.a.storeId, f.a.kitchen, '2026-08-11');
    await mustRefuse(() => edit(f, f.admin, id, { outputQuantity: '4' }), 'planned + active map');
    await sql`update pos_item_maps set status = 'inactive' where id = ${m}`;
    expect((await edit(f, f.admin, id, { outputQuantity: '4' })).ok, 'an inactive map blocked').toBe(true);
  });
});

// =====================================================================================================================
describe('invariant 7 - E3: editPostedProduction on a cook refuses once the recipe changed since posting; void still works', () => {
  async function postedCook(f: F, recipeId: string, qty = '4') {
    await stockUp(f, f.a.storeId, f.a.kitchen, f.rice, '10');
    await stockUp(f, f.a.storeId, f.a.kitchen, f.pork, '10');
    const d = await asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.manager, {
        orgId: f.orgId, storeId: f.a.storeId, locationId: f.a.kitchen, kind: 'cook', recipeId, producedOn: '2026-08-10', labourCost: '0',
        inputs: [], outputs: [{ itemId: f.stew, quantity: qty, unit: 'kg' }],
      }),
    );
    if (!d.ok) throw new Error(d.reason);
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.manager, { recordId: d.recordId }));
    if (!p.ok) throw new Error(p.reason);
    return d.recordId;
  }
  const onHand = async (itemId: string, kitchen: string) =>
    (await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and location_id = ${kitchen}`)[0]!.t;
  const editCook = (f: F, recordId: string, qty: string) =>
    asOrg(f.orgId, (tx) => editPostedProduction(tx, f.manager, { recordId, inputs: [], outputs: [{ itemId: f.stew, quantity: qty, unit: 'kg' }] }));

  it('control: with the recipe unchanged, the cook edit still works (revision 2, ingredients re-derived)', async () => {
    const f = await fixture('i7c');
    const id = await seedRecipe(f);
    const rec = await postedCook(f, id);
    const r = await editCook(f, rec, '6');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await onHand(f.rice, f.a.kitchen)).toBe('5.500');
  });

  it('recipe edited after posting -> the edit is refused with the E3 sentence; posted lines and stock unchanged; void succeeds. Mutant: E3 call removed', async () => {
    const f = await fixture('i7a');
    const id = await seedRecipe(f);
    const rec = await postedCook(f, id);
    const stockBefore = [await onHand(f.rice, f.a.kitchen), await onHand(f.pork, f.a.kitchen), await onHand(f.stew, f.a.kitchen)];
    const linesBefore = await sql`select direction, item_id, quantity::text q, unit from production_record_lines where record_id = ${rec} order by direction, item_id`;
    const ed = await edit(f, f.admin, id, { lines: [{ itemId: f.rice, quantity: '2.5' }, { itemId: f.pork, quantity: '1' }] });
    expect(ed.ok, `the recipe edit itself must be allowed (the cook is posted): ${JSON.stringify(ed)}`).toBe(true);

    const r = await editCook(f, rec, '6');
    expect(r.ok, 'the edit re-derived from the NEW recipe').toBe(false);
    if (!r.ok) expect(r.reason).toBe("The recipe 'Stew' changed after this cook was posted. Void it and record it again.");
    expect([await onHand(f.rice, f.a.kitchen), await onHand(f.pork, f.a.kitchen), await onHand(f.stew, f.a.kitchen)]).toEqual(stockBefore);
    expect(await sql`select direction, item_id, quantity::text q, unit from production_record_lines where record_id = ${rec} order by direction, item_id`).toEqual(linesBefore);
    expect((await sql<{ revision: number }[]>`select revision from production_records where id = ${rec}`)[0]!.revision).toBe(1);

    const v = await asOrg(f.orgId, (tx) => voidProduction(tx, f.manager, { recordId: rec, reason: 'recipe changed' }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(await onHand(f.rice, f.a.kitchen)).toBe('10.000');
  });
});

// =====================================================================================================================
describe('invariant 8 - retire: refused while an active POS map or an in-force/scheduled menu rule names the recipe', () => {
  it('an active v1 map names it: refused naming the POS item and counting the rest; status unchanged. Mutant: retire skips the dependents check', async () => {
    const f = await fixture('i8a');
    const id = await seedRecipe(f);
    await rawMap(f, f.a.storeId, 'stew-box', { mode: 'recipe', recipeId: id, name: 'Stew Box' });
    await rawMap(f, f.b.storeId, 'stew-box', { mode: 'recipe', recipeId: id, name: 'Stew Box' });
    const s = await mustRefuse(() => retire(f, f.admin, id), 'retire with maps');
    expect(s).toContain('Stew Box');
    expect(s).toMatch(/1 more|and 1/i);
    expect((await snap(id)).status).toBe('active');
    expect(await recipeAuditCount(f.orgId)).toBe(0);
  });

  it('once the maps are inactive, retire succeeds (control); a map in another mode or for another recipe never blocks', async () => {
    const f = await fixture('i8b');
    const id = await seedRecipe(f);
    const other = await seedRecipe(f, 'Gumbo');
    const m = await rawMap(f, f.a.storeId, 'stew-box', { mode: 'recipe', recipeId: id });
    await rawMap(f, f.a.storeId, 'gumbo-box', { mode: 'recipe', recipeId: other });
    await mustRefuse(() => retire(f, f.admin, id), 'retire with an active map');
    await sql`update pos_item_maps set status = 'inactive' where id = ${m}`;
    expect((await retire(f, f.admin, id)).ok).toBe(true);
    expect((await snap(id)).status).toBe('inactive');
  });

  it('a depletion rule in force naming it blocks; so does a scheduled one; a rule for another recipe does not', async () => {
    const f = await fixture('i8c');
    const id = await seedRecipe(f);
    const other = await seedRecipe(f, 'Gumbo');
    const vOther = await rawVariant(f, 'Gumbo Plate');
    await rawRule(f, vOther, { mode: 'recipe', recipeId: other });
    const v1 = await rawVariant(f, 'Stew Plate');
    await rawRule(f, v1, { mode: 'recipe', recipeId: id });
    await mustRefuse(() => retire(f, f.admin, id), 'retire with an in-force rule');
    const f2 = await fixture('i8d');
    const id2 = await seedRecipe(f2);
    const v2 = await rawVariant(f2, 'Stew Plate');
    await rawRule(f2, v2, { mode: 'recipe', recipeId: id2, effectiveFrom: new Date(Date.now() + 86_400_000) });
    await mustRefuse(() => retire(f2, f2.admin, id2), 'retire with a scheduled rule');
    expect((await snap(id2)).status).toBe('active');
  });

  it('a DRAFT cook open does NOT block retire, and the draft still posts afterwards (a retired recipe loads for its draft)', async () => {
    const f = await fixture('i8e');
    const id = await seedRecipe(f);
    await stockUp(f, f.a.storeId, f.a.kitchen, f.rice, '10');
    await stockUp(f, f.a.storeId, f.a.kitchen, f.pork, '10');
    const d = await asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.manager, {
        orgId: f.orgId, storeId: f.a.storeId, locationId: f.a.kitchen, kind: 'cook', recipeId: id, producedOn: '2026-08-10', labourCost: '0',
        inputs: [], outputs: [{ itemId: f.stew, quantity: '4', unit: 'kg' }],
      }),
    );
    if (!d.ok) throw new Error(d.reason);
    const r = await retire(f, f.admin, id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.manager, { recordId: d.recordId }));
    expect(p.ok, JSON.stringify(p)).toBe(true);
  });

  it('restore: refused while the output item or any ingredient is retired, in a sentence naming it; works once active again', async () => {
    const f = await fixture('i8f');
    const id = await seedRecipe(f);
    expect((await retire(f, f.admin, id)).ok).toBe(true);
    await sql`update items set status = 'inactive' where id = ${f.pork}`;
    const s = await mustRefuse(() => restore(f, f.admin, id), 'restore with a retired ingredient');
    expect(s).toContain('Pork');
    expect((await snap(id)).status).toBe('inactive');
    await sql`update items set status = 'active' where id = ${f.pork}`;
    await sql`update items set status = 'inactive' where id = ${f.stew}`;
    expect(await mustRefuse(() => restore(f, f.admin, id), 'restore with a retired output')).toContain('Stew');
    await sql`update items set status = 'active' where id = ${f.stew}`;
    expect((await restore(f, f.admin, id)).ok).toBe(true);
  });

  it('retiring an already-retired recipe, or restoring an active one, is not a silent success that writes audit', async () => {
    const f = await fixture('i8g');
    const id = await seedRecipe(f);
    const a = await refusalOf(() => restore(f, f.admin, id));
    const rows = await recipeAuditCount(f.orgId);
    expect(a !== null || rows === 0, 'restore of an active recipe wrote an audit row').toBe(true);
  });
});

// =====================================================================================================================
describe('invariant 9 - exactly one audit row per write, with the R5 action and before/after; none for a refusal', () => {
  const shape = (f: F, name: string, qty: number, lines: [string, number, string][]) => ({
    name, outputItemId: f.stew, outputQuantity: qty,
    lines: lines.map(([itemId, quantity, unit]) => ({ itemId, quantity, unit })).sort((x, y) => x.itemId.localeCompare(y.itemId)),
  });
  /** quantities compared as numbers (the spec fixes the keys, not the decimal text); lines sorted by item. */
  const norm = (j: unknown) => {
    const o = j as { name: string; outputItemId: string; outputQuantity: string | number; lines: { itemId: string; quantity: string | number; unit: string }[] };
    expect(Object.keys(o).sort()).toEqual(['lines', 'name', 'outputItemId', 'outputQuantity']);
    for (const l of o.lines) expect(Object.keys(l).sort()).toEqual(['itemId', 'quantity', 'unit']);
    return {
      name: o.name, outputItemId: o.outputItemId, outputQuantity: Number(o.outputQuantity),
      lines: o.lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unit: l.unit })).sort((x, y) => x.itemId.localeCompare(y.itemId)),
    };
  };

  it('create / edit / retire / restore each append ONE row; create has before null; edit carries old and new. Mutant: append before the guards', async () => {
    const f = await fixture('i9');
    const c = await create(f, f.admin, { name: 'Goulash', outputQuantity: '2', lines: [{ itemId: f.rice, quantity: '1' }, { itemId: f.pork, quantity: '0.5' }] });
    if (!c.ok) throw new Error(c.reason);
    let rows = await recipeAudit(f.orgId);
    expect(rows.map((r) => r.action)).toEqual(['production.recipe_create']);
    expect(rows[0]!.entity).toBe('production_recipes');
    expect(rows[0]!.entity_id).toBe(c.recipeId);
    expect(rows[0]!.actor_person_id).toBe(f.admin.personId);
    expect(rows[0]!.before).toBeNull();
    const created = shape(f, 'Goulash', 2, [[f.rice, 1, 'kg'], [f.pork, 0.5, 'kg']]);
    expect(norm(rows[0]!.after)).toEqual(created);

    const e = await edit(f, f.admin, c.recipeId, { name: 'Goulash 2', outputQuantity: '3', lines: [{ itemId: f.rice, quantity: '1.5' }] });
    expect(e.ok, JSON.stringify(e)).toBe(true);
    rows = await recipeAudit(f.orgId);
    expect(rows.map((r) => r.action)).toEqual(['production.recipe_create', 'production.recipe_edit']);
    expect(norm(rows[1]!.before)).toEqual(created);
    expect(norm(rows[1]!.after)).toEqual(shape(f, 'Goulash 2', 3, [[f.rice, 1.5, 'kg']]));

    expect((await retire(f, f.admin, c.recipeId)).ok).toBe(true);
    expect((await restore(f, f.admin, c.recipeId)).ok).toBe(true);
    rows = await recipeAudit(f.orgId);
    expect(rows.map((r) => r.action)).toEqual(['production.recipe_create', 'production.recipe_edit', 'production.recipe_retire', 'production.recipe_restore']);
    for (const r of rows.slice(2)) {
      expect(r.entity_id).toBe(c.recipeId);
      expect(norm(r.before)).toEqual(shape(f, 'Goulash 2', 3, [[f.rice, 1.5, 'kg']]));
      expect(norm(r.after)).toEqual(shape(f, 'Goulash 2', 3, [[f.rice, 1.5, 'kg']]));
    }
  });

  it('a refused write of every kind appends nothing (guard, E1 refusal, dependents refusal, bad figure)', async () => {
    const f = await fixture('i9r');
    const id = await seedRecipe(f);
    await rawMap(f, f.a.storeId, 'stew-box', { mode: 'recipe', recipeId: id });
    await mustRefuse(() => create(f, f.admin, { outputQuantity: '0' }), 'create');
    await mustRefuse(() => edit(f, f.admin, id, { lines: [] }), 'edit');
    await mustRefuse(() => retire(f, f.admin, id), 'retire');
    await mustRefuse(() => restore(f, f.admin, id), 'restore of an active recipe');
    expect(await recipeAuditCount(f.orgId)).toBe(0);
  });
});

// =====================================================================================================================
describe('invariant 10 - another org\'s recipe is invisible and cannot be written', () => {
  it('list/get from org B do not show A\'s recipe; edit / retire / restore by B\'s admin fail and change nothing. Mutant: org_id filter dropped', async () => {
    const a = await fixture('i10a');
    const b = await fixture('i10b');
    const id = await seedRecipe(a);
    const before = await snap(id);

    expect(await asOrg(b.orgId, (tx) => productionRepo.getRecipe(tx, b.orgId, id))).toBeUndefined();
    expect((await asOrg(b.orgId, (tx) => productionRepo.listRecipes(tx, b.orgId, true))).map((r) => r.id)).not.toContain(id);
    expect((await asOrg(a.orgId, (tx) => productionRepo.listRecipes(tx, a.orgId, true))).map((r) => r.id)).toContain(id);

    for (const [what, run] of [
      ['edit', () => asOrg(b.orgId, (tx) => api.editRecipe(tx, b.admin, { ...input(b, { name: 'Stew' }), recipeId: id }))],
      ['retire', () => asOrg(b.orgId, (tx) => api.retireRecipe(tx, b.admin, { recipeId: id }))],
      ['restore', () => asOrg(b.orgId, (tx) => api.restoreRecipe(tx, b.admin, { recipeId: id }))],
    ] as const) {
      const r = await attempt(run);
      expect(r.failed, `${what}: org B's admin changed org A's recipe`).toBe(true);
      expect(await snap(id)).toEqual(before);
    }
    expect(await recipeAuditCount(a.orgId)).toBe(0);
  });

  it('with the database filter pointing at A (wrong tenant context) and the actor in B, the repo/domain filter alone must refuse', async () => {
    const a = await fixture('i10c');
    const b = await fixture('i10d');
    const id = await seedRecipe(a);
    const before = await snap(id);
    const wrongContext = <T>(fn: (tx: Tx) => Promise<T>) =>
      transaction(async (tx) => {
        await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
        await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
        await tx.execute(dsql`select set_config('app.org_id', ${a.orgId}, true)`);
        return fn(tx);
      });
    for (const run of [
      () => wrongContext((tx) => api.editRecipe(tx, b.admin, { ...input(b, { name: 'Stew' }), recipeId: id })),
      () => wrongContext((tx) => api.retireRecipe(tx, b.admin, { recipeId: id })),
    ]) {
      const r = await attempt(run);
      expect(r.failed, 'a cross-tenant write got through').toBe(true);
    }
    expect(await snap(id)).toEqual(before);
  });
});
