import { afterAll, describe, expect, it } from 'vitest';
import { auditLogRepo, closeDb, systemTransaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import {
  addUsageLine,
  buildPlan,
  createProductionDraft,
  editPostedProduction,
  finalizeSections,
  postProduction,
  postUsage,
  removeUsageLine,
  saveUsageDraft,
  voidProduction,
} from '@shareat/domain';
import { usageCloseRefusal } from '../../src/stock/usage-check-report';
import { usageVariancesFor } from '../../src/stock/usage-tolerance';
import { humanDate } from '../../src/shared/refusal-leaf';
import { asOrg, makeDay, rawMap, refusalOf, sold, sql, stockUp, world, type World } from './t401-s5-setup';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-420 cases 1-12 - the daily usage check counts the ingredients of POSTED recipe cooking (docs/tasks/420-usage-check-counts-cook.md).
 * TESTER. Real Postgres, raw fixtures from t401-s5-setup (one org per scenario).
 *
 * Fixture (all kg: a cook cannot mix kg and L): day D = 2026-08-20, store A, rooms Kitchen (K) and Display (the "bar" room, B).
 *  - cook recipe "Adobo base": Pork 500 g + Soy 100 g -> 0.6 kg Adobo, so a cook of X kg pork has output X x 1.2 kg;
 *  - sale recipe "Adobo plate": Pork 0.35 kg per plate; 2 plates sold -> the day's plan expects Pork 0.700 kg.
 * Deviations from the spec's numbers, on purpose: case 6 uses cook 0.300 and recorded 0.050 (not cook 0.350) so that a recorded line stays
 * positive and K lands exactly on its snapshot 0.350; case 9 does not finalize the recipe section, so no other record holds pork.
 *
 * Red-for-the-right-reason on HEAD: `cooked` does not exist on UsageVariance, the snapshot/live verdicts ignore cooking, and the 14:00
 * auto-post still takes the whole expected pork. Tests marked GUARD pass on HEAD by design (they pin what must NOT change).
 */
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const DAY = '2026-08-20';
const DAY_BEFORE = '2026-08-19';
const AFTER_DUE = new Date('2026-08-21T06:01:00Z'); // 14:00 Manila on D+1 is 06:00Z
const MONTH_FROM = '2026-08-01';
const MONTH_TO = '2026-08-31';

interface Row { itemId: string; itemName: string; expected: string; actual: string; cooked: string; tolerance: string; withinBand: boolean }
interface Pos { key: string; qty: number; map: Parameters<typeof rawMap>[3] }
interface S { w: World; soy: string; adobo: string; cookRecipe: string; saleRecipe: string; dayId: string; pullId: string; keys: string[] }

// pork kg cooked -> adobo kg output (recipe ratio 0.6 : 0.5)
const OUTPUT_OF: Record<string, string> = { '0.1': '0.12', '0.2': '0.24', '0.3': '0.36', '0.35': '0.42', '0.5': '0.6', '0.9': '1.08' };

async function rawItem(w: World, name: string, unit = 'kg'): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${w.orgId}, ${testItemCode()}, ${name}, 'raw_material', ${unit}, ${w.admin.personId}) returning id`;
  return r!.id;
}

/** Plan built (not finalized) for store A on D. `pos` decides what is sold and how it maps; default = 2 Adobo plates (recipe, Kitchen). */
async function scenario(hint: string, pos?: (c: { w: World; saleRecipe: string; adobo: string }) => Pos[]): Promise<S> {
  const w = await world(hint);
  const soy = await rawItem(w, 'Soy sauce');
  const adobo = await rawItem(w, 'Adobo');
  const [cr] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${w.orgId}, 'Adobo base', ${adobo}, 0.6, ${w.admin.personId}) returning id`;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${cr!.id}, ${w.pork}, 500, 'g'), (${cr!.id}, ${soy}, 100, 'g')`;
  const [sr] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${w.orgId}, 'Adobo plate', ${adobo}, 1, ${w.admin.personId}) returning id`;
  await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${sr!.id}, ${w.pork}, 0.35, 'kg')`;

  for (const room of [w.a.kitchen, w.a.display!]) {
    await stockUp(w, w.a.storeId, room, w.pork, '1000');
    await stockUp(w, w.a.storeId, room, soy, '1000');
  }
  await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, '1000');

  const items = pos
    ? pos({ w, saleRecipe: sr!.id, adobo })
    : [{ key: 'plate', qty: 2, map: { mode: 'recipe' as const, recipeId: sr!.id } }];
  for (const p of items) await rawMap(w, w.a.storeId, p.key, p.map);
  const dayId = await makeDay(w, w.a.storeId, DAY, sold(items.map((p) => ({ key: p.key, qty: p.qty }))));
  const plan = await asOrg(w.orgId, (tx) => buildPlan(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: dayId, locationId: w.a.kitchen }));
  if (!plan.ok) throw new Error(`fixture: buildPlan refused: ${plan.reason}`);
  return { w, soy, adobo, cookRecipe: cr!.id, saleRecipe: sr!.id, dayId, pullId: plan.pullId, keys: plan.lines.filter((l) => !l.blocked).map((l) => l.key) };
}

async function finalize(s: S, sections: ('direct' | 'recipe' | 'orphan')[]): Promise<void> {
  const f = await asOrg(s.w.orgId, (tx) => finalizeSections(tx, s.w.manager, { pullId: s.pullId, sections, confirmedKeys: s.keys }));
  if (!f.ok) throw new Error(`fixture: finalize refused: ${f.reason}`);
  // "finalized" moved to the evening of the business date, everywhere a builder could read it from (A10), so 14:00 D+1 is due.
  const at = '2026-08-20T12:00:00Z';
  await sql`update stock_usage_records set created_at = ${at} where org_id = ${s.w.orgId}`;
  await sql`update pos_usage_pulls set direct_finalized_at = case when direct_finalized_at is null then null else ${at}::timestamptz end,
                                       recipe_finalized_at = case when recipe_finalized_at is null then null else ${at}::timestamptz end,
                                       orphan_finalized_at = case when orphan_finalized_at is null then null else ${at}::timestamptz end
             where id = ${s.pullId}`;
}

const draftIn = async (s: S, locationId: string): Promise<string> => {
  const rows = await sql<{ id: string }[]>`
    select id from stock_usage_records where org_id = ${s.w.orgId} and store_id = ${s.w.a.storeId} and used_on = ${DAY} and kind = 'usage'
       and status = 'draft' and location_id = ${locationId}`;
  expect(rows, 'exactly one pull draft in that room').toHaveLength(1);
  return rows[0]!.id;
};

/** Staff set a line to the actual: remove the existing line, add a new one. */
async function setActual(w: World, recordId: string, itemId: string, qty: string): Promise<void> {
  const [line] = await sql<{ id: string }[]>`select id from stock_usage_lines where record_id = ${recordId} and item_id = ${itemId}`;
  if (line) {
    const r = await asOrg(w.orgId, (tx) => removeUsageLine(tx, w.staff, { recordId, lineId: line.id }));
    expect(r.ok).toBe(true);
  }
  const a = await asOrg(w.orgId, (tx) => addUsageLine(tx, w.staff, { recordId, itemId, quantity: qty }));
  expect(a.ok, a.ok ? '' : a.reason).toBe(true);
}

/** A manual usage draft of pork by staff in the Kitchen on D. */
async function manualPork(s: S, qty: string): Promise<string> {
  const r = await asOrg(s.w.orgId, (tx) =>
    saveUsageDraft(tx, s.w.staff, { orgId: s.w.orgId, storeId: s.w.a.storeId, locationId: s.w.a.kitchen, kind: 'usage', usedOn: DAY, lines: [{ itemId: s.w.pork, quantity: qty }] }),
  );
  if (!r.ok) throw new Error(`fixture: manual draft refused: ${r.reason}`);
  return r.recordId;
}
/** Marks a usage record posted by the manager WITHOUT going through the post gate (no verification row, no stock). */
const rawPosted = (s: S, id: string) =>
  sql`update stock_usage_records set status = 'posted', posted_at = now(), posted_by = ${s.w.manager.personId} where id = ${id}`;

async function cookDraft(s: S, pork: string, o: { storeId?: string; locationId?: string; producedOn?: string } = {}): Promise<string> {
  const r = await asOrg(s.w.orgId, (tx) =>
    createProductionDraft(tx, s.w.manager, {
      orgId: s.w.orgId, storeId: o.storeId ?? s.w.a.storeId, locationId: o.locationId ?? s.w.a.kitchen, kind: 'cook', producedOn: o.producedOn ?? DAY,
      labourCost: '0', recipeId: s.cookRecipe, inputs: [], outputs: [{ itemId: s.adobo, quantity: OUTPUT_OF[pork]!, unit: 'kg' }],
    } as Parameters<typeof createProductionDraft>[2]),
  );
  if (!r.ok) throw new Error(`fixture: cook draft refused: ${r.reason}`);
  return r.recordId;
}
async function cookPosted(s: S, pork: string, o: Parameters<typeof cookDraft>[2] = {}): Promise<string> {
  const id = await cookDraft(s, pork, o);
  const p = await asOrg(s.w.orgId, (tx) => postProduction(tx, s.w.manager, { recordId: id }));
  if (!p.ok) throw new Error(`fixture: cook post refused: ${JSON.stringify(p)}`);
  return id;
}

const variances = async (s: S): Promise<Row[]> =>
  (await asOrg(s.w.orgId, (tx) => usageVariancesFor(tx, s.w.orgId, s.w.a.storeId, DAY))) as unknown as Row[];
const porkRow = async (s: S): Promise<Row> => {
  const row = (await variances(s)).find((v) => v.itemId === s.w.pork);
  expect(row, 'pork is covered by the plan').toBeDefined();
  return row!;
};
const onHand = async (itemId: string): Promise<string> =>
  (await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId}`)[0]!.t;
const managerPost = (s: S, id: string, reason?: string) =>
  asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.manager, { recordId: id, ...(reason === undefined ? {} : { verifyOutOfTolerance: { reason } }) }));
const verifiedRows = async (s: S): Promise<number> =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${s.w.orgId} and action = 'stock.usage_tolerance_verified'`)[0]!.n);
const closeRefusal = (s: S) => asOrg(s.w.orgId, (tx) => usageCloseRefusal(tx, s.w.orgId, MONTH_FROM, MONTH_TO));

const sweep = async (s: S) => {
  const r = await systemTransaction((tx) => (domain as unknown as { autoPostDueUsageDrafts(tx: Tx, now: Date): Promise<{ posted: { recordId: string }[]; skipped: { recordId: string; reason: string }[] }> }).autoPostDueUsageDrafts(tx, AFTER_DUE));
  const own = new Set((await sql<{ id: string }[]>`select id from stock_usage_records where org_id = ${s.w.orgId}`).map((x) => x.id));
  return { posted: r.posted.filter((x) => own.has(x.recordId)), skipped: r.skipped.filter((x) => own.has(x.recordId)) };
};
const porkLines = async (s: S): Promise<string[]> =>
  (await sql<{ q: string }[]>`
    select l.quantity::text as q from stock_usage_lines l join stock_usage_records r on r.id = l.record_id
     where r.org_id = ${s.w.orgId} and l.item_id = ${s.w.pork} order by l.quantity`).map((x) => x.q);

// ---------------------------------------------------------------------------------------------------------------------
describe('T-420 live check (store-wide): recorded + cooked against expected', () => {
  it('1. staff record pork 0.200; posted cooks of 0.300 (Kitchen) and 0.200 (Display) -> actual 0.200, cooked 0.500 (whole store), inside the band. Mutant: cook not added to the verdict / only one room', async () => {
    const s = await scenario('c1');
    await manualPork(s, '0.2');
    await cookPosted(s, '0.3');
    await cookPosted(s, '0.2', { locationId: s.w.a.display! });
    const p = await porkRow(s);
    expect(p).toMatchObject({ expected: '0.700', actual: '0.200', cooked: '0.500', withinBand: true });
  }, 240_000);

  it('2a. a DRAFT cook counts nowhere: cooked "0", still outside. Mutant: drafts counted (C1)', async () => {
    const s = await scenario('c2a');
    await manualPork(s, '0.2');
    await cookDraft(s, '0.5');
    const p = await porkRow(s);
    expect(p).toMatchObject({ actual: '0.200', cooked: '0', withinBand: false });
  }, 240_000);

  it('2b. GUARD: with an untouched pull draft, a draft cook changes nothing at 14:00: pork posts 0.700, no adjustment, stock falls by 0.700 only', async () => {
    const s = await scenario('c2b');
    await finalize(s, ['recipe']);
    await cookDraft(s, '0.5');
    const r = await sweep(s);
    expect(r.skipped).toEqual([]);
    expect(r.posted).toHaveLength(1);
    expect(await porkLines(s)).toEqual(['0.700']);
    expect(await onHand(s.w.pork)).toBe('1999.300'); // 2 x 1000 in Kitchen and Display, less 0.700
    const [a] = await sql<{ after: { adjusted: unknown[] } }[]>`select after from audit_log where org_id = ${s.w.orgId} and action = 'stock.usage_auto_posted'`;
    expect(a!.after.adjusted).toEqual([]);
  }, 240_000);

  it('3a. a VOIDED cook gives no credit. Mutant: void not excluded', async () => {
    const s = await scenario('c3a');
    await manualPork(s, '0.2');
    const id = await cookPosted(s, '0.5');
    expect((await porkRow(s)).cooked, 'control: the posted cook counts').toBe('0.500');
    const v = await asOrg(s.w.orgId, (tx) => voidProduction(tx, s.w.manager, { recordId: id, reason: 'cooked the wrong thing' }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(await porkRow(s)).toMatchObject({ cooked: '0', withinBand: false });
  }, 240_000);

  it('3b. a posted cook EDITED from 0.500 to 0.300 credits 0.300, not 0.800. Mutant: reversed lines summed', async () => {
    const s = await scenario('c3b');
    await manualPork(s, '0.2');
    const id = await cookPosted(s, '0.5');
    const e = await asOrg(s.w.orgId, (tx) =>
      editPostedProduction(tx, s.w.manager, { recordId: id, inputs: [], outputs: [{ itemId: s.adobo, quantity: OUTPUT_OF['0.3']!, unit: 'kg' }] } as Parameters<typeof editPostedProduction>[2]),
    );
    expect(e.ok, JSON.stringify(e)).toBe(true);
    expect((await porkRow(s)).cooked).toBe('0.300');
  }, 240_000);

  it('4. not credited: the cook OUTPUT (Adobo), a cook at store B, a cook on D-1, a posted slice and a posted convert of pork; a real cook of 0.100 still is. Mutants: direction=in; store, date or kind filter dropped', async () => {
    const s = await scenario('c4', ({ w, saleRecipe, adobo }) => [
      { key: 'plate', qty: 2, map: { mode: 'recipe', recipeId: saleRecipe } },
      { key: 'adobo', qty: 1, map: { mode: 'direct', itemId: adobo, quantityPerSale: '1' } },
    ]);
    await stockUp(s.w, s.w.b.storeId, s.w.b.kitchen, s.w.pork, '1000');
    await stockUp(s.w, s.w.b.storeId, s.w.b.kitchen, s.soy, '1000');
    await cookPosted(s, '0.5', { storeId: s.w.b.storeId, locationId: s.w.b.kitchen });
    await cookPosted(s, '0.5', { producedOn: DAY_BEFORE });
    for (const [kind, outItem, inItem] of [['slice', s.w.pork, s.w.cheese], ['convert', s.w.pork, s.w.rice]] as const) {
      const [r] = await sql<{ id: string }[]>`
        insert into production_records (org_id, store_id, location_id, kind, status, produced_on, posted_at, posted_by, created_by)
        values (${s.w.orgId}, ${s.w.a.storeId}, ${s.w.a.kitchen}, ${kind}, 'posted', ${DAY}, now(), ${s.w.manager.personId}, ${s.w.manager.personId}) returning id`;
      await sql`insert into production_record_lines (record_id, direction, item_id, quantity, unit, revision) values (${r!.id}, 'out', ${outItem}, 3, 'kg', 1), (${r!.id}, 'in', ${inItem}, 2, 'kg', 1)`;
    }
    await cookPosted(s, '0.1'); // the one real credit: Kitchen, store A, D (its output is 0.12 kg Adobo, not credited)
    const rows = await variances(s);
    const pork = rows.find((v) => v.itemId === s.w.pork)!;
    const adobo = rows.find((v) => v.itemId === s.adobo);
    expect(pork.cooked).toBe('0.100');
    expect(adobo, 'Adobo is covered (sold direct) so it has a row').toBeDefined();
    expect(adobo!.cooked, 'the cook output is never credited').toBe('0');
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-420 snapshot check (one pull draft): cooking in the SAME ROOM is credited', () => {
  it('5. pull draft in Kitchen (snapshot 0.700), staff lower pork to 0.200, posted cook 0.500 in Kitchen -> manager posts with NO reason, no verification row. Mutant: snapshot path not crediting', async () => {
    const s = await scenario('c5');
    await finalize(s, ['recipe']);
    const id = await draftIn(s, s.w.a.kitchen);
    await setActual(s.w, id, s.w.pork, '0.2');
    await cookPosted(s, '0.5');
    const r = await managerPost(s, id);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(await verifiedRows(s)).toBe(0);
  }, 240_000);

  it('5b. GUARD: the same lowered line WITHOUT the cook is refused without a reason (so the credit above is what let it through)', async () => {
    const s = await scenario('c5b');
    await finalize(s, ['recipe']);
    const id = await draftIn(s, s.w.a.kitchen);
    await setActual(s.w, id, s.w.pork, '0.2');
    expect(await refusalOf(() => managerPost(s, id))).not.toBeNull();
  }, 240_000);

  it('6. pull drafts in Kitchen AND Display both hold pork (snapshot 0.350 each); one posted cook 0.300 in Kitchen; each record records 0.050 -> Kitchen is judged WITH the cook (posts), Display WITHOUT it (refused). Mutant: store-wide credit in the snapshot path', async () => {
    const s = await scenario('c6', ({ w, saleRecipe }) => [
      { key: 'plateK', qty: 1, map: { mode: 'recipe', recipeId: saleRecipe } },
      { key: 'plateD', qty: 1, map: { mode: 'recipe', recipeId: saleRecipe, locationId: w.a.display! } },
    ]);
    await finalize(s, ['recipe']);
    const k = await draftIn(s, s.w.a.kitchen);
    const d = await draftIn(s, s.w.a.display!);
    await setActual(s.w, k, s.w.pork, '0.05');
    await setActual(s.w, d, s.w.pork, '0.05');
    await cookPosted(s, '0.3'); // Kitchen
    expect(await refusalOf(() => managerPost(s, d)), 'Display has no cook of its own').not.toBeNull();
    const r = await managerPost(s, k);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-420 the 14:00 auto-post never takes cooked stock a second time', () => {
  it('7. untouched pull draft pork 0.700, posted cook 0.500 in Kitchen -> auto-post posts pork 0.200; stock fell 0.700 in total, never 1.200; audit lists 0.700 -> 0.200. Mutant: snapshot target ignores cooking', async () => {
    const s = await scenario('c7');
    await finalize(s, ['recipe']);
    const start = await onHand(s.w.pork);
    await cookPosted(s, '0.5');
    const r = await sweep(s);
    expect(r.skipped).toEqual([]);
    expect(r.posted).toHaveLength(1);
    expect(await porkLines(s)).toEqual(['0.200']);
    expect(Number(start) - Number(await onHand(s.w.pork))).toBeCloseTo(0.7, 6);
    const [a] = await sql<{ after: { adjusted: { itemId: string; recorded: string; posted: string }[] } }[]>`
      select after from audit_log where org_id = ${s.w.orgId} and action = 'stock.usage_auto_posted'`;
    const adj = a!.after.adjusted.find((x) => x.itemId === s.w.pork);
    expect(adj, 'the pork line is listed as adjusted').toBeDefined();
    expect([Number(adj!.recorded), Number(adj!.posted)]).toEqual([0.7, 0.2]);
  }, 240_000);

  it('8. cook 0.900 > snapshot 0.700 -> no pork line is posted, none negative, nothing skipped. Mutant: missing floor at 0', async () => {
    const s = await scenario('c8');
    await finalize(s, ['recipe']);
    const start = await onHand(s.w.pork);
    await cookPosted(s, '0.9');
    const r = await sweep(s);
    expect(r.skipped).toEqual([]);
    expect(await porkLines(s), 'no pork line at all').toEqual([]);
    expect(Number(start) - Number(await onHand(s.w.pork)), 'stock fell by the cook only').toBeCloseTo(0.9, 6);
  }, 240_000);

  it('9. live step: staff typed pork 0.700 onto the Kitchen pull draft (pork not in its snapshot; plan expects 0.700); posted cook 0.300 -> auto-post posts pork 0.400. Mutant: live step ignores store cooking', async () => {
    const s = await scenario('c9', ({ w, saleRecipe }) => [
      { key: 'rice', qty: 10, map: { mode: 'direct', itemId: w.rice, quantityPerSale: '1' } },
      { key: 'plate', qty: 2, map: { mode: 'recipe', recipeId: saleRecipe } },
    ]);
    await finalize(s, ['direct']); // the recipe section (pork) is NOT finalized: no pork in any snapshot, no other record holds pork
    const id = await draftIn(s, s.w.a.kitchen);
    const a = await asOrg(s.w.orgId, (tx) => addUsageLine(tx, s.w.staff, { recordId: id, itemId: s.w.pork, quantity: '0.7' }));
    expect(a.ok, a.ok ? '' : a.reason).toBe(true);
    const start = await onHand(s.w.pork);
    await cookPosted(s, '0.3');
    const r = await sweep(s);
    expect(r.skipped).toEqual([]);
    expect(r.posted).toHaveLength(1);
    expect(await porkLines(s)).toEqual(['0.400']);
    expect(Number(start) - Number(await onHand(s.w.pork))).toBeCloseTo(0.7, 6);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-420 month close judges with cooking, at close time', () => {
  it('10. manager-posted usage 0.200 + posted cook 0.500 -> no refusal; void the cook -> refusal names "outside the tolerance". Mutant: close not crediting / credit cached across the void', async () => {
    const s = await scenario('c10');
    const rec = await manualPork(s, '0.2');
    await rawPosted(s, rec);
    const cook = await cookPosted(s, '0.5');
    expect(await closeRefusal(s)).toBeNull();
    const v = await asOrg(s.w.orgId, (tx) => voidProduction(tx, s.w.manager, { recordId: cook, reason: 'cooked the wrong thing' }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    const refusal = await closeRefusal(s);
    expect(refusal, 'with the cook voided the 0.200 stands alone against 0.700').not.toBeNull();
    expect(refusal!).toContain('outside the tolerance');
  }, 240_000);

  it('11. late cook: usage 0.700 posted in band, THEN a cook 0.500 posted -> refusal (1.200 against 0.700); a reason on file clears it. Mutant: cooking capped at the shortfall', async () => {
    const s = await scenario('c11');
    const rec = await manualPork(s, '0.7');
    await rawPosted(s, rec);
    expect(await closeRefusal(s), 'control: in band, no cook yet').toBeNull();
    await cookPosted(s, '0.5');
    const refusal = await closeRefusal(s);
    expect(refusal, 'recorded 0.7 + cooked 0.5 is above 0.7: stock taken twice').not.toBeNull();
    expect(refusal!).toContain('outside the tolerance');
    await asOrg(s.w.orgId, (tx) =>
      auditLogRepo.append(tx, s.w.orgId, {
        actorPersonId: s.w.manager.personId, action: 'stock.usage_tolerance_verified', storeId: s.w.a.storeId, entityId: rec, before: null,
        after: { itemId: s.w.pork, businessDate: DAY, expected: '0.700', actual: '0.700', tolerance: '0.1000', reason: 'Counted twice, checked by hand' },
        source: 'web',
      }),
    );
    expect(await closeRefusal(s)).toBeNull();
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-420 the refusal sentence', () => {
  const day = humanDate(DAY as Parameters<typeof humanDate>[0]);
  const tail = 'A manager who has checked the count can post it with a reason.';

  it('12a. with cooking: "Pork: 0.1 recorded + 0.5 used in cooking against 0.7 expected for <day> (more than 10% apart)." Mutant: wording dropped', async () => {
    const s = await scenario('c12a');
    const rec = await manualPork(s, '0.1');
    await cookPosted(s, '0.5'); // 0.1 + 0.5 = 0.6 against 0.7: 14% apart, still outside
    const reason = await refusalOf(() => managerPost(s, rec));
    expect(reason).toBe(`Pork: 0.1 recorded + 0.5 used in cooking against 0.7 expected for ${day} (more than 10% apart). ${tail}`);
  }, 240_000);

  it('12b. GUARD: with no cooking the sentence is byte-for-byte today\'s', async () => {
    const s = await scenario('c12b');
    const rec = await manualPork(s, '0.1');
    const reason = await refusalOf(() => managerPost(s, rec));
    expect(reason).toBe(`Pork: 0.1 recorded against 0.7 expected for ${day} (more than 10% apart). ${tail}`);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-420 case 14 - a cook is credited ONCE across rooms (orchestrator ruling after audit)', () => {
  // Pork is in Display's pull snapshot (0.350) and NOT in Kitchen's (Kitchen's pull covers only rice); staff typed pork onto Kitchen's
  // draft. The cook happens in Display. Display's snapshot check credits it (room scope); Kitchen's live check must NOT credit it again
  // (its credit = cooks from rooms that hold no snapshot of the item = none). Display is swept first (its draft is created first).
  const setup = async (hint: string): Promise<{ s: S; k: string; d: string }> => {
    const s = await scenario(hint, ({ w, saleRecipe }) => [
      { key: 'rice', qty: 10, map: { mode: 'direct', itemId: w.rice, quantityPerSale: '1' } },
      { key: 'plateD', qty: 1, map: { mode: 'recipe', recipeId: saleRecipe, locationId: w.a.display! } },
    ]);
    await finalize(s, ['recipe']);
    await finalize(s, ['direct']);
    const d = await draftIn(s, s.w.a.display!);
    const k = await draftIn(s, s.w.a.kitchen);
    return { s, k, d };
  };
  const typeInKitchen = async (s: S, k: string, qty: string) => {
    const a = await asOrg(s.w.orgId, (tx) => addUsageLine(tx, s.w.staff, { recordId: k, itemId: s.w.pork, quantity: qty }));
    expect(a.ok, a.ok ? '' : a.reason).toBe(true);
  };

  it('14a. post gate: Display records 0.150 + room cook 0.200 = its snapshot 0.350 (posts, no reason); Kitchen typed 0.200 (store total 0.350) posts too, the cook not counted a second time. Mutant: snapshot path ignores cooking / live path credits a cook from a snapshot room', async () => {
    const { s, k, d } = await setup('c14a');
    await setActual(s.w, d, s.w.pork, '0.15');
    await typeInKitchen(s, k, '0.2');
    await cookPosted(s, '0.2', { locationId: s.w.a.display! });
    const rk = await managerPost(s, k);
    expect(rk.ok, rk.ok ? '' : rk.reason).toBe(true);
    const rd = await managerPost(s, d);
    expect(rd.ok, rd.ok ? '' : rd.reason).toBe(true);
    expect(await verifiedRows(s)).toBe(0);
  }, 300_000);

  it('14b. 14:00 auto-post: Display 0.350 -> 0.150 (its cook 0.200 taken off once); Kitchen live step 0.350 - 0.150 = 0.200 (NOT 0.350 - 0.150 - 0.200 = 0). Credit across rooms = the cook, exactly once. Mutant: live step subtracts store-wide cooking', async () => {
    const { s, k } = await setup('c14b');
    await typeInKitchen(s, k, '0.1');
    await cookPosted(s, '0.2', { locationId: s.w.a.display! });
    const r = await sweep(s);
    expect(r.skipped).toEqual([]);
    expect(r.posted).toHaveLength(2);
    expect(await porkLines(s), 'Display 0.150 and Kitchen 0.200').toEqual(['0.150', '0.200']);
  }, 300_000);
});
