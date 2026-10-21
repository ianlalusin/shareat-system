import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { INVENTORY_THRESHOLD_RULES } from '@shareat/domain/field-rules';
import { expectRuleSentence } from '../helpers/rule-sentence';

/**
 * T-371 S0 — app actions that write a constrained numeric column WITHOUT a domain function in the path. `docs/tasks/371-nan-sweep.md` §B
 * ("2 app actions call a repo writer directly: `fixed-assets/actions.ts` -> `updateTerms`, and `inventory/low-stock/actions.ts` -> `setThreshold`").
 *
 * Today: `setThresholdAction` hands the typed `threshold` string straight to `lowStockRepo.setThreshold`, so `'abc'` / `'NaN'` reach the
 * `store_item_thresholds` INSERT and surface as the database's own finite CHECK. The target: a plain sentence naming the field, nothing
 * written, and a later valid call succeeds. `updateTermsAction` was already routed through the domain (`updateAssetTerms`, T-343 S5.5q); its leg
 * is a GUARD (green today) so the next regression there is caught.
 *
 * ⛔ TESTER. The refusal's exact SHAPE is the builder's to choose (a thrown error carrying `userMessage`, or a redirect with `?error=`), so each
 * leg accepts either and asserts what must hold in both: the text reaching the person is a plain sentence that quotes the typed value, names
 * the field in human words, and carries no id and no database vocabulary.
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
import { updateTermsAction } from '../../src/app/fixed-assets/actions';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { urlOf } from '../helpers/flash-jar';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DB_VOCAB = /23514|violates|constraint|finite_check|numeric field overflow|invalid input syntax|NaN is not|\bsql\b/i;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t371-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Pork', 'raw_material', 'kg', ${p!.id}) returning id`;
  ACTOR_HOLDER.actor = { orgId, personId: p!.id };
  return { orgId, storeId: store!.id, personId: p!.id, itemId: item!.id };
}

/** Runs an action; returns the text that would reach the person, whichever way the builder chooses to deliver it. */
async function delivered(run: () => Promise<void>): Promise<{ text: string | null; how: 'threw' | 'redirect-error' | 'ok' }> {
  try {
    await run();
    return { text: null, how: 'ok' };
  } catch (err) {
    if (err instanceof RedirectSignal) {
      const u = urlOf(err.to);
      const e = u.searchParams.get('error');
      return e ? { text: e, how: 'redirect-error' } : { text: null, how: 'ok' };
    }
    const e = err as { userMessage?: string; message?: string };
    return { text: e.userMessage ?? `RAW: ${e.message ?? String(err)}`, how: 'threw' };
  }
}

const thresholdRows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from store_item_thresholds where org_id = ${orgId}`)[0]!.n);
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('setThresholdAction — the typed threshold goes straight to the repo today', () => {
  for (const typed of ['abc', 'NaN']) {
    it(`threshold ${JSON.stringify(typed)}: a plain sentence quoting it, naming the threshold, no id, no database vocabulary; zero rows written; a later valid call succeeds`, async () => {
      const f = await fixture(`thr-${typed}`);
      const before = await thresholdRows(f.orgId);
      const out = await delivered(() => setThresholdAction(fd({ storeId: f.storeId, itemId: f.itemId, threshold: typed })));
      expect(out.text, `the action accepted ${JSON.stringify(typed)} as a threshold`).not.toBeNull();
      expect(out.text, `a raw database error reached the person: ${out.text}`).not.toMatch(/^RAW:/);
      // T-440: the sentence is the rule's requirement; it names the threshold and never echoes what was typed.
      expectRuleSentence(out.text, INVENTORY_THRESHOLD_RULES.threshold, typed);
      expect(out.text!.toLowerCase()).toContain('threshold');
      expect(out.text).not.toMatch(UUID);
      expect(out.text).not.toMatch(DB_VOCAB);
      expect(await thresholdRows(f.orgId), 'a refused threshold wrote a row').toBe(before);

      // a later valid call leaves no partial state in the way
      const ok = await delivered(() => setThresholdAction(fd({ storeId: f.storeId, itemId: f.itemId, threshold: '5' })));
      expect(ok.text, `the control (a valid threshold) was refused: ${ok.text}`).toBeNull();
      const [row] = await sql<{ v: string }[]>`select low_stock_threshold::text as v from store_item_thresholds where org_id = ${f.orgId}`;
      expect(row?.v, 'the valid threshold reads back exactly').toBe('5.000');
    });
  }

  it('blank clears the threshold (a nullable-by-meaning field): no error, no row, and a previously set threshold is removed', async () => {
    const f = await fixture('thr-blank');
    await setThresholdAction(fd({ storeId: f.storeId, itemId: f.itemId, threshold: '7' }));
    expect(await thresholdRows(f.orgId)).toBe(1);
    const out = await delivered(() => setThresholdAction(fd({ storeId: f.storeId, itemId: f.itemId, threshold: '' })));
    expect(out.text, `a blank threshold was refused: ${out.text}`).toBeNull();
    expect(await thresholdRows(f.orgId)).toBe(0);
  });
});

describe('updateTermsAction (guard — already routed through the domain, T-343 S5.5q)', () => {
  it("salvageValue 'abc' redirects with a plain ?error= sentence and changes nothing; a valid salvage value is accepted", async () => {
    const f = await fixture('terms');
    const [asset] = await sql<{ id: string }[]>`
      insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost, useful_life_months, salvage_value, status, created_by)
      values (${f.orgId}, ${f.storeId}, 'Chiller', 'equipment', '2026-01-01', 24000, 24, 0, 'active', ${f.personId}) returning id`;
    const form = (salvage: string) => fd({ assetId: asset!.id, name: 'Chiller', category: 'equipment', usefulLifeMonths: '24', interval: 'monthly', salvageValue: salvage });
    const out = await delivered(() => updateTermsAction(form('abc')));
    expect(out.how).toBe('redirect-error');
    expect(out.text).not.toMatch(UUID);
    expect(out.text).not.toMatch(DB_VOCAB);
    const [kept] = await sql<{ s: string }[]>`select salvage_value::text as s from fixed_assets where id = ${asset!.id}`;
    expect(kept!.s, 'a refused update changed the salvage value').toBe('0.00');
    const ok = await delivered(() => updateTermsAction(form('1000')));
    expect(ok.text, `a valid salvage value was refused: ${ok.text}`).toBeNull();
  });
});
