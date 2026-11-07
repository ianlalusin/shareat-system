/**
 * T-531 R5 (TESTER) - the December bridge, driven from the database with a FAKE writer (no real Firestore). docs/tasks/531-pos-day-close.md R5, R8 "Bridge".
 *
 * ASSUMED API (fixture header lists all): the bridge runs AFTER the close commits, in a fresh transaction:
 *   sendV1Bridge(tx, actor, { storeId, businessDates }, { writer }) -> { results: [{ businessDate, status: 'sent' | 'failed' | 'skipped', reason? }] }   never throws on a write failure;
 *       writes the audit 'pos.v1_bridge_sent' / 'pos.v1_bridge_failed' (entity = the store; after carries the business date and, on failure, the reason).
 *   resendV1Bridge(tx, actor, { storeId, businessDate }, { writer }) -> { sent: true }   capability approve_pos_correction; rebuilds from the DB; writes 'pos.v1_bridge_sent'.
 *   listDayCloses(tx, actor, { storeId }, deps) -> { closes: [{ id, zNo, businessDate, grossTotal, byTender, v1Status }] }; v1Status 'sent' | 'failed' | 'pending'
 *       ("Not yet sent to v1. Tap Resend." is the Till tab's text for 'failed').
 *   writer = { set(path, data, { merge }) }  (the fixture's `fakeWriter`). The real writer lives in apps/erp/src/lib/v1-bridge.ts (see the apps test).
 * Document and fields: see v1-bridge-payload.test.ts. Numbers are JSON numbers.
 *
 * Not covered here: "no pos_v1_store_links row -> no write" (a store cannot be unlinked cheaply on this fixture; hand-back).
 *
 * RED NOW FOR THE RIGHT REASON: day-close.ts does not exist ("MISSING EXPORT ... (T-531 not built)", after the fixture ran).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { RefusalError } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { D1, D2, D3, DC, sql, ymd, asOrg, auditsOf, clockAt, close, closeAll, closesOf, fakeWriter, manila, pinOf, standardDay, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const EXPECTED = {
  payments: { totalGross: 2896.71, txCount: 3, byMethod: { cash: 2396.71, GCash: 500 }, discountsTotal: 178.29, chargesTotal: 0, voidCashRetainedTotal: 0 },
  sales: { dineInSalesGross: 2245 },
  guests: { guestCountFinalTotal: 5, packageSessionsCount: 2 },
};
const pathOf = (w: World, date: string) => `stores/${w.posStoreId}/analytics/${ymd(date)}`;

async function closedStandardDay(date = D1, liveFrom = D1) {
  const w = await world('live', liveFrom);
  await standardDay(w, date);
  const res = await close(w, manila(date, '22:30'), await pinOf(w, w.managerId));
  return { w, res };
}
const send = (w: World, dates: string[], writer: unknown) => asOrg(w.orgId, (tx) => DC.sendV1Bridge(tx, w.counter, { storeId: w.storeId, businessDates: dates }, { writer }));
const resend = (w: World, who: World['counter'], date: string, writer: unknown) => asOrg(w.orgId, (tx) => DC.resendV1Bridge(tx, who, { storeId: w.storeId, businessDate: date }, { writer }));
const list = (w: World) => asOrg(w.orgId, (tx) => DC.listDayCloses(tx, w.counter, { storeId: w.storeId }, clockAt(manila(D1, '22:30'))));

describe('R5 - after the close commits, the day goes to v1 as one full-overwrite document', () => {
  it('the exact document for the standard day at stores/<posStoreId>/analytics/20261102, written with merge:false; audit pos.v1_bridge_sent', async () => {
    const { w } = await closedStandardDay();
    const fw = fakeWriter();
    const out = await send(w, [D1], fw.writer);
    expect(out.results).toMatchObject([{ businessDate: D1, status: 'sent' }]);
    expect(fw.calls).toHaveLength(1);
    expect(fw.calls[0]).toEqual({ path: pathOf(w, D1), data: EXPECTED, opts: { merge: false } });
    expect(await auditsOf(w, 'pos.v1_bridge_sent')).toHaveLength(1);
    expect(await auditsOf(w, 'pos.v1_bridge_failed')).toHaveLength(0);
  });

  it('a failing writer leaves the CLOSE committed (Z, sales day) and records pos.v1_bridge_failed; the history shows it as failed ("Not yet sent to v1. Tap Resend.")', async () => {
    const { w, res } = await closedStandardDay();
    const fw = fakeWriter();
    fw.state.failWith = new Error('firestore unavailable');
    const out = await send(w, [D1], fw.writer);
    expect(out.results[0]).toMatchObject({ businessDate: D1, status: 'failed' });
    expect(fw.calls).toHaveLength(0);
    expect((await closesOf(w)).map((z) => z.id)).toEqual([res.dayCloseId]);
    const failed = await auditsOf(w, 'pos.v1_bridge_failed');
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]!.after)).toContain(D1);
    expect(await auditsOf(w, 'pos.v1_bridge_sent')).toHaveLength(0);
    expect((await list(w)).closes[0]).toMatchObject({ id: res.dayCloseId, zNo: 1, businessDate: D1, v1Status: 'failed' });
  });

  it('Resend (manager, approve_pos_correction) rebuilds the document from the DB and rewrites it: same path, same data, merge:false; a second Resend rewrites the identical document; status becomes sent', async () => {
    const { w } = await closedStandardDay();
    const bad = fakeWriter();
    bad.state.failWith = new Error('firestore unavailable');
    await send(w, [D1], bad.writer);
    const fw = fakeWriter();
    await expect(resend(w, w.manager, D1, fw.writer)).resolves.toMatchObject({ sent: true });
    await expect(resend(w, w.manager, D1, fw.writer)).resolves.toMatchObject({ sent: true });
    expect(fw.calls).toHaveLength(2);
    expect(fw.calls[0]).toEqual({ path: pathOf(w, D1), data: EXPECTED, opts: { merge: false } });
    expect(fw.calls[1]).toEqual(fw.calls[0]);
    expect((await auditsOf(w, 'pos.v1_bridge_sent')).length).toBe(2);
    expect((await list(w)).closes[0]!.v1Status).toBe('sent');
  });

  it('Resend needs approve_pos_correction: the cashier and a manager of another store are refused, and nothing is written', async () => {
    const { w } = await closedStandardDay();
    const fw = fakeWriter();
    await expect(resend(w, w.counter, D1, fw.writer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resend(w, w.managerOther, D1, fw.writer)).rejects.toBeInstanceOf(AuthorizationError);
    expect(fw.calls).toHaveLength(0);
  });

  it('a date after 2026-12-31 is never written: send writes nothing and does not report sent; Resend is refused in words', async () => {
    const { w } = await closedStandardDay('2027-01-04', '2027-01-04');
    const fw = fakeWriter();
    const out = await send(w, ['2027-01-04'], fw.writer);
    expect(out.results[0]!.status).not.toBe('sent');
    expect(fw.calls).toHaveLength(0);
    const err = await resend(w, w.manager, '2027-01-04', fw.writer).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect(fw.calls).toHaveLength(0);
    expect(await auditsOf(w, 'pos.v1_bridge_sent')).toHaveLength(0);
  });

  it('the last day, 2026-12-31, IS written (path 20261231)', async () => {
    const { w } = await closedStandardDay('2026-12-31', '2026-12-31');
    const fw = fakeWriter();
    await send(w, ['2026-12-31'], fw.writer);
    expect(fw.calls.map((c) => c.path)).toEqual([pathOf(w, '2026-12-31')]);
  });

  it('a tender with no v1 method mapping refuses the write with the exact sentence (nothing sent), and the close stays committed', async () => {
    const { w } = await closedStandardDay();
    await sql`update tenders set pos_v1_alias = null where id = ${w.gcash}`;
    const fw = fakeWriter();
    const err = await resend(w, w.manager, D1, fw.writer).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe('Tender GCash has no v1 method mapping.');
    expect(fw.calls).toHaveLength(0);
    expect(await closesOf(w)).toHaveLength(1);
  });

  it('no key: the real writer\'s refusal "The v1 bridge is not configured." is a failed send (recorded), never a failed close', async () => {
    const { w, res } = await closedStandardDay();
    const fw = fakeWriter();
    fw.state.failWith = new RefusalError('v1 bridge: no key', 'The v1 bridge is not configured.');
    const out = await send(w, [D1], fw.writer);
    expect(out.results[0]).toMatchObject({ status: 'failed', reason: 'The v1 bridge is not configured.' });
    expect((await closesOf(w))[0]!.id).toBe(res.dayCloseId);
  });

  // RULING 1 (8 Nov): the late Z at D2 05:30 is dated D2 and the evening Z D3 (before the ruling: D1 and D2), so the two documents are D2 and D3.
  it('several dates go in date order, one document each', async () => {
    const w = await world('live', D1);
    await standardDay(w, D1);
    const pin = await pinOf(w, w.managerId);
    await close(w, manila(D2, '05:30'), pin);
    await standardDay(w, D2);
    await close(w, manila(D2, '22:30'), pin);
    const fw = fakeWriter();
    await send(w, [D3, D2], fw.writer);
    expect(fw.calls.map((c) => c.path)).toEqual([pathOf(w, D2), pathOf(w, D3)]);
  });
});
