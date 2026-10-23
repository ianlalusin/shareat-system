import { afterAll, describe, expect, it, vi } from 'vitest';

import { cast, expectSentenceError, fd, plain, render, run, sql, type Cast } from './t401-s4-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

// T-448: a known verb (Approve, Reject, Save recipe, ...) is an icon button: its words are the aria-label, not visible text.
// Expose them to the text checks so "shows X" and "does not show X" both still mean something.
const plainL = (html: string): string => plain(html.replace(/<button\b[^>]*aria-label="([^"]*)"[^>]*>/g, '<button> $1 '));

/**
 * T-413 S2 - the recipe screens and their actions (docs/tasks/413-production-recipe-admin.md R6, invariant 11), built with
 * Q1 = (a), Q2 = (a). TESTER, not BUILDER. Red today: apps/erp/src/app/inventory/production/recipes/** does not exist (module
 * not found on every leg) and the "Recipes" link is absent.
 *
 * THE CONTRACT THE BUILDER FOLLOWS - the spec fixes the routes and the buttons' existence, NOT these names; the tester pinned them
 * (every one is in the report):
 *  - pages (default export, props { params, searchParams } as Promises, `dynamic = 'force-dynamic'`, renderable by
 *    renderToStaticMarkup, no async child components):
 *      recipes/page.tsx        list; `?status=active|retired|all`, default active (retired = status 'inactive')
 *      recipes/new/page.tsx    the create form
 *      recipes/[id]/page.tsx   view + edit form + retire/restore; unknown id or another org's id -> notFound()
 *  - actions (recipes/actions.ts, `'use server'`, `(fd: FormData) => Promise<void>`, always end in redirectWithFlash, the actor from
 *    the session, errors as sentences):
 *      createRecipeAction   fields: name, outputItemId, outputQuantity, lineItemId (repeated), lineQuantity (repeated, same order)
 *      editRecipeAction     the same fields + recipeId
 *      retireRecipeAction / restoreRecipeAction   field: recipeId
 *    NO unit field is sent by the form (R1); a hostile client sending `lineUnit` = 'g' is refused or ignored, never stored.
 *    Redirects stay under /inventory/production/recipes (create may go to the new recipe's page).
 *  - words: link "New recipe"; detail buttons "Save recipe", "Retire recipe", "Restore recipe"; field labels "Output quantity, in <unit>"
 *    and, per ingredient line, "Quantity, in <unit>"; the list says "Makes <qty> <unit> of <item>" and "<n> ingredients".
 *  - "Recipes" link on /inventory/production: href="/inventory/production/recipes".
 * Mutants: buttons rendered without the capability check; the form label ignores the item's base unit; a unit field in the
 * form; retired recipes in the default list; another org's recipe opens; the action trusts a client unit.
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

const LIST = () => import('../../src/app/inventory/production/recipes/page');
const NEW = () => import('../../src/app/inventory/production/recipes/new/page');
const DETAIL = () => import('../../src/app/inventory/production/recipes/[id]/page');
const ACTIONS = () => import('../../src/app/inventory/production/recipes/actions');
const PRODUCTION = () => import('../../src/app/inventory/production/page');
const BASE = '/inventory/production/recipes';

interface W { c: Cast; stewOut: string; rice: string; sauce: string; stew: string; retired: string }

async function item(c: Cast, name: string, unit: string): Promise<string> {
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${c.orgId}, ${testItemCode()}, ${name}, 'raw_material', ${unit}, ${c.admin.personId}) returning id`;
  return i!.id;
}
async function recipe(c: Cast, name: string, out: string, lines: [string, string, string][], status = 'active'): Promise<string> {
  const [r] = await sql<{ id: string }[]>`insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by, status) values (${c.orgId}, ${name}, ${out}, 2, ${c.admin.personId}, ${status}) returning id`;
  for (const [itemId, q, unit] of lines) await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${itemId}, ${q}, ${unit})`;
  return r!.id;
}
/** Org with: 'Stew' (active; 2 kg of Stew Out from Rice 1.5 kg + Sauce 1 pcs) and 'Old Chowder' (retired). */
async function world(hint: string): Promise<W> {
  const c = await cast(`s2413-${hint}`);
  const stewOut = await item(c, 'Stew Out', 'kg');
  const rice = await item(c, 'Rice', 'kg');
  const sauce = await item(c, 'Sauce', 'pcs');
  const stew = await recipe(c, 'Stew', stewOut, [[rice, '1.5', 'kg'], [sauce, '1', 'pcs']]);
  const retired = await recipe(c, 'Old Chowder', stewOut, [[rice, '1', 'kg']], 'inactive');
  return { c, stewOut, rice, sauce, stew, retired };
}
const recipeRow = async (id: string) => (await sql<{ name: string; status: string; q: string }[]>`select name, status, output_quantity::text q from production_recipes where id = ${id}`)[0];
const linesOf = async (id: string) => sql<{ item_id: string; q: string; unit: string }[]>`select item_id, quantity::text q, unit from production_recipe_lines where recipe_id = ${id} order by item_id`;
const recipeCount = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text n from production_recipes where org_id = ${orgId}`)[0]!.n);

// =====================================================================================================================
describe('invariant 11 - /inventory/production/recipes: the list', () => {
  it('a manager reads the list (name, "Makes 2 kg of Stew Out", ingredient count) and sees no New-recipe control. Mutant: buttons without the capability check', async () => {
    const w = await world('list-m');
    const html = await render(LIST, w.c.manager, {});
    const t = plainL(html);
    expect(t).toContain('Stew');
    expect(t).toContain('Stew Out');
    expect(t).toMatch(/Makes\s+2(\.0+)?\s*kg\s+of\s+Stew Out/);
    expect(t).toMatch(/2 ingredients/);
    expect(t).not.toContain('New recipe');
    expect(html).not.toContain(`${BASE}/new`);
  });

  it('an admin sees the New-recipe control linking to /new', async () => {
    const w = await world('list-a');
    const html = await render(LIST, w.c.admin, {});
    expect(plainL(html)).toContain('New recipe');
    expect(html).toContain(`href="${BASE}/new"`);
    expect(html).toContain(`href="${BASE}/${w.stew}"`);
  });

  it('the filter: default = active only; ?status=retired = retired only; ?status=all = both. Mutant: retired recipes in the default list', async () => {
    const w = await world('list-f');
    const def = plainL(await render(LIST, w.c.admin, {}));
    expect(def).toContain('Stew');
    expect(def).not.toContain('Old Chowder');
    const ret = plainL(await render(LIST, w.c.admin, { search: { status: 'retired' } }));
    expect(ret).toContain('Old Chowder');
    expect(ret).not.toMatch(/Stew(?! Out)/);
    const all = plainL(await render(LIST, w.c.admin, { search: { status: 'all' } }));
    expect(all).toContain('Old Chowder');
    expect(all).toMatch(/Stew(?! Out)/);
  });

  it("another org's recipes never appear", async () => {
    const w = await world('list-o1');
    const o = await world('list-o2');
    await sql`update production_recipes set name = 'Foreign Secret' where id = ${o.stew}`;
    expect(plainL(await render(LIST, w.c.admin, { search: { status: 'all' } }))).not.toContain('Foreign Secret');
  });
});

// =====================================================================================================================
describe('invariant 11 - /inventory/production/recipes/[id]: view, edit form, retire / restore', () => {
  it('a manager sees the recipe and its lines but NO edit form, Save, Retire or Restore. Mutant: buttons without the capability check', async () => {
    const w = await world('det-m');
    for (const id of [w.stew, w.retired]) {
      const html = await render(DETAIL, w.c.manager, { params: { id } });
      const t = plainL(html);
      expect(t).toMatch(/Stew|Old Chowder/);
      expect(t).toContain('Rice');
      for (const bad of ['Save recipe', 'Retire recipe', 'Restore recipe']) expect(t, bad).not.toContain(bad);
      expect(html, 'an editable output field is drawn').not.toMatch(/name="outputQuantity"/);
      expect(html).not.toMatch(/name="lineQuantity"/);
    }
  });

  it('an admin sees the form: label "Output quantity, in kg" for a kg output, per-line "Quantity, in kg" / "in pcs", no unit field. Mutants: label ignores the base unit; a unit control exists', async () => {
    const w = await world('det-a');
    const html = await render(DETAIL, w.c.admin, { params: { id: w.stew } });
    const t = plainL(html);
    expect(t).toContain('Save recipe');
    expect(t).toContain('Retire recipe');
    expect(t).not.toContain('Restore recipe');
    expect(t).toContain('Output quantity, in kg');
    expect(t).toContain('Quantity, in kg');
    expect(t).toContain('Quantity, in pcs');
    expect(html).toMatch(/name="outputQuantity"/);
    expect(html, 'the form must send no unit').not.toMatch(/name="[^"]*unit[^"]*"/i);
    expect(html).toContain(w.stew);
  });

  it('the output label follows the OUTPUT item: a pcs output reads "in pcs"', async () => {
    const w = await world('det-pcs');
    const [r] = await sql<{ id: string }[]>`insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${w.c.orgId}, 'Sauce batch', ${w.sauce}, 10, ${w.c.admin.personId}) returning id`;
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${w.rice}, 1, 'kg')`;
    expect(plainL(await render(DETAIL, w.c.admin, { params: { id: r!.id } }))).toContain('Output quantity, in pcs');
  });

  it('a retired recipe offers Restore, not Retire (admin); a legacy gram line is pre-filled converted to kg', async () => {
    const w = await world('det-r');
    const t = plainL(await render(DETAIL, w.c.admin, { params: { id: w.retired } }));
    expect(t).toContain('Restore recipe');
    expect(t).not.toContain('Retire recipe');
    const g = await recipe(w.c, 'Gram recipe', w.stewOut, [[w.rice, '500', 'g']]);
    const html = await render(DETAIL, w.c.admin, { params: { id: g } });
    expect(html, 'the 500 g line is pre-filled as 0.5 kg').toMatch(/name="lineQuantity"[^>]*value="0\.5(00)?"|value="0\.5(00)?"[^>]*name="lineQuantity"/);
  });

  it("an unknown id or another org's id is not found", async () => {
    const w = await world('det-o1');
    const o = await world('det-o2');
    await expect(render(DETAIL, w.c.admin, { params: { id: '00000000-0000-4000-8000-000000000000' } })).rejects.toThrow(/NEXT_NOT_FOUND/);
    await expect(render(DETAIL, w.c.admin, { params: { id: o.stew } })).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});

// =====================================================================================================================
describe('invariant 11 - /new', () => {
  it('an admin gets the form (name, output item, output quantity, ingredient rows); a manager gets no form', async () => {
    const w = await world('new');
    const html = await render(NEW, w.c.admin, {});
    expect(html).toMatch(/name="name"/);
    expect(html).toMatch(/name="outputItemId"/);
    expect(html).toMatch(/name="outputQuantity"/);
    expect(html).toMatch(/name="lineItemId"/);
    expect(html).not.toMatch(/name="[^"]*unit[^"]*"/i);
    let drawn: string | null = null;
    try {
      drawn = await render(NEW, w.c.manager, {});
    } catch (e) {
      expect(String((e as Error).message), 'only a redirect / not-found is an acceptable refusal').toMatch(/NEXT_REDIRECT|NEXT_NOT_FOUND/);
    }
    if (drawn !== null) {
      expect(drawn, 'a manager was given the create form').not.toMatch(/name="outputQuantity"/);
      expect(plainL(drawn)).not.toContain('Save recipe');
    }
  });
});

// =====================================================================================================================
describe('the actions (thin adapters over the domain)', () => {
  const createForm = (w: W, over: Record<string, string | string[] | undefined> = {}) =>
    fd({ name: 'Goulash', outputItemId: w.stewOut, outputQuantity: '2', lineItemId: [w.rice, w.sauce], lineQuantity: ['1.5', '3'], ...over });

  it("createRecipeAction as admin: saved with each line in its item's BASE unit (kg, pcs), a success banner, nothing typed in the URL", async () => {
    const w = await world('act-c');
    const before = await recipeCount(w.c.orgId);
    const r = await run(ACTIONS, 'createRecipeAction', w.c.admin, createForm(w));
    expect(r.flash.error, `unexpected error: ${r.flash.error}`).toBeUndefined();
    expect(r.flash.ok).toBeTruthy();
    expect(r.path.startsWith(BASE)).toBe(true);
    expect(r.url).not.toContain('Goulash');
    expect(await recipeCount(w.c.orgId)).toBe(before + 1);
    const [row] = await sql<{ id: string }[]>`select id from production_recipes where org_id = ${w.c.orgId} and name = 'Goulash'`;
    expect((await linesOf(row!.id)).map((l) => `${l.item_id}|${l.q}|${l.unit}`).sort()).toEqual([`${w.rice}|1.500|kg`, `${w.sauce}|3.000|pcs`].sort());
  });

  it('a unit sent by a hostile client is never stored: "g" for a kg item is refused (sentence, no row) or ignored (base unit stored). Mutant: the action trusts a client unit', async () => {
    const w = await world('act-u');
    const before = await recipeCount(w.c.orgId);
    const r = await run(ACTIONS, 'createRecipeAction', w.c.admin, createForm(w, { lineUnit: ['g', 'pcs'], unit: 'g' }));
    const [row] = await sql<{ id: string }[]>`select id from production_recipes where org_id = ${w.c.orgId} and name = 'Goulash'`;
    if (row) {
      expect((await linesOf(row.id)).map((l) => l.unit).sort(), 'a client unit reached the table').toEqual(['kg', 'pcs']);
    } else {
      expectSentenceError(r.flash.error, 'hostile unit');
      expect(await recipeCount(w.c.orgId)).toBe(before);
    }
  });

  it('a manager posting the create form is refused in a sentence, no row (the page hiding the button is not the gate)', async () => {
    const w = await world('act-m');
    const before = await recipeCount(w.c.orgId);
    const r = await run(ACTIONS, 'createRecipeAction', w.c.manager, createForm(w));
    expectSentenceError(r.flash.error, 'manager create');
    expect(await recipeCount(w.c.orgId)).toBe(before);
  });

  it('a bad figure (10000.001, abc, 0) is a sentence banner, no row', async () => {
    const w = await world('act-b');
    const before = await recipeCount(w.c.orgId);
    for (const bad of ['10000.001', 'abc', '0']) {
      const r = await run(ACTIONS, 'createRecipeAction', w.c.admin, createForm(w, { outputQuantity: bad }));
      expectSentenceError(r.flash.error, `output ${bad}`);
    }
    expect(await recipeCount(w.c.orgId)).toBe(before);
  });

  it('editRecipeAction as admin saves new lines (base unit); with a draft cook open it is refused with the "Post or void" sentence and nothing changes', async () => {
    const w = await world('act-e');
    const form = (q: string) => fd({ recipeId: w.stew, name: 'Stew', outputItemId: w.stewOut, outputQuantity: q, lineItemId: [w.rice], lineQuantity: ['2'] });
    const ok = await run(ACTIONS, 'editRecipeAction', w.c.admin, form('3'));
    expect(ok.flash.error, `unexpected error: ${ok.flash.error}`).toBeUndefined();
    expect((await recipeRow(w.stew))!.q).toBe('3.000');
    expect((await linesOf(w.stew)).map((l) => `${l.q}|${l.unit}`)).toEqual(['2.000|kg']);

    const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${w.c.orgId}, 'STK', 'Stk') returning id`;
    const [loc] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${w.c.orgId}, ${w.c.storeA}, 'KIT', 'Kitchen', ${t!.id}, 'operating', true, ${w.c.admin.personId}) returning id`;
    await sql`insert into production_records (org_id, store_id, location_id, kind, recipe_id, produced_on, created_by) values (${w.c.orgId}, ${w.c.storeA}, ${loc!.id}, 'cook', ${w.stew}, '2026-08-10', ${w.c.admin.personId})`;
    const before = await linesOf(w.stew);
    const bad = await run(ACTIONS, 'editRecipeAction', w.c.admin, form('5'));
    expectSentenceError(bad.flash.error, 'edit with a draft');
    expect(bad.flash.error).toMatch(/Post or void/i);
    expect((await recipeRow(w.stew))!.q).toBe('3.000');
    expect(await linesOf(w.stew)).toEqual(before);
  });

  it('retireRecipeAction: refused while a POS item uses the recipe (names it), succeeds after; restoreRecipeAction brings it back; a manager is refused', async () => {
    const w = await world('act-r');
    await sql`insert into pos_item_maps (org_id, store_id, pos_item_key, pos_item_name, mode, recipe_id, status, created_by) values (${w.c.orgId}, ${w.c.storeA}, 'stew-box', 'Stew Box', 'recipe', ${w.stew}, 'active', ${w.c.admin.personId})`;
    const blocked = await run(ACTIONS, 'retireRecipeAction', w.c.admin, fd({ recipeId: w.stew, confirmName: 'Stew' }));
    expectSentenceError(blocked.flash.error, 'retire with a map');
    expect(blocked.flash.error).toContain('Stew Box');
    expect((await recipeRow(w.stew))!.status).toBe('active');

    const mgr = await run(ACTIONS, 'retireRecipeAction', w.c.manager, fd({ recipeId: w.stew }));
    expectSentenceError(mgr.flash.error, 'manager retire');
    expect((await recipeRow(w.stew))!.status).toBe('active');

    await sql`update pos_item_maps set status = 'inactive' where recipe_id = ${w.stew}`;
    const ok = await run(ACTIONS, 'retireRecipeAction', w.c.admin, fd({ recipeId: w.stew, confirmName: 'Stew' }));
    expect(ok.flash.error, `unexpected error: ${ok.flash.error}`).toBeUndefined();
    expect((await recipeRow(w.stew))!.status).toBe('inactive');
    const back = await run(ACTIONS, 'restoreRecipeAction', w.c.admin, fd({ recipeId: w.stew }));
    expect(back.flash.error, `unexpected error: ${back.flash.error}`).toBeUndefined();
    expect((await recipeRow(w.stew))!.status).toBe('active');
  });
});

// =====================================================================================================================
describe('/inventory/production links to the recipes screen', () => {
  it('shows a "Recipes" link to /inventory/production/recipes', async () => {
    const w = await world('link');
    const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${w.c.orgId}, 'STK', 'Stk') returning id`;
    await sql`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${w.c.orgId}, ${w.c.storeA}, 'KIT', 'Kitchen', ${t!.id}, 'operating', true, ${w.c.admin.personId})`;
    const html = await render(PRODUCTION, w.c.manager, { search: { store: w.c.storeA } });
    expect(html).toContain(`href="${BASE}"`);
    expect(plainL(html)).toContain('Recipes');
  });
});
