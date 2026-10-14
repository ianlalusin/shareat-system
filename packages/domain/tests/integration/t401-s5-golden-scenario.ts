/**
 * T-401 S5, I16: the ONE deterministic usage-pull scenario whose output is frozen in t401-s5-golden-no-switch.json.
 * The golden was captured from the code BEFORE S5 (pos_item_maps only, no seam). Used by t401-s5-golden-no-switch.test.ts
 * (an unswitched store must still produce exactly this) and by t401-s5-depletion-source.test.ts (a switched store with
 * NO linked key must produce the same plan lines).
 *
 * Feed (store A, business day 2026-08-20): coke 3 (direct, 1 per sale, Kitchen default) | cheese-direct 4 (direct, 0.25 per sale,
 * map location override Display) | box 2 (recipe map: Cheese 0.2 kg + Rice 0.1 kg per 1) | water 5 (no_stock) | mystery 1 (no map: orphan).
 * Finalized: direct, recipe and orphan sections, every plan key confirmed. Output is normalised: every id becomes a label, no timestamps.
 */
import { buildPlan, finalizeSections } from '@shareat/domain';
import { asOrg, makeDay, rawMap, sold, sql, stockUp, type World } from './t401-s5-setup';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export const BUSINESS_DAY = '2026-08-20';

/** Maps for the scenario (raw), stock for it, the stored day. Returns the sales day id. */
export async function seedScenario(w: World, storeId: string, kitchen: string, display: string): Promise<string> {
  await rawMap(w, storeId, 'coke', { mode: 'direct', itemId: w.coke, quantityPerSale: '1', name: 'Coke' });
  await rawMap(w, storeId, 'cheese-direct', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25', locationId: display, name: 'Cheese Direct' });
  await rawMap(w, storeId, 'box', { mode: 'recipe', recipeId: w.recipeId, name: 'Samgyup Box' });
  await rawMap(w, storeId, 'water', { mode: 'no_stock', name: 'Water' });
  await stockUp(w, storeId, kitchen, w.coke, '10');
  await stockUp(w, storeId, display, w.cheese, '10');
  await stockUp(w, storeId, kitchen, w.cheese, '10');
  await stockUp(w, storeId, kitchen, w.rice, '10');
  return makeDay(w, storeId, BUSINESS_DAY, sold([
    { key: 'coke', name: 'Coke', qty: 3 },
    { key: 'cheese-direct', name: 'Cheese Direct', qty: 4 },
    { key: 'box', name: 'Samgyup Box', qty: 2 },
    { key: 'water', name: 'Water', qty: 5 },
    { key: 'mystery', name: 'Mystery Dish', qty: 1 },
  ]));
}

/** Replace every known id with its label, any other uuid with <uuid>; drop every key named *_at / *At. */
export function normalise(value: unknown, labels: ReadonlyMap<string, string>): unknown {
  const text = JSON.stringify(value, (k, v) => (/(_at|At)$/.test(k) ? undefined : v));
  const out = text.replace(UUID, (m) => labels.get(m) ?? '<uuid>');
  return JSON.parse(out);
}

export async function planOnly(w: World, storeId: string, salesDayId: string, locationId: string) {
  const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.manager, { orgId: w.orgId, storeId, salesDayId, locationId }));
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  return p;
}

/** Plan, finalize every section with every key confirmed, then read everything the flow wrote. */
export async function runScenario(w: World, storeId: string, salesDayId: string, kitchen: string, display: string): Promise<Record<string, unknown>> {
  const seen = (await sql<{ id: string }[]>`select id from audit_log where org_id = ${w.orgId}`).map((r) => r.id);
  const plan = await planOnly(w, storeId, salesDayId, kitchen);
  const fin = await asOrg(w.orgId, (tx) =>
    finalizeSections(tx, w.manager, { pullId: plan.pullId, sections: ['direct', 'recipe', 'orphan'], confirmedKeys: plan.lines.map((l) => l.key) }),
  );
  if (!fin.ok) throw new Error(`fixture: finalize refused: ${fin.reason}`);

  const labels = new Map<string, string>([
    [w.coke, 'item:Coke'], [w.cheese, 'item:Cheese'], [w.sauce, 'item:Sauce'], [w.pork, 'item:Pork'], [w.rice, 'item:Rice'],
    [kitchen, 'room:Kitchen'], [display, 'room:Display'], [storeId, 'store'], [w.recipeId, 'recipe:Samgyup Box'],
    [w.admin.personId, 'person:admin'], [w.manager.personId, 'person:manager'], [w.staff.personId, 'person:staff'], [plan.pullId, 'pull'],
  ]);
  const pull = await sql`
    select status, (direct_finalized_at is not null) as direct_done, (recipe_finalized_at is not null) as recipe_done,
           (orphan_finalized_at is not null) as orphan_done, location_id
    from pos_usage_pulls where id = ${plan.pullId}`;
  const lines = await sql`
    select section, line_key, pos_item_key, pos_item_name, item_id, location_id, quantity::text as quantity, blocked, (usage_record_id is not null) as posted
    from pos_usage_pull_lines where pull_id = ${plan.pullId} order by line_key`;
  const records = await sql`
    select r.kind, r.status, r.location_id, r.used_on::text as used_on,
           (select json_agg(json_build_object('item', l.item_id, 'quantity', l.quantity::text) order by l.item_id::text) from stock_usage_lines l where l.record_id = r.id) as lines
    from stock_usage_records r where r.org_id = ${w.orgId} and r.store_id = ${storeId} order by r.location_id::text`;
  const movements = await sql`
    select item_id, location_id, quantity::text as quantity from stock_movements
    where org_id = ${w.orgId} and store_id = ${storeId} and quantity < 0 order by item_id::text, location_id::text`;
  const audits = await sql`
    select action, entity, before, after, store_id from audit_log
    where org_id = ${w.orgId} and id <> all(${seen}::uuid[])
    order by action, entity, after::text`;
  return normalise(
    {
      planLines: plan.lines,
      finalizeOutcome: fin.sections.map((s) => ({ section: s.section, ok: s.ok, posted: s.postedLineCount, held: s.held.length, finalized: s.finalized })),
      pullFinalized: fin.pullFinalized,
      pull,
      pullLines: lines,
      usageRecords: records,
      stockOut: movements,
      auditRows: audits,
    },
    labels,
  ) as Record<string, unknown>;
}
