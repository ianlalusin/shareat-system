import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S7b (BUILDER, 11 Nov 2026) - what the review screen reads and the one door it books a charge through. Real Postgres, real ingest, real posting.
 * docs/tasks/511-settlement-upload-s7b-spec.md Rulings 2 and 3.
 *
 *  - `bookPeriodCharge(tx, actor, { otherLineId })`: the gate of the charge's store in this screen's own words (no store named), then the uploader rule (a non-admin who
 *    uploaded the charge's file is refused; an administrator, tested by `override_period_lock`, is exempt), then `postPlatformCharge` unchanged.
 *  - `listPeriodCharges(tx, actor)`: every staged period charge of the stores the actor may review, posted or not, with a state and a plain reason.
 *  - `getReviewDayDetail` gains canApprove / approveWhy / isCarrier / carrierNote / invoiceCharges / bookedOn / undoNote.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, settlementIntakeRepo } from '@shareat/db';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { D1, D3, approve, asOrg, entryCount, fpInvoice, fpWeek, ingest, lineText, linesOf, postCharge, s7World, sentenceOf, setDestination, zip, type S7World } from './_fixtures/t511-s7a-world';
import { rawOtherLine } from './_fixtures/t511-s6c-world';

const sql = postgres(url, { max: 10 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STORE_NAMES = /Lipa|Malvar|Banay/i;

type BookFn = (tx: unknown, actor: unknown, input: { otherLineId: string }) => Promise<{ posted: boolean; chargeId?: string; journalEntryId?: string }>;
const bookFn = (): BookFn => (D as unknown as { bookPeriodCharge: BookFn }).bookPeriodCharge;
const book = (w: { orgId: string }, who: { personId: string; orgId: string }, otherLineId: string) => asOrg(w.orgId, (tx) => bookFn()(tx, who, { otherLineId }));
const detail = (w: { orgId: string }, who: { personId: string; orgId: string }, lineId: string) => asOrg(w.orgId, (tx) => D.getReviewDayDetail(tx, who, { lineId }));
const listCharges = (w: { orgId: string }, who: { personId: string; orgId: string }) => asOrg(w.orgId, (tx) => D.listPeriodCharges(tx, who));

/* ================================================================== bookPeriodCharge */

describe('S7b bookPeriodCharge - the uploader rule, the scope, then postPlatformCharge', () => {
  it('a manager who did NOT upload books the charge: Dr 6400 112.00 / Cr 1220 112.00, and booking it again is a quiet no-op [kills: a book that does not delegate to postPlatformCharge; a second posting]', async () => {
    const f = await fpWeek(sql, 'b-ok', { charge: true });
    const w = f.w;
    const r = await book(w, w.managerA2, f.chargeLineId!);
    expect(r.posted).toBe(true);
    expect(lineText(await linesOf(sql, r.journalEntryId!))).toEqual(['Cr 1220 112.00', 'Dr 6400 112.00']);
    const entries = await entryCount(sql, w.orgId);
    expect((await book(w, w.managerA2, f.chargeLineId!)).posted).toBe(false);
    expect(await entryCount(sql, w.orgId)).toBe(entries);
  });

  it('the manager who uploaded the invoice is refused in plain words (no store, no id) and nothing is booked [kills: the uploader allowed; a store named; a posting before the refusal]', async () => {
    const f = await fpWeek(sql, 'b-up', { charge: true });
    const w = f.w;
    const before = await entryCount(sql, w.orgId);
    const sentence = await sentenceOf(book(w, w.managerA, f.chargeLineId!));
    expect(sentence).toMatch(/uploaded/i);
    expect(sentence).not.toMatch(UUID_ANY);
    expect(sentence).not.toMatch(STORE_NAMES);
    expect(await entryCount(sql, w.orgId)).toBe(before);
  });

  it('an administrator who uploaded the invoice may book its charge (override_period_lock, the rule approveDay keeps) [kills: the admin held to the rule]', async () => {
    const w = await s7World(sql, 'b-admin');
    await setDestination(sql, w, w.fpA);
    await ingest(w, w.admin, zip(fpInvoice([{ date: D1, gross: 9000, fees: 1800 }], { periodChargeNet: 100 })));
    const [c] = await listCharges(w, w.admin);
    expect(c?.canBook, 'the admin sees a bookable charge').toBe(true);
    expect((await book(w, w.admin, c!.otherLineId)).posted).toBe(true);
  });

  it('a manager of ANOTHER store is refused by scope, in words that name no store; an id that is not a charge is "not found" [kills: scope ignored; a store named; a raw error]', async () => {
    const f = await fpWeek(sql, 'b-scope', { charge: true });
    const w = f.w;
    const before = await entryCount(sql, w.orgId);
    const sentence = await sentenceOf(book(w, w.managerC, f.chargeLineId!));
    expect(sentence).not.toMatch(STORE_NAMES);
    expect(sentence).not.toMatch(UUID_ANY);
    expect(await sentenceOf(book(w, w.managerA2, '00000000-0000-4000-8000-000000000000'))).toMatch(/not found/i);
    expect(await sentenceOf(book(w, w.managerA2, 'not an id'))).toMatch(/not found/i);
    expect(await entryCount(sql, w.orgId)).toBe(before);
  });
});

/* ================================================================== listPeriodCharges and the invoice panel */

describe('S7b the charges the screen shows', () => {
  it('a Foodpanda week: the charge is on every day of its invoice, not booked yet; the person who uploaded sees it cannot be booked by them, another manager can book it [kills: charges only on one day; canBook ignoring the uploader rule; a total that is not net + VAT]', async () => {
    const f = await fpWeek(sql, 'r-panel', { charge: true });
    const w = f.w;
    for (const d of [D1, D3]) {
      const dd = (await detail(w, w.managerA2, f.lines[d]!))!;
      expect(dd.invoiceCharges, d).toHaveLength(1);
      const c = dd.invoiceCharges[0]!;
      expect([c.state, c.net, c.vat, c.total, c.canBook, c.why]).toEqual(['not_booked', '100.00', '12.00', '112.00', true, null]);
      expect(c.invoiceNumber).toBe('200777000001');
    }
    const own = (await detail(w, w.managerA, f.lines[D1]!))!.invoiceCharges[0]!;
    expect([own.state, own.canBook]).toEqual(['not_booked', false]);
    expect(own.why).toMatch(/uploaded/i);
    expect(own.why).not.toMatch(UUID_ANY);
  });

  it('the carrier day: the note appears only on the latest day, only once a charge is booked, with the count and the total; the other days and a Grab day have none [kills: the note on every day; a note before booking; a wrong total]', async () => {
    const f = await fpWeek(sql, 'r-carrier', { charge: true });
    const w = f.w;
    const d3 = (await detail(w, w.managerA2, f.lines[D3]!))!;
    expect([d3.isCarrier, d3.carrierNote], 'nothing booked yet: the day is the carrier but has nothing to net').toEqual([true, null]);
    expect((await detail(w, w.managerA2, f.lines[D1]!))!.isCarrier).toBe(false);
    await book(w, w.managerA2, f.chargeLineId!);
    const after = (await detail(w, w.managerA2, f.lines[D3]!))!;
    expect(after.carrierNote).toMatch(/^This payout also settles 1 charge of this invoice\. The bank deposit is the file's net minus 112\.00\.$/);
    expect((await detail(w, w.managerA2, f.lines[D1]!))!.carrierNote).toBeNull();
    expect(after.invoiceCharges[0]!.state).toBe('booked');
    expect(after.invoiceCharges[0]!.canBook).toBe(false);
    expect(after.invoiceCharges[0]!.why).toBeNull();
  });

  it('who may approve: the uploader is told so in plain words, another manager and an administrator may; a decided day cannot be approved [kills: canApprove ignoring the uploader; the admin exemption missing; a booked day approvable]', async () => {
    const f = await fpWeek(sql, 'r-who', { charge: true });
    const w = f.w;
    const own = (await detail(w, w.managerA, f.lines[D1]!))!;
    expect([own.canApprove, own.approveWhy]).toEqual([false, 'You uploaded a file this day comes from, so someone else must approve it.']);
    const other = (await detail(w, w.managerA2, f.lines[D1]!))!;
    expect([other.canApprove, other.approveWhy]).toEqual([true, null]);
    expect((await detail(w, w.admin, f.lines[D1]!))!.canApprove).toBe(true);
    await approve(w, w.managerA2, f.lines[D1]!);
    const booked = (await detail(w, w.managerA2, f.lines[D1]!))!;
    expect([booked.canApprove, booked.approveWhy]).toEqual([false, null]);
  });

  it('a booked day says the date it was booked on and how to undo it [kills: a booked day with no way back; the wrong date]', async () => {
    const f = await fpWeek(sql, 'r-booked', {});
    const w = f.w;
    const pending = (await detail(w, w.managerA2, f.lines[D1]!))!;
    expect([pending.bookedOn, pending.undoNote]).toEqual([null, null]);
    await approve(w, w.managerA2, f.lines[D1]!);
    const booked = (await detail(w, w.managerA2, f.lines[D1]!))!;
    expect(booked.bookedOn).toBe(D1);
    expect(booked.undoNote).toMatch(/administrator/);
    expect(booked.undoNote).toMatch(/Overview/);
  });

  it('the list covers a fee-only invoice that has no day row, newest first, and only for the stores the person may review [kills: a charge with no day invisible; another store\'s charge listed]', async () => {
    const w = await s7World(sql, 'r-feeonly');
    const up = await ingest(w, w.managerA, zip(fpInvoice([], { periodChargeNet: 100 })));
    expect(up).toBeTruthy();
    const mine = await listCharges(w, w.managerA2);
    expect(mine).toHaveLength(1);
    expect([mine[0]!.net, mine[0]!.total, mine[0]!.state, mine[0]!.canBook]).toEqual(['100.00', '112.00', 'not_booked', true]);
    expect(await listCharges(w, w.managerC), 'a manager of another store sees none').toEqual([]);
    expect((await listCharges(w, w.managerA))[0]!.canBook, 'the uploader may not book it').toBe(false);
  });

  it('a replaced upload\'s charge shows as replaced, and the same charge already booked from an earlier copy says so [kills: a charge from an old file offered for booking; the same-copy refusal discovered only by pressing the button]', async () => {
    const w: S7World = await s7World(sql, 'r-replaced');
    await setDestination(sql, w, w.fpA);
    const days = [{ date: D1, gross: 9000, fees: 1800 }];
    await ingest(w, w.managerA, zip(fpInvoice(days, { periodChargeNet: 100, tag: 'v1' })));
    const first = await listCharges(w, w.managerA2);
    expect(first.map((c) => c.state)).toEqual(['not_booked']);
    const r = await book(w, w.managerA2, first[0]!.otherLineId);
    expect(r.posted).toBe(true);
    await ingest(w, w.managerA, zip(fpInvoice(days, { periodChargeNet: 100, tag: 'v2' })));
    const both = await listCharges(w, w.managerA2);
    expect(both.length, 'the old charge and the new one').toBe(2);
    const states = both.map((c) => c.state).sort();
    expect(states).toEqual(['booked', 'cannot_book']);
    const copy = both.find((c) => c.state === 'cannot_book')!;
    expect(copy.canBook).toBe(false);
    expect(copy.why).toMatch(/already booked/i);
    expect(copy.why).not.toMatch(UUID_ANY);
  });

  it('an unbooked charge of an upload that was replaced shows as replaced and cannot be booked [kills: booking from a file a newer upload replaced]', async () => {
    const w: S7World = await s7World(sql, 'r-replaced2');
    const days = [{ date: D1, gross: 9000, fees: 1800 }];
    await ingest(w, w.managerA, zip(fpInvoice(days, { periodChargeNet: 100, tag: 'v1' })));
    await ingest(w, w.managerA, zip(fpInvoice(days, { periodChargeNet: 100, tag: 'v2' })));
    const all = await listCharges(w, w.managerA2);
    const replaced = all.filter((c) => c.state === 'replaced');
    expect(replaced.length, `states: ${all.map((c) => c.state).join(',')}`).toBeGreaterThanOrEqual(1);
    for (const c of replaced) {
      expect(c.canBook).toBe(false);
      expect(c.why).toMatch(/newer/i);
    }
    expect(all.filter((c) => c.canBook)).toHaveLength(1);
  });

  it('charges still waiting to be booked come first, then the rest newest first, and the cap is applied AFTER that, so an old unbooked charge never falls off [kills: a plain newest-first cap that drops the one charge that needs a person]', async () => {
    const w: S7World = await s7World(sql, 'r-order');
    const mk = (lineDate: string, description: string) =>
      rawOtherLine(sql, { orgId: w.orgId, storeId: w.storeA, channelId: w.fpA, personId: w.admin.personId, net: '100.00', vat: '12.00', lineDate, description });
    const old = await mk('2026-10-01', 'Old unbooked');
    const newer = await mk('2026-10-14', 'Newer booked');
    expect((await postCharge(w, w.admin, newer)).posted).toBe(true);

    const shown = await listCharges(w, w.managerA2);
    expect(shown.map((c) => [c.description, c.state])).toEqual([['Old unbooked', 'not_booked'], ['Newer booked', 'booked']]);
    const capped = await asOrg(w.orgId, (tx) => settlementIntakeRepo.periodChargeFacts(tx, w.orgId, { storeIds: [w.storeA], limit: 1 }));
    expect(capped.map((f) => f.otherLineId), 'one place: the unbooked charge keeps it').toEqual([old]);
  });
});
