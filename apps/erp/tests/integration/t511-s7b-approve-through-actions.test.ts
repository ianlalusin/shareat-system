import { config } from 'dotenv';
import postgres from 'postgres';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-511 S7b (BUILDER, 11 Nov 2026) - the approve and book-charge ACTIONS, called as the app calls them: the real server action module, the session mocked to a real actor, the
 * database reached through the app's own `withOrgPrincipal`, real ingest, real posting. The money is read back raw, to the centavo.
 *
 *  (a) worked example 1: a Grab day, the correction first (Dr 1220 1,000 / Cr 4150 1,000), then the settlement (bank 8,200, 6400 2,300, 2400 500 / Cr 1220 11,000).
 *  (b) worked example 2: a Foodpanda week; the day that carries the charge is refused until the charge is booked through bookChargeAction; then it nets 7,888.00 and the bank totals 21,488.00.
 *  (c) the reason round trip: no reason -> the redirect carries `ack` and NO banner, nothing is written; the page (rendered from the real detail) then shows the reason form with the
 *      figure; the reason and the confirmed figure book it. A forged figure, a missing figure and a reason on a day that needs none cannot book a different amount.
 *  (d) who may act: the uploader (not an administrator) is refused on BOTH actions; a manager of another store is refused by scope in words that name no store.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.setConfig({ testTimeout: 180_000, hookTimeout: 90_000 });
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const act0 = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => act0.actor),
  requireSession: vi.fn(async () => ({ actor: act0.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import {
  D1, D2, D3, GRAB_DAY, aggText, asOrg, chargeLinks, correctionCount, correctionEntryId, corrections, entryCount, fpWeek, grabWorld, linesOf, lineFull, lineText, netDebit, settlementFull, settlementsOf,
} from '../../../../packages/domain/tests/integration/_fixtures/t511-s7a-world';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
setStorageDriver(inMemoryDriver());
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/channel-settlements/review/actions');
type Who = { personId: string; orgId: string };
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STORE_NAMES = /Lipa|Malvar|Banay/i;
const sorted = (xs: string[]): string[] => [...xs].sort();

async function act(who: Who, name: 'approveDayAction' | 'bookChargeAction', fields: Record<string, string>) {
  act0.actor = who;
  const m = (await ACTIONS()) as unknown as Record<string, (f: FormData) => Promise<void>>;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const o = outcomeOf(await captureRedirect(() => m[name]!(fd)));
  return { path: o.path, nav: o.nav, error: o.flash.error, ok: o.flash.ok, stamp: (o.flash as { stamp?: string }).stamp };
}

/** What a refused action must leave behind: nothing. */
async function snapshot(orgId: string, lineIds: string[] = []) {
  return { entries: await entryCount(sql, orgId), corrections: await correctionCount(sql, orgId), settlements: (await settlementsOf(sql, orgId)).length, states: await Promise.all(lineIds.map(async (id) => (await lineFull(sql, id)).review_state)) };
}

/* ================================================================== (a) worked example 1 */

describe('S7b (a) a Grab day approved through approveDayAction: the correction first, to the centavo', () => {
  it('staff 10,000.00, file 11,000.00: Dr 1220 1,000 / Cr 4150 1,000, then bank 8,200, 6400 2,300 and 2400 500 against 1220 11,000; the flash says booked with the POSTED stamp; the day ends booked by the approver [kills: an action that does not book; the correction missing; the stamp missing]', async () => {
    const g = await grabWorld(sql, 'act-ex1');
    const w = g.w;
    const r = await act(w.managerA2, 'approveDayAction', { lineId: g.lineId });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe("Booked. The day's payout is on the books and the sales figure now matches the file.");
    expect(r.stamp).toBe('POSTED');
    expect(r.path).toBe('/channel-settlements/review');
    expect(r.nav.get('day')).toBe(g.lineId);
    expect(r.nav.get('ack')).toBeNull();

    const corr = (await corrections(sql, w.orgId))[0]!;
    expect([corr.from_amount, corr.to_amount]).toEqual(['10000.00', '11000.00']);
    expect(lineText(await linesOf(sql, await correctionEntryId(sql, corr.id)))).toEqual(['Cr 4150 1000.00', 'Dr 1220 1000.00']);
    const [s] = await settlementsOf(sql, w.orgId);
    const full = await settlementFull(sql, s!.id);
    expect([full.gross_amount, full.net_deposited, full.variance, full.settlement_gain, full.difference_reason]).toEqual(['11000.00', '8200.00', '0.00', '0.00', null]);
    expect(await aggText(sql, full.journal_entry_id!)).toEqual(sorted(['Dr 1140 8200.00', 'Dr 6400 2300.00', 'Dr 2400 500.00', 'Cr 1220 11000.00']));
    expect([await netDebit(sql, w.orgId, '1220'), await netDebit(sql, w.orgId, '4150'), await netDebit(sql, w.orgId, '6420'), await netDebit(sql, w.orgId, '7100')]).toEqual(['0.00', '-11000.00', '0.00', '0.00']);
    const line = await lineFull(sql, g.lineId);
    expect([line.review_state, line.decided_by, line.settlement_id]).toEqual(['booked', w.managerA2.personId, s!.id]);

    const again = await act(w.managerA2, 'approveDayAction', { lineId: g.lineId });
    expect(again.error, 'a second press is refused in words').toMatch(/already decided|booked/i);
    expect((await settlementsOf(sql, w.orgId)).length).toBe(1);
  });
});

/* ================================================================== (b) worked example 2 */

describe('S7b (b) a Foodpanda week: the charge booked through bookChargeAction first, netted at the last day', () => {
  it('D1 and D2 approve; D3 is refused while the charge is unbooked; the uploader cannot book it; another manager does; D3 then books 7,888.00 and the bank totals 21,488.00 [kills: a carrier approved before its charge; the charge expensed twice; the uploader booking their own charge]', async () => {
    const f = await fpWeek(sql, 'act-ex2', { charge: true });
    const w = f.w;
    for (const d of [D1, D2]) {
      const r = await act(w.managerA2, 'approveDayAction', { lineId: f.lines[d]! });
      expect([r.error, r.stamp]).toEqual([undefined, 'POSTED']);
    }
    const before = await snapshot(w.orgId, [f.lines[D3]!]);
    const held = await act(w.managerA2, 'approveDayAction', { lineId: f.lines[D3]! });
    expect(held.error).toMatch(/charge/i);
    expect(held.ok).toBeUndefined();
    expect(await snapshot(w.orgId, [f.lines[D3]!]), 'a refused carrier leaves nothing behind').toEqual(before);

    const own = await act(w.managerA, 'bookChargeAction', { otherLineId: f.chargeLineId!, lineId: f.lines[D3]! });
    expect(own.error, 'the person who uploaded the invoice does not book its charge').toMatch(/uploaded/i);
    expect(own.error).not.toMatch(UUID_ANY);
    expect(await snapshot(w.orgId, [f.lines[D3]!]), 'nothing booked by the refused uploader').toEqual(before);

    const booked = await act(w.managerA2, 'bookChargeAction', { otherLineId: f.chargeLineId!, lineId: f.lines[D3]! });
    expect([booked.error, booked.ok, booked.stamp]).toEqual([undefined, 'Charge booked.', 'POSTED']);
    expect(booked.nav.get('day')).toBe(f.lines[D3]!);
    const [charge] = await sql<{ id: string; journal_entry_id: string; total_amount: string }[]>`select id::text, journal_entry_id::text, total_amount::text from channel_period_charges where org_id = ${w.orgId}`;
    expect(charge!.total_amount).toBe('112.00');
    expect(lineText(await linesOf(sql, charge!.journal_entry_id))).toEqual(['Cr 1220 112.00', 'Dr 6400 112.00']);

    const r3 = await act(w.managerA2, 'approveDayAction', { lineId: f.lines[D3]! });
    expect([r3.error, r3.stamp]).toEqual([undefined, 'POSTED']);
    const all = await settlementsOf(sql, w.orgId);
    expect(all).toHaveLength(3);
    const s3 = await settlementFull(sql, all[2]!.id);
    expect([s3.net_deposited, s3.variance, s3.settlement_gain]).toEqual(['7888.00', '0.00', '0.00']);
    expect(await aggText(sql, s3.journal_entry_id!)).toEqual(sorted(['Dr 1140 7888.00', 'Dr 6400 2000.00', 'Cr 1220 9888.00']));
    expect(await netDebit(sql, w.orgId, '1140'), 'the bank total is the invoice total').toBe('21488.00');
    expect([await netDebit(sql, w.orgId, '1220'), await netDebit(sql, w.orgId, '6400'), await netDebit(sql, w.orgId, '6420')]).toEqual(['0.00', '5512.00', '0.00']);
    expect(await chargeLinks(sql, w.orgId)).toEqual([{ settlement_id: all[2]!.id, charge_id: charge!.id }]);
  });
});

/* ================================================================== (c) the reason round trip */

describe('S7b (c) the reason round trip, and what a forged figure cannot do', () => {
  /** Staff 8,000 vs file 9,000 and 3,000 already received by hand: the payout then exceeds the day by 3,000.00 (past tolerance). */
  async function reasonWorld(hint: string) {
    const f = await fpWeek(sql, hint, { staff: ['8000.00', '', ''] });
    const w = f.w;
    await asOrg(w.orgId, (tx) =>
      postEntry(tx, {
        orgId: w.orgId, entryDate: '2026-10-13', sourceType: 'manual_journal', sourceId: crypto.randomUUID(), idempotencyKey: `s7b-receipt:${crypto.randomUUID()}`, memo: 'Paid by hand', postedBy: w.admin.personId,
        lines: [
          { accountCode: '1130', storeId: w.storeA, debit: '3000.00' },
          { accountCode: '1220', storeId: w.storeA, credit: '3000.00', partyType: 'channel', partyId: w.fpA },
        ],
      }),
    );
    return { f, w, lineId: f.lines[D1]! };
  }

  it('no reason: the redirect carries ack=over-3000.00 and NO banner and NO stamp, and nothing is written; the page then shows the reason form with that figure; the reason and the confirmed figure book it as income [kills: an error banner on the question; the figure lost; the reason box missing; a gain booked without a reason]', async () => {
    const { w, lineId } = await reasonWorld('act-reason');
    const before = await snapshot(w.orgId, [lineId]);
    const asked = await act(w.managerA2, 'approveDayAction', { lineId });
    expect([asked.error, asked.ok, asked.stamp]).toEqual([undefined, undefined, undefined]);
    expect(asked.nav.get('ack')).toBe('over-3000.00');
    expect(asked.nav.get('day')).toBe(lineId);
    expect(await snapshot(w.orgId, [lineId]), 'the question wrote nothing, not even the correction').toEqual(before);

    // the page: the real detail and the ack the redirect carried, rendered
    const { DayDetail } = await import('../../src/app/channel-settlements/review/DayDetail');
    const { parseAck } = await import('../../src/app/channel-settlements/review/words');
    const detail = (await asOrg(w.orgId, (tx) => D.getReviewDayDetail(tx, w.managerA2, { lineId })))!;
    const html = renderToStaticMarkup(h(DayDetail, { detail, access: { canReject: true, canReopen: false, canOverrideLoans: false }, loans: [], backHref: '/x', filters: {}, ack: parseAck(asked.nav.get('ack') ?? undefined) }));
    expect(html).toContain('name="confirmedDifference" value="3000.00"');
    expect(html).toContain('more than the day');
    expect(html).toMatch(/<textarea[^>]*name="reason"/);

    const done = await act(w.managerA2, 'approveDayAction', { lineId, reason: '  Customer paid us directly on 12 Oct  ', confirmedDifference: '3000.00' });
    expect([done.error, done.stamp]).toEqual([undefined, 'POSTED']);
    const [s] = await settlementsOf(sql, w.orgId);
    const full = await settlementFull(sql, s!.id);
    expect([full.difference_reason, full.settlement_gain, full.outstanding_cleared]).toEqual(['Customer paid us directly on 12 Oct', '3000.00', '6000.00']);
    expect(await aggText(sql, full.journal_entry_id!)).toEqual(sorted(['Dr 1140 7200.00', 'Dr 6400 1800.00', 'Cr 1220 6000.00', 'Cr 7100 3000.00']));
  });

  it('a confirmed figure that differs from the real difference, or none at all, asks again with the REAL figure and books nothing [kills: a reason that carries to another amount; a forged figure booked]', async () => {
    const { w, lineId } = await reasonWorld('act-forged');
    const before = await snapshot(w.orgId, [lineId]);
    for (const confirmedDifference of ['1.00', '3000.01', '0.00']) {
      const r = await act(w.managerA2, 'approveDayAction', { lineId, reason: 'The statement is right', confirmedDifference });
      expect(r.nav.get('ack'), `confirmed ${confirmedDifference}`).toBe('over-3000.00');
      expect([r.error, r.ok]).toEqual([undefined, undefined]);
    }
    const none = await act(w.managerA2, 'approveDayAction', { lineId, reason: 'The statement is right' });
    expect(none.nav.get('ack'), 'a reason with no confirmed figure').toBe('over-3000.00');
    expect(await snapshot(w.orgId, [lineId])).toEqual(before);
  });

  it('a blank reason with the RIGHT figure is refused again: the question stays up (ack kept, no banner), nothing is written, and the page shows one Approve and book [kills: the reason form vanishing after an empty submit; a gain booked with a blank reason]', async () => {
    const { w, lineId } = await reasonWorld('act-blank');
    const before = await snapshot(w.orgId, [lineId]);
    const r = await act(w.managerA2, 'approveDayAction', { lineId, reason: '   ', confirmedDifference: '3000.00' });
    expect([r.error, r.ok, r.stamp]).toEqual([undefined, undefined, undefined]);
    expect(r.nav.get('ack')).toBe('over-3000.00');
    expect(r.nav.get('day')).toBe(lineId);
    expect(await snapshot(w.orgId, [lineId])).toEqual(before);
  });

  /**
   * DOCUMENTED LIMIT (audit finding 2, accepted by BOSS): the hidden `confirmedDifference` carries the AMOUNT the person saw, not the direction. Someone who types a forged
   * address (`ack=short-3000.00` for a payout that is really OVER by 3,000.00) is shown the wrong wording, but the server works the direction out again from the books and books
   * the REAL one (a gain here, never a loss). Nothing is booked in a direction the books do not have. `approveDay` is deliberately not changed.
   */
  it('a forged ack with the WRONG direction and the right amount shows the wrong words but books the REAL direction (a gain, not a loss) [documents the accepted limit; kills: the direction taken from the address]', async () => {
    const { w, lineId } = await reasonWorld('act-wrong-way');
    const { DayDetail } = await import('../../src/app/channel-settlements/review/DayDetail');
    const { parseAck } = await import('../../src/app/channel-settlements/review/words');
    const detail = (await asOrg(w.orgId, (tx) => D.getReviewDayDetail(tx, w.managerA2, { lineId })))!;
    const html = renderToStaticMarkup(h(DayDetail, { detail, access: { canReject: true, canReopen: false, canOverrideLoans: false }, loans: [], backHref: '/x', filters: {}, ack: parseAck('short-3000.00') }));
    expect(html, 'the forged address makes the page say loss').toContain('It is booked as a loss.');
    expect(html).toContain('name="confirmedDifference" value="3000.00"');

    const r = await act(w.managerA2, 'approveDayAction', { lineId, reason: 'Customer paid us directly on 12 Oct', confirmedDifference: '3000.00' });
    expect([r.error, r.stamp]).toEqual([undefined, 'POSTED']);
    const [s] = await settlementsOf(sql, w.orgId);
    const full = await settlementFull(sql, s!.id);
    expect([full.settlement_gain, full.variance], 'the books say over, so a gain').toEqual(['3000.00', '0.00']);
    expect(await aggText(sql, full.journal_entry_id!)).toContain('Cr 7100 3000.00');
  });

  it('a forged ack in the address changes nothing: on a day that needs no reason, a reason and a made-up figure book the plain day and store no reason [kills: the URL figure used as the amount; a reason stored on a clean day]', async () => {
    const f = await fpWeek(sql, 'act-forged-clean');
    const r = await act(f.w.managerA2, 'approveDayAction', { lineId: f.lines[D1]!, reason: 'not needed', confirmedDifference: '9999.00' });
    expect([r.error, r.stamp]).toEqual([undefined, 'POSTED']);
    const [s] = await settlementsOf(sql, f.w.orgId);
    const full = await settlementFull(sql, s!.id);
    expect([full.gross_amount, full.net_deposited, full.settlement_gain, full.variance, full.difference_reason]).toEqual(['9000.00', '7200.00', '0.00', '0.00', null]);
  });
});

/* ================================================================== (d) who may act */

describe('S7b (d) the uploader and the other store', () => {
  it('the manager who uploaded the Grab files is refused on approve, in plain words with no store and no id; nothing is booked; an administrator who uploaded may approve [kills: the uploader allowed through the action; a store named]', async () => {
    const g = await grabWorld(sql, 'act-upl');
    const before = await snapshot(g.w.orgId, [g.lineId]);
    const r = await act(g.w.managerA, 'approveDayAction', { lineId: g.lineId });
    expect(r.error).toMatch(/uploaded/i);
    expect(r.error).not.toMatch(UUID_ANY);
    expect(r.error).not.toMatch(STORE_NAMES);
    expect(r.ok).toBeUndefined();
    expect(await snapshot(g.w.orgId, [g.lineId])).toEqual(before);
    const g2 = await grabWorld(sql, 'act-upl-admin', { txBy: 'admin', trBy: 'admin' });
    const ok = await act(g2.w.admin, 'approveDayAction', { lineId: g2.lineId });
    expect([ok.error, ok.stamp]).toEqual([undefined, 'POSTED']);
  });

  it('a manager of ANOTHER store is refused by scope on both actions, in words that name no store; nothing is booked [kills: scope ignored; a store named]', async () => {
    const f = await fpWeek(sql, 'act-scope', { charge: true });
    const w = f.w;
    const before = await snapshot(w.orgId, [f.lines[D1]!]);
    const a = await act(w.managerC, 'approveDayAction', { lineId: f.lines[D1]! });
    const b = await act(w.managerC, 'bookChargeAction', { otherLineId: f.chargeLineId! });
    for (const r of [a, b]) {
      expect(r.error, 'a sentence').toMatch(/\s/);
      expect(r.error).not.toMatch(STORE_NAMES);
      expect(r.error).not.toMatch(UUID_ANY);
      expect(r.ok).toBeUndefined();
    }
    expect(await snapshot(w.orgId, [f.lines[D1]!])).toEqual(before);
    expect(D2).toBeTruthy();
    expect(GRAB_DAY).toBeTruthy();
  });
});
