import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-409 audit round - R-B (authorize first on the cook action) and R-A (recipe form states the base unit). TESTER.
 * R-B: a caller without `record_stock_movement` gets the SAME refusal whether the recipeId exists or not.
 * R-A: no recipe form exists on HEAD (createRecipe has no caller in apps/erp, editRecipe does not exist) - the form test is
 * red until one is built; its label must read "Output quantity, in <base unit>".
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: the database name must contain "_test".');

vi.mock('next/navigation', async () => ({ ...(await import('../helpers/flash-jar-core')).nextNavigationMock() }));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({ actor: ACTOR_HOLDER.actor!, sessionId: 's', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('R-B - the cook action authorizes before it reads the recipe or item', () => {
  it('a person with no role: real recipeId and made-up recipeId give identical refusal text, and neither says the recipe does not exist. Mutant: getRecipe/getItemForProduction before authorize', async () => {
    const code = uid('t409s3');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Lipa', '2020-01-01') returning id`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Nobody') returning id`;
    const [adm] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Owner') returning id`;
    const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
    const [loc] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgId}, ${store!.id}, 'A', 'A', ${lt!.id}, 'operating', true, ${adm!.id}) returning id`;
    const [it] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Soup', 'raw_material', 'kg', ${adm!.id}) returning id`;
    const [rec] = await sql<{ id: string }[]>`insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${orgId}, 'Soup batch', ${it!.id}, 2, ${adm!.id}) returning id`;
    ACTOR_HOLDER.actor = { orgId, personId: p!.id };
    const { saveProductionDraftAction } = await import('../../src/app/inventory/production/actions');
    const run = async (recipeId: string, outputItemId: string) => {
      const fd = new FormData();
      fd.set('storeId', store!.id); fd.set('locationId', loc!.id); fd.set('kind', 'cook'); fd.set('producedOn', '2026-06-10');
      fd.set('recipeId', recipeId); fd.set('outputQuantity', '4');
      if (outputItemId) { fd.set('outputItemId', outputItemId); fd.set('outputUnit', 'kg'); }
      return outcomeOf(await captureRedirect(() => saveProductionDraftAction(fd)));
    };
    const real = await run(rec!.id, '');
    const fake = await run('00000000-0000-4000-8000-000000000000', '');
    const realWithItem = await run(rec!.id, it!.id);
    const fakeWithItem = await run('00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111');
    expect(real.flash.error, 'no refusal for the unauthorized caller').toBeTruthy();
    expect(fake.flash.error).toBe(real.flash.error);
    expect(fakeWithItem.flash.error).toBe(realWithItem.flash.error);
    expect(real.flash.error).not.toMatch(/does not exist|not exist/i);
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from production_records where org_id = ${orgId}`;
    expect(n!.n).toBe('0');
  }, 60_000);
});
