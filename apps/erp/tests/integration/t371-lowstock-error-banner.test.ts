import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 smoke fix — `/inventory/low-stock`. `setThresholdAction` let the parse refusal throw uncaught, so the person got Next's generic
 * "Something went wrong" page. Siblings (fixed-assets, locations) catch, redirect to the page with `?error=<sentence>` and keep `store`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { setThresholdAction } from '../../src/app/inventory/low-stock/actions';
import { urlOf } from '../helpers/flash-jar';
import { INVENTORY_THRESHOLD_RULES } from '@shareat/domain/field-rules';
import { expectRuleSentence } from '../helpers/rule-sentence';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture() {
  const code = uid('t371-lsfix');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Pork', 'raw_material', 'kg', ${p!.id}) returning id`;
  ACTOR_HOLDER.actor = { orgId, personId: p!.id };
  return { orgId, storeId: store!.id, itemId: item!.id };
}
const rows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from store_item_thresholds where org_id = ${orgId}`)[0]!.n);
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function redirectOf(run: () => Promise<void>): Promise<URL | null> {
  try {
    await run();
    return null;
  } catch (err) {
    if (err instanceof RedirectSignal) return urlOf(err.to);
    throw err;
  }
}

describe('setThresholdAction — refusal is a redirect with ?error=, not an uncaught throw', () => {
  it("'abc' redirects to the page with the sentence and the store kept; no row; '5' then saves", async () => {
    const f = await fixture();
    const to = await redirectOf(() => setThresholdAction(fd({ storeId: f.storeId, itemId: f.itemId, threshold: 'abc' })));
    expect(to, 'the action threw instead of redirecting').not.toBeNull();
    expect(to!.pathname).toBe('/inventory/low-stock');
    expect(to!.searchParams.get('store')).toBe(f.storeId);
    // T-440: the sentence is the rule's requirement (never the typed value).
    expectRuleSentence(to!.searchParams.get('error'), INVENTORY_THRESHOLD_RULES.threshold, 'abc');
    expect(await rows(f.orgId)).toBe(0);

    const ok = await redirectOf(() => setThresholdAction(fd({ storeId: f.storeId, itemId: f.itemId, threshold: '5' })));
    expect(ok, 'a valid threshold redirected').toBeNull();
    const [row] = await sql<{ v: string }[]>`select low_stock_threshold::text as v from store_item_thresholds where org_id = ${f.orgId}`;
    expect(row?.v).toBe('5.000');
  });
});
