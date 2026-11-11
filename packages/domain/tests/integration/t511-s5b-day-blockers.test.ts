import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S5b (TESTER, 2026-11-05) - `dayBlockers`: the ordered list of reasons a store-day cannot be approved yet (S7 enforces, S5 only shows), on a REAL Postgres.
 * docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 2; design Component F "Blockers" (the one list, line 213).
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/day-checks.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT (tester's choices where the spec leaves a signature open; the builder must meet these or ask BOSS to change the tests):
 *  B1  `dayBlockers(tx, actor, target, opts?: { today?: string }): Promise<{ blockers: { code: string; sentence: string }[]; willPostOn: string | null; postNote: string | null }>`.
 *      `target` is a staged `DayLineRow`, or `{ channelId, salesDate }` for a day with no staged line (`'id' in target` tells them apart). `opts.today` (YYYY-MM-DD) is the
 *      clock for `firstOpenDateOnOrAfter` (default: today in Manila).
 *  B2  The documented ORDER (design line 213) and the codes:
 *        no_file, not_paid, charges_unexplained, store_not_matched, sales_day_not_verified, loan_check, no_destination_account, negative_net_deposit,
 *        posted_settlement_exists, earlier_day_open, line_not_current.
 *      Sentences (case-insensitive fragments): no_file "no file for this day"; not_paid "not paid yet"; charges_unexplained "explain"; store_not_matched "not matched";
 *      sales_day_not_verified exactly "waiting for the sales day to be verified"; loan_check one of "no matching loan recorded" / "loan amounts don't match" /
 *      "waiting for other stores' files"; no_destination_account "no destination account" and negative_net_deposit "negative deposit" and posted_settlement_exists
 *      "already has a posted settlement" (the three T-150 `previewChannelSettlement` sentences, taken from it, not re-written); earlier_day_open "earlier day";
 *      line_not_current "newer". No sentence contains a UUID, a raw code or a store name other than the actor's.
 *  B3  FRESH, never the line's snapshot: the staff figure and the verified state are read from the sales day at call time (`recorded_figure` / `difference` of the line are
 *      never consulted); is_current is read from the table by the line's id; a line object passed in stale does not fool it.
 *  B4  Only the three preview blockers above come from `previewChannelSettlement` (called with the FILE order value as gross, via `lineToSettlementInput`). Its
 *      variance, gain and "nothing outstanding" refusals are NOT blockers: a gap between the file and what staff recorded (Lipa 20 Oct, 454.00) is the correction's
 *      business (slice 6), not a reason to hold the day.
 *  B5  A closed or locked period is NOT a blocker (BOSS ruling 9): `blockers` stays free of it and `willPostOn` is `firstOpenDateOnOrAfter(salesDate, today)` as YYYY-MM-DD
 *      with `postNote` "... will post on <that date> ..."; both null when the period is open.
 *  B6  A day with NO staged line blocks (no_file) only when staff recorded sales for it (a VERIFIED day with a channel amount above zero, as `daysWithRecordedSalesAndNoLine`
 *      reads it); nothing recorded, an open day, or a confirmed no-sales day is not a gap. Earlier days start at the channel's FIRST staged day; an earlier date with no line
 *      counts as open only when staff recorded sales that day; a decided (booked or rejected) earlier line does not block.
 *  B7  Manager privacy: for a non-admin actor the loan_check sentence is the viewer-redacted one of loan-check.ts (never another store's name).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, settlementIntakeRepo } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { dayBlockers } from '../../src/settlement-intake/day-checks';
import { overrideLoanAllocation, rejectDay } from '../../src/settlement-intake/review';
import {
  LIPA_FP, UUID_RE, asOrg, bookLine, closedPeriod, lineById, lineOn, mkLoan, postedSettlementRaw, postedSalesDay as salesDay, setDestination, stageGrabOctober, synthFoodpanda,
  world3, type World3,
} from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 8 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const zip = (b: Buffer): File => ({ bytes: b, contentType: 'application/zip' });
let tagSeq = 0;
const tag = (): string => `s5bd-${Date.now()}-${++tagSeq}`;
const TODAY = '2026-11-05';

const stageFp = async (w: World3, date: string, revenue = 1000): Promise<void> => {
  await ingest(w, w.managerA, zip(synthFoodpanda([{ date, revenue }], LIPA_FP, tag())));
};

/** The blockers of the CURRENT line of a channel and date, read the way a screen would (the camelCase row from the repo). */
const blockersAt = (w: World3, who: Actor, channelId: string, date: string) =>
  asOrg(w.orgId, async (tx) => {
    const line = await settlementIntakeRepo.currentLine(tx, w.orgId, channelId, date);
    return dayBlockers(tx, who, line!, { today: TODAY });
  });
const codes = async (w: World3, who: Actor, channelId: string, date: string): Promise<string[]> => (await blockersAt(w, who, channelId, date)).blockers.map((b) => b.code);

/** A day with every check green: staged, paid, a destination account, a verified sales day that matches. */
async function cleanDay(hint: string, opts: { periods?: boolean } = {}) {
  const w = await world3(sql, hint, opts);
  await stageFp(w, '2026-10-12');
  const line = await lineOn(sql, w.orgId, w.fpA, '2026-10-12');
  await sql`update settlement_day_lines set paid_state = 'paid' where id = ${line.id}`;
  await setDestination(sql, w, w.fpA);
  const salesDayId = await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '1000.00', { verified: true });
  return { w, line, salesDayId };
}

/* ================================================================== the green day, and one test per blocker */

describe('T-511 S5b dayBlockers - one blocker at a time, from a day that is otherwise green', () => {
  it('control: the clean day has no blocker and no "will post on" note [kills: a blocker that is always there]', async () => {
    const { w } = await cleanDay('blk-clean');
    expect(await blockersAt(w, w.managerA, w.fpA, '2026-10-12')).toEqual({ blockers: [], willPostOn: null, postNote: null });
  });

  it('no file: a day with no staged line blocks only when staff recorded sales for it; nothing recorded, an open day and a confirmed no-sales day do not [kills: every empty day blocked; recorded sales ignored]', async () => {
    const w = await world3(sql, 'blk-nofile');
    const target = { channelId: w.fpA, salesDate: '2026-10-12' };
    const ask = () => asOrg(w.orgId, (tx) => dayBlockers(tx, w.managerA, target, { today: TODAY }));
    expect((await ask()).blockers).toEqual([]);
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '700.00', { verified: false });
    expect((await ask()).blockers, 'an open day is not a gap').toEqual([]);
    const w2 = await world3(sql, 'blk-nofile-zero');
    await salesDay(sql, w2, w2.storeA, w2.fpA, '2026-10-12', '0.00', { verified: true, noSales: true });
    expect((await asOrg(w2.orgId, (tx) => dayBlockers(tx, w2.managerA, { channelId: w2.fpA, salesDate: '2026-10-12' }, { today: TODAY }))).blockers, 'a confirmed zero is not a gap').toEqual([]);
    const w3 = await world3(sql, 'blk-nofile-sales');
    await salesDay(sql, w3, w3.storeA, w3.fpA, '2026-10-12', '700.00', { verified: true });
    const r = await asOrg(w3.orgId, (tx) => dayBlockers(tx, w3.managerA, { channelId: w3.fpA, salesDate: '2026-10-12' }, { today: TODAY }));
    expect(r.blockers.map((b) => b.code)).toEqual(['no_file']);
    expect(r.blockers[0]!.sentence).toMatch(/no file for this day/i);
  });

  it('not paid yet applies to GRAB only (BOSS ruling 1, 5 Nov: a Processing transfer is not paid; a Foodpanda invoice is the payout statement, so its paid state never blocks) [kills: a Processing payout read as paid; Foodpanda held for paid state]', async () => {
    // test edit (builder 1, 5 Nov 2026): the tester pinned the not_paid blocker on a Foodpanda line, which ruling 1 forbids; the same check now runs on a Grab line and the Foodpanda case pins the opposite.
    const { w, line } = await cleanDay('blk-unpaid');
    await sql`update settlement_day_lines set paid_state = 'not_paid' where id = ${line.id}`;
    expect((await blockersAt(w, w.managerA, w.fpA, '2026-10-12')).blockers.map((b) => b.code), 'Foodpanda is never blocked for paid state').toEqual([]);
    const g = await world3(sql, 'blk-unpaid-grab');
    await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), g, g.managerA, 'lipa');
    const grab = await lineOn(sql, g.orgId, g.grabA, '2026-10-13');
    await sql`update settlement_day_lines set paid_state = 'paid' where id = ${grab.id}`;
    expect(await codes(g, g.admin, g.grabA, '2026-10-13')).not.toContain('not_paid');
    await sql`update settlement_day_lines set paid_state = 'not_paid' where id = ${grab.id}`;
    const r = await blockersAt(g, g.admin, g.grabA, '2026-10-13');
    expect(r.blockers[0]!.code).toBe('not_paid');
    expect(r.blockers[0]!.sentence).toMatch(/not paid yet/i);
  });

  it('charges unexplained: an unexplained amount other than zero blocks, in plain words [kills: a residual let through]', async () => {
    const { w, line } = await cleanDay('blk-unexplained');
    await sql`update settlement_day_lines set unexplained = '5.00' where id = ${line.id}`;
    const r = await blockersAt(w, w.managerA, w.fpA, '2026-10-12');
    expect(r.blockers.map((b) => b.code)).toEqual(['charges_unexplained']);
    expect(r.blockers[0]!.sentence).toMatch(/explain/i);
  });

  it('store not matched: the channel lost the platform code the file was matched by (cleared, or changed to another) [kills: a stale match trusted]', async () => {
    const a = await cleanDay('blk-nomatch-clear');
    await sql`update sales_channels set platform = null, platform_store_code = null where id = ${a.w.fpA}`;
    const r = await blockersAt(a.w, a.w.managerA, a.w.fpA, '2026-10-12');
    expect(r.blockers.map((b) => b.code)).toEqual(['store_not_matched']);
    expect(r.blockers[0]!.sentence).toMatch(/not matched/i);
    const b = await cleanDay('blk-nomatch-change');
    await sql`update sales_channels set platform_store_code = 'ZZZZ' where id = ${b.w.fpA}`;
    expect(await codes(b.w, b.w.managerA, b.w.fpA, '2026-10-12')).toEqual(['store_not_matched']);
  });

  it('no verified sales day: waiting for it to be verified; it clears the moment the day is verified, though the line\'s own snapshot stays null (fresh, not the snapshot) [kills: reading recorded_figure from the line]', async () => {
    const w = await world3(sql, 'blk-unverified');
    await stageFp(w, '2026-10-12');
    const line = await lineOn(sql, w.orgId, w.fpA, '2026-10-12');
    await sql`update settlement_day_lines set paid_state = 'paid' where id = ${line.id}`;
    await setDestination(sql, w, w.fpA);
    expect(line.recorded_figure).toBeNull();
    const before = await blockersAt(w, w.managerA, w.fpA, '2026-10-12');
    expect(before.blockers.map((b) => b.code)).toEqual(['sales_day_not_verified']);
    expect(before.blockers[0]!.sentence).toMatch(/waiting for the sales day to be verified/i);
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '1000.00', { verified: true });
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).recorded_figure, 'the snapshot never changed').toBeNull();
    expect((await blockersAt(w, w.managerA, w.fpA, '2026-10-12')).blockers).toEqual([]);
  });

  it('an open (unverified) sales day is still "waiting"; a confirmed no-sales day is a verified zero and does not block [kills: any sales-day row counted as verified]', async () => {
    const w = await world3(sql, 'blk-open-day');
    await stageFp(w, '2026-10-12');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w.orgId}`;
    await setDestination(sql, w, w.fpA);
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '1000.00', { verified: false });
    expect(await codes(w, w.managerA, w.fpA, '2026-10-12')).toEqual(['sales_day_not_verified']);
    const z = await world3(sql, 'blk-zero-day');
    await stageFp(z, '2026-10-12');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${z.orgId}`;
    await setDestination(sql, z, z.fpA);
    await salesDay(sql, z, z.storeA, z.fpA, '2026-10-12', '0.00', { verified: true, noSales: true });
    // T-511 S7a: a confirmed zero is still not an "unverified" day, but it holds no journal entry, so the file figure has nothing to replace: the one new blocker, in the spec's words.
    expect(await codes(z, z.managerA, z.fpA, '2026-10-12')).toEqual(['sales_day_not_posted']);
  });

  it('no destination account on the channel (the T-150 sentence) [kills: a missing account found only at posting]', async () => {
    const w = await world3(sql, 'blk-nodest');
    await stageFp(w, '2026-10-12');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w.orgId}`;
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '1000.00', { verified: true });
    const r = await blockersAt(w, w.managerA, w.fpA, '2026-10-12');
    expect(r.blockers.map((b) => b.code)).toEqual(['no_destination_account']);
    expect(r.blockers[0]!.sentence).toMatch(/no destination account/i);
  });

  it('negative net deposit [kills: fees above the payout let through]', async () => {
    const { w, line } = await cleanDay('blk-negative');
    await sql`update settlement_day_lines set net_payout = '-5.00' where id = ${line.id}`;
    const r = await blockersAt(w, w.managerA, w.fpA, '2026-10-12');
    expect(r.blockers.map((b) => b.code)).toEqual(['negative_net_deposit']);
    expect(r.blockers[0]!.sentence).toMatch(/negative deposit/i);
  });

  it('a posted settlement already exists for the channel and day (the T-150 sentence) [kills: a second settlement for the same day]', async () => {
    const { w, salesDayId } = await cleanDay('blk-posted');
    await postedSettlementRaw(sql, w, { channelId: w.fpA, storeId: w.storeA, salesDayId, date: '2026-10-12' });
    const r = await blockersAt(w, w.managerA, w.fpA, '2026-10-12');
    expect(r.blockers.map((b) => b.code)).toEqual(['posted_settlement_exists']);
    expect(r.blockers[0]!.sentence).toMatch(/already has a posted settlement/i);
  });

  it('a gap between the file and staff (file 1,000.00, staff 850.00) is NOT a blocker: the correction handles it, not the hold [kills: the preview\'s variance or gain refusal leaking in]', async () => {
    const w = await world3(sql, 'blk-gap');
    await stageFp(w, '2026-10-12');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w.orgId}`;
    await setDestination(sql, w, w.fpA);
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '850.00', { verified: true });
    expect(await codes(w, w.managerA, w.fpA, '2026-10-12')).toEqual([]);
  });
});

describe('T-511 S5b dayBlockers - a closed period is not a blocker', () => {
  it('October closed: no blocker, willPostOn = the first open date on or after the sales day (1 Nov), and the note says so; locked is the same [kills: a closed period blocking; no note]', async () => {
    const { w } = await cleanDay('blk-closed', { periods: false });
    await closedPeriod(sql, w, '2026-10-01', '2026-10-31');
    const r = await blockersAt(w, w.managerA, w.fpA, '2026-10-12');
    expect(r.blockers).toEqual([]);
    expect(r.willPostOn).toBe('2026-11-01');
    expect(r.postNote).toMatch(/will post on/i);
    expect(r.postNote).toMatch(/2026-11-01|1 Nov/i);
    const l = await cleanDay('blk-locked', { periods: false });
    await closedPeriod(sql, l.w, '2026-10-01', '2026-10-31', 'locked');
    expect((await blockersAt(l.w, l.w.managerA, l.w.fpA, '2026-10-12')).willPostOn).toBe('2026-11-01');
  });

  it('an open month: willPostOn and postNote are null [kills: a note on every day]', async () => {
    const { w } = await cleanDay('blk-open-period');
    const r = await blockersAt(w, w.managerA, w.fpA, '2026-10-12');
    expect([r.willPostOn, r.postNote]).toEqual([null, null]);
  });
});

describe('T-511 S5b dayBlockers - earlier days of the same channel', () => {
  /** Days 12 and 14 staged and otherwise green; 13 has no line. */
  async function twoDays(hint: string, staffRecordedThe13th: boolean) {
    const w = await world3(sql, hint);
    await stageFp(w, '2026-10-12');
    await stageFp(w, '2026-10-14');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w.orgId}`;
    await setDestination(sql, w, w.fpA);
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '1000.00', { verified: true });
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-14', '1000.00', { verified: true });
    if (staffRecordedThe13th) await salesDay(sql, w, w.storeA, w.fpA, '2026-10-13', '300.00', { verified: true });
    return w;
  }

  it('the first staged day has no earlier day; the next day is blocked while the first is neither booked nor rejected, and the sentence says "earlier day" [kills: no ordering rule; the first day blocking itself]', async () => {
    const w = await world3(sql, 'blk-earlier');
    await stageFp(w, '2026-10-12');
    await stageFp(w, '2026-10-13');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w.orgId}`;
    await setDestination(sql, w, w.fpA);
    for (const d of ['2026-10-12', '2026-10-13']) await salesDay(sql, w, w.storeA, w.fpA, d, '1000.00', { verified: true });
    expect(await codes(w, w.managerA, w.fpA, '2026-10-12')).toEqual([]);
    const r = await blockersAt(w, w.managerA, w.fpA, '2026-10-13');
    expect(r.blockers.map((b) => b.code)).toEqual(['earlier_day_open']);
    expect(r.blockers[0]!.sentence).toMatch(/earlier day/i);
    expect(r.blockers[0]!.sentence).not.toMatch(UUID_RE);
  });

  it('rejecting the earlier day clears it; booking it clears it too [kills: a decided day still blocking]', async () => {
    const w = await world3(sql, 'blk-earlier-cleared');
    await stageFp(w, '2026-10-12');
    await stageFp(w, '2026-10-13');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w.orgId}`;
    await setDestination(sql, w, w.fpA);
    for (const d of ['2026-10-12', '2026-10-13']) await salesDay(sql, w, w.storeA, w.fpA, d, '1000.00', { verified: true });
    const first = await lineOn(sql, w.orgId, w.fpA, '2026-10-12');
    await asOrg(w.orgId, (tx) => rejectDay(tx, w.managerA, { lineId: first.id, reason: 'Checked, not ours' }));
    expect(await codes(w, w.managerA, w.fpA, '2026-10-13')).toEqual([]);
    const w2 = await world3(sql, 'blk-earlier-booked');
    await stageFp(w2, '2026-10-12');
    await stageFp(w2, '2026-10-13');
    await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w2.orgId}`;
    await setDestination(sql, w2, w2.fpA);
    for (const d of ['2026-10-12', '2026-10-13']) await salesDay(sql, w2, w2.storeA, w2.fpA, d, '1000.00', { verified: true });
    await bookLine(sql, w2, (await lineOn(sql, w2.orgId, w2.fpA, '2026-10-12')).id);
    expect(await codes(w2, w2.managerA, w2.fpA, '2026-10-13')).toEqual([]);
  });

  it('an earlier date with NO line blocks the later day only when staff recorded sales that day [kills: every gap blocking; a recorded day ignored]', async () => {
    const withSales = await twoDays('blk-gap-sales', true);
    await sql`update settlement_day_lines set review_state = 'rejected', decision_reason = 'x', decided_by = ${withSales.admin.personId}, decided_at = now() where org_id = ${withSales.orgId} and sales_date = '2026-10-12'`;
    expect(await codes(withSales, withSales.managerA, withSales.fpA, '2026-10-14')).toEqual(['earlier_day_open']);
    const without = await twoDays('blk-gap-none', false);
    await sql`update settlement_day_lines set review_state = 'rejected', decision_reason = 'x', decided_by = ${without.admin.personId}, decided_at = now() where org_id = ${without.orgId} and sales_date = '2026-10-12'`;
    expect(await codes(without, without.managerA, without.fpA, '2026-10-14')).toEqual([]);
  });
});

describe('T-511 S5b dayBlockers - the line is not the current version', () => {
  it('a line replaced by a newer file is flagged (read from the table by id, not from the object passed in); the newer line is not [kills: trusting a stale object]', async () => {
    const w = await world3(sql, 'blk-stale');
    await stageFp(w, '2026-10-12', 1000);
    const v1 = await lineOn(sql, w.orgId, w.fpA, '2026-10-12');
    const staleObject = await asOrg(w.orgId, (tx) => lineById(tx, v1.id));
    expect(staleObject.isCurrent).toBe(true);
    await stageFp(w, '2026-10-12', 1100);
    const asked = await asOrg(w.orgId, (tx) => dayBlockers(tx, w.managerA, staleObject, { today: TODAY }));
    expect(asked.blockers.map((b) => b.code)).toContain('line_not_current');
    expect(asked.blockers.find((b) => b.code === 'line_not_current')!.sentence).toMatch(/newer/i);
    expect((await codes(w, w.managerA, w.fpA, '2026-10-12'))).not.toContain('line_not_current');
  });
});

/* ================================================================== Grab: the loan check inside the blockers, privacy, and the documented order */

describe('T-511 S5b dayBlockers - the loan check as a blocker (Grab only)', () => {
  it('Lipa 13 Oct with no loan recorded in the system: blocked by "no matching loan recorded"; Foodpanda is never asked [kills: Grab days passing with no loan; a loan check on Foodpanda]', async () => {
    const w = await world3(sql, 'blk-loan-none');
    await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, w.managerA, 'lipa');
    const r = await blockersAt(w, w.admin, w.grabA, '2026-10-13');
    const loan = r.blockers.find((b) => b.code === 'loan_check');
    expect(loan?.sentence).toMatch(/no matching loan recorded/i);
    const fp = await cleanDay('blk-loan-fp');
    expect((await codes(fp.w, fp.w.admin, fp.w.fpA, '2026-10-12'))).not.toContain('loan_check');
  });

  it('all three stores\' October files in and both loans recorded: 14 Oct (Lipa 509.12 + 208.50, Malvar 238.50, Banay 1,024.26 + 382.74 = 2,363.12) passes the loan check, split row and all [kills: a company sum that stops at one store]', async () => {
    const w = await world3(sql, 'blk-loan-ok');
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    for (const date of ['2026-10-14', '2026-10-16', '2026-10-20']) {
      expect((await codes(w, w.admin, w.grabA, date)), `Lipa ${date}`).not.toContain('loan_check');
    }
    expect((await codes(w, w.admin, w.grabB, '2026-10-14')), 'Malvar 14 Oct').not.toContain('loan_check');
    expect((await codes(w, w.admin, w.grabC, '2026-10-14')), 'Banay 14 Oct').not.toContain('loan_check');
  });

  it('a loan repayment amount that is wrong by one centavo on an ordinary day: "loan amounts don\'t match", blocking [kills: tolerance on every day]', async () => {
    const w = await world3(sql, 'blk-loan-mismatch');
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.89' });
    const r = await blockersAt(w, w.admin, w.grabA, '2026-10-20');
    expect(r.blockers.find((b) => b.code === 'loan_check')?.sentence).toMatch(/loan amounts (don't|do not) match/i);
  });

  it('an admin override feeds the check: pinning all of Lipa 13 Oct deductions (1,821.75) to the first loan makes that loan over its 591.24, so the day no longer matches [kills: the override stored but never read by the check]', async () => {
    const w = await world3(sql, 'blk-loan-override');
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    const l1 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    expect(await codes(w, w.admin, w.grabA, '2026-10-13')).not.toContain('loan_check');
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-13');
    await asOrg(w.orgId, (tx) => overrideLoanAllocation(tx, w.admin, { lineId: line.id, allocations: [{ loanId: l1, amount: '1821.75' }] }));
    const after = (await blockersAt(w, w.admin, w.grabA, '2026-10-13')).blockers.find((b) => b.code === 'loan_check');
    expect(after?.sentence).toMatch(/loan amounts (don't|do not) match/i);
  });

  it('waiting for another store\'s file: Malvar\'s 13 Oct line retired, so Lipa 13 Oct waits. The ADMIN\'s sentence names Malvar; the MANAGER of Lipa\'s says only "waiting for other stores\' files" and no store name [kills: another store named to a manager]', async () => {
    const w = await world3(sql, 'blk-loan-wait');
    for (const [who, store] of [[w.managerA, 'lipa'], [w.managerB, 'malvar'], [w.managerC, 'banay']] as const) await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, who, store);
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    await sql`update settlement_day_lines set is_current = false where org_id = ${w.orgId} and channel_id = ${w.grabB} and sales_date = '2026-10-13'`;
    // test edit (builder 3, 5 Nov 2026, BOSS fix 2): Lipa waits for Malvar only if Malvar recorded Grab sales that day (a store with no sales day was closed and is never waited on)
    await salesDay(sql, w, w.storeB, w.grabB, '2026-10-13', '1200.00', { verified: true });
    const asManager =(await blockersAt(w, w.managerA, w.grabA, '2026-10-13')).blockers.find((b) => b.code === 'loan_check');
    expect(asManager?.sentence).toMatch(/waiting for other stores['’] files/i);
    expect(asManager?.sentence).not.toMatch(/Malvar|Banay/);
    expect(asManager?.sentence).not.toMatch(UUID_RE);
    const asAdmin = (await blockersAt(w, w.admin, w.grabA, '2026-10-13')).blockers.find((b) => b.code === 'loan_check');
    expect(asAdmin?.sentence).toMatch(/waiting for other stores['’] files/i);
    expect(asAdmin?.sentence).toContain('Malvar');
  });
});

describe('T-511 S5b dayBlockers - the documented order, every blocker at once', () => {
  it('Lipa 13 Oct broken everywhere gives the blockers in the documented order, each with its own sentence, none with an id or a raw code [kills: a re-ordered list; a missing blocker]', async () => {
    const w = await world3(sql, 'blk-order');
    await stageGrabOctober((x, y, z) => ingest(x as World3, y, z), w, w.managerA, 'lipa');
    const v1 = await lineOn(sql, w.orgId, w.grabA, '2026-10-13');
    const old = await asOrg(w.orgId, (tx) => lineById(tx, v1.id)); // the object a screen would hold
    // v1 broken on the line itself, then replaced by a v2 (a copy with its loan lines) so v1 is "not the current version"
    await sql`update settlement_day_lines set paid_state = 'not_paid', unexplained = '5.00', net_payout = '-5.00', is_current = false where id = ${v1.id}`;
    const [v2] = await sql<{ id: string }[]>`
      insert into settlement_day_lines (org_id, channel_id, store_id, platform, sales_date, version, source_upload_id, order_value, gross_info, commission, marketing, platform_fee,
        vendor_discount, loan_deduction, loan_disbursal, net_payout, paid_state)
      select org_id, channel_id, store_id, platform, sales_date, 2, source_upload_id, order_value, gross_info, commission, marketing, platform_fee,
        vendor_discount, loan_deduction, loan_disbursal, net_payout, 'not_paid' from settlement_day_lines where id = ${v1.id} returning id`;
    await sql`
      insert into settlement_loan_lines (org_id, day_line_id, kind, amount, row_ordinal)
      select org_id, ${v2!.id}, kind, amount, row_ordinal from settlement_loan_lines where day_line_id = ${v1.id}`;
    await sql`update sales_channels set platform = null, platform_store_code = null where id = ${w.grabA}`; // store not matched
    const sdId = await salesDay(sql, w, w.storeA, w.grabA, '2026-10-13', '100.00', { verified: false }); // sales day not verified
    await postedSettlementRaw(sql, w, { channelId: w.grabA, storeId: w.storeA, salesDayId: sdId, date: '2026-10-13' }); // a posted settlement exists
    // no destination account (never set), no loan recorded (the loan check blocks), 12 Oct still pending (an earlier day is open)
    const r = await asOrg(w.orgId, (tx) => dayBlockers(tx, w.admin, old, { today: TODAY }));
    const documented = [
      'not_paid', 'charges_unexplained', 'store_not_matched', 'sales_day_not_verified', 'loan_check', 'loan_leg_problem', 'no_destination_account', 'negative_net_deposit',
      'posted_settlement_exists', 'earlier_day_open', 'line_not_current',
    ];
    expect(r.blockers.map((b) => b.code), 'every blocker that applies, in the documented order (no_file does not apply: a line exists)').toEqual(documented);
    for (const b of r.blockers) {
      expect(b.sentence.length).toBeGreaterThan(10);
      expect(b.sentence).not.toMatch(UUID_RE);
      expect(b.sentence).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });

  it('no_file comes first when it applies: a day with no line, recorded sales, and a destination missing still lists no_file before anything else [kills: no_file buried]', async () => {
    const w = await world3(sql, 'blk-order-nofile');
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '700.00', { verified: true });
    const r = await asOrg(w.orgId, (tx) => dayBlockers(tx, w.managerA, { channelId: w.fpA, salesDate: '2026-10-12' }, { today: TODAY }));
    expect(r.blockers.map((b) => b.code)[0]).toBe('no_file');
  });
});
