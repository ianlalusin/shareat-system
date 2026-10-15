/**
 * T-401 S6 - the v1 POS usage pull CREATES A USAGE DRAFT; staff edit it to actuals; the manager posts; an unposted pull draft
 * is AUTO-POSTED the next afternoon. TESTER; real Postgres; raw fixtures. Ian's ruling, 15 Oct (supersedes "the pull posts nothing"):
 *
 *  1. Finalizing the pull for a store + day creates ONE T-168 usage record: status draft, author = the system (not a person at the
 *     store), one line per covered item, quantity = EXPECTED. It moves NO stock. Finalizing again / building again never makes a second
 *     draft; if staff already started a usage draft for that store + day, the pull fills the MISSING covered lines into it.
 *  2. Staff edit the lines to actuals, the manager posts (T-168 postUsage). Each line is checked against its expected (+-10%).
 *  3. AUTO-POST: a draft the pull created, still unposted at 14:00 Manila the day after its business date, is posted by
 *     `autoPostDueUsageDrafts(tx, now)` -> { posted, skipped: [{ recordId, reason }] }. In-band lines post as they stand; an
 *     out-of-band line (no reason is possible) posts at its EXPECTED quantity. The record gets `auto_posted = true` and an audit row
 *     `stock.usage_auto_posted` (category stock, sensitivity normal, store). A post the system refuses (frozen room, period lock) is
 *     left as a draft and reported in `skipped`, never forced. Idempotent. Manual drafts (items the POS does not sell) are never
 *     auto-posted.
 *
 * ## Names the tester ASSUMED (spec names none) - the builder meets these or tells the tester
 *  - `autoPostDueUsageDrafts(tx, now: Date)` exported from @shareat/domain, run here inside `systemTransaction`;
 *  - the column is `stock_usage_records.auto_posted boolean` (spec); audit action `stock.usage_auto_posted` (spec);
 *  - "the next day" is counted from the record's BUSINESS DATE (used_on). Each test also moves `created_at` to the evening of the
 *    business date, so reading it from the creation day gives the same answer. The tests avoid the exact 14:00:00 boundary;
 *  - the pull's draft is found by (store, used_on, kind 'usage', status 'draft'); `created_by` is a person who is neither the
 *    staff member nor the manager (the system author); the spec names no column for "pull-made", so the auto-post's reach is
 *    asserted through behaviour (a manual draft of an item the POS does not sell is never touched);
 *  - an auto-posted record's lines are rewritten to what was posted (an out-of-band line shows its expected quantity).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, systemTransaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domainModule from '@shareat/domain';
import { addUsageLine, buildPlan, finalizeSections, postUsage, removeUsageLine, saveUsageDraft, voidPosUsagePull } from '@shareat/domain';
import { asOrg, makeDay, rawMap, sold, sql, stockUp, world, type World } from './t401-s5-setup';
import { movementCount, usageRecordsOfDay } from './_fixtures/pull-draft';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const auto = domainModule as unknown as {
  autoPostDueUsageDrafts(tx: Tx, now: Date): Promise<{ posted: unknown[]; skipped: { recordId: string; reason: string }[] }>;
};

const DAY = '2026-08-20';
const START = 1000;
// 14:00 Manila (UTC+8) on 2026-08-21 is 06:00:00Z.
const BEFORE_DUE = new Date('2026-08-21T05:59:00Z');
const AFTER_DUE = new Date('2026-08-21T06:01:00Z');
const SAME_DAY_EVENING = new Date('2026-08-20T20:00:00Z');

interface S { w: World; dayId: string; pullId: string; keys: string[] }

/** Store A, day DAY: 'a' (10 sold) maps direct to Cheese x1 (expected 10) and 'b' (10 sold) to Rice x1 (expected 10) when `two`. Plan built. */
async function scenario(hint: string, two = false): Promise<S> {
  const w = await world(hint);
  await rawMap(w, w.a.storeId, 'a', { mode: 'direct', itemId: w.cheese, quantityPerSale: '1' });
  await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, String(START));
  const items = [{ key: 'a', qty: 10 }];
  if (two) {
    await rawMap(w, w.a.storeId, 'b', { mode: 'direct', itemId: w.rice, quantityPerSale: '1' });
    await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, String(START));
    items.push({ key: 'b', qty: 10 });
  }
  const dayId = await makeDay(w, w.a.storeId, DAY, sold(items));
  const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: dayId, locationId: w.a.kitchen }));
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  return { w, dayId, pullId: p.pullId, keys: p.lines.filter((l) => !l.blocked).map((l) => l.key) };
}

const finalize = (s: S, sections: ('direct' | 'recipe' | 'orphan')[] = ['direct'], keys: string[] = s.keys) =>
  asOrg(s.w.orgId, (tx) => finalizeSections(tx, s.w.manager, { pullId: s.pullId, sections, confirmedKeys: keys }));

async function mustFinalize(s: S, sections: ('direct' | 'recipe' | 'orphan')[] = ['direct']) {
  const f = await finalize(s, sections);
  if (!f.ok) throw new Error(`fixture: finalize refused: ${f.reason}`);
}

/**
 * Moves "when the pull was finalized" to the evening of the business date, in EVERY place a builder could read it from (A10: due = the later
 * of 14:00 Manila the next day and finalized_at + 4h): the record's created_at and the pull's section stamps.
 */
async function backdate(recordId: string, at = '2026-08-20T12:00:00Z') {
  await sql`update stock_usage_records set created_at = ${at} where id = ${recordId}`;
  await sql`update pos_usage_pulls set direct_finalized_at = case when direct_finalized_at is null then null else ${at}::timestamptz end,
                                       recipe_finalized_at = case when recipe_finalized_at is null then null else ${at}::timestamptz end,
                                       orphan_finalized_at = case when orphan_finalized_at is null then null else ${at}::timestamptz end
             where id in (select pull_id from pos_usage_pull_lines where usage_record_id = ${recordId})`;
}

/** The day's one draft; moves its created_at to the evening of the business date (so "next day" is unambiguous). */
async function theDraft(s: S) {
  const recs = await usageRecordsOfDay(sql, s.w.a.storeId, DAY);
  expect(recs, 'exactly one usage record for the store and day').toHaveLength(1);
  expect(recs[0]!.status).toBe('draft');
  await backdate(recs[0]!.id);
  return recs[0]!;
}

/** Staff set a line to the actual: the existing line goes, a new one is added (T-168 has no edit-quantity call). */
async function setActual(w: World, recordId: string, itemId: string, qty: string) {
  const [line] = await sql<{ id: string }[]>`select id from stock_usage_lines where record_id = ${recordId} and item_id = ${itemId}`;
  if (line) {
    const r = await asOrg(w.orgId, (tx) => removeUsageLine(tx, w.staff, { recordId, lineId: line.id }));
    expect(r.ok, 'staff may remove a line of the draft').toBe(true);
  }
  const a = await asOrg(w.orgId, (tx) => addUsageLine(tx, w.staff, { recordId, itemId, quantity: qty }));
  expect(a.ok, a.ok ? '' : a.reason).toBe(true);
}

async function onHand(w: World, itemId: string): Promise<number> {
  const [r] = await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where org_id = ${w.orgId} and item_id = ${itemId}`;
  return Number(r!.t);
}
/** The sweep is system-wide; every other test's drafts are in the same database. Scope what it reports to THIS test's org. */
async function runAuto(now: Date, w: World) {
  const r = await systemTransaction((tx) => auto.autoPostDueUsageDrafts(tx, now));
  const own = new Set((await sql<{ id: string }[]>`select id from stock_usage_records where org_id = ${w.orgId}`).map((x) => x.id));
  return {
    posted: (r.posted as { recordId: string }[]).filter((x) => own.has(x.recordId)),
    skipped: r.skipped.filter((x) => own.has(x.recordId)),
  };
}
const autoAudit = (w: World) => sql<{ store_id: string | null; category: string; sensitivity: string; entity_id: string | null }[]>`
  select store_id, category, sensitivity, entity_id from audit_log where org_id = ${w.orgId} and action = 'stock.usage_auto_posted' order by occurred_at`;
const flagOf = async (id: string) => (await sql<{ a: boolean }[]>`select auto_posted as a from stock_usage_records where id = ${id}`)[0]!.a;
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from stock_usage_records where id = ${id}`)[0]!.status;

// ---------------------------------------------------------------------------------------------------------------------
describe('finalizing the pull creates the usage draft (expected, system author, no stock)', () => {
  it('finalize -> ONE draft for the store + day, one line per covered item at its EXPECTED quantity, authored by neither the staff member nor the manager; no stock moves, no journal', async () => {
    const s = await scenario('d1', true);
    const before = await movementCount(sql, s.w.orgId);
    await mustFinalize(s);
    const [d] = await usageRecordsOfDay(sql, s.w.a.storeId, DAY);
    expect(d!.status).toBe('draft');
    expect(d!.lines).toEqual({ [s.w.cheese]: '10.000', [s.w.rice]: '10.000' });
    expect([s.w.staff.personId, s.w.manager.personId, s.w.admin.personId], 'the author is the system, not a person at the store').not.toContain(d!.createdBy);
    expect(await movementCount(sql, s.w.orgId)).toBe(before);
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
    const [je] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${s.w.orgId} and source_type = 'usage_record'`;
    expect(Number(je!.n), 'no journal entry').toBe(0);
  }, 180_000);

  it('idempotent: finalizing the other sections, finalizing again, and rebuilding the plan never make a second draft. Mutant: one record per finalize call', async () => {
    const s = await scenario('d2', true);
    await mustFinalize(s, ['direct']);
    const again = await finalize(s, ['direct']);
    expect(again.ok && again.sections[0]!.ok, 'a section finalizes once').toBe(false);
    await mustFinalize(s, ['recipe', 'orphan']);
    const recs = await usageRecordsOfDay(sql, s.w.a.storeId, DAY);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.lines).toEqual({ [s.w.cheese]: '10.000', [s.w.rice]: '10.000' });
  }, 180_000);

  it('A2 (supersedes "the pull fills a staff-started draft"): a draft staff already started for that store + day + room is NEVER touched; the pull writes its OWN system draft beside it. Mutant: the pull adds lines to the staff draft', async () => {
    const s = await scenario('d3', true);
    const started = await asOrg(s.w.orgId, (tx) =>
      saveUsageDraft(tx, s.w.staff, { orgId: s.w.orgId, storeId: s.w.a.storeId, locationId: s.w.a.kitchen, kind: 'usage', usedOn: DAY, lines: [{ itemId: s.w.cheese, quantity: '9' }] }),
    );
    if (!started.ok) throw new Error(started.reason);
    await mustFinalize(s);
    const recs = await usageRecordsOfDay(sql, s.w.a.storeId, DAY);
    expect(recs, 'the staff draft and a separate pull draft').toHaveLength(2);
    const staffRec = recs.find((r) => r.id === started.recordId)!;
    expect(staffRec.lines, 'the staff draft is exactly what staff typed: no line added, none changed').toEqual({ [s.w.cheese]: '9.000' });
    expect(staffRec.createdBy).toBe(s.w.staff.personId);
    const pullRec = recs.find((r) => r.id !== started.recordId)!;
    expect([s.w.staff.personId, s.w.manager.personId, s.w.admin.personId], 'the pull draft is system-authored').not.toContain(pullRec.createdBy);
    expect(pullRec.lines[s.w.rice], 'the pull draft carries the covered item the staff draft lacks, at expected').toBe('10.000');
  }, 180_000);

  it('a wastage draft of the same day is NOT the usage draft: the pull still makes its own usage draft', async () => {
    const s = await scenario('d4');
    const wr = await asOrg(s.w.orgId, (tx) =>
      saveUsageDraft(tx, s.w.staff, { orgId: s.w.orgId, storeId: s.w.a.storeId, locationId: s.w.a.kitchen, kind: 'wastage', reasonCode: 'spoilage', usedOn: DAY, lines: [{ itemId: s.w.cheese, quantity: '1' }] }),
    );
    if (!wr.ok) throw new Error(wr.reason);
    await mustFinalize(s);
    const recs = await usageRecordsOfDay(sql, s.w.a.storeId, DAY);
    expect(recs, 'the usage draft (usageRecordsOfDay lists kind usage only)').toHaveLength(1);
    expect(recs[0]!.lines).toEqual({ [s.w.cheese]: '10.000' });
    expect(recs[0]!.id).not.toBe(wr.recordId);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('staff edit to actuals, the manager posts; each line is held to its expected', () => {
  it('in-band edit (10 -> 10.5): the manager posts with no reason; stock falls by the ACTUAL 10.5; no verification row', async () => {
    const s = await scenario('e1');
    await mustFinalize(s);
    const d = await theDraft(s);
    await setActual(s.w, d.id, s.w.cheese, '10.5');
    const r = await asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.manager, { recordId: d.id }));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(await statusOf(d.id)).toBe('posted');
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 10.5);
    expect(await flagOf(d.id), 'a manager post is not an auto-post').toBe(false);
    const [v] = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${s.w.orgId} and action = 'stock.usage_tolerance_verified'`;
    expect(Number(v!.n)).toBe(0);
  }, 180_000);

  it('out-of-band edit (10 -> 12): refused without a reason, nothing moves; with a reason it posts 12 and writes stock.usage_tolerance_verified', async () => {
    const s = await scenario('e2');
    await mustFinalize(s);
    const d = await theDraft(s);
    await setActual(s.w, d.id, s.w.cheese, '12');
    const no = await asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.manager, { recordId: d.id }));
    expect(no.ok).toBe(false);
    expect(await statusOf(d.id)).toBe('draft');
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
    const yes = await asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.manager, { recordId: d.id, verifyOutOfTolerance: { reason: 'Counted twelve trays' } }));
    expect(yes.ok, yes.ok ? '' : yes.reason).toBe(true);
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 12);
    const [v] = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${s.w.orgId} and action = 'stock.usage_tolerance_verified'`;
    expect(Number(v!.n)).toBe(1);
  }, 180_000);

  it('the pull draft left untouched (actual = expected) posts clean: the band is the pull draft against itself, never doubled by counting it twice', async () => {
    const s = await scenario('e3');
    await mustFinalize(s);
    const d = await theDraft(s);
    const r = await asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.manager, { recordId: d.id }));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 10);
  }, 180_000);

  it('staff cannot post the pull draft (post_usage is a manager capability); nothing moves', async () => {
    const s = await scenario('e4');
    await mustFinalize(s);
    const d = await theDraft(s);
    await expect(asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.staff as Actor, { recordId: d.id }))).rejects.toThrow();
    expect(await statusOf(d.id)).toBe('draft');
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-post: an unposted pull draft posts at 14:00 Manila the next day', () => {
  it('before 14:00 nothing posts; after 14:00 the draft posts in full, auto_posted = true, one stock.usage_auto_posted row (store, stock, normal); stock falls by the expected', async () => {
    const s = await scenario('a1');
    await mustFinalize(s);
    const d = await theDraft(s);
    const early = await runAuto(BEFORE_DUE, s.w);
    expect(early.posted, 'before the deadline: nothing').toHaveLength(0);
    expect(await statusOf(d.id)).toBe('draft');
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
    const same = await runAuto(SAME_DAY_EVENING, s.w);
    expect(same.posted, 'the evening of the business date: nothing').toHaveLength(0);

    const late = await runAuto(AFTER_DUE, s.w);
    expect(late.posted).toHaveLength(1);
    expect(late.skipped).toEqual([]);
    expect(await statusOf(d.id)).toBe('posted');
    expect(await flagOf(d.id)).toBe(true);
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 10);
    const rows = await autoAudit(s.w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_id: s.w.a.storeId, category: 'stock', sensitivity: 'normal', entity_id: d.id });
  }, 180_000);

  it('idempotent: running again posts nothing more - no second movement, no second audit row', async () => {
    const s = await scenario('a2');
    await mustFinalize(s);
    await theDraft(s);
    await runAuto(AFTER_DUE, s.w);
    const again = await runAuto(AFTER_DUE, s.w);
    expect(again.posted).toHaveLength(0);
    expect(again.skipped).toEqual([]);
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 10);
    expect(await autoAudit(s.w)).toHaveLength(1);
  }, 180_000);

  it('in-band lines post as they stand; an out-of-band line with no reason posts at its EXPECTED quantity. Mutant: out-of-band posts the actual, or the whole record is skipped', async () => {
    const s = await scenario('a3', true);
    await mustFinalize(s);
    const d = await theDraft(s);
    await setActual(s.w, d.id, s.w.cheese, '10.5'); // +5%: stays
    await setActual(s.w, d.id, s.w.rice, '15'); //    +50%: back to expected 10
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted).toHaveLength(1);
    expect(await statusOf(d.id)).toBe('posted');
    expect(await onHand(s.w, s.w.cheese), 'in-band line posts as typed').toBe(START - 10.5);
    expect(await onHand(s.w, s.w.rice), 'out-of-band line posts at expected').toBe(START - 10);
    const lines = await sql<{ item_id: string; quantity: string }[]>`select item_id, quantity from stock_usage_lines where record_id = ${d.id}`;
    expect(Object.fromEntries(lines.map((l) => [l.item_id, l.quantity])), 'the record itself now says what was posted').toEqual({ [s.w.cheese]: '10.500', [s.w.rice]: '10.000' });
  }, 180_000);

  it('a manager-posted pull draft is not touched again (already posted, auto_posted stays false)', async () => {
    const s = await scenario('a4');
    await mustFinalize(s);
    const d = await theDraft(s);
    expect((await asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.manager, { recordId: d.id }))).ok).toBe(true);
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted).toHaveLength(0);
    expect(await flagOf(d.id)).toBe(false);
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 10);
    expect(await autoAudit(s.w)).toHaveLength(0);
  }, 180_000);

  it('MANUAL drafts are never auto-posted: a staff draft for an item the POS does not sell (Coke) stays a draft well past the deadline; the pull draft beside it posts', async () => {
    const s = await scenario('a5');
    await stockUp(s.w, s.w.a.storeId, s.w.a.kitchen, s.w.coke, String(START));
    await mustFinalize(s);
    const pullDraft = await theDraft(s);
    const manual = await asOrg(s.w.orgId, (tx) =>
      saveUsageDraft(tx, s.w.staff, { orgId: s.w.orgId, storeId: s.w.a.storeId, locationId: s.w.a.kitchen, kind: 'usage', usedOn: '2026-08-10', lines: [{ itemId: s.w.coke, quantity: '5' }] }),
    );
    if (!manual.ok) throw new Error(manual.reason);
    await sql`update stock_usage_records set created_at = '2026-08-10T12:00:00Z' where id = ${manual.recordId}`;
    const r = await runAuto(new Date('2026-09-30T06:01:00Z'), s.w);
    expect(await statusOf(manual.recordId), 'a manual draft waits for a manager however old').toBe('draft');
    expect(await onHand(s.w, s.w.coke)).toBe(START);
    expect(await statusOf(pullDraft.id)).toBe('posted');
    expect(r.skipped.map((x) => x.recordId)).not.toContain(manual.recordId);
  }, 180_000);

  it('a refused post (the kitchen is being counted) is left as a draft, reported in skipped with a reason, never forced; once the count ends the next run posts it', async () => {
    const s = await scenario('a6');
    await mustFinalize(s);
    const d = await theDraft(s);
    const [cs] = await sql<{ id: string }[]>`
      insert into count_sessions (org_id, store_id, status, counted_on, opened_by) values (${s.w.orgId}, ${s.w.a.storeId}, 'open', '2026-08-20', ${s.w.manager.personId}) returning id`;
    await sql`insert into count_session_locations (session_id, location_id) values (${cs!.id}, ${s.w.a.kitchen})`;
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.recordId).toBe(d.id);
    expect(r.skipped[0]!.reason.length, 'the reason is words').toBeGreaterThan(5);
    expect(await statusOf(d.id)).toBe('draft');
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
    expect(await flagOf(d.id)).toBe(false);
    expect(await autoAudit(s.w)).toHaveLength(0);

    await sql`update count_sessions set status = 'cancelled', closed_by = ${s.w.manager.personId}, closed_at = now() where id = ${cs!.id}`;
    const ok = await runAuto(AFTER_DUE, s.w);
    expect(ok.posted).toHaveLength(1);
    expect(await statusOf(d.id)).toBe('posted');
  }, 180_000);

  it('a refused post (the stock period of the business date is closed) is left as a draft and listed in skipped with words; reopening the month lets the next run post it', async () => {
    const s = await scenario('a6b');
    await mustFinalize(s);
    const d = await theDraft(s);
    // Months close in order: close every earlier month first, then August.
    const months = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${s.w.orgId} and starts_on <= '2026-08-01' order by starts_on`;
    for (const m of months) {
      await sql`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${s.w.admin.personId} where id = ${m.id}`;
    }
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted).toHaveLength(0);
    expect(r.skipped.map((x) => x.recordId)).toEqual([d.id]);
    expect(r.skipped[0]!.reason.length, 'the reason is words').toBeGreaterThan(5);
    expect(await statusOf(d.id)).toBe('draft');
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
    expect(await autoAudit(s.w)).toHaveLength(0);
    await sql`update fiscal_periods set status = 'open', closed_at = null, closed_by = null where org_id = ${s.w.orgId} and starts_on = '2026-08-01'`;
    const ok = await runAuto(AFTER_DUE, s.w);
    expect(ok.posted).toHaveLength(1);
    expect(await statusOf(d.id)).toBe('posted');
  }, 180_000);

  it('one refused record does not stop the others: store A frozen, store B (same org) due too -> B posts, A is skipped', async () => {
    const s = await scenario('a7');
    await rawMap(s.w, s.w.b.storeId, 'a', { mode: 'direct', itemId: s.w.cheese, quantityPerSale: '1' });
    await stockUp(s.w, s.w.b.storeId, s.w.b.kitchen, s.w.cheese, String(START));
    const dayB = await makeDay(s.w, s.w.b.storeId, DAY, sold([{ key: 'a', qty: 10 }]));
    const pb = await asOrg(s.w.orgId, (tx) => buildPlan(tx, s.w.manager, { orgId: s.w.orgId, storeId: s.w.b.storeId, salesDayId: dayB, locationId: s.w.b.kitchen }));
    if (!pb.ok) throw new Error(pb.reason);
    await mustFinalize(s);
    const fb = await asOrg(s.w.orgId, (tx) => finalizeSections(tx, s.w.manager, { pullId: pb.pullId, sections: ['direct'], confirmedKeys: pb.lines.filter((l) => !l.blocked).map((l) => l.key) }));
    expect(fb.ok).toBe(true);
    const dA = await theDraft(s);
    const [dB] = await usageRecordsOfDay(sql, s.w.b.storeId, DAY);
    await sql`update stock_usage_records set created_at = '2026-08-20T12:00:00Z' where id = ${dB!.id}`;
    const [cs] = await sql<{ id: string }[]>`
      insert into count_sessions (org_id, store_id, status, counted_on, opened_by) values (${s.w.orgId}, ${s.w.a.storeId}, 'open', '2026-08-20', ${s.w.manager.personId}) returning id`;
    await sql`insert into count_session_locations (session_id, location_id) values (${cs!.id}, ${s.w.a.kitchen})`;
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted).toHaveLength(1);
    expect(r.skipped.map((x) => x.recordId)).toEqual([dA.id]);
    expect(await statusOf(dB!.id)).toBe('posted');
    expect(await statusOf(dA.id)).toBe('draft');
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('voiding a pull whose draft is still unposted', () => {
  it('voids the pull and removes the live draft (deleted or void): no stock moves, no usage record left to post; the day is free to pull again', async () => {
    const s = await scenario('v1');
    await mustFinalize(s);
    await theDraft(s);
    const before = await movementCount(sql, s.w.orgId);
    const out = await asOrg(s.w.orgId, (tx) => voidPosUsagePull(tx, s.w.manager, { pullId: s.pullId, reason: 'POS corrected' }));
    expect(out.ok).toBe(true);
    expect(await movementCount(sql, s.w.orgId)).toBe(before);
    expect(await usageRecordsOfDay(sql, s.w.a.storeId, DAY), 'no live (draft or posted) record is left for the day').toEqual([]);
    const [p] = await sql<{ status: string }[]>`select status from pos_usage_pulls where id = ${s.pullId}`;
    expect(p!.status).toBe('void');
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted, 'the voided pull draft is never auto-posted').toHaveLength(0);
  }, 180_000);

  it('a pull draft the manager already POSTED is reversed by the void (the existing rule): stock comes back', async () => {
    const s = await scenario('v2');
    await mustFinalize(s);
    const d = await theDraft(s);
    expect((await asOrg(s.w.orgId, (tx) => postUsage(tx, s.w.manager, { recordId: d.id }))).ok).toBe(true);
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 10);
    const out = await asOrg(s.w.orgId, (tx) => voidPosUsagePull(tx, s.w.manager, { pullId: s.pullId, reason: 'POS corrected' }));
    expect(out.ok).toBe(true);
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
    expect(await statusOf(d.id)).toBe('void');
  }, 180_000);
});
