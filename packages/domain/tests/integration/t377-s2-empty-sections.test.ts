import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-377 S2 (DEF-597) - an empty section counts as done. `docs/tasks/377-pos-smoke-follow-ups.md` section S2, tests
 * E1-E10 (W1-W3 are `apps/erp/tests/integration/t375-s5-pos-usage-page.test.ts`).
 *
 * TESTER, not BUILDER. Real Postgres and the real domain; nothing doubled. Fixture shape from
 * `t375-s5-usage-from-feed.test.ts`: a linked, mapped store, an imported (and verified) day, the pinned sold_items feed.
 *
 * ## The rule under test (R2/R3)
 * After the section loop and before the all-three check, if EVERY unstamped section has no line in the STORED plan and
 * none in the FRESH rebuild (blocked lines count), `finalizeSections` stamps them all (all or none), and the ok result
 * carries `pullFinalized`. A refused call stamps nothing.
 *
 * ## Mutants (each must turn the named tests red; the spec's list)
 *  - delete the sweep                                   -> E1, E2
 *  - sweep ignores blocked lines                        -> E4
 *  - sweep checks stored lines only                     -> E5, E10
 *  - sweep checks fresh lines only                      -> E6
 *  - sweep moved above the PLAN_CHANGED loop            -> E7 (first leg)
 *  - sweep stamps every unstamped section               -> E3
 *  - sweep stamps each empty section on its own         -> E3 (orphan), E9
 *  - sweep pushes a `results` row                       -> E1, E2
 *
 * ## Read through a cast
 * `pullFinalized` is added to the ok result by the builder; it is read through a cast so this file compiles first.
 * On HEAD it is `undefined`, so every `toBe(true|false)` on it is red there: that is the target field, not a setup error.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, findingsRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as D from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import type { PosV1SoldItemInput } from '../../../db/src/pos-v1/fixtures';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

const DAY = '2027-01-10';
const DAY2 = '2027-01-11';
const ZERO_FIGURES = { paidTotal: 0, receiptCount: 0, packageOnly: 0, discounts: 0, charges: 0, methods: {} };
type Section = 'direct' | 'recipe' | 'orphan';
type MapMode = 'direct' | 'recipe' | 'no_stock' | 'none';

const sold = (...keys: string[]): PosV1SoldItemInput[] => keys.map((k) => ({ key: k, name: k, physicalQty: 2 }));

async function fixture(hint: string) {
  const code = uid(`t377s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series('2026-12-01'::date, '2027-02-01'::date, interval '1 month') m`;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Lipa', 'multi_room') returning id`;
  const storeId = st!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const managerId = p!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeId})`;
  const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [room] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${managerId}) returning id`;
  const kitchen = room!.id;
  const locations: LocationLike[] = [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];
  const mkItem = async (c: string, name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${c}, ${name}, 'meat_slab', 'kg', ${managerId}) returning id`)[0]!.id;
  const cheese = await mkItem('CHEESE', 'Cheese');
  const buns = await mkItem('BUNS', 'Buns');
  for (const itemId of [cheese, buns]) {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
      values (${orgId}, ${`orgs/${orgId}/p-${uid('f')}.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
    const [del] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgId}, ${storeId}, 'purchase', '2026-12-02', ${file!.id}, ${managerId}) returning id`;
    await asOrg(orgId, (tx) =>
      receiveDelivery(tx, {
        orgId, storeId, deliveryId: del!.id, deliveredOn: '2026-12-02', locations, receivedBy: managerId,
        lines: [{ lineId: '1', itemId, itemKind: 'meat_slab', receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '10.0000', locationId: kitchen }],
      }),
    );
  }
  // Recipes use kg so a recipe line is a visible quantity (0.2 kg x 2 sold = 0.400), never rounded away.
  const mkRecipe = async (name: string, status: 'active' | 'inactive') => {
    const [r] = await sql<{ id: string }[]>`
      insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
      values (${orgId}, ${name}, ${cheese}, 1, ${managerId}) returning id`;
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${cheese}, 0.2, 'kg')`;
    if (status === 'inactive') await sql`update production_recipes set status = 'inactive' where id = ${r!.id}`;
    return r!.id;
  };
  const recipe = await mkRecipe('R Box', 'active');
  const deadRecipe = await mkRecipe('R Dead', 'active'); // made inactive by a test AFTER it is mapped

  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });
  await linkTestStore(sql, { orgId, storeId, channelId: ch!.id, createdBy: managerId });

  const manager = actorOf(orgId, managerId);
  const f = { orgId, storeId, kitchen, cheese, buns, recipe, deadRecipe, managerId, manager };

  /** Set the map of one POS item key (creates it, or edits the active one). */
  const setMap = async (key: string, mode: MapMode, o: { recipeId?: string } = {}) => {
    const [existing] = await sql<{ id: string }[]>`select id from pos_item_maps where store_id = ${storeId} and pos_item_key = ${key} and status = 'active'`;
    if (mode === 'none') {
      if (existing) await sql`update pos_item_maps set status = 'archived' where id = ${existing.id}`;
      return;
    }
    const base = { orgId, storeId, posItemKey: key, posItemName: key, editMapId: existing?.id };
    const out = await asOrg(orgId, (tx) =>
      D.upsertPosItemMap(
        tx,
        manager,
        mode === 'direct'
          ? { ...base, mode, itemId: key === 'B' ? buns : cheese, quantityPerSale: '1', confirmShared: true }
          : mode === 'recipe'
            ? { ...base, mode, recipeId: o.recipeId ?? recipe }
            : { ...base, mode },
      ),
    );
    if (!out.ok) throw new Error(`fixture: upsertPosItemMap(${key}, ${mode}) refused: ${'reason' in out ? out.reason : ''}`);
  };
  return { ...f, setMap };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** Import a day (and verify it, so the T-177 detector can see it). */
async function day(f: F, date: string, items: readonly PosV1SoldItemInput[], opts: { zero?: boolean; verify?: boolean } = {}): Promise<string> {
  const id = (
    await asOrg(f.orgId, (tx) =>
      importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date, soldItems: items, figures: opts.zero ? ZERO_FIGURES : undefined }),
    )
  ).id;
  if (opts.verify !== false) await asOrg(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, id));
  return id;
}
const plan = (f: F, salesDayId: string) =>
  asOrg(f.orgId, (tx) => D.buildPlan(tx, f.manager, { orgId: f.orgId, storeId: f.storeId, salesDayId, locationId: f.kitchen }));
type Planned = Extract<Awaited<ReturnType<typeof plan>>, { ok: true }>;
async function mustPlan(f: F, dayId: string): Promise<Planned> {
  const p = await plan(f, dayId);
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  return p;
}
const fin = (f: F, pullId: string, sections: Section[], keys: string[]) =>
  asOrg(f.orgId, (tx) => D.finalizeSections(tx, f.manager, { pullId, sections, confirmedKeys: keys }));
const keysOf = (p: Planned, section: Section) => p.lines.filter((l) => l.section === section && !l.blocked).map((l) => l.key);
const pullFinalizedOf = (r: unknown): unknown => (r as { pullFinalized?: unknown }).pullFinalized;
const mustOk = (r: Awaited<ReturnType<typeof fin>>) => {
  expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

type PullRow = {
  status: string;
  direct_finalized_at: Date | null;
  recipe_finalized_at: Date | null;
  orphan_finalized_at: Date | null;
  finalized_at: Date | null;
  finalized_by: string | null;
};
const pullRow = async (id: string) => (await sql<PullRow[]>`select * from pos_usage_pulls where id = ${id}`)[0]!;
const stamps = (r: PullRow) => [r.direct_finalized_at, r.recipe_finalized_at, r.orphan_finalized_at].map((v) => v !== null);
const storedLines = (pullId: string) =>
  sql<{ section: string; line_key: string; blocked: unknown; usage_record_id: string | null }[]>`
    select section, line_key, blocked, usage_record_id from pos_usage_pull_lines where pull_id = ${pullId} order by line_key`;
const usageCount = async (f: F) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_usage_records where org_id = ${f.orgId}`)[0]!.n);
const notRun = (f: F) =>
  asOrg(f.orgId, async (tx) => (await findingsRepo.posUsagePullNotRun(tx, f.orgId)).filter((x) => x.storeId === f.storeId));

// =====================================================================================================
describe('E1 - the smoke case: direct finalized, recipe and orphan empty -> the pull finishes', () => {
  it('items map only to direct; finalize [direct] -> finalized, three stamps, ONE results row, usage posted, the finding is gone', async () => {
    const f = await fixture('e1');
    await f.setMap('A', 'direct');
    const dayId = await day(f, DAY, sold('A'));
    const p = await mustPlan(f, dayId);
    expect(p.lines.map((l) => l.section), 'control: only a direct line exists').toEqual(['direct']);
    expect(await notRun(f), 'control: before the finalize the finding fires for the store').toHaveLength(1);

    const out = mustOk(await fin(f, p.pullId, ['direct'], keysOf(p, 'direct')));
    const row = await pullRow(p.pullId);
    expect(row.status, 'DEF-597: the pull is finalized').toBe('finalized');
    expect(row.finalized_at).not.toBeNull();
    expect(row.finalized_by).toBe(f.managerId);
    expect(pullFinalizedOf(out)).toBe(true);
    expect(stamps(row), 'all three stamps').toEqual([true, true, true]);
    expect(out.sections.map((s) => s.section), 'the sweep adds no results row (REV-6)').toEqual(['direct']);
    expect((await storedLines(p.pullId)).every((l) => l.usage_record_id), 'the direct usage record is posted').toBe(true);
    expect(await usageCount(f)).toBe(1);
    expect(await notRun(f), 'the finding is gone').toHaveLength(0);
  });
});

describe('E2 - the PHP 0 day: all three sections empty', () => {
  it('finalize with sections [] and no keys -> finalized, pullFinalized, no results row, zero usage records', async () => {
    const f = await fixture('e2');
    const dayId = await day(f, DAY, [], { zero: true, verify: false }); // verifySalesDay refuses a day with no figures
    const p = await mustPlan(f, dayId);
    expect(p.lines, 'control: a zero day plans no lines').toHaveLength(0);

    const out = mustOk(await fin(f, p.pullId, [], []));
    const row = await pullRow(p.pullId);
    expect(row.status).toBe('finalized');
    expect(row.finalized_by).toBe(f.managerId);
    expect(stamps(row)).toEqual([true, true, true]);
    expect(pullFinalizedOf(out)).toBe(true);
    expect(out.sections, 'no results row (REV-6)').toHaveLength(0);
    expect(await usageCount(f)).toBe(0);
  });

  it('control: the same zero day finalized with [direct] -> the same end state', async () => {
    const f = await fixture('e2c');
    const dayId = await day(f, DAY, [], { zero: true, verify: false }); // verifySalesDay refuses a day with no figures
    const p = await mustPlan(f, dayId);
    const out = mustOk(await fin(f, p.pullId, ['direct'], []));
    const row = await pullRow(p.pullId);
    expect(row.status).toBe('finalized');
    expect(stamps(row)).toEqual([true, true, true]);
    expect(pullFinalizedOf(out)).toBe(true);
    expect(await usageCount(f)).toBe(0);
  });
});

describe('E3 - a section waiting for a person is never stamped (all or none)', () => {
  it('A direct, B recipe; finalize [direct] -> recipe NOT stamped, orphan NOT stamped, planned, pullFinalized false, the finding still fires', async () => {
    const f = await fixture('e3');
    await f.setMap('A', 'direct');
    await f.setMap('B', 'recipe');
    const dayId = await day(f, DAY, sold('A', 'B'));
    const p = await mustPlan(f, dayId);
    expect(keysOf(p, 'recipe'), 'control: recipe has a line').toHaveLength(1);

    const out = mustOk(await fin(f, p.pullId, ['direct'], keysOf(p, 'direct')));
    const row = await pullRow(p.pullId);
    expect(stamps(row), 'direct only; recipe and orphan (empty!) stay open - all or none').toEqual([true, false, false]);
    expect(row.status).toBe('planned');
    expect(pullFinalizedOf(out)).toBe(false);
    expect(await notRun(f)).toHaveLength(1);
  });
});

describe('E9 - the remap hole (REV-2)', () => {
  it('A direct, B unmapped, recipe empty; finalize [direct] stamps nothing else; map B to a recipe, build again -> the stored plan has the recipe line and finalize [recipe] posts it', async () => {
    const f = await fixture('e9');
    await f.setMap('A', 'direct');
    const dayId = await day(f, DAY, sold('A', 'B'));
    const p = await mustPlan(f, dayId);
    expect(keysOf(p, 'orphan'), 'control: B is an orphan line').toEqual(['orphan:B']);

    const first = mustOk(await fin(f, p.pullId, ['direct'], keysOf(p, 'direct')));
    const row = await pullRow(p.pullId);
    expect(stamps(row), 'recipe (empty) and orphan (B) are not stamped').toEqual([true, false, false]);
    expect(pullFinalizedOf(first)).toBe(false);
    expect(row.status).toBe('planned');

    await f.setMap('B', 'recipe');
    const again = await mustPlan(f, dayId);
    expect(again.pullId).toBe(p.pullId);
    const stored = await storedLines(p.pullId);
    expect(stored.filter((l) => l.section === 'recipe').map((l) => l.line_key), "B's recipe line is in the stored plan, not dropped by a frozen recipe section").toEqual(['recipe:B:0']);

    mustOk(await fin(f, p.pullId, ['recipe'], ['recipe:B:0']));
    expect(await usageCount(f), "B's recipe usage record is posted (A's direct one + B's)").toBe(2);
    const after = await storedLines(p.pullId);
    expect(after.find((l) => l.line_key === 'recipe:B:0')?.usage_record_id).toBeTruthy();
  });
});

describe('E10 - R3 on the button path: sections [] never stamps what a new mapping filled', () => {
  it('B no_stock -> all three empty at build; change B to direct; finalize [] -> nothing stamped, pullFinalized false, planned', async () => {
    const f = await fixture('e10');
    await f.setMap('B', 'no_stock');
    const dayId = await day(f, DAY, sold('B'));
    const p = await mustPlan(f, dayId);
    expect(p.lines, 'control: no_stock yields no line, so all three sections are empty at build').toHaveLength(0);

    await f.setMap('B', 'direct');
    const out = mustOk(await fin(f, p.pullId, [], []));
    const row = await pullRow(p.pullId);
    expect(stamps(row)).toEqual([false, false, false]);
    expect(row.status).toBe('planned');
    expect(pullFinalizedOf(out)).toBe(false);
    expect(await usageCount(f)).toBe(0);
  });
});

describe('E4 - a blocked line counts as a line', () => {
  it('A direct, C a recipe made inactive before the build (blocked recipe line); finalize [direct] -> recipe and orphan not stamped, planned', async () => {
    const f = await fixture('e4');
    await f.setMap('A', 'direct');
    await f.setMap('C', 'recipe', { recipeId: f.deadRecipe });
    await sql`update production_recipes set status = 'inactive' where id = ${f.deadRecipe}`;
    const dayId = await day(f, DAY, sold('A', 'C'));
    const p = await mustPlan(f, dayId);
    const blockedRecipe = p.lines.filter((l) => l.section === 'recipe');
    expect(blockedRecipe.map((l) => l.blocked), 'control: recipe holds exactly one BLOCKED line').toEqual([true]);

    const out = mustOk(await fin(f, p.pullId, ['direct'], keysOf(p, 'direct')));
    const row = await pullRow(p.pullId);
    expect(stamps(row)).toEqual([true, false, false]);
    expect(row.status).toBe('planned');
    expect(pullFinalizedOf(out)).toBe(false);
  });
});

describe('E5 - R3, the fresh side', () => {
  it('A direct, B no_stock; change B to recipe; finalize [direct] with A -> recipe and orphan NOT stamped, planned', async () => {
    const f = await fixture('e5');
    await f.setMap('A', 'direct');
    await f.setMap('B', 'no_stock');
    const dayId = await day(f, DAY, sold('A', 'B'));
    const p = await mustPlan(f, dayId);
    expect(p.lines.map((l) => l.section), 'control: the STORED plan has only the direct line').toEqual(['direct']);

    await f.setMap('B', 'recipe');
    const out = mustOk(await fin(f, p.pullId, ['direct'], ['direct:A']));
    const row = await pullRow(p.pullId);
    expect(stamps(row)).toEqual([true, false, false]);
    expect(row.status).toBe('planned');
    expect(pullFinalizedOf(out)).toBe(false);
  });
});

describe('E6 - R3, the stored side', () => {
  it('A direct, C recipe; build; change C to no_stock (the fresh plan has no C line); finalize [direct] -> recipe NOT stamped, planned', async () => {
    const f = await fixture('e6');
    await f.setMap('A', 'direct');
    await f.setMap('C', 'recipe');
    const dayId = await day(f, DAY, sold('A', 'C'));
    const p = await mustPlan(f, dayId);
    expect(keysOf(p, 'recipe'), 'control: the STORED plan has a recipe line for C').toEqual(['recipe:C:0']);

    await f.setMap('C', 'no_stock');
    const out = mustOk(await fin(f, p.pullId, ['direct'], ['direct:A']));
    const row = await pullRow(p.pullId);
    expect(stamps(row)).toEqual([true, false, false]);
    expect(row.status).toBe('planned');
    expect(pullFinalizedOf(out)).toBe(false);
  });
});

describe('E7 - R4: a refused finalize stamps nothing', () => {
  it('on the E1 fixture (the sweep WOULD fire): a confirmed key no longer in the rebuild -> PLAN_CHANGED, no stamp; control: the right keys then finish the pull', async () => {
    const f = await fixture('e7');
    await f.setMap('A', 'direct');
    const dayId = await day(f, DAY, sold('A'));
    const p = await mustPlan(f, dayId);

    const refused = await fin(f, p.pullId, ['direct'], ['direct:A', 'direct:none']);
    expect(refused.ok).toBe(false);
    expect(String(refused.ok ? '' : refused.reason)).toMatch(/^PLAN_CHANGED/);
    const row = await pullRow(p.pullId);
    expect(stamps(row)).toEqual([false, false, false]);
    expect(row.status).toBe('planned');

    // control: this very pull finishes with the right keys, so the refusal above is what held the sweep back
    const ok = mustOk(await fin(f, p.pullId, ['direct'], ['direct:A']));
    expect(pullFinalizedOf(ok)).toBe(true);
    expect((await pullRow(p.pullId)).status).toBe('finalized');
  });

  it('a voided day refuses the finalize and stamps nothing (a pin only: no mutant can sit before this refusal)', async () => {
    const f = await fixture('e7v');
    await f.setMap('A', 'direct');
    const dayId = await day(f, DAY2, sold('A'), { verify: false });
    const p = await mustPlan(f, dayId);
    // voidSalesDay itself refuses a day with a live pull, so the day is voided by raw SQL (the state a later void leaves).
    await sql`update sales_days set status = 'voided', voided_by = ${f.managerId}, voided_at = now(), void_reason = 'Entered wrong' where id = ${dayId}`;

    const refused = await fin(f, p.pullId, ['direct'], ['direct:A']);
    expect(refused.ok, 'the voided-day refusal').toBe(false);
    const row = await pullRow(p.pullId);
    expect(stamps(row)).toEqual([false, false, false]);
    expect(row.status).not.toBe('finalized');
    expect(await usageCount(f)).toBe(0);
  });
});

describe('E8 - control: the order of today is unchanged', () => {
  it('three non-empty sections; recipe, then direct, then orphan -> finalized only after the third; each call names only its section', async () => {
    const f = await fixture('e8');
    await f.setMap('A', 'direct');
    await f.setMap('B', 'recipe');
    const dayId = await day(f, DAY, sold('A', 'B', 'C')); // C unmapped -> orphan
    const p = await mustPlan(f, dayId);
    expect(keysOf(p, 'direct').length + keysOf(p, 'recipe').length + keysOf(p, 'orphan').length, 'control: one line in each section').toBe(3);

    const r1 = mustOk(await fin(f, p.pullId, ['recipe'], keysOf(p, 'recipe')));
    expect(r1.sections.map((s) => s.section)).toEqual(['recipe']);
    expect((await pullRow(p.pullId)).status).toBe('planned');

    const r2 = mustOk(await fin(f, p.pullId, ['direct'], keysOf(p, 'direct')));
    expect(r2.sections.map((s) => s.section)).toEqual(['direct']);
    expect((await pullRow(p.pullId)).status).toBe('planned');

    const r3 = mustOk(await fin(f, p.pullId, ['orphan'], keysOf(p, 'orphan')));
    expect(r3.sections.map((s) => s.section)).toEqual(['orphan']);
    expect((await pullRow(p.pullId)).status).toBe('finalized');
  });
});
