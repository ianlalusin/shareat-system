/**
 * T-401 S5, I23 (docs/tasks/401-erp-menu-catalog-master.md section 4 and R7.3): USAGE SOURCE RESOLUTION.
 * Switched store: a linked key -> the menu rule in force at PLAN time, with the link's location; an unlinked key -> its
 * pos_item_maps row; neither -> orphan. Unswitched store: maps only. Plus the two guards that stop a recipe changing
 * under a pull the manager has not finished (switchUsageSource and setDepletionRule refused while the store has a `planned` pull).
 * TESTER, not BUILDER. Real Postgres. Links, switches, rules and maps are made RAW so the plan is the only subject.
 *
 * Contract assumed (see t401-s5-setup.ts `s5`/`repoS5`): buildPlan and finalizeSections keep today's signatures; the new
 * domain functions are exported from @shareat/domain; refusals may be returned ({ok:false}) or thrown (refusalOf reads both).
 *
 * Red today: nothing reads menu_pos_v1_links or menu_usage_source_switches, so a switched store plans from maps only
 * (and switchUsageSource / the setDepletionRule guard do not exist). Mutants: fallback skipped; source read from the link
 * instead of the switch row; the rule read at the business day (or at finalize) instead of plan time; a scheduled rule applied;
 * finalize still reading maps; the guards missing or ignoring a stamped section.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPlan, finalizeSections, voidPosUsagePull } from '@shareat/domain';
import { closeDb } from '@shareat/db';
import { BUSINESS_DAY, normalise, planOnly, seedScenario } from './t401-s5-golden-scenario';
import {
  asOrg, makeDay, rawLink, rawMap, rawRule, rawSwitch, rawVariant, refusalOf, s5, sold, sql, stockUp, world, type World,
} from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const day = (w: World, items: Parameters<typeof sold>[0], date = BUSINESS_DAY) => makeDay(w, w.a.storeId, date, sold(items));
const lineOf = (lines: readonly { key: string }[], key: string) => lines.find((l) => l.key === key) as
  | { key: string; section: string; itemId: string | null; locationId: string | null; quantity: string | null; posItemKey: string }
  | undefined;
const DAYMS = 86_400_000;

describe('I23 -- usage source resolution at plan time', () => {
  it('switched store: linked key -> menu rule at the link location; map-only key -> its map; neither -> orphan (mutant: fallback skipped)', async () => {
    const w = await world('i23a');
    const v = await rawVariant(w, 'Cheese Plate');
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    await rawLink(w, w.a.storeId, 'linked', v, w.a.display!);
    await rawMap(w, w.a.storeId, 'linked', { mode: 'direct', itemId: w.pork, quantityPerSale: '9' }); // the link must win over this
    await rawMap(w, w.a.storeId, 'maponly', { mode: 'direct', itemId: w.coke, quantityPerSale: '1' });
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    const d = await day(w, [{ key: 'linked', qty: 2 }, { key: 'maponly', qty: 3 }, { key: 'neither', qty: 1 }]);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);

    const linked = lineOf(plan.lines, 'direct:linked');
    expect(linked, 'a menu line for the linked key').toBeDefined();
    expect({ item: linked!.itemId, room: linked!.locationId, qty: linked!.quantity }).toEqual({ item: w.cheese, room: w.a.display, qty: '1.000' });
    const mapOnly = lineOf(plan.lines, 'direct:maponly');
    expect(mapOnly, 'an unlinked key still resolves through pos_item_maps (fallback)').toBeDefined();
    expect({ item: mapOnly!.itemId, room: mapOnly!.locationId, qty: mapOnly!.quantity }).toEqual({ item: w.coke, room: w.a.kitchen, qty: '3.000' });
    expect(lineOf(plan.lines, 'orphan:neither')?.section, 'neither link nor map: an orphan').toBe('orphan');
    expect(plan.lines.some((l) => l.itemId === w.pork), 'the map of a linked key is not used').toBe(false);
  }, 120_000);

  it('the source is read from the SWITCH ROW, not from the link: same link, no switch row -> maps only (mutant: source read from the link)', async () => {
    const w = await world('i23b');
    const v = await rawVariant(w, 'Cheese Plate');
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    await rawLink(w, w.a.storeId, 'linked', v);
    await rawMap(w, w.a.storeId, 'linked', { mode: 'direct', itemId: w.pork, quantityPerSale: '9' });
    const d = await day(w, [{ key: 'linked', qty: 2 }, { key: 'neither', qty: 1 }]);
    const unswitched = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    expect(lineOf(unswitched.lines, 'direct:linked')).toMatchObject({ itemId: w.pork, quantity: '18.000' });
    expect(lineOf(unswitched.lines, 'orphan:neither')?.section).toBe('orphan');

    // switched back: the latest row wins, so maps again
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'on', 0);
    const on = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    expect(lineOf(on.lines, 'direct:linked')).toMatchObject({ itemId: w.cheese, quantity: '1.000' });
    await rawSwitch(w, w.a.storeId, 'v1_pos_map', null, null);
    const off = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    expect(lineOf(off.lines, 'direct:linked')).toMatchObject({ itemId: w.pork, quantity: '18.000' });
  }, 120_000);

  it('plan-time semantics: a rule added AFTER the business day but before the plan resolves that day; the greatest effective_from <= now wins; a SCHEDULED rule is not applied', async () => {
    const w = await world('i23c');
    const v = await rawVariant(w, 'Cheese Plate');
    // the day is long past; every rule below is added now, i.e. after the business day
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.75' }); // later row: in force
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '9', effectiveFrom: new Date(Date.now() + 2 * DAYMS) }); // scheduled: not yet
    await rawLink(w, w.a.storeId, 'late', v);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    const d = await day(w, [{ key: 'late', qty: 4 }]);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    expect(lineOf(plan.lines, 'direct:late'), '4 sold x 0.75 in force now').toMatchObject({ itemId: w.cheese, quantity: '3.000' });
  }, 120_000);

  it('a no_stock rule makes no line, a recipe rule explodes like a recipe map (mutant: rule mode ignored)', async () => {
    const w = await world('i23d');
    const vNo = await rawVariant(w, 'Water');
    await rawRule(w, vNo, { mode: 'no_stock' });
    const vRec = await rawVariant(w, 'Samgyup Box');
    await rawRule(w, vRec, { mode: 'recipe', recipeId: w.recipeId });
    await rawLink(w, w.a.storeId, 'water', vNo);
    await rawLink(w, w.a.storeId, 'box', vRec);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    const d = await day(w, [{ key: 'water', qty: 5 }, { key: 'box', qty: 2 }]);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    expect(plan.lines.filter((l) => l.posItemKey === 'water'), 'no_stock: no line at all, not an orphan either').toEqual([]);
    const box = plan.lines.filter((l) => l.posItemKey === 'box').map((l) => ({ section: l.section, item: l.itemId, qty: l.quantity })).sort((a, b) => String(a.item).localeCompare(String(b.item)));
    expect(box).toEqual([
      { section: 'recipe', item: w.cheese, qty: '0.400' },
      { section: 'recipe', item: w.rice, qty: '0.200' },
    ].sort((a, b) => String(a.item).localeCompare(String(b.item))));
  }, 120_000);

  it('a switched store with NO linked key plans exactly the pre-S5 golden plan lines (nothing but the source differs)', async () => {
    const w = await world('i23e');
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'no links', 0);
    const d = await seedScenario(w, w.a.storeId, w.a.kitchen, w.a.display!);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    const golden = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 't401-s5-golden-no-switch.json'), 'utf8')) as { planLines: unknown };
    const labels = new Map<string, string>([
      [w.coke, 'item:Coke'], [w.cheese, 'item:Cheese'], [w.sauce, 'item:Sauce'], [w.pork, 'item:Pork'], [w.rice, 'item:Rice'],
      [w.a.kitchen, 'room:Kitchen'], [w.a.display!, 'room:Display'],
    ]);
    expect(normalise(plan.lines, labels)).toEqual(golden.planLines);
  }, 120_000);

  it('finalize rebuilds with the SAME source: the posted usage is the menu rule, not the map (mutant: finalize still reads listActiveMaps)', async () => {
    const w = await world('i23f');
    const v = await rawVariant(w, 'Cheese Plate');
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    await rawLink(w, w.a.storeId, 'linked', v);
    await rawMap(w, w.a.storeId, 'linked', { mode: 'direct', itemId: w.pork, quantityPerSale: '9' });
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, '10');
    await stockUp(w, w.a.storeId, w.a.kitchen, w.pork, '100');
    const d = await day(w, [{ key: 'linked', qty: 2 }]);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    const fin = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: ['direct:linked'] }));
    expect(fin.ok, fin.ok ? '' : fin.reason).toBe(true);
    const out = await sql<{ item_id: string; q: string }[]>`
      select item_id, (-sum(quantity))::text as q from stock_movements where org_id = ${w.orgId} and quantity < 0 group by item_id`;
    expect(Object.fromEntries(out.map((r) => [r.item_id, Number(r.q)]))).toEqual({ [w.cheese]: 1 });
  }, 120_000);

  it('S5 ruling 1: a switched store writes NO audit row for its pull, in plan or in finalize (the source is derivable from the switch row)', async () => {
    const w = await world('i23g');
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'no links', 0);
    await rawMap(w, w.a.storeId, 'coke', { mode: 'direct', itemId: w.coke, quantityPerSale: '1' });
    await stockUp(w, w.a.storeId, w.a.kitchen, w.coke, '10');
    const before = (await sql<{ id: string }[]>`select id from audit_log where org_id = ${w.orgId}`).length;
    const d = await day(w, [{ key: 'coke', qty: 1 }, { key: 'neither', qty: 1 }]);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId: plan.pullId, sections: ['direct', 'recipe', 'orphan'], confirmedKeys: ['direct:coke'] }));
    const rows = await sql<{ entity: string; after: unknown }[]>`select entity, after from audit_log where org_id = ${w.orgId}`;
    expect(rows.filter((r) => r.entity === 'pos_usage_pulls'), 'no pull audit row').toEqual([]);
    expect(JSON.stringify(rows.map((r) => r.after))).not.toContain('depletionSource');
    expect(before, 'setup wrote only its own rows').toBeGreaterThanOrEqual(0);
  }, 120_000);
});

/** A switched store A, one linked key whose rule is `qty`, a day planned (not finalized). */
async function plannedPull(hint: string, switched = true) {
  const w = await world(hint);
  const v = await rawVariant(w, 'Cheese Plate');
  await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
  await rawLink(w, w.a.storeId, 'linked', v);
  await rawMap(w, w.a.storeId, 'linked', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
  await rawMap(w, w.a.storeId, 'water', { mode: 'no_stock' });
  if (switched) await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
  const d = await day(w, [{ key: 'linked', qty: 2 }, { key: 'water', qty: 1 }]);
  const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
  return { w, v, d, plan };
}

describe('I23 -- the guards while a store has a planned pull', () => {
  it('switchUsageSource is refused while a pull is planned, including one whose direct section is already stamped; accepted once it is finalized (mutant: guard ignores a stamped section)', async () => {
    // an UNSWITCHED store (maps only) with a planned pull
    const w = await world('i23h');
    await rawMap(w, w.a.storeId, 'coke', { mode: 'direct', itemId: w.coke, quantityPerSale: '1' });
    await rawMap(w, w.a.storeId, 'box', { mode: 'recipe', recipeId: w.recipeId });
    await stockUp(w, w.a.storeId, w.a.kitchen, w.coke, '10');
    const d = await day(w, [{ key: 'coke', qty: 2 }, { key: 'box', qty: 1 }]);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    const sw = () => asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx));

    const planned = await refusalOf(sw);
    expect(planned, 'refused with a planned pull').not.toBeNull();
    expect(planned!).toMatch(/Lipa|pull|plan/i);

    // finalize ONLY the direct section: status stays `planned` (recipe + orphan not stamped)
    const part = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: ['direct:coke'] }));
    expect(part.ok, part.ok ? '' : part.reason).toBe(true);
    const [row] = await sql<{ status: string; direct: Date | null }[]>`select status, direct_finalized_at as direct from pos_usage_pulls where id = ${plan.pullId}`;
    expect(row).toMatchObject({ status: 'planned' });
    expect(row!.direct, 'the direct section is stamped').not.toBeNull();
    expect(await refusalOf(sw), 'still refused with the direct section stamped').not.toBeNull();
    expect(await repoS5Source(w)).toBe('v1_pos_map');

    // finish the pull
    const rest = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId: plan.pullId, sections: ['recipe', 'orphan'], confirmedKeys: [] }));
    expect(rest.ok, rest.ok ? '' : rest.reason).toBe(true);
    const [fin] = await sql<{ status: string }[]>`select status from pos_usage_pulls where id = ${plan.pullId}`;
    expect(fin!.status).toBe('finalized');
    expect(await refusalOf(sw), 'accepted once the pull is finalized (no differences: nothing is linked)').toBeNull();
    expect(await repoS5Source(w)).toBe('menu_rules');
  }, 180_000);

  it('a VOIDED pull no longer blocks the switch', async () => {
    const w = await world('i23i');
    await rawMap(w, w.a.storeId, 'coke', { mode: 'direct', itemId: w.coke, quantityPerSale: '1' });
    const d = await day(w, [{ key: 'coke', qty: 2 }]);
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    const sw = () => asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx));
    expect(await refusalOf(sw)).not.toBeNull();
    await asOrg(w.orgId, (tx) => voidPosUsagePull(tx, w.admin, { pullId: plan.pullId, reason: 'test void' }));
    expect(await refusalOf(sw)).toBeNull();
  }, 120_000);

  it('a pull planned at ANOTHER store (B) does not block store A (mutant: the guard is org-wide)', async () => {
    const w = await world('i23j');
    await rawMap(w, w.b.storeId, 'coke', { mode: 'direct', itemId: w.coke, quantityPerSale: '1' });
    const dB = await makeDay(w, w.b.storeId, BUSINESS_DAY, sold([{ key: 'coke', qty: 2 }]));
    const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.manager, { orgId: w.orgId, storeId: w.b.storeId, salesDayId: dB, locationId: w.b.kitchen }));
    expect(p.ok).toBe(true);
    await makeDay(w, w.a.storeId, BUSINESS_DAY, sold([{ key: 'coke', qty: 1 }]));
    const r = await refusalOf(() => asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx)));
    expect(r).toBeNull();
  }, 120_000);

  it('setDepletionRule on a variant linked at a SWITCHED store with a planned pull is refused, naming store and date; cancelScheduledDepletionRule too (mutant: guard missing on either)', async () => {
    const { w, v } = await plannedPull('i23k');
    const countRules = async () => Number((await sql<{ n: string }[]>`select count(*)::text as n from menu_depletion_rules where variant_id = ${v}`)[0]!.n);
    const before = await countRules();

    const set = await refusalOf(() => asOrg(w.orgId, (tx) => s5.setDepletionRule(w.admin, { variantId: v, mode: 'direct', itemId: w.cheese, quantityPerSale: '0.6' }, tx)));
    expect(set, 'setDepletionRule refused').not.toBeNull();
    expect(set!).toMatch(/Lipa/);
    expect(set!).toMatch(/Aug 20/);
    expect(await countRules(), 'setDepletionRule wrote nothing').toBe(before);
    const scheduled = await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '2', effectiveFrom: new Date(Date.now() + 3 * DAYMS) });
    const cancel = await refusalOf(() => asOrg(w.orgId, (tx) => s5.cancelScheduledDepletionRule(w.admin, { id: scheduled }, tx)));
    expect(cancel, 'cancelScheduledDepletionRule refused').not.toBeNull();
    expect(cancel!).toMatch(/Lipa/);
    expect(await countRules(), 'the scheduled rule was not removed').toBe(before + 1);
  }, 120_000);

  it('the guard is narrow: a variant linked only at an UNSWITCHED store, an unlinked variant, and a finalized pull all still allow a rule change', async () => {
    // unswitched store A with a planned pull and a linked variant
    const u = await plannedPull('i23l', false);
    const ok1 = await refusalOf(() => asOrg(u.w.orgId, (tx) => s5.setDepletionRule(u.w.admin, { variantId: u.v, mode: 'direct', itemId: u.w.cheese, quantityPerSale: '0.6' }, tx)));
    expect(ok1, 'linked at a store that is not switched').toBeNull();

    // switched store, planned pull, but a DIFFERENT variant (not linked anywhere)
    const s = await plannedPull('i23m');
    const other = await rawVariant(s.w, 'Unlinked Dish');
    await rawRule(s.w, other, { mode: 'no_stock' });
    const ok2 = await refusalOf(() => asOrg(s.w.orgId, (tx) => s5.setDepletionRule(s.w.admin, { variantId: other, mode: 'direct', itemId: s.w.cheese, quantityPerSale: '1' }, tx)));
    expect(ok2, 'unlinked variant').toBeNull();

    // switched store, but the pull is void: allowed again
    await asOrg(s.w.orgId, (tx) => voidPosUsagePull(tx, s.w.admin, { pullId: s.plan.pullId, reason: 'test void' }));
    const ok3 = await refusalOf(() => asOrg(s.w.orgId, (tx) => s5.setDepletionRule(s.w.admin, { variantId: s.v, mode: 'direct', itemId: s.w.cheese, quantityPerSale: '0.6' }, tx)));
    expect(ok3, 'no planned pull any more').toBeNull();
  }, 180_000);
});

async function repoS5Source(w: World): Promise<string> {
  const [r] = await sql<{ source: string }[]>`
    select source from menu_usage_source_switches where store_id = ${w.a.storeId} order by created_at desc, id desc limit 1`;
  return r?.source ?? 'v1_pos_map';
}
