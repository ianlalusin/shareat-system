/**
 * T-401 S5, I24 (docs/tasks/401-erp-menu-catalog-master.md section 4 and R7.4/R7.5): NO BLIND SWITCH.
 * Switching to menu_rules runs the comparison itself over the last 7 stored day feeds; with differences it is refused unless
 * acceptDifferences + a reason (stored with the count); switching back needs nothing and is immediate; compareDepletionSources
 * is read-only. TESTER, not BUILDER. Real Postgres; maps, rules and links are raw.
 *
 * Contract assumed (t401-s5-setup.ts `s5`): compareDepletionSources(actor,{storeId,days?}) -> { differenceCount, differences[{businessDate?,posItemKey,kind?}] };
 * switchUsageSource(actor,{storeId,source:'menu_rules'|'v1_pos_map',acceptDifferences?,reason?}) returns or throws a refusal sentence;
 * the source value for "maps" is the schema's 'v1_pos_map' (the task doc's prose says pos_item_maps; the CHECK in migration 0196 says v1_pos_map).
 *
 * Red today: none of switchUsageSource / compareDepletionSources exists. Mutants: the switch skips the comparison; the comparison
 * writes a plan, a pull, a switch or an audit row; switching back runs the comparison; the reason is not required with
 * acceptDifferences; difference_count not stored.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@shareat/db';
import { planOnly } from './t401-s5-golden-scenario';
import { asOrg, count, makeDay, rawLink, rawMap, rawRule, rawSwitch, rawVariant, refusalOf, repoS5, s5, sold, sql, world, type World } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const DATES = ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'];

/** 7 stored days. 'same' (sold every day) has a link whose rule equals its map. 'pork-belly' (sold ONLY on 17 Aug) has a rule 0.5 against a map 0.25. */
async function sevenDays(hint: string) {
  const w = await world(hint);
  const vSame = await rawVariant(w, 'Rice Bowl');
  await rawRule(w, vSame, { mode: 'direct', itemId: w.rice, quantityPerSale: '0.1' });
  await rawLink(w, w.a.storeId, 'same', vSame);
  await rawMap(w, w.a.storeId, 'same', { mode: 'direct', itemId: w.rice, quantityPerSale: '0.1' });
  const vPork = await rawVariant(w, 'Pork Belly');
  await rawRule(w, vPork, { mode: 'direct', itemId: w.pork, quantityPerSale: '0.5' });
  await rawLink(w, w.a.storeId, 'pork-belly', vPork);
  await rawMap(w, w.a.storeId, 'pork-belly', { mode: 'direct', itemId: w.pork, quantityPerSale: '0.25', name: 'pork-belly' });
  const dayIds: Record<string, string> = {};
  for (const date of DATES) {
    const items = [{ key: 'same', qty: 2 }, ...(date === '2026-08-17' ? [{ key: 'pork-belly', qty: 4 }] : [])];
    dayIds[date] = await makeDay(w, w.a.storeId, date, sold(items));
  }
  return { w, vPork, dayIds };
}

const sourceOf = (w: World) => asOrg(w.orgId, (tx) => repoS5.menuRepo.usageSourceInForce(tx, w.a.storeId));
const switchRows = (w: World) => sql<{ source: string; reason: string | null; difference_count: number | null }[]>`
  select source, reason, difference_count from menu_usage_source_switches where store_id = ${w.a.storeId} order by created_at, id`;
const run = <T,>(w: World, fn: (tx: Parameters<Parameters<typeof asOrg>[1]>[0]) => Promise<T>) => asOrg(w.orgId, fn);

describe('I24 -- no blind switch', () => {
  it('with a difference: refused naming the day and the key; with a reason it is accepted and the row carries difference_count = 1; switching back is accepted at once and the next plan is maps-only', async () => {
    const { w, dayIds } = await sevenDays('i24a');
    const refusal = await refusalOf(() => run(w, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx)));
    expect(refusal, 'refused').not.toBeNull();
    expect(refusal!).toMatch(/Aug 17/);
    expect(refusal!).toMatch(/pork-belly/);
    expect(await switchRows(w), 'a refusal writes no switch row').toEqual([]);
    expect(await sourceOf(w), 'still maps').toBe('v1_pos_map');

    // acceptDifferences without a reason is not enough
    const noReason = await refusalOf(() => run(w, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules', acceptDifferences: true }, tx)));
    expect(noReason, 'acceptDifferences needs a typed reason').not.toBeNull();
    expect(await switchRows(w)).toEqual([]);

    const ok = await refusalOf(() => run(w, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules', acceptDifferences: true, reason: 'Pork belly rule is the new standard' }, tx)));
    expect(ok, 'accepted with a reason').toBeNull();
    expect(await switchRows(w)).toEqual([{ source: 'menu_rules', reason: 'Pork belly rule is the new standard', difference_count: 1 }]);
    expect(await sourceOf(w)).toBe('menu_rules');
    const on = await planOnly(w, w.a.storeId, dayIds['2026-08-17']!, w.a.kitchen);
    expect(on.lines.find((l) => l.key === 'direct:pork-belly')?.quantity, 'the rule (0.5 x 4)').toBe('2.000');

    // back: always allowed, immediate, no comparison and no reason
    const back = await refusalOf(() => run(w, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'v1_pos_map' }, tx)));
    expect(back, 'switching back needs nothing').toBeNull();
    expect((await switchRows(w)).map((r) => r.source)).toEqual(['menu_rules', 'v1_pos_map']);
    expect(await sourceOf(w)).toBe('v1_pos_map');
    const off = await planOnly(w, w.a.storeId, dayIds['2026-08-17']!, w.a.kitchen);
    expect(off.lines.find((l) => l.key === 'direct:pork-belly')?.quantity, 'maps again (0.25 x 4)').toBe('1.000');
  }, 240_000);

  it('zero differences: accepted with no reason, difference_count = 0 (mutant: a reason is demanded anyway / the count is not stored)', async () => {
    const { w, vPork } = await sevenDays('i24b');
    // make the rule agree with the map: a newer rule row, same quantity as the map
    await rawRule(w, vPork, { mode: 'direct', itemId: w.pork, quantityPerSale: '0.25' });
    const r = await refusalOf(() => run(w, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx)));
    expect(r, 'no differences -> no refusal').toBeNull();
    expect(await switchRows(w)).toEqual([{ source: 'menu_rules', reason: null, difference_count: 0 }]);
  }, 240_000);

  it('compareDepletionSources lists the day and key, and writes NOTHING (mutant: the comparison writes a plan, a pull, a switch or an audit row)', async () => {
    const { w } = await sevenDays('i24c');
    const tables = ['menu_usage_source_switches', 'pos_usage_pulls', 'pos_usage_pull_lines', 'audit_log', 'menu_pos_v1_links', 'menu_depletion_rules', 'pos_item_maps'];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t, w.orgId)])));
    const before = await snapshot();
    const cmp = await run(w, (tx) => s5.compareDepletionSources(w.admin, { storeId: w.a.storeId }, tx));
    expect(cmp.differenceCount).toBe(1);
    expect(cmp.differences.map((d) => d.posItemKey)).toEqual(['pork-belly']);
    expect(cmp.differences[0]!.businessDate).toBe('2026-08-17');
    expect(await snapshot(), 'row counts before and after are equal').toEqual(before);
  }, 240_000);

  it('a link that differs from its map is reported even if the item never sold in the window (a slow seller cannot hide a difference)', async () => {
    const w = await world('i24d');
    const v = await rawVariant(w, 'Pork Belly');
    await rawRule(w, v, { mode: 'direct', itemId: w.pork, quantityPerSale: '0.5' });
    await rawLink(w, w.a.storeId, 'slow', v);
    await rawMap(w, w.a.storeId, 'slow', { mode: 'direct', itemId: w.pork, quantityPerSale: '0.25' });
    await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'other', qty: 1 }])); // 'slow' did not sell
    const cmp = await run(w, (tx) => s5.compareDepletionSources(w.admin, { storeId: w.a.storeId }, tx));
    expect(cmp.differences.map((d) => d.posItemKey)).toContain('slow');
    const refusal = await refusalOf(() => run(w, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx)));
    expect(refusal, 'the switch is refused on a standing difference').not.toBeNull();
  }, 180_000);

  it('switching BACK to maps is allowed even while the store has a planned pull (ruling: the rollback is always one click)', async () => {
    const { w, dayIds } = await sevenDays('i24f');
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    await planOnly(w, w.a.storeId, dayIds['2026-08-20']!, w.a.kitchen);
    const back = await refusalOf(() => run(w, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'v1_pos_map' }, tx)));
    expect(back).toBeNull();
    expect(await sourceOf(w)).toBe('v1_pos_map');
  }, 180_000);

  it('capability: staff and manager are refused (switch_usage_source is admin and above), and nothing is written', async () => {
    const { w } = await sevenDays('i24e');
    for (const actor of [w.staff, w.manager]) {
      await expect(run(w, (tx) => s5.switchUsageSource(actor, { storeId: w.a.storeId, source: 'v1_pos_map' }, tx))).rejects.toThrow(/may not 'switch_usage_source'/);
    }
    expect(await switchRows(w)).toEqual([]);
  }, 180_000);
});
