/**
 * T-401 S6 - usage tolerance (+-10%) and the staff-draft queue that MOVES stock. TESTER; real Postgres; raw fixtures.
 * Contract: docs/tasks/401-erp-menu-catalog-master.md "S5 rulings" point 7 (I28) and point 8, and Ian's ruling 2026-10-14
 * (bible row 335): the manager-posted staff drafts move stock (actual); the POS pull becomes a CHECK ONLY (expected).
 *
 * Compared per (store, business date, item), decimal arithmetic only:
 *   expected = sum of that day's plan lines for the item from the source in force (menu rules if switched, else maps);
 *   actual   = sum of that day's stock_usage_records kind 'usage', draft + posted, not void, at that store (wastage ignored).
 *   inside iff |actual - expected| <= tolerance * expected (inclusive); tolerance = item override, else org setting, default 0.10.
 *   expected 0 with actual > 0, or expected > 0 with actual 0: always outside.
 * Outside: postUsage refused unless `verifyOutOfTolerance: { reason }` (non-blank); the post then writes audit
 * `stock.usage_tolerance_verified` (stock, high, store; after = { itemId, businessDate, expected, actual, tolerance, reason }).
 * Setting the org tolerance or an item override: admin only (`set_menu_depletion`), audited.
 *
 * ## Red today
 * The columns / functions do not exist (migration 0198 is the builder's): the band is not enforced, so an out-of-band post goes
 * through; the pull still posts stock; the setters are missing (TypeError). Every test also asserts BEHAVIOUR (stock moved or
 * not, record status, audit rows) so it stays meaningful once the schema lands. Positive controls sit beside every refusal.
 *
 * ## Names the tester ASSUMED (spec names none) - the builder meets these or tells the tester
 *  - `postUsage(tx, actor, { recordId, verifyOutOfTolerance?: { reason } })` (spec: the field name; the function is T-168's);
 *  - `setOrgUsageTolerance(tx, actor, { tolerance })` and `setItemUsageTolerance(tx, actor, { itemId, tolerance | null })`, both
 *    exported from @shareat/domain, tolerance a decimal string such as '0.05'; null clears the override;
 *  - `isWithinUsageTolerance(expected, actual, tolerance): boolean`, the pure band (the T-176 follow-up reuses it);
 *  - the setters write an audit row whose action contains 'tolerance';
 *  - the store-wide queue is `stockUsageRepo.listUsageRecords(tx, storeId)`, and each row must name who recorded it (the
 *    author's person id or display name appears in the row); the spec names no function or field.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domainModule from '@shareat/domain';
import { buildPlan, finalizeSections, saveUsageDraft, voidUsage } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { asOrg, makeDay, rawLink, rawMap, rawRule, rawSwitch, rawVariant, refusalOf, sold, sql, stockUp, uid, world, type World } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const s6 = domainModule as unknown as {
  postUsage(tx: Tx, actor: Actor, input: { recordId: string; verifyOutOfTolerance?: { reason: string } }): Promise<{ ok: boolean; reason?: string }>;
  setOrgUsageTolerance(tx: Tx, actor: Actor, input: { tolerance: string }): Promise<unknown>;
  setItemUsageTolerance(tx: Tx, actor: Actor, input: { itemId: string; tolerance: string | null }): Promise<unknown>;
  isWithinUsageTolerance(expected: string, actual: string, tolerance: string): boolean;
  listUsageVariances(tx: Tx, actor: Actor, input: { storeId: string; date: string }): Promise<{ itemId: string; itemName: string; expected: string; actual: string; withinBand: boolean }[]>;
  listStoreUsageQueue(tx: Tx, actor: Actor, storeId: string): Promise<Record<string, unknown>[]>;
};

const DAY = '2026-08-20';
const START = 1000; // kg of cheese stocked, so a post is never refused for short stock

interface Scenario { w: World; dayId: string; pullId: string; keys: string[] }

/** A linked store A, day DAY sold `soldQty` of key 'a' mapped direct to Cheese x `perSale`: expected cheese = soldQty * perSale. Plan built (a pull exists). */
async function scenario(hint: string, soldQty: number, perSale = '1'): Promise<Scenario> {
  const w = await world(hint);
  await rawMap(w, w.a.storeId, 'a', { mode: 'direct', itemId: w.cheese, quantityPerSale: perSale });
  await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, String(START));
  const dayId = await makeDay(w, w.a.storeId, DAY, sold([{ key: 'a', qty: soldQty }]));
  const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: dayId, locationId: w.a.kitchen }));
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  return { w, dayId, pullId: p.pullId, keys: p.lines.filter((l) => !l.blocked).map((l) => l.key) };
}

async function draft(w: World, actor: Actor, qty: string, over: { itemId?: string; storeId?: string; locationId?: string; day?: string; kind?: 'usage' | 'wastage' } = {}): Promise<string> {
  const kind = over.kind ?? 'usage';
  const r = await asOrg(w.orgId, (tx) =>
    saveUsageDraft(tx, actor, {
      orgId: w.orgId, storeId: over.storeId ?? w.a.storeId, locationId: over.locationId ?? w.a.kitchen, kind, usedOn: over.day ?? DAY,
      ...(kind === 'wastage' ? { reasonCode: 'spoilage' } : {}),
      lines: [{ itemId: over.itemId ?? w.cheese, quantity: qty }],
    }),
  );
  if (!r.ok) throw new Error(`fixture: draft refused: ${r.reason}`);
  return r.recordId;
}

const post = (w: World, actor: Actor, recordId: string, reason?: string) =>
  asOrg(w.orgId, (tx) => s6.postUsage(tx, actor, { recordId, ...(reason === undefined ? {} : { verifyOutOfTolerance: { reason } }) }));
/** A refusal as a sentence (null when the post went through). */
const postRefusal = (w: World, actor: Actor, recordId: string, reason?: string) => refusalOf(() => post(w, actor, recordId, reason));

async function onHand(w: World, itemId = w.cheese): Promise<number> {
  const [r] = await sql<{ t: string }[]>`select coalesce(sum(m.quantity),0)::text as t from stock_movements m where m.org_id = ${w.orgId} and m.item_id = ${itemId}`;
  return Number(r!.t);
}
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from stock_usage_records where id = ${id}`)[0]!.status;
const verifiedAudit = (w: World) => sql<{ store_id: string | null; category: string; sensitivity: string; after: Record<string, unknown> | null }[]>`
  select store_id, category, sensitivity, after from audit_log where org_id = ${w.orgId} and action = 'stock.usage_tolerance_verified' order by occurred_at`;
const toleranceAudit = (w: World) => sql<{ action: string; after: unknown }[]>`
  select action, after from audit_log where org_id = ${w.orgId} and action in ('menu.usage_tolerance_set', 'menu.item_usage_tolerance_set') order by occurred_at`;

/** A refused post changed nothing: still draft, stock untouched, no verification row. Returns nothing; asserts. */
async function expectUntouched(w: World, recordId: string) {
  expect(await statusOf(recordId)).toBe('draft');
  expect(await onHand(w)).toBe(START);
  expect(await verifiedAudit(w)).toEqual([]);
}

/** A staff member scoped to store B only: no standing at store A. */
async function outsiderOf(w: World): Promise<Actor> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Outsider Ollie') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.b.storeId})`;
  return { personId: p!.id, orgId: w.orgId };
}

// ---------------------------------------------------------------------------------------------------------------------
describe('I28 - the band (pure)', () => {
  const cases: [string, string, string, boolean, string][] = [
    ['10', '10', '0.10', true, 'equal is inside'],
    ['10', '11', '0.10', true, 'exactly +10% is inside. Mutant: < instead of <='],
    ['10', '9', '0.10', true, 'exactly -10% is inside. Mutants: < instead of <=; band divides by ACTUAL (0.9 -> 1 > 0.9)'],
    ['10', '11.1', '0.10', false, '+11% is outside. Mutant: band divides by ACTUAL (1.11 allowed -> 1.1 <= 1.11)'],
    ['10', '8.9', '0.10', false, '-11% is outside'],
    ['7', '7.7', '0.10', true, 'decimal arithmetic: 7.7 - 7 is 0.7000000000000002 in floats, > 0.7000000000000001. Mutant: floating point'],
    ['3', '3.3', '0.10', true, 'decimal arithmetic at a small expected'],
    ['10', '15', '0.50', true, 'a wider tolerance moves the edge'],
    ['10', '15.1', '0.50', false, 'a wider tolerance still has an edge'],
    ['0', '1', '0.10', false, 'expected 0, actual > 0 is always outside. Mutant: 0 * tolerance >= |1 - 0| style guard missing, or an empty-expected skip'],
    ['0', '1', '0.50', false, 'expected 0, actual > 0 is outside at any tolerance'],
    ['10', '0', '0.10', false, 'expected > 0, actual 0 is always outside'],
    ['10', '0', '1.00', false, 'expected > 0, actual 0 is outside even at 100%'],
  ];
  for (const [expected, actual, tol, inside, why] of cases) {
    it(`expected ${expected}, actual ${actual}, tolerance ${tol} -> ${inside ? 'inside' : 'outside'} (${why})`, () => {
      expect(s6.isWithinUsageTolerance(expected, actual, tol)).toBe(inside);
    });
  }
});

describe('I28 - an out-of-band post', () => {
  it('is refused without a reason (absent, empty, blank): the draft stays a draft, no stock moves, no audit row; positive control: the same draft posts with a reason', async () => {
    const { w } = await scenario('o1', 10);
    const id = await draft(w, w.staff, '12'); // +20%
    expect(await postRefusal(w, w.manager, id), 'no reason given').not.toBeNull();
    await expectUntouched(w, id);
    expect(await postRefusal(w, w.manager, id, ''), 'empty reason').not.toBeNull();
    await expectUntouched(w, id);
    expect(await postRefusal(w, w.manager, id, '   '), 'blank reason').not.toBeNull();
    await expectUntouched(w, id);
    // control
    expect(await postRefusal(w, w.manager, id, 'Staff counted two extra trays')).toBeNull();
    expect(await statusOf(id)).toBe('posted');
    expect(await onHand(w)).toBe(START - 12);
  }, 180_000);

  it('accepted with a reason writes exactly one stock.usage_tolerance_verified row at the store, after = { itemId, businessDate, expected, actual, tolerance, reason }', async () => {
    const { w } = await scenario('o2', 10);
    const id = await draft(w, w.staff, '12');
    expect(await postRefusal(w, w.manager, id, 'Staff counted two extra trays')).toBeNull();
    const rows = await verifiedAudit(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.store_id).toBe(w.a.storeId);
    expect(rows[0]!.category).toBe('stock');
    expect(rows[0]!.sensitivity).toBe('high');
    const a = rows[0]!.after as Record<string, unknown>;
    expect(a.itemId).toBe(w.cheese);
    expect(a.businessDate).toBe(DAY);
    expect(Number(a.expected)).toBe(10);
    expect(Number(a.actual)).toBe(12);
    expect(Number(a.tolerance)).toBe(0.1);
    expect(a.reason).toBe('Staff counted two extra trays');
  }, 180_000);

  it('exactly +10% and exactly -10% post with NO reason and write no verification row. Mutant: < instead of <=; band divides by actual', async () => {
    const hi = await scenario('b1', 10);
    const idHi = await draft(hi.w, hi.w.staff, '11');
    expect(await postRefusal(hi.w, hi.w.manager, idHi)).toBeNull();
    expect(await onHand(hi.w)).toBe(START - 11);
    expect(await verifiedAudit(hi.w)).toEqual([]);
    const lo = await scenario('b2', 10);
    const idLo = await draft(lo.w, lo.w.staff, '9');
    expect(await postRefusal(lo.w, lo.w.manager, idLo), '9 of 10 is exactly -10%: inside').toBeNull();
    expect(await onHand(lo.w)).toBe(START - 9);
    expect(await verifiedAudit(lo.w)).toEqual([]);
  }, 180_000);

  it('11.1 of 10 and 8.9 of 10 are outside and refused. Mutant: band divides by ACTUAL', async () => {
    const hi = await scenario('b3', 10);
    const idHi = await draft(hi.w, hi.w.staff, '11.1');
    expect(await postRefusal(hi.w, hi.w.manager, idHi)).not.toBeNull();
    await expectUntouched(hi.w, idHi);
    const lo = await scenario('b4', 10);
    const idLo = await draft(lo.w, lo.w.staff, '8.9');
    expect(await postRefusal(lo.w, lo.w.manager, idLo)).not.toBeNull();
    await expectUntouched(lo.w, idLo);
  }, 180_000);

  it('uses decimal arithmetic: 7.7 of 7 posts clean (floats would flag it)', async () => {
    const { w } = await scenario('d1', 7);
    const id = await draft(w, w.staff, '7.7');
    expect(await postRefusal(w, w.manager, id)).toBeNull();
    expect(await verifiedAudit(w)).toEqual([]);
  }, 180_000);

  it('an UNCOVERED item (no pull line, no menu rule, no map) is never checked: any actual posts with no reason and no verification row. Mutant: uncovered treated as expected 0', async () => {
    const { w } = await scenario('u1', 10);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, '100');
    const id = await draft(w, w.staff, '37', { itemId: w.rice });
    expect(await postRefusal(w, w.manager, id)).toBeNull();
    expect(await statusOf(id)).toBe('posted');
    expect(await onHand(w, w.rice)).toBe(63);
    expect(await verifiedAudit(w)).toEqual([]);
  }, 180_000);

  it('a COVERED item with expected 0 (a menu rule for it, none sold today) and actual > 0 is flagged: refused without a reason, accepted with one. Mutant: an empty expected skips the check', async () => {
    const { w, dayId } = await scenario('z1', 10);
    const vc = await rawVariant(w, 'Cheese dish');
    await rawRule(w, vc, { mode: 'direct', itemId: w.cheese, quantityPerSale: '1' });
    await rawLink(w, w.a.storeId, 'a', vc);
    const vr = await rawVariant(w, 'Rice dish');
    await rawRule(w, vr, { mode: 'direct', itemId: w.rice, quantityPerSale: '1' });
    await rawLink(w, w.a.storeId, 'r', vr); // rice dish: covered by a rule, sold 0 today
    await rawSwitch(w, w.a.storeId, 'menu_rules');
    const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: dayId, locationId: w.a.kitchen }));
    expect(p.ok, p.ok ? '' : String((p as { reason?: string }).reason)).toBe(true);
    const id = await draft(w, w.staff, '1', { itemId: w.rice });
    await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, '100');
    expect(await postRefusal(w, w.manager, id)).not.toBeNull();
    expect(await statusOf(id)).toBe('draft');
    expect(await onHand(w, w.rice)).toBe(100);
    expect(await postRefusal(w, w.manager, id, 'Used for the staff meal')).toBeNull();
    const rows = await verifiedAudit(w);
    expect(rows).toHaveLength(1);
    expect(Number((rows[0]!.after as Record<string, unknown>).expected)).toBe(0);
    expect(Number((rows[0]!.after as Record<string, unknown>).actual)).toBe(1);
  }, 180_000);

  it('actual counts EVERY usage draft of the item and day, not just the one being posted: drafts 5 + 7 (12 of 10) refuse either; 5 + 6 (11) post. Mutant: only this record', async () => {
    const out = await scenario('m1', 10);
    const a1 = await draft(out.w, out.w.staff, '5');
    await draft(out.w, out.w.manager, '7');
    expect(await postRefusal(out.w, out.w.manager, a1), '5 alone is inside, 5 + 7 is not').not.toBeNull();
    await expectUntouched(out.w, a1);
    const ok = await scenario('m2', 10);
    const b1 = await draft(ok.w, ok.w.staff, '5');
    await draft(ok.w, ok.w.manager, '6');
    expect(await postRefusal(ok.w, ok.w.manager, b1)).toBeNull();
  }, 180_000);

  it('a draft that contributes to an out-of-band day is refused as one of a PAIR too: after one posts with a reason, the other, still out of band, needs its own reason', async () => {
    const { w } = await scenario('m3', 10);
    const a = await draft(w, w.staff, '8');
    const b = await draft(w, w.manager, '8'); // 16 of 10
    expect(await postRefusal(w, w.manager, a, 'two cooks, two counts')).toBeNull();
    expect(await postRefusal(w, w.manager, b)).not.toBeNull();
    expect(await statusOf(b)).toBe('draft');
    expect(await postRefusal(w, w.manager, b, 'confirmed with both cooks')).toBeNull();
    expect(await verifiedAudit(w)).toHaveLength(2);
  }, 180_000);

  it('a VOIDED record is not actual: post 10 (inside), void it, a new draft of 10 posts clean. Mutant: void counted (20 of 10 refuses)', async () => {
    const { w } = await scenario('v1', 10);
    const first = await draft(w, w.staff, '10');
    expect(await postRefusal(w, w.manager, first)).toBeNull();
    const voided = await asOrg(w.orgId, (tx) => voidUsage(tx, w.manager, { recordId: first, reason: 'entered on the wrong day' }));
    expect(voided.ok).toBe(true);
    const second = await draft(w, w.staff, '10');
    expect(await postRefusal(w, w.manager, second)).toBeNull();
    expect(await onHand(w)).toBe(START - 10);
  }, 180_000);

  it('wastage and records of other stores or other days are NOT compared: wastage 5 + another store 50 + another day 50 + usage 10 -> clean. Mutant: no kind / store / day filter', async () => {
    const { w } = await scenario('f1', 10);
    await draft(w, w.manager, '5', { kind: 'wastage' });
    await draft(w, w.manager, '50', { storeId: w.b.storeId, locationId: w.b.kitchen });
    await draft(w, w.manager, '50', { day: '2026-08-19' });
    const id = await draft(w, w.staff, '10');
    expect(await postRefusal(w, w.manager, id)).toBeNull();
    expect(await verifiedAudit(w)).toEqual([]);
  }, 180_000);

  it('expected survives the pull being finalized (it is the plan, not the posted pull): after finalize, 12 of 10 is still flagged', async () => {
    const { w, pullId, keys } = await scenario('x1', 10);
    const f = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId, sections: ['direct'], confirmedKeys: keys }));
    expect(f.ok, f.ok ? '' : String((f as { reason?: string }).reason)).toBe(true);
    const id = await draft(w, w.staff, '12');
    expect(await postRefusal(w, w.manager, id)).not.toBeNull();
    expect(await statusOf(id)).toBe('draft');
  }, 180_000);

  it('expected comes from the source in force: switched to menu rules (2 per sale) the expectation is 10 not 5, so 10 posts clean; unswitched, the same 10 is out of band', async () => {
    const un = await scenario('s1', 5);
    const idUn = await draft(un.w, un.w.staff, '10');
    expect(await postRefusal(un.w, un.w.manager, idUn), 'maps say 5: 10 is +100%').not.toBeNull();

    const sw = await scenario('s2', 5);
    const v = await rawVariant(sw.w, 'Dish');
    await rawRule(sw.w, v, { mode: 'direct', itemId: sw.w.cheese, quantityPerSale: '2' });
    await rawLink(sw.w, sw.w.a.storeId, 'a', v);
    await rawSwitch(sw.w, sw.w.a.storeId, 'menu_rules');
    // the switch happened after the plan above: rebuild so the plan is from the rules (a planned pull may be rebuilt)
    const p = await asOrg(sw.w.orgId, (tx) => buildPlan(tx, sw.w.staff, { orgId: sw.w.orgId, storeId: sw.w.a.storeId, salesDayId: sw.dayId, locationId: sw.w.a.kitchen }));
    expect(p.ok, p.ok ? '' : String((p as { reason?: string }).reason)).toBe(true);
    const idSw = await draft(sw.w, sw.w.staff, '10');
    expect(await postRefusal(sw.w, sw.w.manager, idSw), 'rules say 10').toBeNull();
    expect(await verifiedAudit(sw.w)).toEqual([]);
  }, 180_000);
});

describe('I28 - the tolerance setting and the item override', () => {
  it('org setting 0.05: 10.6 of 10 is refused (default would allow it); 10.5 posts. Admin sets it, and it is audited', async () => {
    const { w } = await scenario('t1', 10);
    const before = await toleranceAudit(w);
    await asOrg(w.orgId, (tx) => s6.setOrgUsageTolerance(tx, w.admin, { tolerance: '0.05' }));
    const rows = await toleranceAudit(w);
    expect(rows.length).toBe(before.length + 1);
    expect(rows[rows.length - 1]!.action).toBe('menu.usage_tolerance_set');
    expect(JSON.stringify(rows[rows.length - 1]!.after)).toContain('0.05');
    const bad = await draft(w, w.staff, '10.6');
    expect(await postRefusal(w, w.manager, bad)).not.toBeNull();
    expect(await statusOf(bad)).toBe('draft');
  }, 180_000);

  it('org setting 0.20: 12 of 10 posts clean (the default would flag it); 12.1 is refused', async () => {
    const ok = await scenario('t2', 10);
    await asOrg(ok.w.orgId, (tx) => s6.setOrgUsageTolerance(tx, ok.w.admin, { tolerance: '0.20' }));
    const id = await draft(ok.w, ok.w.staff, '12');
    expect(await postRefusal(ok.w, ok.w.manager, id)).toBeNull();
    const bad = await scenario('t3', 10);
    await asOrg(bad.w.orgId, (tx) => s6.setOrgUsageTolerance(tx, bad.w.admin, { tolerance: '0.20' }));
    const id2 = await draft(bad.w, bad.w.staff, '12.1');
    expect(await postRefusal(bad.w, bad.w.manager, id2)).not.toBeNull();
  }, 180_000);

  it('an item override wins over the org setting, both ways; clearing it (null) returns to the org setting. Audited', async () => {
    const { w } = await scenario('i1', 10);
    await asOrg(w.orgId, (tx) => s6.setOrgUsageTolerance(tx, w.admin, { tolerance: '0.05' }));
    const before = (await toleranceAudit(w)).length;
    await asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: '0.50' }));
    expect((await toleranceAudit(w)).length).toBe(before + 1);
    expect((await toleranceAudit(w)).at(-1)!.action).toBe('menu.item_usage_tolerance_set');
    const wide = await draft(w, w.staff, '14'); // +40%: inside the override, outside the org 5%
    expect(await postRefusal(w, w.manager, wide), 'override 50% beats org 5%').toBeNull();

    await asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: null }));
    expect((await toleranceAudit(w)).length).toBe(before + 2);
  }, 180_000);

  it('a tighter item override flags what the default allows: override 0.02, 10.5 of 10 refused. Mutant: override ignored', async () => {
    const { w } = await scenario('i2', 10);
    await asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: '0.02' }));
    const id = await draft(w, w.staff, '10.5');
    expect(await postRefusal(w, w.manager, id)).not.toBeNull();
    expect(await statusOf(id)).toBe('draft');
  }, 180_000);

  it('a cleared override puts the default back: set 0.50, clear, then 14 of 10 is refused again', async () => {
    const { w } = await scenario('i3', 10);
    await asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: '0.50' }));
    await asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: null }));
    const id = await draft(w, w.staff, '14');
    expect(await postRefusal(w, w.manager, id)).not.toBeNull();
  }, 180_000);

  it('only admin sets either: manager and staff are refused (set_menu_depletion), nothing is written; admin is the positive control. Mutant: a manager can set the item override', async () => {
    const { w } = await scenario('c1', 10);
    for (const who of [w.manager, w.staff]) {
      await expect(asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, who, { itemId: w.cheese, tolerance: '0.50' }))).rejects.toThrow(/may not 'set_menu_depletion'/);
      await expect(asOrg(w.orgId, (tx) => s6.setOrgUsageTolerance(tx, who, { tolerance: '0.50' }))).rejects.toThrow(/may not 'set_menu_depletion'/);
    }
    expect(await toleranceAudit(w)).toEqual([]);
    // the refusals changed nothing: 14 of 10 is still out of band
    const id = await draft(w, w.staff, '14');
    expect(await postRefusal(w, w.manager, id)).not.toBeNull();
    // control
    await asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: '0.50' }));
    expect(await postRefusal(w, w.manager, id)).toBeNull();
  }, 180_000);

  it('a nonsense tolerance is refused, not stored: negative, above 1, not a number', async () => {
    const { w } = await scenario('c2', 10);
    for (const bad of ['-0.1', '1.5', 'abc', '']) {
      expect(await refusalOf(() => asOrg(w.orgId, (tx) => s6.setOrgUsageTolerance(tx, w.admin, { tolerance: bad }) as Promise<unknown>)), `org ${bad}`).not.toBeNull();
      expect(await refusalOf(() => asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: bad }) as Promise<unknown>)), `item ${bad}`).not.toBeNull();
    }
    expect(await toleranceAudit(w)).toEqual([]);
  }, 180_000);
});

describe('the pull is a check only; drafts move stock (bible row 335)', () => {
  it('finalizing the pull for a covered item takes NO stock out; the manager-posted draft is the only stock out (no double). Mutant: the pull still posts', async () => {
    const { w, pullId, keys } = await scenario('p1', 10);
    expect(keys.length).toBeGreaterThan(0);
    const f = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId, sections: ['direct'], confirmedKeys: keys }));
    expect(f.ok, f.ok ? '' : String((f as { reason?: string }).reason)).toBe(true);
    expect(await onHand(w), 'the pull moved stock').toBe(START);
    // Round 2 (Ian, 15 Oct): the pull makes a DRAFT (one per store + day + room) and moves no stock. The manager posting that draft is the only stock out.
    const made = await sql<{ id: string; status: string }[]>`
      select distinct r.id, r.status from pos_usage_pull_lines l join stock_usage_records r on r.id = l.usage_record_id where l.pull_id = ${pullId}`;
    expect(made.length, 'the pull made exactly one draft').toBe(1);
    expect(made[0]!.status, 'a draft, not posted').toBe('draft');
    const id = made[0]!.id;
    expect(await postRefusal(w, w.manager, id)).toBeNull();
    expect(await onHand(w)).toBe(START - 10);
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from stock_usage_records r join stock_usage_lines l on l.record_id = r.id
      where r.org_id = ${w.orgId} and r.kind = 'usage' and r.status = 'posted' and r.used_on = ${DAY} and l.item_id = ${w.cheese}`;
    expect(Number(n!.n), 'exactly one posted usage for the item and day').toBe(1);
  }, 180_000);

  it('order does not matter: the draft is posted FIRST, then the pull is finalized; stock still falls once (by the draft). Mutant: the pull posts after', async () => {
    const { w, pullId, keys } = await scenario('p2', 10);
    const id = await draft(w, w.staff, '10');
    expect(await postRefusal(w, w.manager, id)).toBeNull();
    const f = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId, sections: ['direct'], confirmedKeys: keys }));
    expect(f.ok, f.ok ? '' : String((f as { reason?: string }).reason)).toBe(true);
    expect(await onHand(w)).toBe(START - 10);
  }, 180_000);

  it('a recipe-covered item is a check only too: a recipe ingredient (Rice 0.1 kg per box) is not taken by the pull', async () => {
    const w = await world('p3');
    await rawMap(w, w.a.storeId, 'box', { mode: 'recipe', recipeId: w.recipeId });
    await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, String(START));
    await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, String(START));
    const dayId = await makeDay(w, w.a.storeId, DAY, sold([{ key: 'box', qty: 10 }]));
    const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: dayId, locationId: w.a.kitchen }));
    if (!p.ok) throw new Error(p.reason);
    const keys = p.lines.filter((l) => !l.blocked).map((l) => l.key);
    expect(keys.length).toBeGreaterThan(0);
    const f = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId: p.pullId, sections: ['recipe'], confirmedKeys: keys }));
    expect(f.ok, f.ok ? '' : String((f as { reason?: string }).reason)).toBe(true);
    expect(await onHand(w, w.rice)).toBe(START);
    expect(await onHand(w, w.cheese)).toBe(START);
    // The pull made ONE draft (the kitchen) holding the recipe ingredients at their expected quantities; no stock moved yet.
    const made = await sql<{ id: string; status: string }[]>`
      select distinct r.id, r.status from pos_usage_pull_lines l join stock_usage_records r on r.id = l.usage_record_id where l.pull_id = ${p.pullId}`;
    expect(made.length, 'the pull made exactly one draft').toBe(1);
    expect(made[0]!.status).toBe('draft');
    // expected rice = 10 boxes * 0.1 kg = 1: the manager posts the pull draft and rice falls by that 1 (no second draft needed)
    expect(await postRefusal(w, w.manager, made[0]!.id)).toBeNull();
    expect(await onHand(w, w.rice)).toBe(START - 1);
  }, 180_000);
});

describe('the queue: many staff draft at once; all store staff see who recorded what; only a manager posts', () => {
  async function secondStaff(w: World): Promise<Actor> {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Cashier Cora') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.a.storeId})`;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${w.orgId}, ${w.a.storeId}, ${p!.id}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId: w.orgId, storeId: w.a.storeId, employmentId: emp!.id, personId: p!.id, setBy: w.manager.personId });
    return { personId: p!.id, orgId: w.orgId };
  }

  it('two staff draft the same item and day at once: both succeed, nothing merged or refused', async () => {
    const { w } = await scenario('q1', 10);
    const cora = await secondStaff(w);
    const a = await draft(w, w.staff, '5');
    const b = await draft(w, cora, '5');
    expect(a).not.toBe(b);
    const rows = await sql<{ status: string }[]>`select status from stock_usage_records where id in (${a}, ${b})`;
    expect(rows.map((r) => r.status)).toEqual(['draft', 'draft']);
  }, 180_000);

  it('one staff member sees the other staff member\'s draft, with the author named. Mutant: the queue is filtered to the viewer\'s own drafts, or omits the author', async () => {
    const { w } = await scenario('q2', 10);
    const cora = await secondStaff(w);
    const mine = await draft(w, w.staff, '5');
    const hers = await draft(w, cora, '5');
    const list = await asOrg(w.orgId, (tx) => s6.listStoreUsageQueue(tx, w.staff, w.a.storeId));
    const byId = new Map(list.map((r) => [String(r.id), JSON.stringify(r)]));
    expect(byId.has(mine) && byId.has(hers), 'both drafts are in the store queue').toBe(true);
    expect(byId.get(hers)!.includes(cora.personId) || byId.get(hers)!.includes('Cashier Cora'), 'her row names her').toBe(true);
    expect(byId.get(mine)!.includes(w.staff.personId) || byId.get(mine)!.includes('Staffer'), 'my row names me').toBe(true);
    expect(byId.get(hers)!, 'row carries the item').toMatch(/Cheese/);
    expect(byId.get(hers)!, 'row carries the quantity').toMatch(/\b5(\.0+)?\b/);
    const asCora = await asOrg(w.orgId, (tx) => s6.listStoreUsageQueue(tx, cora, w.a.storeId));
    expect(asCora.map((r) => String(r.id))).toEqual(expect.arrayContaining([mine, hers]));
  }, 180_000);

  it('the queue is per store: store B\'s draft is not in store A\'s queue', async () => {
    const { w } = await scenario('q3', 10);
    const inB = await draft(w, w.manager, '5', { storeId: w.b.storeId, locationId: w.b.kitchen });
    const list = await asOrg(w.orgId, (tx) => s6.listStoreUsageQueue(tx, w.staff, w.a.storeId));
    expect(list.map((r) => String(r.id))).not.toContain(inB);
  }, 180_000);

  it('the queue is store-scoped: a person with no scope at store A is refused; a staff member of A reads it (control)', async () => {
    const { w } = await scenario('q7', 10);
    const outsider = await outsiderOf(w);
    await draft(w, w.staff, '5');
    await expect(asOrg(w.orgId, (tx) => s6.listStoreUsageQueue(tx, outsider, w.a.storeId))).rejects.toThrow(/may not/);
    expect((await asOrg(w.orgId, (tx) => s6.listStoreUsageQueue(tx, w.staff, w.a.storeId))).length).toBeGreaterThan(0);
  }, 180_000);

  it('only a manager posts: staff posting is refused (post_usage), even with a verification reason on an out-of-band draft; nothing moves. Manager is the control', async () => {
    const inside = await scenario('q4', 10);
    const idIn = await draft(inside.w, inside.w.staff, '10');
    await expect(post(inside.w, inside.w.staff, idIn)).rejects.toThrow(/may not 'post_usage'/);
    expect(await statusOf(idIn)).toBe('draft');
    expect(await onHand(inside.w)).toBe(START);

    const out = await scenario('q5', 10);
    const idOut = await draft(out.w, out.w.staff, '14');
    await expect(post(out.w, out.w.staff, idOut, 'I verify my own count')).rejects.toThrow(/may not 'post_usage'/);
    await expectUntouched(out.w, idOut);

    expect(await postRefusal(inside.w, inside.w.manager, idIn)).toBeNull();
    expect(await onHand(inside.w)).toBe(START - 10);
  }, 180_000);

  it('a verified post is recorded as the MANAGER\'s act: the audit row names the manager as actor, not the drafting staff member', async () => {
    const { w } = await scenario('q6', 10);
    const id = await draft(w, w.staff, '14');
    expect(await postRefusal(w, w.manager, id, 'Rice cooker ran twice')).toBeNull();
    const [row] = await sql<{ actor_id: string | null }[]>`
      select actor_person_id as actor_id from audit_log where org_id = ${w.orgId} and action = 'stock.usage_tolerance_verified'`;
    expect(row?.actor_id).toBe(w.manager.personId);
  }, 180_000);
});

describe('listUsageVariances (read for the day, per covered item)', () => {
  it('one row per covered item with itemName, expected, actual, withinBand: outside, inside, and expected > 0 / actual 0', async () => {
    const { w } = await scenario('r1', 10);
    await draft(w, w.staff, '12');
    let rows = await asOrg(w.orgId, (tx) => s6.listUsageVariances(tx, w.staff, { storeId: w.a.storeId, date: DAY }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: w.cheese, itemName: 'Cheese', withinBand: false });
    expect(Number(rows[0]!.expected)).toBe(10);
    expect(Number(rows[0]!.actual)).toBe(12);

    const ins = await scenario('r2', 10);
    await draft(ins.w, ins.w.staff, '11');
    rows = await asOrg(ins.w.orgId, (tx) => s6.listUsageVariances(tx, ins.w.staff, { storeId: ins.w.a.storeId, date: DAY }));
    expect(rows[0]).toMatchObject({ itemId: ins.w.cheese, withinBand: true });

    const none = await scenario('r3', 10);
    rows = await asOrg(none.w.orgId, (tx) => s6.listUsageVariances(tx, none.w.staff, { storeId: none.w.a.storeId, date: DAY }));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.actual)).toBe(0);
    expect(rows[0]!.withinBand).toBe(false);
  }, 180_000);

  it('an uncovered item does not appear; another day is empty; the item override changes withinBand. Mutant: every used item listed', async () => {
    const { w } = await scenario('r4', 10);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, '100');
    await draft(w, w.staff, '5', { itemId: w.rice });
    await draft(w, w.staff, '14');
    let rows = await asOrg(w.orgId, (tx) => s6.listUsageVariances(tx, w.staff, { storeId: w.a.storeId, date: DAY }));
    expect(rows.map((r) => r.itemId)).toEqual([w.cheese]);
    expect(rows[0]!.withinBand).toBe(false);
    await asOrg(w.orgId, (tx) => s6.setItemUsageTolerance(tx, w.admin, { itemId: w.cheese, tolerance: '0.50' }));
    rows = await asOrg(w.orgId, (tx) => s6.listUsageVariances(tx, w.staff, { storeId: w.a.storeId, date: DAY }));
    expect(rows[0]!.withinBand).toBe(true);
    rows = await asOrg(w.orgId, (tx) => s6.listUsageVariances(tx, w.staff, { storeId: w.a.storeId, date: '2026-08-19' }));
    expect(rows).toEqual([]);
  }, 180_000);

  it('store-scoped: a person with no scope at the store is refused; reading changes nothing', async () => {
    const { w } = await scenario('r5', 10);
    const outsider = await outsiderOf(w);
    await expect(asOrg(w.orgId, (tx) => s6.listUsageVariances(tx, outsider, { storeId: w.a.storeId, date: DAY }))).rejects.toThrow(/may not/);
    expect(await onHand(w)).toBe(START);
  }, 180_000);
});
