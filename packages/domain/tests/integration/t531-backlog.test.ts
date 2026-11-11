/**
 * T-531 R11 (TESTER) - a Z that would span more than 2 business days is refused, and "Close day by day" (`closeBacklog`) closes the backlog one business day at a time.
 * docs/tasks/531-pos-day-close.md R11 (Ian, bible row 450), R8. Real Postgres on a scratch "_test" database.
 *
 * ASSUMED API: closeDay (see t531-close.test.ts) and
 *   closeBacklog(tx, actor, { storeId, pairingId, terminalId, closeRunId, approval: { pin } }, deps) -> { wrote, closes: { dayCloseId, zNo, businessDate, salesDayId }[] }
 *   Z id of a day = uuidv5(businessDate, closeRunId) (name = the date, namespace = the run id: the `uuidv5(name, namespace)` of pos/shared.ts and the
 *   convention of applyPresetToAllLines; R11 writes "uuidv5(closeRunId, businessDate)", hand-back Q6).
 *   Audit 'pos.day_closed_backlog' { after: { days / zNos / totals, approvedBy } }: asserted only for count, store and that the approver id and each Z's number are in the row.
 * Sentence (exact): "This close would cover more than 2 days. Call a manager."
 *
 * Timeline: live_from D1; "now" is D4 14:00; sales on D1, D2, D3 and D4 (today). The backlog is D1..D3 (3 Zs), today D4 stays open.
 * Each past Z's window ends at the NEXT day's 04:00 (the day start hour), so the windows are D1 04:00-D2 04:00, D2 04:00-D3 04:00, D3 04:00-D4 04:00.
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
import { AuthenticationError, AuthorizationError, POS_APPROVAL_PIN_CAPPED } from '@shareat/auth';
import { uuidv5 } from '../../src/pos/shared';
import {
  D1, D2, D3, D4, D5, FAR, auditsOf, backlog, close, closeAll, closesOf, manila, openReceiptCount, pinOf, porkSale, salesDaysOf, sell, sql, stateVersion, uuid, world, type World,
} from './_fixtures/t531-day-close';
import { insertDerivedSalesDayRow } from './_fixtures/pos-day';

afterAll(closeAll);

const MORE_THAN_2 = 'This close would cover more than 2 days. Call a manager.';
const NOW = manila(D4, '14:00');

/** pork x1 (250.00) on D1, pork x2 (500.00) on D2, pork x1 on D3, and one on D4 (today). */
async function fourDays(w: World, o: { skip?: string[] } = {}) {
  const skip = new Set(o.skip ?? []);
  if (!skip.has(D1)) await porkSale(w, manila(D1, '12:00'));
  if (!skip.has(D2)) await sell(w, { at: manila(D2, '12:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', pay: [{ tenderId: w.cash, amount: '500.00' }] });
  if (!skip.has(D3)) await porkSale(w, manila(D3, '12:00'));
  await porkSale(w, manila(D4, '12:00'));
}
async function expectRefused(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err instanceof RefusalError || err instanceof AuthorizationError || err instanceof AuthenticationError, `expected a refusal, got ${String((err as Error)?.message)}`).toBe(true);
}
const counts = async (w: World) => ({
  closes: (await closesOf(w)).length, days: (await salesDaysOf(w)).length, openReceipts: await openReceiptCount(w),
  closeAudits: (await auditsOf(w, 'pos.day_closed')).length, backlogAudits: (await auditsOf(w, 'pos.day_closed_backlog')).length, version: await stateVersion(w),
});

// ======================================================================================================================
describe('R11 - closeDay refuses a window of more than 2 business days', () => {
  it('3 business dates (oldest receipt D1, today D3): refused with the exact sentence, nothing written (no Z, no sales day, no receipt frozen)', async () => {
    const w = await world('live', D1);
    await porkSale(w, manila(D1, '12:00'));
    await porkSale(w, manila(D3, '09:00'));
    const was = await counts(w);
    const err = await close(w, manila(D3, '10:00'), await pinOf(w, w.managerId)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe(MORE_THAN_2);
    expect(await counts(w)).toEqual(was);
  });

  it('a 2-day window still closes normally (row 390\'s forgotten Z): oldest receipt D2, now D3 -> one Z, one sales day holding both days, spansTwoDates', async () => {
    const w = await world('live', D2);
    await porkSale(w, manila(D2, '12:00'));
    await porkSale(w, manila(D3, '08:00'));
    const res = await close(w, manila(D3, '10:00'), await pinOf(w, w.managerId));
    expect(res).toMatchObject({ wrote: true, zNo: 1 });
    expect(res.reading.spansTwoDates).toBe(true);
    const days = await salesDaysOf(w);
    expect(days).toHaveLength(1);
    // RULING 1 (8 Nov): the Z closes on D3, so it is dated D3 (the later date of the two it covers). Before the ruling this expected D2.
    expect(days[0]).toMatchObject({ business_date: D3, total_sales: '500.00', cash_collected: '500.00', status: 'submitted' });
  });

  it('the count starts at the OLDEST UNCLOSED RECEIPT, not at the window start: live_from D1 but the first receipt is on D3 at 08:00, now D3 10:00 -> closes', async () => {
    const w = await world('live', D1);
    await porkSale(w, manila(D3, '08:00'));
    await expect(close(w, manila(D3, '10:00'), await pinOf(w, w.managerId))).resolves.toMatchObject({ wrote: true });
  });
});

// ======================================================================================================================
describe('R11 - closeBacklog: one Z per past business day with sales, oldest first, today left open', () => {
  it('a 4-day backlog gives 3 Zs, 3 submitted sales days with their own figures, windows ending at the next 04:00, z_no counting up, and today\'s receipt left open', async () => {
    const w = await world('live', D1);
    await fourDays(w);
    const managerPin = await pinOf(w, w.managerId);
    const was = await counts(w);
    const res = await backlog(w, NOW, await pinOf(w, w.adminId));
    expect(res.wrote).toBe(true);
    expect(res.closes.map((c) => [c.businessDate, c.zNo])).toEqual([[D1, 1], [D2, 2], [D3, 3]]);

    const closes = await closesOf(w);
    expect(closes.map((z) => [z.business_date, z.z_no, z.receipt_count, z.gross_total])).toEqual([
      [D1, 1, 1, '250.00'], [D2, 2, 1, '500.00'], [D3, 3, 1, '250.00'],
    ]);
    expect(closes.map((z) => [z.window_start, z.window_end])).toEqual([
      [manila(D1, '04:00'), manila(D2, '04:00')],
      [manila(D2, '04:00'), manila(D3, '04:00')],
      [manila(D3, '04:00'), manila(D4, '04:00')],
    ]);
    expect(closes.every((z) => z.approved_by === w.adminId && z.closed_by === w.managerId)).toBe(true);

    const days = await salesDaysOf(w);
    expect(days.map((d) => [d.business_date, d.status, d.source, d.total_sales, d.cash_collected])).toEqual([
      [D1, 'submitted', 'pos_receipts', '250.00', '250.00'],
      [D2, 'submitted', 'pos_receipts', '500.00', '500.00'],
      [D3, 'submitted', 'pos_receipts', '250.00', '250.00'],
    ]);
    expect(days.every((d) => d.submitted_by === w.managerId)).toBe(true);

    expect(await openReceiptCount(w), 'today (D4) is left open, to be closed normally').toBe(1);
    expect(closes.some((z) => z.business_date === D4)).toBe(false);

    const now = await counts(w);
    expect(now).toMatchObject({ closes: 3, days: 3, openReceipts: 1, closeAudits: 3, backlogAudits: 1 });
    expect(now.version).toBeGreaterThan(was.version);
    const [b] = await auditsOf(w, 'pos.day_closed_backlog');
    expect(b).toMatchObject({ actor_person_id: w.managerId, store_id: w.storeId });
    const blob = JSON.stringify(b!.after);
    expect(blob).toContain(w.adminId);
    for (const z of closes) expect(blob).toContain(z.id);

    // today's own Z then closes normally from the end of D3's Z (D4 04:00), with the manager's PIN
    await expect(close(w, NOW, managerPin)).resolves.toMatchObject({ wrote: true, zNo: 4 });
  });

  it('a business day with no receipts gets no Z (D2 skipped: Zs for D1 and D3, z_no 1 and 2, no gap)', async () => {
    const w = await world('live', D1);
    await fourDays(w, { skip: [D2] });
    const res = await backlog(w, NOW, await pinOf(w, w.adminId));
    expect(res.closes.map((c) => [c.businessDate, c.zNo])).toEqual([[D1, 1], [D3, 2]]);
    expect((await closesOf(w)).map((z) => z.z_no)).toEqual([1, 2]);
    expect((await salesDaysOf(w)).map((d) => d.business_date)).toEqual([D1, D3]);
  });

  it('each Z id is uuidv5(businessDate, closeRunId), and a replay of the same run writes nothing new (wrote:false)', async () => {
    const w = await world('live', D1);
    await fourDays(w);
    const pin = await pinOf(w, w.adminId);
    const closeRunId = uuid();
    const first = await backlog(w, NOW, pin, { closeRunId });
    expect((await closesOf(w)).map((z) => z.id)).toEqual([D1, D2, D3].map((d) => uuidv5(d, closeRunId)));
    expect(first.closes.map((c) => c.dayCloseId)).toEqual([D1, D2, D3].map((d) => uuidv5(d, closeRunId)));
    const was = await counts(w);
    const again = await backlog(w, manila(D4, '15:00'), pin, { closeRunId });
    expect(again.wrote).toBe(false);
    expect(await counts(w)).toEqual(was);
  });

  it('a non-manager (the cashier) is refused even with a right manager PIN, and nothing is written; the store manager is not', async () => {
    const w = await world('live', D1);
    await fourDays(w);
    const pin = await pinOf(w, w.adminId);
    const was = await counts(w);
    await expectRefused(backlog(w, NOW, pin, { who: w.counter }));
    await expectRefused(backlog(w, NOW, pin, { who: w.kitchen }));
    expect(await counts(w)).toEqual(was);
    await expect(backlog(w, NOW, pin, { who: w.manager })).resolves.toMatchObject({ wrote: true });
  });

  it('a manager of another store is refused', async () => {
    const w = await world('live', D1);
    await fourDays(w);
    await expectRefused(backlog(w, NOW, await pinOf(w, w.adminId), { who: w.managerOther }));
    expect(await closesOf(w)).toHaveLength(0);
  });

  it('a wrong PIN is refused and COUNTED although the transaction rolled back: 4 wrong leave the right one working, 6 wrong trip the cap even for the right PIN', async () => {
    const w = await world('live', D1);
    await fourDays(w);
    const pin = await pinOf(w, w.adminId);
    for (let i = 0; i < 4; i++) await expect(backlog(w, NOW, '999999')).rejects.toBeInstanceOf(AuthenticationError);
    await expect(backlog(w, NOW, pin), 'four misses are under the cap of five').resolves.toMatchObject({ wrote: true });

    const w2 = await world('live', D1);
    await fourDays(w2);
    for (let i = 0; i < 6; i++) await expect(backlog(w2, NOW, '999999')).rejects.toBeInstanceOf(AuthenticationError);
    const err = await backlog(w2, NOW, await pinOf(w2, w2.adminId)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toContain(POS_APPROVAL_PIN_CAPPED);
    expect(await closesOf(w2)).toHaveLength(0);
  });

  it('it is one transaction: a day that cannot derive its sales day (a live feed day exists for D2) rolls the WHOLE run back, D1\'s Z included', async () => {
    const w = await world('live', D1);
    await fourDays(w);
    await sql`update pos_stores set live_from = ${FAR} where store_id = ${w.storeId}`;
    await insertDerivedSalesDayRow(sql, { orgId: w.orgId, storeId: w.storeId, businessDate: D2, createdBy: w.adminId, posStoreId: w.posStoreId });
    await sql`update pos_stores set live_from = ${D1} where store_id = ${w.storeId}`;
    const was = await counts(w);
    const err = await backlog(w, NOW, await pinOf(w, w.adminId)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe(`A sales day for ${D2} already exists (pos_v1_day_feed). Ask an accountant.`);
    expect(await counts(w)).toEqual({ ...was });
    expect(await openReceiptCount(w)).toBe(4);
  });
});

// ======================================================================================================================
// Added by the BUILDER (audit fix 3): a LIVE store ignores unclosed receipts of business days before live_from. They are test-mode receipts from before the switch (the
// T-533 runbook purges them): they must neither block a Z with "more than 2 days" nor be closed into a day the 0247 guard would refuse.
describe('live store with old test-mode receipts (before live_from)', () => {
  it('closeDay closes normally: only the receipts on or after live_from are read and frozen; the old ones stay open and untouched; the sales day holds only the new figures', async () => {
    const w = await world('live', D2);
    await porkSale(w, manila(D1, '11:00'));
    await porkSale(w, manila(D1, '12:00'));
    await porkSale(w, manila(D2, '12:00'));
    const res = await close(w, manila(D2, '22:00'), await pinOf(w, w.managerId));
    expect(res).toMatchObject({ wrote: true, zNo: 1 });
    expect(res.reading).toMatchObject({ receiptCount: 1, grossTotal: '250.00', lateCount: 0 });
    expect((await closesOf(w))[0]).toMatchObject({ business_date: D2, receipt_count: 1, gross_total: '250.00' });
    expect((await closesOf(w))[0]!.window_start).toEqual(manila(D2, '04:00'));
    expect((await salesDaysOf(w)).map((d) => [d.business_date, d.total_sales])).toEqual([[D2, '250.00']]);
    expect(await openReceiptCount(w), 'the two pre-switch receipts are untouched').toBe(2);
  });

  it('they do not count towards the 2-day limit: old receipts on D1 and a sale on D4 (live from D4) still close', async () => {
    const w = await world('live', D4);
    await porkSale(w, manila(D1, '12:00'));
    await porkSale(w, manila(D4, '12:00'));
    await expect(close(w, manila(D4, '22:00'), await pinOf(w, w.managerId))).resolves.toMatchObject({ wrote: true, zNo: 1 });
    expect(await openReceiptCount(w)).toBe(1);
  });

  it('closeBacklog never tries a day before live_from: live from D3, receipts on D1 (old), D3 and D4, now D5 -> Zs for D3 and D4 only, the D1 receipt stays open', async () => {
    const w = await world('live', D3);
    await porkSale(w, manila(D1, '12:00'));
    await porkSale(w, manila(D3, '12:00'));
    await porkSale(w, manila(D4, '12:00'));
    const res = await backlog(w, manila(D5, '10:00'), await pinOf(w, w.adminId));
    expect(res.closes.map((c) => [c.businessDate, c.zNo])).toEqual([[D3, 1], [D4, 2]]);
    expect((await salesDaysOf(w)).map((d) => d.business_date)).toEqual([D3, D4]);
    expect(await openReceiptCount(w)).toBe(1);
  });
});
