/**
 * T-401 S6 - month-close BLOCK on unposted / unexplained usage, and the usage-check scorecard. TESTER; real Postgres; raw fixtures.
 * Ian's rulings, 15 Oct:
 *  8. `closePeriod` refuses while, in that org + month, any usage record is a DRAFT (pull-made or manual), or is POSTED with an
 *     out-of-band line and no reason. An auto-posted record (its out-of-band lines were posted at EXPECTED) never blocks.
 *     Another org's records, and another month's, never block.
 *  9. `usageCheckScorecard(tx, actor, { from, to })` -> one row per store: { storeId, pullDrafts, postedByManager, autoPosted,
 *     autoPostedPct }. Capability `view_financial_reports` (what the dashboard gate uses); a store-scoped manager sees only
 *     their own stores.
 *
 * ## Names / meanings the tester ASSUMED (the spec names none) - the builder meets these or tells the tester
 *  - `usageCheckScorecard` is exported from @shareat/domain and returns an array of rows (an object `{ stores: [...] }` is also
 *    read); the store id key is `storeId`;
 *  - the range is by the record's BUSINESS DATE (used_on), inclusive both ends; a "pull draft" is a usage record the pull made
 *    (found through pos_usage_pull_lines.usage_record_id); `pullDrafts` counts every pull-made record of the range whatever its
 *    status except void; `postedByManager` = posted and auto_posted false; `autoPosted` = auto_posted true;
 *    `autoPostedPct` = autoPosted / pullDrafts x 100 as a number (1 of 4 -> 25), 0 when pullDrafts is 0;
 *  - "ignores auto-posted" (the spec's mutant) is read as: the close check must neither count an auto-posted record as an
 *    unexplained out-of-band post nor skip the drafts that remain beside it;
 *  - "posted with an out-of-band line and no reason" is judged the way the post gate judges it: the item's day total against the
 *    pull's expected, and no `stock.usage_tolerance_verified` audit row for that record + item.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, systemTransaction, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import * as domainModule from '@shareat/domain';
import { buildPlan, closePeriod, finalizeSections, postUsage, saveUsageDraft } from '@shareat/domain';
import { asOrg, makeDay, rawMap, sold, sql, stockUp, world, type World } from './t401-s5-setup';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const mod = domainModule as unknown as {
  autoPostDueUsageDrafts(tx: Tx, now: Date): Promise<{ posted: unknown[]; skipped: { recordId: string; reason: string }[] }>;
  usageCheckScorecard(tx: Tx, actor: { personId: string; orgId: string }, range: { from: string; to: string }): Promise<unknown>;
};
/** The sweep is system-wide and every test's drafts share the database: scope what it reports to THIS test's org. */
async function runAuto(now: Date, w: World) {
  const r = await systemTransaction((tx) => mod.autoPostDueUsageDrafts(tx, now));
  const own = new Set((await sql<{ id: string }[]>`select id from stock_usage_records where org_id = ${w.orgId}`).map((x) => x.id));
  return {
    posted: (r.posted as { recordId: string }[]).filter((x) => own.has(x.recordId)),
    skipped: r.skipped.filter((x) => own.has(x.recordId)),
  };
}
/** Voids a usage record the way the void CHECK needs it (voided_at, voided_by, a reason). */
const voidRecord = (w: World, id: string) =>
  sql`update stock_usage_records set status = 'void', voided_at = now(), voided_by = ${w.admin.personId}, void_reason = 'test fixture' where id = ${id}`;

interface Row { storeId: string; pullDrafts: number; postedByManager: number; autoPosted: number; autoPostedPct: number }
async function scorecard(w: World, actor: { personId: string; orgId: string }, from: string, to: string): Promise<Row[]> {
  const out = (await asOrg(w.orgId, (tx) => mod.usageCheckScorecard(tx, actor, { from, to }))) as Row[] | { stores: Row[] };
  return Array.isArray(out) ? out : out.stores;
}

/** A pull-made usage draft for (store, date): 'a' 10 sold -> Cheese x1 (expected 10). Returns the record id. created_at moved to the evening of the day. */
async function pullDraft(w: World, storeId: string, kitchen: string, date: string): Promise<string> {
  const [m] = await sql<{ n: string }[]>`select count(*)::text as n from pos_item_maps where store_id = ${storeId} and pos_item_key = 'a'`;
  if (Number(m!.n) === 0) {
    await rawMap(w, storeId, 'a', { mode: 'direct', itemId: w.cheese, quantityPerSale: '1' });
    await stockUp(w, storeId, kitchen, w.cheese, '1000');
  }
  const dayId = await makeDay(w, storeId, date, sold([{ key: 'a', qty: 10 }]));
  const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.manager, { orgId: w.orgId, storeId, salesDayId: dayId, locationId: kitchen }));
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  const f = await asOrg(w.orgId, (tx) =>
    finalizeSections(tx, w.manager, { pullId: p.pullId, sections: ['direct'], confirmedKeys: p.lines.filter((l) => !l.blocked).map((l) => l.key) }),
  );
  if (!f.ok) throw new Error(`fixture: finalize refused: ${f.reason}`);
  const [r] = await sql<{ id: string }[]>`select id from stock_usage_records where store_id = ${storeId} and used_on = ${date} and kind = 'usage' and status <> 'void'`;
  if (!r) throw new Error('fixture: finalize made no usage record');
  await sql`update stock_usage_records set created_at = ${date + 'T12:00:00Z'} where id = ${r.id}`;
  return r.id;
}
const managerPost = (w: World, id: string, reason?: string) =>
  asOrg(w.orgId, (tx) => postUsage(tx, w.manager, { recordId: id, ...(reason ? { verifyOutOfTolerance: { reason } } : {}) }));
const mustPost = async (w: World, id: string, reason?: string) => {
  const r = await managerPost(w, id, reason);
  if (!r.ok) throw new Error(`fixture: post refused: ${r.reason}`);
};
async function manualDraft(w: World, date: string, qty = '5'): Promise<string> {
  const r = await asOrg(w.orgId, (tx) =>
    saveUsageDraft(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, locationId: w.a.kitchen, kind: 'usage', usedOn: date, lines: [{ itemId: w.coke, quantity: qty }] }),
  );
  if (!r.ok) throw new Error(`fixture: manual draft refused: ${r.reason}`);
  return r.recordId;
}

/** Closes every month before August so August is the next one to close (periods close in order). */
async function closeEarlierMonths(w: World) {
  await sql`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${w.admin.personId} where org_id = ${w.orgId} and starts_on < '2026-08-01'`;
}
/** The stock-up deliveries of the fixture are drafts dated in August, which would block the close on their own: mark them received first. */
const closeAug = async (w: World) => {
  await sql`update deliveries set status = 'received', received_at = now(), received_by = ${w.staff.personId} where org_id = ${w.orgId} and status = 'draft'`;
  // The fixture's POS sales days (made for the pull) are old, open, POS-sourced days: they would trip salesDayUnposted on their own. Verify them.
  await sql`update sales_days set status = 'submitted', submitted_at = now(), submitted_by = ${w.staff.personId} where org_id = ${w.orgId} and status = 'open'`;
  await sql`update sales_days set status = 'verified', verified_at = now(), verified_by = ${w.manager.personId} where org_id = ${w.orgId} and status = 'submitted'`;
  return asOrg(w.orgId, (tx) => closePeriod(tx, w.admin, { period: '2026-08' }));
};
const periodStatus = async (w: World, month: string) =>
  (await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${w.orgId} and starts_on = ${month + '-01'}`)[0]!.status;

// ---------------------------------------------------------------------------------------------------------------------
describe('month-close blocks on unposted or unexplained usage', () => {
  it('control: a month with no usage records closes (so every refusal below is the usage rule, not the fixture)', async () => {
    const w = await world('mc0');
    await closeEarlierMonths(w);
    await closeAug(w);
    expect(await periodStatus(w, '2026-08')).toBe('closed');
  }, 180_000);

  it('a PULL draft still unposted in the month refuses the close with a sentence about usage; once the manager posts it the month closes', async () => {
    const w = await world('mc1');
    await closeEarlierMonths(w);
    const id = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-20');
    await expect(closeAug(w)).rejects.toThrow(/usage/i);
    expect(await periodStatus(w, '2026-08')).toBe('open');
    await mustPost(w, id);
    await closeAug(w);
    expect(await periodStatus(w, '2026-08')).toBe('closed');
  }, 180_000);

  it('a MANUAL draft (Coke, which the POS does not sell) refuses the close too; voiding it frees the month', async () => {
    const w = await world('mc2');
    await closeEarlierMonths(w);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.coke, '100');
    const id = await manualDraft(w, '2026-08-31');
    await expect(closeAug(w), 'last day of the month counts').rejects.toThrow(/usage/i);
    await voidRecord(w, id);
    await closeAug(w);
    expect(await periodStatus(w, '2026-08')).toBe('closed');
  }, 180_000);

  it('POSTED in band closes; POSTED out of band WITH a reason closes; POSTED out of band with NO reason refuses (mutant: only drafts are looked at)', async () => {
    const w = await world('mc3');
    await closeEarlierMonths(w);
    const ok = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-10');
    await mustPost(w, ok);
    await closeAug(w);
    expect(await periodStatus(w, '2026-08')).toBe('closed');

    const w2 = await world('mc3b');
    await closeEarlierMonths(w2);
    const id = await pullDraft(w2, w2.a.storeId, w2.a.kitchen, '2026-08-10');
    const [line] = await sql<{ id: string }[]>`select id from stock_usage_lines where record_id = ${id}`;
    await sql`update stock_usage_lines set quantity = 15 where id = ${line!.id}`; // +50% against expected 10
    await mustPost(w2, id, 'Counted fifteen');
    await closeAug(w2);
    expect(await periodStatus(w2, '2026-08'), 'a reason was given at the post').toBe('closed');

    const w3 = await world('mc3c');
    await closeEarlierMonths(w3);
    const id3 = await pullDraft(w3, w3.a.storeId, w3.a.kitchen, '2026-08-10');
    await mustPost(w3, id3); // in band, no reason needed
    const [l3] = await sql<{ id: string }[]>`select id from stock_usage_lines where record_id = ${id3}`;
    await sql`update stock_usage_lines set quantity = 15 where id = ${l3!.id}`; // out of band after the fact: posted, no reason on file
    await expect(closeAug(w3)).rejects.toThrow(/usage/i);
    expect(await periodStatus(w3, '2026-08')).toBe('open');
  }, 300_000);

  it('an AUTO-POSTED record never blocks (its out-of-band line went in at expected), but a draft left beside it does. Mutant: auto-posted counted as unexplained', async () => {
    const w = await world('mc4');
    await closeEarlierMonths(w);
    const id = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-10');
    const [line] = await sql<{ id: string }[]>`select id from stock_usage_lines where record_id = ${id}`;
    await sql`update stock_usage_lines set quantity = 15 where id = ${line!.id}`; // staff typed 15: out of band
    const r = await runAuto(new Date('2026-08-11T06:01:00Z'), w);
    expect(r.posted).toHaveLength(1);
    const [rec] = await sql<{ status: string; a: boolean }[]>`select status, auto_posted as a from stock_usage_records where id = ${id}`;
    expect(rec).toMatchObject({ status: 'posted', a: true });
    await closeAug(w);
    expect(await periodStatus(w, '2026-08'), 'an auto-posted record is explained by the auto-post itself').toBe('closed');

    const w2 = await world('mc4b');
    await closeEarlierMonths(w2);
    await pullDraft(w2, w2.a.storeId, w2.a.kitchen, '2026-08-10');
    await runAuto(new Date('2026-08-11T06:01:00Z'), w2);
    await pullDraft(w2, w2.a.storeId, w2.a.kitchen, '2026-08-25'); // a later day, still a draft
    await expect(closeAug(w2)).rejects.toThrow(/usage/i);
  }, 300_000);

  it("another MONTH's draft and another ORG's draft never block this month's close", async () => {
    const w = await world('mc5');
    await closeEarlierMonths(w);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.coke, '100');
    await manualDraft(w, '2026-09-01'); // the day after the month
    const other = await world('mc5-other');
    await stockUp(other, other.a.storeId, other.a.kitchen, other.coke, '100');
    await manualDraft(other, '2026-08-15'); // same month, a different organisation
    await closeAug(w);
    expect(await periodStatus(w, '2026-08')).toBe('closed');
    expect(await periodStatus(other, '2026-08'), 'control: the other org is untouched').toBe('open');
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('usageCheckScorecard', () => {
  async function build(hint: string) {
    const w = await world(hint);
    // Day 10: pull drafts at A and B, both auto-posted (due 11 Aug 14:00 Manila). Later days are created afterwards.
    const a10 = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-10');
    const b10 = await pullDraft(w, w.b.storeId, w.b.kitchen, '2026-08-10');
    const auto = await runAuto(new Date('2026-08-11T06:01:00Z'), w);
    expect(auto.posted).toHaveLength(2);
    const a11 = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-11');
    await mustPost(w, a11);
    const a12 = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-12');
    const a13 = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-13');
    const a25 = await pullDraft(w, w.a.storeId, w.a.kitchen, '2026-08-25'); // outside the range below
    await mustPost(w, a25);
    return { w, a10, b10, a11, a12, a13, a25 };
  }
  const rowOf = (rows: Row[], storeId: string) => rows.find((r) => r.storeId === storeId);

  it('counts per store over the range: A has 4 pull drafts (1 auto-posted, 1 manager-posted, 2 still draft) = 25%; B has 1, auto-posted = 100%; day 25 is outside', async () => {
    const { w } = await build('sc1');
    const rows = await scorecard(w, w.manager, '2026-08-01', '2026-08-20');
    expect(rowOf(rows, w.a.storeId)).toMatchObject({ pullDrafts: 4, postedByManager: 1, autoPosted: 1, autoPostedPct: 25 });
    expect(rowOf(rows, w.b.storeId)).toMatchObject({ pullDrafts: 1, postedByManager: 0, autoPosted: 1, autoPostedPct: 100 });
    const wide = await scorecard(w, w.admin, '2026-08-01', '2026-08-31');
    expect(rowOf(wide, w.a.storeId), 'the wider range picks day 25 up (control for the range filter)').toMatchObject({ pullDrafts: 5, postedByManager: 2, autoPosted: 1, autoPostedPct: 20 });
  }, 600_000);

  it('a store with no pull drafts in the range reads 0 and 0% (never NaN); a voided pull draft is not counted', async () => {
    const { w, a12 } = await build('sc2');
    const none = await scorecard(w, w.admin, '2026-07-01', '2026-07-31');
    for (const r of none.filter((x) => x.storeId === w.a.storeId || x.storeId === w.b.storeId)) {
      expect(r).toMatchObject({ pullDrafts: 0, postedByManager: 0, autoPosted: 0, autoPostedPct: 0 });
    }
    await voidRecord(w, a12);
    const rows = await scorecard(w, w.admin, '2026-08-01', '2026-08-20');
    expect(rowOf(rows, w.a.storeId)!.pullDrafts).toBe(3);
  }, 600_000);

  it('a manager scoped to store A sees only store A; a manager of A and B sees both. Mutant: no store scoping', async () => {
    const { w } = await build('sc3');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'A-only Manager') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.a.storeId})`;
    const aOnly = { personId: p!.id, orgId: w.orgId };
    const rows = await scorecard(w, aOnly, '2026-08-01', '2026-08-20');
    expect(rows.map((r) => r.storeId)).toEqual([w.a.storeId]);
    expect(rowOf(rows, w.a.storeId)!.pullDrafts).toBe(4);
    const both = await scorecard(w, w.manager, '2026-08-01', '2026-08-20');
    expect(both.map((r) => r.storeId).sort()).toEqual([w.a.storeId, w.b.storeId].sort());
  }, 600_000);

  it("staff (no view_financial_reports) is refused; another org's stores never appear", async () => {
    const { w } = await build('sc4');
    await expect(asOrg(w.orgId, (tx) => mod.usageCheckScorecard(tx, w.staff, { from: '2026-08-01', to: '2026-08-20' }))).rejects.toThrow(AuthorizationError);
    const other = await world('sc4-other');
    const rows = await scorecard(other, other.manager, '2026-08-01', '2026-08-31');
    expect(rows.every((r) => r.pullDrafts === 0)).toBe(true);
    expect(rows.map((r) => r.storeId)).not.toContain(w.a.storeId);
  }, 600_000);
});
