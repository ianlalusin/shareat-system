import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S7a (TESTER, 8 Nov 2026) - `approveDay`: one person approves one staged settlement day and the books move, in ONE transaction. Real Postgres, real ingest, real posting.
 * docs/tasks/511-settlement-upload-s7-spec.md (Rulings 1-9 and the two worked examples are binding); design Components F and G.
 *
 * RED TODAY, for one reason: `approveDay` does not exist (`D.approveDay is not a function`) and the new blocker codes are not produced. Each test fails for its own reason.
 *
 * NAMES AND SHAPES PINNED (the builder meets these or asks BOSS to change the tests; the spec leaves each open):
 *  A1  `approveDay(tx, actor, { lineId, differenceReason? })` on the `@shareat/domain` barrel -> `{ settlementId, correctionId: string | null, chargeIds: string[], postedOn }`.
 *      `correctionId` is null when no correction was posted by THIS call (file figure already equals the booked figure). `postedOn` is the date the settlement was booked on.
 *  A2  THE CLOCK: there is no clock seam. The one clock is the transaction's Manila date (`manilaToday(tx)`). These tests therefore use sales dates in October 2026 and
 *      periods Oct/Nov 2026, which behave the same on any real date from 1 Nov 2026 on. A closed October gives `postedOn` 2026-11-01 whatever the real date is (>= 1 Nov).
 *  A3  The typed refusal for the reason case is a `SettlementIntakeRefusal` (barrel) with `code === 'NEEDS_REASON'` and the two facts as own properties:
 *      `difference` (the ABSOLUTE difference, '3000.00') and `sign` ('short' | 'over'). Its sentence is plain words.
 *  A4  A refusal for a blocked day carries the FIRST blocker's sentence (the one the screen shows first) verbatim, in `userMessage` (it may carry more).
 *  A5  The uploader refusal: a plain sentence that says the person uploaded the file ("upload"), names no store and no id; not an AuthorizationError message about
 *      permissions. An admin (`override_period_lock`) is exempt. A person of ANOTHER store is refused by scope, in words that name no store at all.
 *  A6  Audit `settlement_day.approved`: entity = the staged line, store scope, actor = approver, source 'web'; the payload holds (anywhere, key names are free) the settlement id,
 *      the correction id, both upload ids of the line, the reader version, and whether a difference reason was given (a boolean under a key with "reason" in it);
 *      the TEXT of the reason is NOT in the audit payload.
 *
 * SPEC DISCREPANCY (reported, not decided): the spec's negative control says the skipped correction "books 6420 1,000 silently and leaves 1,000 on 1220". The code says
 * otherwise: owed 10,000, cleared 10,000, difference = 10,000 - (2,300 + 500 + 8,200) = -1,000, i.e. the payout EXCEEDS the day, which is a GAIN (Cr 7100 1,000) and leaves
 * 1220 at 0. Test (i) pins what the code does; the lesson (an order-skipping approve books staff's mistake as income) is the same.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

/** Flips a failure into the settlement step; records how many corrections the SAME transaction held at that moment (proof the correction ran first). */
const failure = vi.hoisted(() => ({ on: false, correctionsInTx: null as number | null }));
vi.mock('../../src/channel-settlements', async (original) => {
  const actual = await original<typeof import('../../src/channel-settlements')>();
  return {
    ...actual,
    recordChannelSettlement: async (...args: Parameters<typeof actual.recordChannelSettlement>) => {
      if (failure.on) {
        const { sql: dsql } = await import('drizzle-orm');
        const rows = (await args[0].execute(dsql`select count(*)::int as n from sales_day_platform_corrections`)) as unknown as { n: number }[];
        failure.correctionsInTx = rows[0]!.n;
        throw new Error('forced settlement failure');
      }
      return actual.recordChannelSettlement(...args);
    },
  };
});

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { loanLegsForLine } from '../../src/settlement-intake/settlement-input';
import { READER_VERSION } from '../../src/settlement-intake/version';
import {
  D1, D2, D3, GRAB_DAY, NEXT_OPEN, aggText, approve, asOrg, auditRows, blockersOf, chargeLinks, correctionCount, correctionEntryId, corrections, entriesOf, entryCount, entryOf,
  fpInvoice, fpWeek, grabWorld, ingest, leaves, lineFull, linesOf, lineText, mkLoan, netDebit, postCharge, s7World, salesDay, sentenceOf, settlementFull, settlementsOf,
  setDestination, stageFpOne, zip,
} from './_fixtures/t511-s7a-world';

const sql = postgres(url, { max: 10 });
beforeEach(() => {
  setStorageDriver(inMemoryDriver());
  failure.on = false;
  failure.correctionsInTx = null;
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STORE_NAMES = /Lipa|Malvar|Banay/i;
const sorted = (xs: string[]): string[] => [...xs].sort();
const controls = async (orgId: string) => ({
  c1220: await netDebit(sql, orgId, '1220'), c4150: await netDebit(sql, orgId, '4150'), c6400: await netDebit(sql, orgId, '6400'), c6420: await netDebit(sql, orgId, '6420'),
  c7100: await netDebit(sql, orgId, '7100'),
});
/** What a refused approve must leave behind: nothing. */
async function snapshot(orgId: string, lineIds: string[] = []) {
  return { entries: await entryCount(sql, orgId), corrections: await correctionCount(sql, orgId), settlements: (await settlementsOf(sql, orgId)).length, states: await Promise.all(lineIds.map(async (id) => (await lineFull(sql, id)).review_state)) };
}

/* ================================================================== (a) worked example 1: a Grab day, the correction first */

describe('S7a (a) worked example 1 - a Grab day: the correction first, then the settlement, to the centavo', () => {
  it('staff 10,000.00, file 11,000.00, commission 2,200.00, platform fee 100.00, loan 500.00, payout 8,200.00: Dr 1220 1,000 / Cr 4150 1,000, then Dr 1140 8,200, Dr 6400 2,300, Dr 2400 500 / Cr 1220 11,000; difference 0, no acknowledgement; the line ends booked [kills: no correction (a silent 7100); a settlement that clears the staff figure; fees to the wrong account; an acknowledgement asked of a clean day; a line left pending]', async () => {
    const g = await grabWorld(sql, 'ex1');
    const w = g.w;
    expect((await blockersOf(w, w.managerA2, g.lineId)).blockers, 'control: nothing blocks the day').toEqual([]);
    expect(await netDebit(sql, w.orgId, '1220'), 'control: 1220 holds what staff recorded').toBe('10000.00');
    const [staged] = await sql<Record<string, string>[]>`select order_value::text, commission::text, platform_fee::text, loan_deduction::text, net_payout::text, unexplained::text from settlement_day_lines where id = ${g.lineId}`;
    expect([staged!.order_value, staged!.commission, staged!.platform_fee, staged!.loan_deduction, staged!.net_payout, staged!.unexplained], 'control: the staged figures of the worked example').toEqual(['11000.00', '2200.00', '100.00', '500.00', '8200.00', '0.00']);

    const r = await approve(w, w.managerA2, g.lineId);
    expect(typeof r.correctionId, 'the correction was posted by this call').toBe('string');
    expect(r.chargeIds).toEqual([]);
    expect(r.postedOn).toBe(GRAB_DAY);

    const corr = (await corrections(sql, w.orgId))[0]!;
    expect(corr.id).toBe(r.correctionId);
    expect([corr.from_amount, corr.to_amount, corr.entry_date]).toEqual(['10000.00', '11000.00', GRAB_DAY]);
    const corrEntry = await correctionEntryId(sql, r.correctionId!);
    expect(lineText(await linesOf(sql, corrEntry))).toEqual(['Cr 4150 1000.00', 'Dr 1220 1000.00']);

    const s = await settlementFull(sql, r.settlementId);
    expect(s.status).toBe('posted');
    expect([s.gross_amount, s.outstanding_cleared, s.net_deposited, s.variance, s.settlement_gain, s.difference_reason]).toEqual(['11000.00', '11000.00', '8200.00', '0.00', '0.00', null]);
    expect(s.reference, 'the reference is the Grab payout id').toBe(g.payoutId);
    expect(s.settled_on).toBe(GRAB_DAY);
    expect(await aggText(sql, s.journal_entry_id!)).toEqual(sorted(['Dr 1140 8200.00', 'Dr 6400 2300.00', 'Dr 2400 500.00', 'Cr 1220 11000.00']));
    expect(await controls(w.orgId)).toEqual({ c1220: '0.00', c4150: '-11000.00', c6400: '2300.00', c6420: '0.00', c7100: '0.00' });

    const line = await lineFull(sql, g.lineId);
    expect([line.review_state, line.decided_by, line.settlement_id]).toEqual(['booked', w.managerA2.personId, r.settlementId]);
    expect(line.decided_at).toBeInstanceOf(Date);
  });
});

/* ================================================================== (b) worked example 2: a Foodpanda week, a period charge, a carrier day */

describe('S7a (b) worked example 2 - a Foodpanda week with a period charge: the carrier day nets it once', () => {
  it('D1 and D2 approve as plain days; D3 (the latest day of the upload) is the carrier: it is blocked until the 112.00 charge is booked, then books 7,888.00 with settleChargeIds; the bank totals 21,488.00 and 6400 holds the charge once [kills: the charge expensed twice (6420 112); a carrier that is not the latest day; the charge netted at D1; the bank total off by the charge; a D3 allowed before the charge is booked]', async () => {
    const f = await fpWeek(sql, 'ex2', { charge: true });
    const w = f.w;
    expect(f.chargeLineId, 'control: the invoice carries one unrecognised charge as a period charge').not.toBeNull();
    const codes = async (d: string) => (await blockersOf(w, w.managerA2, f.lines[d]!)).blockers.map((b) => b.code);
    expect(await codes(D1), 'D1 is not the carrier: the unbooked charge does not hold it').not.toContain('period_charge_unbooked');
    expect(await codes(D2)).not.toContain('period_charge_unbooked');

    const r1 = await approve(w, w.managerA2, f.lines[D1]!);
    const r2 = await approve(w, w.managerA2, f.lines[D2]!);
    expect([r1.correctionId, r1.chargeIds, r2.correctionId, r2.chargeIds], 'staff recorded exactly the file figure: no correction, no charge').toEqual([null, [], null, []]);

    expect(await codes(D3), 'the carrier is held while its upload has a charge staged but not booked').toContain('period_charge_unbooked');
    const before = await snapshot(w.orgId, [f.lines[D3]!]);
    const held = await sentenceOf(approve(w, w.managerA2, f.lines[D3]!));
    expect(held).not.toMatch(UUID_ANY);
    expect(await snapshot(w.orgId, [f.lines[D3]!]), 'a refused carrier leaves nothing behind').toEqual(before);

    const c = await postCharge(w, w.admin, f.chargeLineId!);
    expect(c.posted).toBe(true);
    expect(lineText(await linesOf(sql, c.journalEntryId!))).toEqual(['Cr 1220 112.00', 'Dr 6400 112.00']);
    expect(await codes(D3), 'booked: the carrier is free').not.toContain('period_charge_unbooked');

    const r3 = await approve(w, w.managerA2, f.lines[D3]!);
    expect(r3.chargeIds).toEqual([c.chargeId]);
    const s = [await settlementFull(sql, r1.settlementId), await settlementFull(sql, r2.settlementId), await settlementFull(sql, r3.settlementId)];
    expect(s.map((x) => x.reference), 'every day of the invoice carries the invoice number').toEqual(['200777000001', '200777000001', '200777000001']);
    expect(await aggText(sql, s[0]!.journal_entry_id!)).toEqual(sorted(['Dr 1140 7200.00', 'Dr 6400 1800.00', 'Cr 1220 9000.00']));
    expect(await aggText(sql, s[1]!.journal_entry_id!)).toEqual(sorted(['Dr 1140 6400.00', 'Dr 6400 1600.00', 'Cr 1220 8000.00']));
    expect(await aggText(sql, s[2]!.journal_entry_id!)).toEqual(sorted(['Dr 1140 7888.00', 'Dr 6400 2000.00', 'Cr 1220 9888.00']));
    expect(s.map((x) => [x.net_deposited, x.variance, x.settlement_gain, x.difference_reason])).toEqual([['7200.00', '0.00', '0.00', null], ['6400.00', '0.00', '0.00', null], ['7888.00', '0.00', '0.00', null]]);
    expect(await netDebit(sql, w.orgId, '1140'), 'the bank total is the invoice total').toBe('21488.00');
    expect(await controls(w.orgId)).toEqual({ c1220: '0.00', c4150: '-27000.00', c6400: '5512.00', c6420: '0.00', c7100: '0.00' });
    expect(await chargeLinks(sql, w.orgId)).toEqual([{ settlement_id: r3.settlementId, charge_id: c.chargeId }]);
  });

  it('the carrier is the latest-dated CURRENT line of the upload even when it is rejected: then the charge stays a 1220 credit and D1 and D2 book plain [kills: the carrier moving to the latest decided day; the charge netted into D2]', async () => {
    const f = await fpWeek(sql, 'ex2-rej', { charge: true });
    const w = f.w;
    const c = await postCharge(w, w.admin, f.chargeLineId!);
    await asOrg(w.orgId, (tx) => D.rejectDay(tx, w.managerA2, { lineId: f.lines[D3]!, reason: 'The platform will reissue the last day.' }));
    const r1 = await approve(w, w.managerA2, f.lines[D1]!);
    const r2 = await approve(w, w.managerA2, f.lines[D2]!);
    expect([r1.chargeIds, r2.chargeIds]).toEqual([[], []]);
    expect((await settlementFull(sql, r2.settlementId)).net_deposited, 'D2 is not the carrier: its net is not reduced').toBe('6400.00');
    expect(await chargeLinks(sql, w.orgId), 'the charge is netted by nobody').toEqual([]);
    expect(await netDebit(sql, w.orgId, '1220'), 'D3 owed 10,000 less the 112 credit').toBe('9888.00');
    expect(c.posted).toBe(true);
  });
});

/* ================================================================== (c) the reason case */

describe('S7a (c) a difference past tolerance needs the approver\'s typed reason, and a refused approve leaves NOTHING', () => {
  /** Staff 8,000 vs file 9,000 (a correction of +1,000 will be posted), and 3,000 already received by hand: after the correction 1220 holds 6,000, the payout exceeds the day by 3,000. */
  async function reasonWorld(hint: string) {
    const f = await fpWeek(sql, hint, { staff: ['8000.00', '', ''] });
    const w = f.w;
    await asOrg(w.orgId, (tx) =>
      postEntry(tx, {
        orgId: w.orgId, entryDate: '2026-10-13', sourceType: 'manual_journal', sourceId: crypto.randomUUID(), idempotencyKey: `s7a-receipt:${crypto.randomUUID()}`, memo: 'Paid by hand', postedBy: w.admin.personId,
        lines: [
          { accountCode: '1130', storeId: w.storeA, debit: '3000.00' },
          { accountCode: '1220', storeId: w.storeA, credit: '3000.00', partyType: 'channel', partyId: w.fpA },
        ],
      }),
    );
    return { f, w, lineId: f.lines[D1]! };
  }

  it('no reason: the typed refusal NEEDS_REASON { difference 3000.00, sign over }, and the WHOLE transaction rolled back: no correction row, no settlement, no entry, no audit row, the line still pending [kills: a correction left behind by the refusal; a silent 7100; a refusal with no figures; a line marked booked]', async () => {
    const { w, lineId } = await reasonWorld('reason-none');
    const before = await snapshot(w.orgId, [lineId]);
    const err = await approve(w, w.managerA2, lineId).then(() => null, (e: unknown) => e);
    expect(err, 'the approve must refuse').toBeInstanceOf(D.SettlementIntakeRefusal);
    const e = err as D.SettlementIntakeRefusal & { difference?: string; sign?: string };
    expect(e.code).toBe('NEEDS_REASON');
    expect([e.difference, e.sign]).toEqual(['3000.00', 'over']);
    expect(String(e.userMessage)).not.toMatch(UUID_ANY);
    expect(await snapshot(w.orgId, [lineId]), 'nothing at all was written').toEqual(before);
    expect(await correctionCount(sql, w.orgId), 'the correction that ran first was rolled back').toBe(0);
    expect((await auditRows(sql, w.orgId, 'settlement_day.approved')).length).toBe(0);
    expect((await auditRows(sql, w.orgId, 'platform_sales.corrected')).length, 'no audit row of the rolled-back correction').toBe(0);
  });

  it('a blank reason (spaces) is no reason; a reason over 500 characters is refused in words; both leave nothing behind [kills: whitespace accepted as a reason; an over-long reason truncated or stored]', async () => {
    const { w, lineId } = await reasonWorld('reason-bad');
    const before = await snapshot(w.orgId, [lineId]);
    const blank = await approve(w, w.managerA2, lineId, '   ').then(() => null, (e: unknown) => e);
    expect(blank).toBeInstanceOf(D.SettlementIntakeRefusal);
    expect((blank as { code?: string }).code).toBe('NEEDS_REASON');
    const long = await sentenceOf(approve(w, w.managerA2, lineId, 'x'.repeat(501), '3000.00'));
    expect(long).toMatch(/reason/i);
    expect(long).not.toMatch(UUID_ANY);
    expect(await snapshot(w.orgId, [lineId])).toEqual(before);
  });

  it('with a reason: it books, the trimmed reason is stored on the settlement, the gain is booked to 7100, and the audit row says a reason was given WITHOUT storing its text [kills: the reason dropped; stored untrimmed; the gain booked to 6420; the reason text copied into the audit payload]', async () => {
    const { w, lineId } = await reasonWorld('reason-yes');
    const reason = 'Customer paid us directly on 12 Oct';
    // ruling 5 (fixer): the reason is bound to the difference the approver saw, so the screen sends that figure back with the reason
    const r = await approve(w, w.managerA2, lineId, `  ${reason}  `, '3000.00');
    const s = await settlementFull(sql, r.settlementId);
    expect([s.difference_reason, s.settlement_gain, s.variance, s.outstanding_cleared]).toEqual([reason, '3000.00', '0.00', '6000.00']);
    expect(await aggText(sql, s.journal_entry_id!)).toEqual(sorted(['Dr 1140 7200.00', 'Dr 6400 1800.00', 'Cr 1220 6000.00', 'Cr 7100 3000.00']));
    expect(typeof r.correctionId).toBe('string');
    const [row] = await auditRows(sql, w.orgId, 'settlement_day.approved');
    expect(JSON.stringify(row!.after), 'the text of the reason is not audited').not.toContain(reason);
    const flags = Object.entries(row!.after ?? {}).filter(([k]) => /reason/i.test(k));
    expect(flags.length, 'a key with "reason" in it says whether one was given').toBeGreaterThan(0);
    expect(flags.every(([, v]) => v === true)).toBe(true);
  });

  it('a reason given when none is needed is ignored: nothing stored (the day is within tolerance) [kills: a typed reason stored on a clean day]', async () => {
    const f = await fpWeek(sql, 'reason-unneeded');
    const r = await approve(f.w, f.w.managerA2, f.lines[D1]!, 'not needed here');
    expect((await settlementFull(sql, r.settlementId)).difference_reason).toBeNull();
    const [row] = await auditRows(sql, f.w.orgId, 'settlement_day.approved');
    const flags = Object.entries(row!.after ?? {}).filter(([k]) => /reason/i.test(k));
    expect(flags.every(([, v]) => v === false || v === null), 'no reason was stored, so none is reported').toBe(true);
  });
});

/* ================================================================== (d) who may approve */

describe('S7a (d) who may approve: the uploader rule, the admin exemption, the store scope', () => {
  it('Grab: the person who uploaded the SOURCE file and the person who uploaded the PAYOUT file are each refused in plain words naming no store; a third manager of the store may approve; a manager of another store is refused by scope in words that name no store; a staff member holds no permission [kills: only one of the two uploads checked; a store named in the refusal; the uploader allowed; scope ignored]', async () => {
    const g = await grabWorld(sql, 'upl', { txBy: 'managerA', trBy: 'managerA2' });
    const w = g.w;
    const before = await snapshot(w.orgId, [g.lineId]);
    const line = await lineFull(sql, g.lineId);
    expect(line.payout_upload_id, 'control: a Grab line has a payout upload besides its source upload').not.toBeNull();
    expect(line.payout_upload_id).not.toBe(line.source_upload_id);

    for (const [who, label] of [[w.managerA, 'source uploader'], [w.managerA2, 'payout uploader']] as const) {
      const s = await sentenceOf(approve(w, who, g.lineId));
      expect(s, label).toMatch(/upload/i);
      expect(s, label).not.toMatch(STORE_NAMES);
      expect(s, label).not.toMatch(UUID_ANY);
    }
    const other = await sentenceOf(approve(w, w.managerB, g.lineId));
    expect(other, 'a manager of another store learns nothing about this one').not.toMatch(STORE_NAMES);
    expect(other).not.toMatch(UUID_ANY);
    await sentenceOf(approve(w, w.staff, g.lineId));
    expect(await snapshot(w.orgId, [g.lineId]), 'every refusal left nothing behind').toEqual(before);

    const r = await approve(w, w.managerA3, g.lineId);
    expect((await lineFull(sql, g.lineId)).decided_by, 'a different manager of the same store approved').toBe(w.managerA3.personId);
    expect(r.settlementId).toBeTruthy();
  });

  it('Foodpanda: the manager who uploaded the invoice is refused; a different manager approves [kills: the Foodpanda upload not checked]', async () => {
    const f = await fpWeek(sql, 'upl-fp');
    const w = f.w;
    const before = await snapshot(w.orgId, [f.lines[D1]!]);
    expect(await sentenceOf(approve(w, w.managerA, f.lines[D1]!))).toMatch(/upload/i);
    expect(await snapshot(w.orgId, [f.lines[D1]!])).toEqual(before);
    expect((await approve(w, w.managerA2, f.lines[D1]!)).settlementId).toBeTruthy();
  });

  it('an administrator may approve a day they uploaded themselves (the accepted one-admin default) [kills: the admin held to the rule; the exemption tested by role name instead of override_period_lock]', async () => {
    const g = await grabWorld(sql, 'upl-admin', { txBy: 'admin', trBy: 'admin' });
    const r = await approve(g.w, g.w.admin, g.lineId);
    expect((await lineFull(sql, g.lineId)).decided_by).toBe(g.w.admin.personId);
    expect(r.postedOn).toBe(GRAB_DAY);
  });
});

/* ================================================================== (e) once, and only once */

describe('S7a (e) double and concurrent approve: exactly one books', () => {
  it('a second approve of the same day is refused in words and posts nothing more [kills: a second settlement; a second correction; a silent no-op that hides the refusal]', async () => {
    const g = await grabWorld(sql, 'dbl');
    const w = g.w;
    await approve(w, w.managerA2, g.lineId);
    const before = await snapshot(w.orgId, [g.lineId]);
    const s = await sentenceOf(approve(w, w.managerA3, g.lineId));
    expect(s).toMatch(/already|decided|booked/i);
    expect(s).not.toMatch(UUID_ANY);
    expect(await snapshot(w.orgId, [g.lineId])).toEqual(before);
    expect(before.settlements).toBe(1);
  });

  it('two approvals racing on one day (two transactions): exactly one wins; one settlement, one correction, the books posted once [kills: both winning (a double count); a deadlock; a lost lock order channel -> line]', async () => {
    const g = await grabWorld(sql, 'race');
    const w = g.w;
    const before = await entryCount(sql, w.orgId);
    const out = await Promise.allSettled([approve(w, w.managerA2, g.lineId), approve(w, w.managerA3, g.lineId)]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(out.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect((await settlementsOf(sql, w.orgId)).length).toBe(1);
    expect(await correctionCount(sql, w.orgId)).toBe(1);
    expect(await entryCount(sql, w.orgId), 'one correction entry and one settlement entry').toBe(before + 2);
    expect((await controls(w.orgId)).c1220).toBe('0.00');
  });
});

/* ================================================================== (f) a closed period */

describe('S7a (f) a closed period for the sales date: books on the first open date, never in the closed month', () => {
  it('October closed after the days posted, November open: the correction and the settlement are both dated 1 Nov; settledOn is 1 Nov; October stays closed; the day shows "will post on" and is not blocked [kills: posting into a closed period; reopening it; the correction dated by a different rule than the settlement; willPostOn ignored]', async () => {
    const f = await fpWeek(sql, 'closed', { loanPeriods: false, staff: ['8000.00', '8000.00', '10000.00'] });
    const w = f.w;
    await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on = '2026-10-01'`;
    const b = await blockersOf(w, w.managerA2, f.lines[D1]!);
    expect(b.blockers, 'a closed month never blocks').toEqual([]);
    expect(b.willPostOn).toBe(NEXT_OPEN);

    const r = await approve(w, w.managerA2, f.lines[D1]!);
    expect(r.postedOn).toBe(NEXT_OPEN);
    expect(typeof r.correctionId).toBe('string');
    expect((await entryOf(sql, await correctionEntryId(sql, r.correctionId!))).entry_date, 'the correction follows the same rule').toBe(NEXT_OPEN);
    const s = await settlementFull(sql, r.settlementId);
    expect([s.settled_on, (await entryOf(sql, s.journal_entry_id!)).entry_date]).toEqual([NEXT_OPEN, NEXT_OPEN]);
    const [p] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${w.orgId} and starts_on = '2026-10-01'`;
    expect(p!.status, 'a period is never reopened').toBe('closed');
    const dated = (await entriesOf(sql, w.orgId)).filter((e) => e.source_type === 'channel_settlement' || e.source_type === 'sale').filter((e) => e.entry_date === NEXT_OPEN);
    expect(dated.length, 'a correction and a settlement are in November').toBe(2);
  });
});

/* ================================================================== (g) every blocker refuses approve, in plain words */

describe('S7a (g) every blocker refuses approve in plain words, and a refused approve writes nothing', () => {
  /** Runs approve on a blocked day and checks the whole contract of a refusal. Returns the blockers and the refusal sentence. */
  async function refusedFor(w: Awaited<ReturnType<typeof s7World>>, lineId: string, code: string) {
    const before = await snapshot(w.orgId, [lineId]);
    const b = (await blockersOf(w, w.managerA2, lineId)).blockers;
    expect(b.map((x) => x.code), `the day is blocked by ${code}`).toContain(code);
    const sentence = await sentenceOf(approve(w, w.managerA2, lineId));
    expect(sentence, 'A4: the first blocker, in its own words').toContain(b[0]!.sentence);
    expect(sentence).not.toMatch(UUID_ANY);
    expect(sentence).not.toMatch(/select |insert |update |violates|constraint/i);
    expect(await snapshot(w.orgId, [lineId]), 'nothing written').toEqual(before);
    return { blockers: b, sentence };
  }

  it('loan_leg_problem: a loan deduction the loan check cannot place on a loan; its text is the legs blocker of loanLegsForLine [kills: the legs blocker read nowhere (S6 required it); a hand-written second sentence]', async () => {
    const g = await grabWorld(sql, 'blk-leg', { loan: false });
    const { blockers } = await refusedFor(g.w, g.lineId, 'loan_leg_problem');
    const expected = loanLegsForLine({ storeId: g.w.storeA, loanDeduction: '500.00' }, null).blocker;
    expect(expected, 'control: the legs function has a blocker for a deduction nobody placed').toBeTruthy();
    expect(blockers.find((b) => b.code === 'loan_leg_problem')!.sentence).toBe(expected);
  });

  it('nothing_to_settle: an order value of 0.00 (the payout cannot post; the owner handles it by hand) [kills: a zero day passing to the settlement]', async () => {
    const w = await s7World(sql, 'blk-zero');
    await setDestination(sql, w, w.fpA);
    await ingest(w, w.managerA, zip(fpInvoice([{ date: D1, gross: 0, fees: 0 }])));
    const line = (await stageFpOne(sql, w, D1))!;
    const { blockers } = await refusedFor(w, line, 'nothing_to_settle');
    expect(blockers.find((b) => b.code === 'nothing_to_settle')!.sentence).not.toMatch(UUID_ANY);
  });

  it('sales_day_not_posted: a verified day with no journal entry (the file figure cannot replace anything yet) [kills: correctPlatformSales left to fail late with a raw refusal]', async () => {
    const w = await s7World(sql, 'blk-unposted');
    await setDestination(sql, w, w.fpA);
    await salesDay(sql, w, w.storeA, w.fpA, D1, '9000.00', { verified: true });
    await ingest(w, w.managerA, zip(fpInvoice([{ date: D1, gross: 9000, fees: 1800 }])));
    const line = (await stageFpOne(sql, w, D1))!;
    const { blockers } = await refusedFor(w, line, 'sales_day_not_posted');
    expect(blockers.find((b) => b.code === 'sales_day_not_posted')!.sentence).toMatch(/file figure cannot replace anything yet/i);
    expect(blockers.map((b) => b.code), 'verified, so not the "unverified" blocker').not.toContain('sales_day_not_verified');
  });

  it('earlier_day_open: the second day first is refused, the first day is untouched [kills: approval out of order]', async () => {
    const f = await fpWeek(sql, 'blk-earlier');
    await refusedFor(f.w, f.lines[D2]!, 'earlier_day_open');
  });

  it('line_not_current: a newer file replaced the day; the old line cannot be approved, the newer one can [kills: approving a retired version]', async () => {
    const f = await fpWeek(sql, 'blk-stale');
    await ingest(f.w, f.w.managerA, zip(fpInvoice([{ date: D1, gross: 9100, fees: 1800 }, { date: D2, gross: 8000, fees: 1600 }, { date: D3, gross: 10000, fees: 2000 }], { tag: 'v2' })));
    const s = (await refusedFor(f.w, f.lines[D1]!, 'line_not_current')).sentence;
    expect(s).toMatch(/newer/i);
  });

  it('sales_day_not_verified: a day staff have not verified [kills: booking an unverified day]', async () => {
    const w = await s7World(sql, 'blk-unverified');
    await setDestination(sql, w, w.fpA);
    await salesDay(sql, w, w.storeA, w.fpA, D1, '9000.00', { verified: false });
    await ingest(w, w.managerA, zip(fpInvoice([{ date: D1, gross: 9000, fees: 1800 }])));
    const line = (await stageFpOne(sql, w, D1))!;
    const { sentence } = await refusedFor(w, line, 'sales_day_not_verified');
    expect(sentence).toMatch(/waiting for the sales day to be verified/i);
  });

  it('no_destination_account: the channel has nowhere to bank it [kills: a settlement attempted with no bank account]', async () => {
    const f = await fpWeek(sql, 'blk-dest', { destination: false });
    const { sentence } = await refusedFor(f.w, f.lines[D1]!, 'no_destination_account');
    expect(sentence).toMatch(/no destination account/i);
  });

  it('blockers are re-run INSIDE the approve transaction: a day that turned blocked after the screen drew (the account removed) is refused, not booked [kills: blockers read once before the lock]', async () => {
    const f = await fpWeek(sql, 'blk-inside');
    const w = f.w;
    expect((await blockersOf(w, w.managerA2, f.lines[D1]!)).blockers, 'control: green when the screen drew').toEqual([]);
    await sql`update sales_channels set destination_money_account_id = null where id = ${w.fpA}`;
    await sentenceOf(approve(w, w.managerA2, f.lines[D1]!));
    expect((await settlementsOf(sql, w.orgId)).length).toBe(0);
  });
});

/* ================================================================== (h) atomic */

describe('S7a (h) approve is atomic: a failure after the correction rolls the correction back too', () => {
  it('the settlement step fails after the correction was posted: no correction row, no entry, the line pending; with the failure gone the same day books [kills: a correction committed before the settlement; a half-booked day]', async () => {
    const g = await grabWorld(sql, 'atomic');
    const w = g.w;
    const before = await snapshot(w.orgId, [g.lineId]);
    failure.on = true;
    const err = await approve(w, w.managerA2, g.lineId).then(() => null, (e: unknown) => e);
    expect((err as Error | null)?.message).toBe('forced settlement failure');
    expect(failure.correctionsInTx, 'proof: the correction existed in the SAME transaction when the settlement failed').toBe(1);
    expect(await snapshot(w.orgId, [g.lineId]), 'and then it was rolled back with everything else').toEqual(before);
    expect((await auditRows(sql, w.orgId, 'platform_sales.corrected')).length).toBe(0);
    failure.on = false;
    const r = await approve(w, w.managerA2, g.lineId);
    expect(typeof r.correctionId, 'control: the same day books once the failure is gone').toBe('string');
  });
});

/* ================================================================== (i) negative control */

describe('S7a (i) negative control for worked example 1: the settlement WITHOUT the correction', () => {
  it('owed 10,000: the payout of 8,200 + fees 2,300 + loan 500 exceeds the day by 1,000, inside tolerance, so it books SILENTLY as a gain (Cr 7100 1,000) and 4150 never learns the 1,000: exactly what the correction-first order prevents [kills: a negative control that no longer reproduces the defect, so test (a) proves nothing]', async () => {
    const g = await grabWorld(sql, 'negctl');
    const w = g.w;
    const res = await asOrg(w.orgId, (tx) =>
      D.recordChannelSettlement(tx, w.admin, {
        storeId: w.storeA, channelId: w.grabA, salesDayId: g.dayId!, businessDate: GRAB_DAY, grossAmount: '11000.00', netDeposited: '8200.00', settledOn: GRAB_DAY,
        deductions: { commission: '2200.00', platformFee: '100.00' }, loanLegs: [{ loanId: g.loanId!, amount: '500.00', ownerStoreId: w.storeA }],
      }),
    );
    expect(await aggText(sql, res.entryId)).toEqual(sorted(['Dr 1140 8200.00', 'Dr 6400 2300.00', 'Dr 2400 500.00', 'Cr 1220 10000.00', 'Cr 7100 1000.00']));
    expect([res.variance, res.settlementGain]).toEqual(['0.00', '1000.00']);
    expect(await controls(w.orgId), 'no 4150 for the missing 1,000').toMatchObject({ c4150: '-10000.00', c1220: '0.00', c6420: '0.00', c7100: '-1000.00' });
  });
});

/* ================================================================== (j) privacy */

describe('S7a (j) refusal texts never carry another store\'s name or a loan balance', () => {
  it('a manager of Lipa whose Grab day deducts 500.00 against a Malvar loan that expects 400.00 (a mismatch): the refusal and the blocker name no other store, no loan name and no balance [kills: the loan check\'s company-wide sentence leaking to a manager; a balance in a refusal]', async () => {
    const g = await grabWorld(sql, 'priv', { loan: false });
    const w = g.w;
    await mkLoan(sql, w, { storeId: w.storeB, name: 'Malvar Hidden Loan', startDate: '2026-05-11', principal: '200000.00', repayment: '400.00' });
    const b = (await blockersOf(w, w.managerA2, g.lineId)).blockers;
    expect(b.length, 'control: the day is blocked').toBeGreaterThan(0);
    const texts = [...b.map((x) => x.sentence), await sentenceOf(approve(w, w.managerA2, g.lineId))];
    for (const t of texts) {
      expect(t).not.toMatch(/Malvar|Banay|Hidden Loan/i);
      expect(t, 'no loan balance').not.toMatch(/200[, ]?000|199[, ]?[0-9]{3}/);
      expect(t).not.toMatch(UUID_ANY);
    }
  });
});

/* ================================================================== (k) the audit row */

describe('S7a (k) audit settlement_day.approved', () => {
  it('one row per approval: entity = the line, the line\'s store, the approver, source web; the settlement id, the correction id, both upload ids and the reader version are in the payload; no reason given [kills: no audit; the wrong entity or actor; ids missing]', async () => {
    const g = await grabWorld(sql, 'audit');
    const w = g.w;
    const r = await approve(w, w.managerA2, g.lineId);
    const rows = await auditRows(sql, w.orgId, 'settlement_day.approved');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect([row.entity_id, row.store_id, row.actor_person_id, row.source]).toEqual([g.lineId, w.storeA, w.managerA2.personId, 'web']);
    const line = await lineFull(sql, g.lineId);
    const seen = leaves({ before: row.before, after: row.after });
    for (const id of [r.settlementId, r.correctionId!, line.source_upload_id, line.payout_upload_id!]) expect(seen, `payload holds ${id}`).toContain(id);
    expect(seen.some((s) => s.includes(READER_VERSION)), 'the reader version').toBe(true);
    expect(Object.entries(row.after ?? {}).filter(([k]) => /charge/i.test(k)).length, 'a charge-ids key (empty here)').toBeGreaterThan(0);
  });

  it('a day with no correction records "none", a carrier records its charge ids [kills: a correction id invented; charge ids dropped]', async () => {
    const f = await fpWeek(sql, 'audit-carrier', { charge: true });
    const w = f.w;
    const c = await postCharge(w, w.admin, f.chargeLineId!);
    await approve(w, w.managerA2, f.lines[D1]!);
    await approve(w, w.managerA2, f.lines[D2]!);
    const r3 = await approve(w, w.managerA2, f.lines[D3]!);
    const rows = await auditRows(sql, w.orgId, 'settlement_day.approved');
    expect(rows).toHaveLength(3);
    const last = rows.find((x) => x.entity_id === f.lines[D3]!)!;
    expect(leaves(last.after)).toContain(c.chargeId);
    expect(leaves(last.after)).toContain(r3.settlementId);
    const first = rows.find((x) => x.entity_id === f.lines[D1]!)!;
    expect(leaves(first.after), 'no charge on a plain day').not.toContain(c.chargeId);
    expect((await corrections(sql, w.orgId)).length, 'staff = file: no correction anywhere').toBe(0);
  });
});
