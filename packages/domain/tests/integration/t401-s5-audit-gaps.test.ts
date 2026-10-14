/**
 * T-401 S5 audit gaps (orchestrator list a-g). TESTER; real Postgres; raw fixtures. Some are RED until the builder's parallel fixes land.
 *  (a) a switch cannot commit while another transaction holds an uncommitted plan (two connections)
 *  (b) a rule that comes due between plan and finalize does not change what finalize posts
 *  (c) setItemStatus itself refuses retiring an item with an active menu rule (and writes no retire audit)
 *  (d) linkPosV1Item refuses a locationId of another store
 *  (e) seedLinkFromMap from a bad map (inactive item) refuses in a sentence and writes nothing
 *  (f) switching to the source already in force is refused, no row, no audit
 *  (g) compareDepletionSources by an admin scoped to another store is refused (an authorization error, not a missing function)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { buildPlan, finalizeSections } from '@shareat/domain';
import { closeDb } from '@shareat/db';
import { planOnly } from './t401-s5-golden-scenario';
import { asOrg, makeDay, rawLink, rawMap, rawRule, rawSwitch, rawVariant, refusalOf, s5, sold, sql, stockUp, world } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const switchRows = (storeId: string) => sql<{ n: string }[]>`select count(*)::text n from menu_usage_source_switches where store_id = ${storeId}`.then((r) => Number(r[0]!.n));

describe('(a) a switch cannot commit over an uncommitted plan', () => {
  it('while tx1 holds an unfinished buildPlan, the switch from tx2 does not commit; once tx1 commits it is refused; no switch row ever appears', async () => {
    const w = await world('gap-a');
    await rawMap(w, w.a.storeId, 'coke', { mode: 'direct', itemId: w.coke, quantityPerSale: '1' });
    const d = await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'coke', qty: 2 }]));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let planned!: () => void;
    const planDone = new Promise<void>((r) => { planned = r; });
    const tx1 = asOrg(w.orgId, async (tx) => {
      const p = await buildPlan(tx, w.manager, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: d, locationId: w.a.kitchen });
      expect(p.ok).toBe(true);
      planned();
      await gate; // the plan is written but NOT committed
    });
    await planDone;
    let settled: 'pending' | 'done' | 'failed' = 'pending';
    let err: unknown;
    const tx2 = asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx)).then(
      () => { settled = 'done'; },
      (e) => { settled = 'failed'; err = e; },
    );
    await sleep(1500);
    expect(settled, 'the switch must wait for (or be refused by) the plan in flight, never commit beside it').not.toBe('done');
    expect(await switchRows(w.a.storeId)).toBe(0);
    release();
    await tx1;
    await tx2;
    expect(settled, 'after the plan commits the switch is refused').toBe('failed');
    expect(String((err as { message?: string })?.message ?? err)).not.toMatch(/is not a function/);
    expect(await switchRows(w.a.storeId)).toBe(0);
  }, 120_000);
});

describe('(b) a rule that falls due between plan and finalize', () => {
  it('finalize posts what the plan showed (cheese 1), not the newly due rule (cheese 4)', async () => {
    const w = await world('gap-b');
    const v = await rawVariant(w, 'Cheese Plate');
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.5' });
    await rawRule(w, v, { mode: 'direct', itemId: w.cheese, quantityPerSale: '2', effectiveFrom: new Date(Date.now() + 4000) });
    await rawLink(w, w.a.storeId, 'plate', v);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, '20');
    const d = await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'plate', qty: 2 }]));
    const plan = await planOnly(w, w.a.storeId, d, w.a.kitchen);
    expect(plan.lines.find((l) => l.key === 'direct:plate')?.quantity).toBe('1.000');
    await sleep(4500); // the 2.0 rule is now in force
    const fin = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId: plan.pullId, sections: ['direct'], confirmedKeys: ['direct:plate'] }));
    const out = await sql<{ q: string }[]>`select (-sum(quantity))::text q from stock_movements where org_id = ${w.orgId} and item_id = ${w.cheese} and quantity < 0`;
    // either finalize refuses (the plan changed under the manager: nothing posted) or it posts the PLANNED 1; it must never post 4
    expect(Number(out[0]?.q ?? 0), `finalize outcome ${JSON.stringify(fin)}`).not.toBe(4);
    expect([0, 1]).toContain(Number(out[0]?.q ?? 0));
  }, 120_000);
});

describe('(c) setItemStatus itself', () => {
  it('refuses retiring an item an active menu rule at a switched store depletes; item stays active; no retire_item audit', async () => {
    const w = await world('gap-c');
    const v = await rawVariant(w, 'Pork Dish');
    await rawRule(w, v, { mode: 'direct', itemId: w.pork, quantityPerSale: '1' });
    await rawLink(w, w.a.storeId, 'dish', v);
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'test', 0);
    const r = await refusalOf(() => asOrg(w.orgId, (tx) => s5.setItemStatus(tx, w.superAdmin, { itemId: w.pork, status: 'inactive' })));
    expect(r, 'refused with a sentence').not.toBeNull();
    expect((await sql<{ status: string }[]>`select status from items where id = ${w.pork}`)[0]!.status).toBe('active');
    expect(await sql`select 1 from audit_log where org_id = ${w.orgId} and action = 'retire_item'`).toHaveLength(0);
  }, 120_000);
});

describe('(d) link location', () => {
  it("a locationId that belongs to another store is refused; nothing written", async () => {
    const w = await world('gap-d');
    const v = await rawVariant(w, 'Dish');
    await rawRule(w, v, { mode: 'no_stock' });
    const r = await refusalOf(() => asOrg(w.orgId, (tx) => s5.linkPosV1Item(w.admin, { storeId: w.a.storeId, posItemKey: 'dish', variantId: v, locationId: w.b.kitchen }, tx)));
    expect(r).not.toBeNull();
    expect(await sql`select 1 from menu_pos_v1_links where org_id = ${w.orgId}`).toHaveLength(0);
  }, 120_000);
});

describe('(e) seed from a bad map', () => {
  it('a direct map onto an inactive stock item is refused in a sentence; no link, no rule', async () => {
    const w = await world('gap-e');
    await rawMap(w, w.a.storeId, 'old', { mode: 'direct', itemId: w.rice, quantityPerSale: '1' });
    await sql`update items set status = 'inactive' where id = ${w.rice}`;
    const v = await rawVariant(w, 'Old Dish');
    const r = await refusalOf(() => asOrg(w.orgId, (tx) => s5.seedLinkFromMap(w.admin, { storeId: w.a.storeId, posItemKey: 'old', variantId: v }, tx)));
    expect(r, 'refused').not.toBeNull();
    expect(await sql`select 1 from menu_pos_v1_links where org_id = ${w.orgId}`).toHaveLength(0);
    expect(await sql`select 1 from menu_depletion_rules where variant_id = ${v}`).toHaveLength(0);
  }, 120_000);
});

describe('(f) switching to the source already in force', () => {
  it('is refused and writes no row and no audit (both directions)', async () => {
    const w = await world('gap-f');
    await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'x', qty: 1 }]));
    const audits = () => sql`select 1 from audit_log where org_id = ${w.orgId} and action = 'menu.usage_source_switch'`.then((r) => r.length);
    const same = await refusalOf(() => asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'v1_pos_map' }, tx)));
    expect(same, 'no row = maps in force: switching to maps is refused').not.toBeNull();
    expect(await switchRows(w.a.storeId)).toBe(0);
    expect(await audits()).toBe(0);
    await asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx));
    const again = await refusalOf(() => asOrg(w.orgId, (tx) => s5.switchUsageSource(w.admin, { storeId: w.a.storeId, source: 'menu_rules' }, tx)));
    expect(again).not.toBeNull();
    expect(await switchRows(w.a.storeId)).toBe(1);
    expect(await audits()).toBe(1);
  }, 120_000);
});

describe('(g) compare by a viewer scoped to another store', () => {
  it('an admin scoped to store B only is refused for store A', async () => {
    const w = await world('gap-g');
    await makeDay(w, w.a.storeId, '2026-08-20', sold([{ key: 'x', qty: 1 }]));
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Admin B') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.b.storeId})`;
    const adminB = { personId: p!.id, orgId: w.orgId };
    let caught: unknown;
    try {
      await asOrg(w.orgId, (tx) => s5.compareDepletionSources(adminB, { storeId: w.a.storeId }, tx));
    } catch (e) { caught = e; }
    expect(caught, 'refused').toBeDefined();
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(String((caught as Error).message)).toMatch(/may not|scope|not allowed|access/i);
  }, 120_000);
});
