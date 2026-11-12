/**
 * T-531 R3 / R4 (TESTER) - `closeDay` and the sales day it derives. docs/tasks/531-pos-day-close.md R3, R4, R8 "Close". Real Postgres on a scratch "_test" database.
 *
 * ASSUMED API (see the header of `_fixtures/t531-day-close.ts` for the full list):
 *   closeDay(tx, actor, { storeId, pairingId, terminalId, closeId, approval: { pin } }, deps) -> { wrote, dayCloseId, zNo, reading, salesDayId }
 *     R3 lists `{storeId, terminalId, closeId, approval}`; `pairingId` is added because requireContext (R1 of T-524) needs the tablet. If the builder does not take it, the extra key is ignored.
 *   posV2Repo.closeReceipts(tx, orgId, storeId, dayCloseId, receiptIds) -> number of rows updated (WHERE day_close_id IS NULL), R3 step 5.
 *   audit actions: 'pos.day_closed' { before: null, after: { zNo, receiptCount, grossTotal, approvedBy, ... } }, 'sales_day.derived_from_z' (entity = the sales day).
 *     The `after` key NAMES are assumed from R3 step 7 ("z_no, window, count, gross, byTender, approvedBy"): zNo, receiptCount, grossTotal, approvedBy.
 * Sentences asserted EXACTLY (R3, R4): "There are no sales to close since the last Z.", "Another close is in progress. Try again.",
 *   "A sales day for <date> already exists (<source>). Ask an accountant." (the date is ISO, as the spec writes <date>; source is the stored value).
 *
 * The clock is `deps.now` (T-524 PosDeps). Business day starts 04:00 (RATES). Selling after a Z on the SAME business date is deliberately not tested (hand-back Q1).
 *
 * RED NOW FOR THE RIGHT REASON: packages/domain/src/pos/day-close.ts does not exist ("MISSING EXPORT ... (T-531 not built)", after the fixture ran).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { posV2Repo, RefusalError } from '@shareat/db';
import { AuthenticationError, AuthorizationError, POS_APPROVAL_PIN_CAPPED, POS_APPROVAL_REFUSED } from '@shareat/auth';
import {
  D1, D2, D3, DC, FAR, asOrg, auditsOf, channelRowsOf, clockAt, close, closeAll, closeTendersOf, closesOf, gcashAccountId, manila, openReceiptCount, pinOf, porkSale, receiptsOfClose, salesDayTendersOf,
  salesDaysOf, secondTerminal, sell, sql, standardDay, stateVersion, tenderMap, uuid, world, type World,
} from './_fixtures/t531-day-close';
import { insertDerivedSalesDayRow } from './_fixtures/pos-day';

afterAll(closeAll);

const NO_SALES = 'There are no sales to close since the last Z.';
const RACE = 'Another close is in progress. Try again.';
const NOT_ON = 'The new POS is not switched on for this store yet.';

async function expectRefusal(p: Promise<unknown>, sentence: string | string[]) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  const msg = (err as RefusalError).userMessage;
  if (Array.isArray(sentence)) expect(sentence).toContain(msg);
  else expect(msg).toBe(sentence);
  expect(msg, 'no UUID in a sentence').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
}
const counts = async (w: World) => ({
  closes: (await closesOf(w)).length,
  days: (await salesDaysOf(w)).length,
  openReceipts: await openReceiptCount(w),
  closeAudits: (await auditsOf(w, 'pos.day_closed')).length,
  derivedAudits: (await auditsOf(w, 'sales_day.derived_from_z')).length,
  version: await stateVersion(w),
});
const AT = manila(D1, '22:30');

// ======================================================================================================================
describe('R3 - the happy path: the first Z of a live store, the standard day', () => {
  it('one pos_day_closes row, its tender rows (net collected), every receipt frozen to it, the sales day derived and SUBMITTED with the right figures, audits written', async () => {
    const w = await world();
    const day = await standardDay(w);
    const managerPin = await pinOf(w, w.managerId);
    const was = await counts(w);
    const res = await close(w, AT, managerPin);

    expect(res).toMatchObject({ wrote: true, zNo: 1 });
    expect(res.reading).toMatchObject({ receiptCount: 3, grossTotal: '2896.71' });

    const closes = await closesOf(w);
    expect(closes).toHaveLength(1);
    const z = closes[0]!;
    expect(z).toMatchObject({ id: res.dayCloseId, z_no: 1, business_date: D1, receipt_count: 3, gross_total: '2896.71', closed_by: w.counterId, approved_by: w.managerId, terminal_id: w.terminalId });
    expect(z.window_start).toEqual(manila(D1, '04:00'));
    expect(z.window_end).toEqual(AT);
    expect((await closeTendersOf(z.id)).map((t) => [t.tender_id, t.amount])).toEqual([[w.cash, '2396.71'], [w.gcash, '500.00']]);

    expect((await receiptsOfClose(z.id)).map((r) => r.id).sort()).toEqual(day.map((d) => d.receiptId).sort());
    expect(await openReceiptCount(w)).toBe(0);

    const days = await salesDaysOf(w);
    expect(days).toHaveLength(1);
    expect(res.salesDayId).toBe(days[0]!.id);
    expect(days[0]).toMatchObject({
      business_date: D1, status: 'submitted', source: 'pos_receipts', pos_day_close_id: z.id,
      total_sales: '3075.00', unli_sales: '2245.00', ala_carte_sales: '830.00', senior_discount: '128.29', pwd_discount: '0.00', other_discount: '50.00',
      comps: '0.00', refunds: '0.00', service_charge: '0.00', other_charges: '0.00', cash_collected: '2396.71', online_collected: '500.00', credit_sales: '0.00',
      submitted_by: w.counterId, created_by: w.counterId, journal_entry_id: null,
    });
    expect((await salesDayTendersOf(days[0]!.id)).map((t) => [t.money_account_id, t.amount])).toEqual([[await gcashAccountId(w), '500.00']]);
    expect(await channelRowsOf(days[0]!.id), 'sales_day_channels stays empty: the POS has no remitted channels').toBe(0);

    const now = await counts(w);
    expect(now).toMatchObject({ closes: 1, days: 1, openReceipts: 0, closeAudits: 1, derivedAudits: 1 });
    expect(now.version, 'state_version bumped (R3 step 7)').toBeGreaterThan(was.version);
    const [closedAudit] = await auditsOf(w, 'pos.day_closed');
    expect(closedAudit).toMatchObject({ actor_person_id: w.counterId, store_id: w.storeId, entity_id: z.id, before: null });
    expect(closedAudit!.after).toMatchObject({ zNo: 1, receiptCount: 3, grossTotal: '2896.71', approvedBy: w.managerId });
    expect((await auditsOf(w, 'sales_day.derived_from_z'))[0]).toMatchObject({ entity_id: days[0]!.id, store_id: w.storeId });
  });

  it('the manager\'s PIN text is nowhere: not in any audit row, not in the Z, not in the sales day', async () => {
    const w = await world();
    await standardDay(w);
    const pin = await pinOf(w, w.managerId);
    await close(w, AT, pin);
    const [row] = await sql<{ blob: string }[]>`
      select (select coalesce(string_agg(row_to_json(a)::text, ' '), '') from audit_log a where a.org_id = ${w.orgId})
          || (select coalesce(string_agg(row_to_json(c)::text, ' '), '') from pos_day_closes c where c.org_id = ${w.orgId})
          || (select coalesce(string_agg(row_to_json(d)::text, ' '), '') from sales_days d where d.org_id = ${w.orgId}) as blob`;
    const blob = row!.blob;
    expect(blob).not.toContain(`"pin"`);
    expect(blob).not.toContain(`:"${pin}"`);
    expect(blob).not.toContain(`"${pin}"`);
  });

  it('an active ADMIN\'s PIN approves too (approved_by is the approver, not the cashier)', async () => {
    const w = await world();
    await porkSale(w, manila(D1, '12:00'));
    const res = await close(w, AT, await pinOf(w, w.adminId));
    expect(res.wrote).toBe(true);
    expect((await closesOf(w))[0]).toMatchObject({ closed_by: w.counterId, approved_by: w.adminId });
  });
});

// ======================================================================================================================
describe('R3 step 2 / 3 - idempotency and the empty close', () => {
  it('a replay of the same closeId returns wrote:false with the same Z and writes nothing (no second Z, sales day, audit or version bump)', async () => {
    const w = await world();
    await standardDay(w);
    const pin = await pinOf(w, w.managerId);
    const closeId = uuid();
    const first = await close(w, AT, pin, { closeId });
    const was = await counts(w);
    const again = await close(w, manila(D1, '23:10'), pin, { closeId });
    expect(again).toMatchObject({ wrote: false, dayCloseId: first.dayCloseId, zNo: 1 });
    expect(await counts(w)).toEqual(was);
    expect(first.dayCloseId, 'the device id IS the row id (idempotent by id)').toBe(closeId);
  });

  it('no receipts since the last Z is refused with the exact sentence and writes nothing; so is a second close right after a Z', async () => {
    const w = await world();
    const pin = await pinOf(w, w.managerId);
    const was = await counts(w);
    await expectRefusal(close(w, AT, pin), NO_SALES);
    expect(await counts(w)).toEqual(was);

    await porkSale(w, manila(D1, '12:00'));
    await close(w, AT, pin);
    const after = await counts(w);
    await expectRefusal(close(w, manila(D1, '23:30'), pin), NO_SALES);
    expect(await counts(w)).toEqual(after);
  });

  it('a store switched off refuses with the T-524 sentence (the close is a till write)', async () => {
    const w = await world();
    await porkSale(w, manila(D1, '12:00'));
    await sql`update pos_stores set mode = 'off', live_from = null where store_id = ${w.storeId}`;
    await expectRefusal(close(w, AT, await pinOf(w, w.managerId)), NOT_ON);
  });
});

// ======================================================================================================================
describe('R3 step 1 - who may close, who may approve, and what a wrong PIN costs', () => {
  it('a wrong PIN is refused (the one approval sentence), and nothing is written', async () => {
    const w = await world();
    await standardDay(w);
    const was = await counts(w);
    const err = await close(w, AT, '999999').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toBe(POS_APPROVAL_REFUSED);
    expect(await counts(w)).toEqual(was);
  });

  it('the miss COMMITS although the close rolled back, and exactly once: 4 wrong PINs leave the right one working', async () => {
    const w = await world();
    await standardDay(w);
    const pin = await pinOf(w, w.managerId);
    for (let i = 0; i < 4; i++) await expect(close(w, AT, '999999')).rejects.toBeInstanceOf(AuthenticationError);
    const res = await close(w, AT, pin);
    expect(res.wrote, 'four misses are under the cap of five: a double charge would have capped it').toBe(true);
  });

  it('six wrong PINs trip the cap; the next attempt, even with the RIGHT PIN, is refused the way the cap refuses, and no Z is written', async () => {
    const w = await world();
    await standardDay(w);
    const pin = await pinOf(w, w.managerId);
    for (let i = 0; i < 6; i++) await expect(close(w, AT, '999999')).rejects.toBeInstanceOf(AuthenticationError);
    const err = await close(w, AT, pin).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toContain(POS_APPROVAL_PIN_CAPPED);
    expect(await closesOf(w)).toHaveLength(0);
    expect(await openReceiptCount(w)).toBe(3);
  });

  it('a person without record_sale (the kitchen) is refused before anything is read; nothing is written', async () => {
    const w = await world();
    await porkSale(w, manila(D1, '12:00'));
    const was = await counts(w);
    await expect(close(w, AT, await pinOf(w, w.managerId), { who: w.kitchen })).rejects.toBeInstanceOf(AuthorizationError);
    expect(await counts(w)).toEqual(was);
  });

  it('a manager PIN from ANOTHER store, and a cashier\'s own PIN, cannot approve (the one approval sentence); the store\'s own manager can', async () => {
    const w = await world();
    await porkSale(w, manila(D1, '12:00'));
    for (const person of [w.managerOtherId, w.counterId]) {
      const err = await close(w, AT, await pinOf(w, person)).then(() => null, (e: unknown) => e);
      expect(err, 'expected the approval to be refused').toBeInstanceOf(AuthenticationError);
      expect((err as Error).message).toBe(POS_APPROVAL_REFUSED);
    }
    expect(await closesOf(w)).toHaveLength(0);
    await expect(close(w, AT, await pinOf(w, w.managerId))).resolves.toMatchObject({ wrote: true });
  });
});

// ======================================================================================================================
describe('R3 step 5 - closeReceipts: the one-time column write, counted', () => {
  it('returns the number of rows it closed, only closes receipts that are still open, and a second call closes none', async () => {
    const w = await world();
    const day = await standardDay(w);
    const [z] = await sql<{ id: string }[]>`
      insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
      values (${w.orgId}, ${w.storeId}, ${w.terminalId}, 1, ${D1}, ${manila(D1, '04:00')}, ${AT}, 3, 2896.71, ${w.counterId}, ${w.managerId}) returning id`;
    const ids = day.map((d) => d.receiptId);
    const [n1, n2, n3] = await asOrg(w.orgId, async (tx) => [
      await posV2Repo.closeReceipts(tx, w.orgId, w.storeId, z!.id, ids.slice(0, 2)),
      await posV2Repo.closeReceipts(tx, w.orgId, w.storeId, z!.id, ids),
      await posV2Repo.closeReceipts(tx, w.orgId, w.storeId, z!.id, ids),
    ]);
    expect([n1, n2, n3]).toEqual([2, 1, 0]);
    expect((await receiptsOfClose(z!.id)).length).toBe(3);
  });
});

// ======================================================================================================================
describe('R4 - the sales day: refusals roll the WHOLE close back; test mode never books', () => {
  it('a live sales day already there for the date (a v1 feed day) refuses with the exact sentence and rolls everything back (no day_close_id set)', async () => {
    const w = await world('live', D1);
    await standardDay(w);
    // The new 0247 guard refuses a feed day on/after live_from, so make the old day while live_from is later, then put live_from back.
    await sql`update pos_stores set live_from = ${FAR} where store_id = ${w.storeId}`;
    await insertDerivedSalesDayRow(sql, { orgId: w.orgId, storeId: w.storeId, businessDate: D1, createdBy: w.adminId, posStoreId: w.posStoreId });
    await sql`update pos_stores set live_from = ${D1} where store_id = ${w.storeId}`;
    const was = await counts(w);
    await expectRefusal(close(w, AT, await pinOf(w, w.managerId)), `A sales day for ${D1} already exists (pos_v1_day_feed). Ask an accountant.`);
    const now = await counts(w);
    expect(now).toEqual(was);
    expect(now.openReceipts, 'no receipt got a day_close_id').toBe(3);
    expect(now.closes).toBe(0);
  });

  it('a second terminal\'s Z on the same business date is refused for the sales day (row 313: one billing tablet), and its Z rolls back too', async () => {
    const w = await world('live', D1);
    const t2 = await secondTerminal(w);
    await porkSale(w, manila(D1, '12:00'));
    await sell(w, { at: manila(D1, '13:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', pay: [{ tenderId: w.cash, amount: '500.00' }], terminal: t2 });
    const pin = await pinOf(w, w.managerId);
    await close(w, AT, pin); // terminal 1 closes D1
    const was = await counts(w);
    const second = t2.use(() => asOrg(w.orgId, (tx) =>
      DC.closeDay(tx, w.counter, { storeId: w.storeId, pairingId: t2.pairingId, terminalId: t2.terminalId, closeId: uuid(), approval: { pin } }, clockAt(AT))));
    await expectRefusal(second, `A sales day for ${D1} already exists (pos_receipts). Ask an accountant.`);
    expect(await counts(w)).toEqual(was);
    expect(await openReceiptCount(w), 'terminal 2\'s receipt stays open').toBe(1);
  });

  it('TEST mode: the Z closes (row, tenders, receipts frozen) but NO sales day is created and no derivation audit is written (test mode never books)', async () => {
    const w = await world('test');
    await standardDay(w);
    const res = await close(w, AT, await pinOf(w, w.managerId));
    expect(res.wrote).toBe(true);
    expect(res.salesDayId).toBeNull();
    const [z] = await closesOf(w);
    expect(z).toMatchObject({ receipt_count: 3, gross_total: '2896.71' });
    expect(z!.window_end).toEqual(AT);
    expect(await openReceiptCount(w)).toBe(0);
    expect(await salesDaysOf(w)).toHaveLength(0);
    expect((await auditsOf(w, 'sales_day.derived_from_z')).length).toBe(0);
    expect((await auditsOf(w, 'pos.day_closed')).length).toBe(1);
  });
});

// ======================================================================================================================
describe('R3 step 5 - concurrent closes', () => {
  it('two closes of the same window at once: one wins, the other is refused, and no receipt is in two closes (one Z, one sales day)', async () => {
    const w = await world();
    await standardDay(w);
    const pin = await pinOf(w, w.managerId);
    const settled = await Promise.allSettled([close(w, AT, pin), close(w, AT, pin)]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const bad = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect({ ok: ok.length, bad: bad.length }).toEqual({ ok: 1, bad: 1 });
    expect(bad[0]!.reason).toBeInstanceOf(RefusalError);
    expect([RACE, NO_SALES]).toContain((bad[0]!.reason as RefusalError).userMessage);
    const closes = await closesOf(w);
    expect(closes).toHaveLength(1);
    expect((await receiptsOfClose(closes[0]!.id)).length).toBe(3);
    expect(await openReceiptCount(w)).toBe(0);
    expect(await salesDaysOf(w)).toHaveLength(1);
  });
});

// ======================================================================================================================
describe('R2/R3 - selling after a Z: the next Z\'s window starts at the previous end', () => {
  // RULING 1 (8 Nov): a Z is dated with the business day it CLOSES: max(lastZ.business_date + 1, startHourDate(windowEnd)). The late Z at D2 05:30 is dated D2 (it covers D1 and a few
  // hours of D2: row 390's forgotten Z takes the later date); the next Z, at D2 22:00, is dated D3. (Before the ruling this test expected D1 and D2.)
  it('a late Z at 05:30 on D2 closes D1 (a two-date window: allowed, row 390\'s forgotten Z) and is dated D2; the next Z starts at 05:30, gets z_no 2, the business date D3 and its own sales day', async () => {
    const w = await world('live', D1);
    await standardDay(w);
    const pin = await pinOf(w, w.managerId);
    const z1 = await close(w, manila(D2, '05:30'), pin);
    expect(z1).toMatchObject({ wrote: true, zNo: 1 });
    expect(z1.reading.spansTwoDates, 'D1 04:00 to D2 05:30 touches two business dates').toBe(true);
    expect((await closesOf(w))[0]).toMatchObject({ business_date: D2, receipt_count: 3 });

    await porkSale(w, manila(D2, '12:00'));
    const z2 = await close(w, manila(D2, '22:00'), pin);
    expect(z2).toMatchObject({ wrote: true, zNo: 2 });
    const [a, b] = await closesOf(w);
    expect(b!.window_start, 'the next Z starts where the previous ended').toEqual(a!.window_end);
    expect(b).toMatchObject({ z_no: 2, business_date: D3, receipt_count: 1, gross_total: '250.00' });
    expect(tenderMap(z2.reading)[w.cash]).toBe('250.00');

    const days = await salesDaysOf(w);
    expect(days.map((d) => [d.business_date, d.status, d.source, d.total_sales, d.cash_collected])).toEqual([
      [D2, 'submitted', 'pos_receipts', '3075.00', '2396.71'],
      [D3, 'submitted', 'pos_receipts', '250.00', '250.00'],
    ]);
    expect(await openReceiptCount(w)).toBe(0);
  });
});
