/**
 * T-401 S5 rulings 1, 3, 4 (docs/tasks/401-erp-menu-catalog-master.md "S5 rulings (Opus planner, 2026-10-14)"). TESTER; real Postgres; raw fixtures.
 *  - audit rows: linkPosV1Item -> menu.pos_v1_link; unlinkPosV1Item -> menu.pos_v1_unlink; switchUsageSource -> menu.usage_source_switch
 *    (after = { source, differenceCount, reason }); seedLinkFromMap -> menu.pos_v1_link, plus menu_depletion_rule_set when it creates the rule.
 *  - link / unlink / seed at a SWITCHED store with a planned pull are refused naming store and date; at an unswitched store always allowed.
 *  - difference_count = distinct keys with a difference: a key differing on 3 days AND standing -> 3 entries (no standing one), count 1.
 * Everything lives in pos/depletion-source.ts; tests import the functions from @shareat/domain. Red today: the functions do not exist.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@shareat/db';
import { planOnly } from './t401-s5-golden-scenario';
import { asOrg, makeDay, rawLink, rawMap, rawRule, rawSwitch, rawVariant, refusalOf, s5, sold, sql, world, type World } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const auditOf = (w: World, action: string) => sql<{ entity: string; store_id: string | null; after: Record<string, unknown> | null }[]>`
  select entity, store_id, after from audit_log where org_id = ${w.orgId} and action = ${action} order by created_at`;

describe('audit rows', () => {
  it('link and unlink each leave one row (menu.pos_v1_link / menu.pos_v1_unlink) naming the store and menu_pos_v1_links', async () => {
    const w = await world('aud1');
    const v = await rawVariant(w, 'Dish');
    await rawRule(w, v, { mode: 'no_stock' });
    await asOrg(w.orgId, (tx) => s5.linkPosV1Item(w.admin, { storeId: w.a.storeId, posItemKey: 'dish', variantId: v }, tx));
    const l = await auditOf(w, 'menu.pos_v1_link');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ entity: 'menu_pos_v1_links', store_id: w.a.storeId });
    await asOrg(w.orgId, (tx) => s5.unlinkPosV1Item(w.admin, { storeId: w.a.storeId, posItemKey: 'dish' }, tx));
    const u = await auditOf(w, 'menu.pos_v1_unlink');
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ entity: 'menu_pos_v1_links', store_id: w.a.storeId });
  }, 120_000);

  it('a switch leaves menu.usage_source_switch with after = { source, differenceCount, reason }; a refused switch leaves none', async () => {
    const w = await world('aud2');
    await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'x', qty: 1 }]));
    await expect(asOrg(w.orgId, (tx) => s5.switchUsageSource(w.manager, { storeId: w.a.storeId, source: 'menu_rules' }, tx))).rejects.toThrow(/may not 'switch_usage_source'/);
    expect(await auditOf(w, 'menu.usage_source_switch')).toEqual([]);
    await asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx));
    const rows = await auditOf(w, 'menu.usage_source_switch');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'menu_usage_source_switches', store_id: w.a.storeId });
    expect(rows[0]!.after).toEqual({ source: 'menu_rules', differenceCount: 0, reason: null });
  }, 120_000);

  it('seed writes menu.pos_v1_link AND menu_depletion_rule_set when it creates the rule; only the link row when the variant already has a rule', async () => {
    const w = await world('aud3');
    await rawMap(w, w.a.storeId, 'k1', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25' });
    await rawMap(w, w.a.storeId, 'k2', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25' });
    const fresh = await rawVariant(w, 'Fresh');
    const ruled = await rawVariant(w, 'Ruled');
    await rawRule(w, ruled, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    await asOrg(w.orgId, (tx) => s5.seedLinkFromMap(w.admin, { storeId: w.a.storeId, posItemKey: 'k1', variantId: fresh }, tx));
    expect(await auditOf(w, 'menu.pos_v1_link')).toHaveLength(1);
    expect(await auditOf(w, 'menu_depletion_rule_set')).toHaveLength(1);
    await asOrg(w.orgId, (tx) => s5.seedLinkFromMap(w.admin, { storeId: w.a.storeId, posItemKey: 'k2', variantId: ruled }, tx));
    expect(await auditOf(w, 'menu.pos_v1_link')).toHaveLength(2);
    expect(await auditOf(w, 'menu_depletion_rule_set'), 'no rule created, no rule audit').toHaveLength(1);
  }, 120_000);
});

describe('links move plans too: refused at a switched store with a planned pull', () => {
  async function scene(switched: boolean) {
    const w = await world(switched ? 'lk1' : 'lk2');
    const vLinked = await rawVariant(w, 'Linked');
    await rawRule(w, vLinked, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    await rawLink(w, w.a.storeId, 'linked', vLinked);
    const vNew = await rawVariant(w, 'New');
    await rawRule(w, vNew, { mode: 'no_stock' });
    const vSeed = await rawVariant(w, 'Seed');
    await rawMap(w, w.a.storeId, 'seedme', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25' });
    await rawMap(w, w.a.storeId, 'linked', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    if (switched) await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    const d = await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'linked', qty: 2 }]));
    await planOnly(w, w.a.storeId, d, w.a.kitchen);
    return { w, vNew, vSeed };
  }
  const linkCount = (w: World) => sql<{ n: string }[]>`select count(*)::text n from menu_pos_v1_links where org_id = ${w.orgId} and status = 'active'`.then((r) => Number(r[0]!.n));

  it('link, unlink and seed are each refused naming Lipa and Aug 20, and write nothing', async () => {
    const { w, vNew, vSeed } = await scene(true);
    const before = await linkCount(w);
    const attempts = [
      () => asOrg(w.orgId, (tx) => s5.linkPosV1Item(w.admin, { storeId: w.a.storeId, posItemKey: 'brand-new', variantId: vNew }, tx)),
      () => asOrg(w.orgId, (tx) => s5.unlinkPosV1Item(w.admin, { storeId: w.a.storeId, posItemKey: 'linked' }, tx)),
      () => asOrg(w.orgId, (tx) => s5.seedLinkFromMap(w.admin, { storeId: w.a.storeId, posItemKey: 'seedme', variantId: vSeed }, tx)),
    ];
    for (const a of attempts) {
      const r = await refusalOf(a);
      expect(r, 'refused').not.toBeNull();
      expect(r!).toMatch(/Lipa/);
      expect(r!).toMatch(/Aug 20/);
    }
    expect(await linkCount(w)).toBe(before);
  }, 180_000);

  it('at an UNSWITCHED store the same three are allowed (a link there changes nothing until a switch)', async () => {
    const { w, vNew, vSeed } = await scene(false);
    expect(await refusalOf(() => asOrg(w.orgId, (tx) => s5.linkPosV1Item(w.admin, { storeId: w.a.storeId, posItemKey: 'brand-new', variantId: vNew }, tx)))).toBeNull();
    expect(await refusalOf(() => asOrg(w.orgId, (tx) => s5.seedLinkFromMap(w.admin, { storeId: w.a.storeId, posItemKey: 'seedme', variantId: vSeed }, tx)))).toBeNull();
    expect(await refusalOf(() => asOrg(w.orgId, (tx) => s5.unlinkPosV1Item(w.admin, { storeId: w.a.storeId, posItemKey: 'linked' }, tx)))).toBeNull();
  }, 180_000);
});

describe('I24 count rule (ruling 4)', () => {
  it('a key that differs on 3 sold days and also standing -> 3 day entries, no standing entry, differenceCount 1; the refusal names the earliest day', async () => {
    const w = await world('cnt');
    const v = await rawVariant(w, 'Pork Belly');
    await rawRule(w, v, { mode: 'direct', itemId: w.pork, quantityPerSale: '0.5' });
    await rawLink(w, w.a.storeId, 'pork-belly', v);
    await rawMap(w, w.a.storeId, 'pork-belly', { mode: 'direct', itemId: w.pork, quantityPerSale: '0.25', name: 'pork-belly' });
    for (const d of ['2026-08-16', '2026-08-18', '2026-08-19']) await makeDay(w, w.a.storeId, d, sold([{ key: 'pork-belly', qty: 4 }]));
    const cmp = await asOrg(w.orgId, (tx) => s5.compareDepletionSources(w.admin, { storeId: w.a.storeId }, tx));
    expect(cmp.differenceCount).toBe(1);
    expect(cmp.differences.map((d) => d.businessDate).sort()).toEqual(['2026-08-16', '2026-08-18', '2026-08-19']);
    expect(cmp.differences.every((d) => d.posItemKey === 'pork-belly')).toBe(true);
    const r = await refusalOf(() => asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx)));
    expect(r!).toMatch(/Aug 16/);
    expect(r!).toMatch(/pork-belly/);
  }, 180_000);

  it('a key that differs only standing (never sold in the window) gives one entry with businessDate null and count 1', async () => {
    const w = await world('cnt2');
    const v = await rawVariant(w, 'Slow');
    await rawRule(w, v, { mode: 'direct', itemId: w.pork, quantityPerSale: '0.5' });
    await rawLink(w, w.a.storeId, 'slow', v);
    await rawMap(w, w.a.storeId, 'slow', { mode: 'direct', itemId: w.pork, quantityPerSale: '0.25' });
    await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'other', qty: 1 }]));
    const cmp = await asOrg(w.orgId, (tx) => s5.compareDepletionSources(w.admin, { storeId: w.a.storeId }, tx));
    expect(cmp.differenceCount).toBe(1);
    expect(cmp.differences).toHaveLength(1);
    expect(cmp.differences[0]).toMatchObject({ posItemKey: 'slow', businessDate: null });
  }, 120_000);
});
