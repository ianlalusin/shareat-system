import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * T-409 S2 - invariant 10: the production screen offers one form per kind (`?kind=slice|cook|convert`), the pickers are
 * filtered by item kind, and the cook form sends a recipe. `docs/tasks/409-production-slice-pickers.md` R4. Q1 = (a), Q2 = (a).
 *
 * TESTER. Red on HEAD for the right reasons: the one form lists EVERY item in both pickers (slice / convert assertions), shows
 * input rows and no recipe select for a cook (cook assertions), and `saveProductionDraftAction` never sends `recipeId`
 * (action assertion: the cook is refused at HEAD, "a production run needs at least one input").
 *
 * ASSUMED (the spec leaves them open; the builder may differ and I will follow):
 *  - the nav key is `kind` (spec R4); the selects keep the existing field names `inputItemId` / `outputItemId`;
 *  - the cook form's fields are `recipeId` (select) and `outputQuantity`; the action test ALSO sends `outputItemId` and
 *    `outputUnit` so it works whether the builder reads them or derives them from the recipe;
 *  - the "no recipe exists" sentence mentions both "recipe" and "admin".
 * The domain half of every rule is in `packages/domain/tests/integration/t409-s1-production-rules.test.ts`.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/flash-jar-core')).nextNavigationMock(),
}));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { closeDb } from '@shareat/db';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** Items: kinds meat_slab x2, meat_sliced x2, raw_material (Flour, Stock, Soup), supply. Recipe 'Soup batch': 2 kg out from 500 g Flour + 1.5 kg Stock. */
async function fixture(hint: string, withRecipe = true) {
  const code = uid(`t409s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Lipa', '2020-01-01') returning id`;
  const storeId = store!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = p!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'A', 'Stockroom A', ${lt!.id}, 'operating', true, ${adminId}) returning id`;
  const mk = async (name: string, kind: string, parent: string | null = null) => {
    const [r] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
      values (${orgId}, ${testItemCode()}, ${name}, ${kind}, 'kg', ${parent}, ${adminId}) returning id`;
    return r!.id;
  };
  const slabA = await mk('Alpha Slab', 'meat_slab');
  const slabB = await mk('Bravo Slab', 'meat_slab');
  const slicedA = await mk('Alpha Sliced', 'meat_sliced', slabA);
  const slicedB = await mk('Bravo Sliced', 'meat_sliced', slabB);
  const flour = await mk('Charlie Flour', 'raw_material');
  const stock = await mk('Delta Stock', 'raw_material');
  const soup = await mk('Echo Soup', 'raw_material');
  const supply = await mk('Foxtrot Gloves', 'supply');
  let recipeId = '';
  if (withRecipe) {
    const [rec] = await sql<{ id: string }[]>`
      insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
      values (${orgId}, 'Soup batch', ${soup}, 2, ${adminId}) returning id`;
    recipeId = rec!.id;
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${recipeId}, ${flour}, 500, 'g'), (${recipeId}, ${stock}, 1.5, 'kg')`;
    // A second, INACTIVE recipe that must not be offered.
    const [dead] = await sql<{ id: string }[]>`
      insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by, status)
      values (${orgId}, 'Retired chowder', ${soup}, 2, ${adminId}, 'inactive') returning id`;
    void dead;
  }
  return { orgId, storeId, adminId, locationId: loc!.id, items: { slabA, slabB, slicedA, slicedB, flour, stock, soup, supply }, recipeId };
}

async function render(f: { orgId: string; adminId: string; storeId: string }, kind?: string): Promise<string> {
  ACTOR_HOLDER.actor = { orgId: f.orgId, personId: f.adminId };
  const Page = (await import('../../src/app/inventory/production/page')).default;
  const sp: Record<string, string> = { store: f.storeId };
  if (kind) sp.kind = kind;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(sp) })) as never);
}

/** The visible option labels of every <select name="..."> in the markup (empty list if none). */
function optionLabels(html: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'g');
  for (const m of html.matchAll(re)) {
    for (const o of m[1]!.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)) out.push(o[1]!.replace(/<[^>]+>/g, '').trim());
  }
  return out;
}
const hasName = (labels: string[], name: string) => labels.some((l) => l.includes(name));

describe('invariant 10 - ?kind=slice: inputs list slabs only, outputs sliced meat only', () => {
  it('Mutant: unfiltered list -> Flour / Soup / Gloves / the sliced items appear in the input picker -> red', async () => {
    const f = await fixture('slice');
    const html = await render(f, 'slice');
    const ins = optionLabels(html, 'inputItemId');
    const outs = optionLabels(html, 'outputItemId');
    expect(ins.length, 'no input picker rendered').toBeGreaterThan(0);
    expect(hasName(ins, 'Alpha Slab')).toBe(true);
    expect(hasName(ins, 'Bravo Slab')).toBe(true);
    for (const bad of ['Alpha Sliced', 'Bravo Sliced', 'Charlie Flour', 'Delta Stock', 'Echo Soup', 'Foxtrot Gloves']) {
      expect(hasName(ins, bad), `${bad} is offered as a slice INPUT`).toBe(false);
    }
    expect(hasName(outs, 'Alpha Sliced')).toBe(true);
    expect(hasName(outs, 'Bravo Sliced')).toBe(true);
    for (const bad of ['Alpha Slab', 'Bravo Slab', 'Charlie Flour', 'Delta Stock', 'Echo Soup', 'Foxtrot Gloves']) {
      expect(hasName(outs, bad), `${bad} is offered as a slice OUTPUT`).toBe(false);
    }
  }, 60_000);
});

describe('invariant 10 - ?kind=convert: both lists sliced meat only', () => {
  it('Mutant: unfiltered lists', async () => {
    const f = await fixture('convert');
    const html = await render(f, 'convert');
    for (const [label, list] of [['input', optionLabels(html, 'inputItemId')], ['output', optionLabels(html, 'outputItemId')]] as const) {
      expect(list.length, `no ${label} picker rendered`).toBeGreaterThan(0);
      expect(hasName(list, 'Alpha Sliced')).toBe(true);
      expect(hasName(list, 'Bravo Sliced')).toBe(true);
      for (const bad of ['Alpha Slab', 'Bravo Slab', 'Charlie Flour', 'Delta Stock', 'Echo Soup', 'Foxtrot Gloves']) {
        expect(hasName(list, bad), `${bad} is offered as a convert ${label}`).toBe(false);
      }
    }
  }, 60_000);
});

describe('invariant 10 - ?kind=cook: a recipe, no input rows', () => {
  it('has a recipe select with the ACTIVE recipe only, and no input item / quantity fields. Mutant: input rows still rendered', async () => {
    const f = await fixture('cook');
    const html = await render(f, 'cook');
    const recipes = optionLabels(html, 'recipeId');
    expect(recipes.length, 'no recipe select').toBeGreaterThan(0);
    expect(hasName(recipes, 'Soup batch')).toBe(true);
    expect(hasName(recipes, 'Retired chowder'), 'an inactive recipe is offered').toBe(false);
    expect(html).not.toMatch(/name="inputItemId"/);
    expect(html).not.toMatch(/name="inputQuantity"/);
    expect(html).not.toMatch(/name="inputUnit"/);
    expect(html, 'an output quantity field is missing').toMatch(/name="outputQuantity"/);
  }, 60_000);

  it('with no recipe at all: a sentence says a recipe is needed and an admin adds it; no form to submit blind. Mutant: sentence missing', async () => {
    const f = await fixture('cook-none', false);
    const html = await render(f, 'cook');
    expect(html).toMatch(/recipe/i);
    expect(html).toMatch(/admin/i);
    expect(html).not.toMatch(/name="inputItemId"/);
  }, 60_000);
});

describe('invariant 10 - the action sends the recipe: a cook saved from the form is a recipe-derived draft', () => {
  it('saveProductionDraftAction with recipeId + 4 kg -> redirect to the record, recipe stored, inputs derived (Flour 1.000, Stock 3.000). Mutant: recipeId not sent -> the cook is refused', async () => {
    const f = await fixture('action');
    ACTOR_HOLDER.actor = { orgId: f.orgId, personId: f.adminId };
    const { saveProductionDraftAction } = await import('../../src/app/inventory/production/actions');
    const fd = new FormData();
    fd.set('storeId', f.storeId);
    fd.set('locationId', f.locationId);
    fd.set('kind', 'cook');
    fd.set('producedOn', '2026-06-10');
    fd.set('labourCost', '');
    fd.set('recipeId', f.recipeId);
    fd.set('outputItemId', f.items.soup);
    fd.set('outputQuantity', '4');
    fd.set('outputUnit', 'kg');
    const signal = await captureRedirect(() => saveProductionDraftAction(fd));
    const out = outcomeOf(signal);
    expect(out.path, `refused or sent back to the list: ${JSON.stringify(out.flash)}`).toMatch(/^\/inventory\/production\/[0-9a-f-]{36}$/);
    const recordId = out.path.split('/').pop()!;
    const [rec] = await sql<{ recipe_id: string | null; kind: string }[]>`select recipe_id, kind from production_records where id = ${recordId}`;
    expect(rec!.kind).toBe('cook');
    expect(rec!.recipe_id).toBe(f.recipeId);
    const lines = await sql<{ direction: string; item_id: string; q: string }[]>`
      select direction, item_id, quantity::text as q from production_record_lines where record_id = ${recordId}`;
    const key = (l: { direction: string; item_id: string; q: string }) => `${l.direction}|${l.item_id}|${l.q}`;
    expect(lines.map(key).sort()).toEqual([`out|${f.items.flour}|1.000`, `out|${f.items.stock}|3.000`, `in|${f.items.soup}|4.000`].sort());
  }, 60_000);

  it('a slice posted to the action with a non-slab input comes back as an ?error sentence and writes nothing. Mutant: action bypasses the domain rule', async () => {
    const f = await fixture('action-slice');
    ACTOR_HOLDER.actor = { orgId: f.orgId, personId: f.adminId };
    const { saveProductionDraftAction } = await import('../../src/app/inventory/production/actions');
    const fd = new FormData();
    fd.set('storeId', f.storeId);
    fd.set('locationId', f.locationId);
    fd.set('kind', 'slice');
    fd.set('producedOn', '2026-06-10');
    fd.set('inputItemId', f.items.flour);
    fd.set('inputQuantity', '10');
    fd.set('inputUnit', 'kg');
    fd.set('outputItemId', f.items.slicedA);
    fd.set('outputQuantity', '9');
    fd.set('outputUnit', 'kg');
    const out = outcomeOf(await captureRedirect(() => saveProductionDraftAction(fd)));
    expect(out.path).toBe('/inventory/production');
    expect(out.flash.error ?? '').toMatch(/slab/i);
    expect(out.flash.error ?? '').toContain('Charlie Flour');
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from production_records where org_id = ${f.orgId}`;
    expect(n!.n).toBe('0');
  }, 60_000);
});

beforeAll(() => {
  // Rendering imports the real page; nothing to prepare, kept for symmetry with the sibling page tests.
});
