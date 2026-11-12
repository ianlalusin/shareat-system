import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S6b (TESTER, 7 Nov 2026) - `correctPlatformSales`: the file figure replaces the staff figure in sales and the receivable through a correcting entry.
 * docs/tasks/511-settlement-upload-s6-spec.md "S6b"; design decision 17 (option B) and BOSS rulings. Real Postgres, real posting.
 *
 * RED TODAY, for one reason: `packages/domain/src/channel-settlements/correction.ts` does not exist (a missing module, acceptable for this one new file), and
 * migration 0243 (`sales_day_platform_corrections`) does not exist. Each leg loads the module lazily (`_fixtures/t511-s6b-world.ts` `correct`), so each fails
 * on its own "Failed to resolve import" and the controls that do not call it pass.
 *
 * PINNED (the builder meets these or asks BOSS to change the tests; the spec leaves each open):
 *  P1  `correctPlatformSales(tx, actor, { dayLineId, reason, today? })` returns `{ corrected: false }` for a zero delta, else
 *      `{ corrected: true, correctionId, journalEntryId }` (ids equal the correction row's id and the entry's id, as `postPosCorrection` returns).
 *      `dayLineId` is the staged `settlement_day_lines` id; its `order_value` is THE FILE FIGURE, its channel, store and sales_date name the day.
 *      `reason` is required (the table's reason is non-blank). The clock for `firstOpenDateOnOrAfter` is today in Manila; tests set it through the seam `correctPlatformSalesOnClock` (not on the barrel).
 *  P2  old figure = the channel's amount on the day's own posted entry PLUS the prior platform corrections of that channel and day, read from `journal_lines`
 *      (never `sales_day_channels.amount`, which is never overwritten). delta = file - old. Dr 1220 / Cr 4150 for a positive delta, Dr 4150 / Cr 1220 for a negative one.
 *      The 1220 line carries party channel (the channel's id) and the day's store; the 4150 line the day's store and no party.
 *  P3  journal entry: source_type 'sale', source_id = the correction row's id, status posted, idempotency key `sales_day:{dayId}:platform_correction:{lineId}`.
 *  P4  table `sales_day_platform_corrections` columns used here: id, org_id, store_id, sales_day_id, channel_id, day_line_id, from_amount, to_amount (numeric(14,2): the
 *      old figure and the file figure), entry_date, journal_entry_id, reason, posted_by, posted_at.
 *  P5  a second call for the same staged line is a quiet no-op (nothing thrown, nothing written); what it RETURNS is not pinned.
 *  P6  a sales day that is not verified is refused (design: "a file never posts to an unverified day"; no entry exists to read the staff figure from).
 *  P7  audit `platform_sales.corrected`: one row per posted correction, entity_id = the correction id, store_id = the day's store, actor = the caller. Nothing for a no-op.
 *  P8  refusals are plain sentences (`userMessage`, no UUID); a wrong store scope is an AuthorizationError, thrown BEFORE any read of the day's figures.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import * as D from '@shareat/domain';
import {
  DATE, NEXT_OPEN, UUID_RE, asOrg, auditRows, correct, correctProd, corrections, entriesOf, fx, linesOf, lineText, netDebit, rawDayLine, sentenceOf,
} from './_fixtures/t511-s6b-world';
import { submitThenVerify } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const dayRow = (dayId: string) => sql<{ status: string; total_sales: string; journal_entry_id: string | null }[]>`select status, total_sales::text, journal_entry_id::text from sales_days where id = ${dayId}`;
const channelAmount = async (dayId: string, channelId: string) =>
  (await sql<{ amount: string }[]>`select amount::text from sales_day_channels where sales_day_id = ${dayId} and channel_id = ${channelId}`)[0]!.amount;

describe('X1 - the entry point is exported from @shareat/domain', () => {
  it('correctPlatformSales is a function on the barrel [kills: a function nobody can import from the apps]', () => {
    expect(typeof (D as unknown as Record<string, unknown>).correctPlatformSales).toBe('function');
  });
});

describe('S6b delta up - the file is higher than staff typed', () => {
  it('staff 9,000 / file 10,000: Dr 1220 1,000.00 (party the channel, the day\'s store) / Cr 4150 1,000.00; the row, the entry, the audit; staff figure untouched; 1220 now 10,000.00 [kills: wrong side; no party on 1220; the channel amount overwritten; no audit; no row]', async () => {
    const f = await fx(sql, 'up', { staff: '9000.00', file: '10000.00' });
    const dayEntry = (await dayRow(f.dayId))[0]!.journal_entry_id;
    expect(Number(await netDebit(sql, f.orgId, '1220')), 'control: the day raised 9,000 on 1220').toBe(9000);

    const res = await correct(f, f.admin);
    expect(res.corrected).toBe(true);

    const rows = await corrections(sql, f.orgId);
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect({ store: c.store_id, day: c.sales_day_id, channel: c.channel_id, line: c.day_line_id, from: c.from_amount, to: c.to_amount, date: c.entry_date, reason: c.reason, by: c.posted_by }).toEqual({
      store: f.storeA, day: f.dayId, channel: f.channelId, line: f.lineId, from: '9000.00', to: '10000.00', date: DATE, reason: 'File is the truth', by: f.admin.personId,
    });
    expect(res.correctionId).toBe(c.id);
    expect(res.journalEntryId).toBe(c.journal_entry_id);

    const entry = (await entriesOf(sql, f.orgId)).find((e) => e.id === c.journal_entry_id)!;
    expect(entry, 'the correction\'s entry').toBeDefined();
    expect({ type: entry.source_type, sourceId: entry.source_id, status: entry.status, date: entry.entry_date, key: entry.idempotency_key }).toEqual({
      type: 'sale', sourceId: c.id, status: 'posted', date: DATE, key: `sales_day:${f.dayId}:platform_correction:${f.lineId}`,
    });
    const lines = await linesOf(sql, c.journal_entry_id);
    expect(lineText(lines)).toEqual(['Cr 4150 1000.00', 'Dr 1220 1000.00']);
    const dr = lines.find((l) => l.code === '1220')!;
    const cr = lines.find((l) => l.code === '4150')!;
    expect([dr.party_type, dr.party_id, dr.store_id]).toEqual(['channel', f.channelId, f.storeA]);
    expect([cr.party_type, cr.store_id]).toEqual([null, f.storeA]);

    expect(await channelAmount(f.dayId, f.channelId), 'the staff figure is never overwritten').toBe('9000.00');
    expect((await dayRow(f.dayId))[0]).toEqual({ status: 'verified', total_sales: '9000.00', journal_entry_id: dayEntry });
    expect((await entriesOf(sql, f.orgId)).find((e) => e.id === dayEntry)!.status, 'the day\'s own entry stands').toBe('posted');
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10000);

    const audit = await auditRows(sql, f.orgId, 'platform_sales.corrected');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_id: c.id, store_id: f.storeA, actor_person_id: f.admin.personId });
  });
});

describe('S6b delta down - the file is lower than staff typed (DEF-810)', () => {
  it('staff 11,000 / file 10,000: Dr 4150 1,000.00 / Cr 1220 1,000.00 (party the channel); 1220 now 10,000.00; from 11,000.00 to 10,000.00 [kills: always Dr 1220; the absolute delta posted on the wrong side]', async () => {
    const f = await fx(sql, 'down', { staff: '11000.00', file: '10000.00' });
    const res = await correct(f, f.admin);
    expect(res.corrected).toBe(true);
    const c = (await corrections(sql, f.orgId))[0]!;
    expect([c.from_amount, c.to_amount]).toEqual(['11000.00', '10000.00']);
    const lines = await linesOf(sql, c.journal_entry_id);
    expect(lineText(lines)).toEqual(['Cr 1220 1000.00', 'Dr 4150 1000.00']);
    const cr = lines.find((l) => l.code === '1220')!;
    expect([cr.party_type, cr.party_id, cr.store_id]).toEqual(['channel', f.channelId, f.storeA]);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10000);
    expect(Number(await netDebit(sql, f.orgId, '4150'))).toBe(-10000);
    expect(await channelAmount(f.dayId, f.channelId)).toBe('11000.00');
  });
});

describe('S6b delta zero - nothing to correct', () => {
  it('staff 10,000 = file 10,000: { corrected: false }; no row, no entry, no audit [kills: a zero-amount entry; a row written for a no-op]', async () => {
    const f = await fx(sql, 'zero', { staff: '10000.00', file: '10000.00' });
    const before = (await entriesOf(sql, f.orgId)).length;
    const res = await correct(f, f.admin);
    expect(res.corrected).toBe(false);
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
    expect((await entriesOf(sql, f.orgId)).length).toBe(before);
    expect(await auditRows(sql, f.orgId, 'platform_sales.corrected')).toHaveLength(0);
  });
});

describe('S6b money - two decimals, no float', () => {
  it('staff 8,000.07 / file 8,000.20: the delta is exactly 0.13 on both lines [kills: float subtraction (0.1300000000001), a rounded delta]', async () => {
    const f = await fx(sql, 'cents', { staff: '8000.07', file: '8000.20' });
    await correct(f, f.admin);
    const c = (await corrections(sql, f.orgId))[0]!;
    expect([c.from_amount, c.to_amount]).toEqual(['8000.07', '8000.20']);
    const lines = await linesOf(sql, c.journal_entry_id);
    expect(lineText(lines)).toEqual(['Cr 4150 0.13', 'Dr 1220 0.13']);
    expect(await netDebit(sql, f.orgId, '1220')).toBe('8000.20');
  });

  it('a large figure keeps its cents: staff 123,456,789.02 / file 123,456,789.15 (a day total of 14 digits) gives exactly 0.13 [kills: a Number() round trip]', async () => {
    const f = await fx(sql, 'big', { staff: '123456789.02', file: '123456789.15' });
    await correct(f, f.admin);
    const lines = await linesOf(sql, (await corrections(sql, f.orgId))[0]!.journal_entry_id);
    expect(lineText(lines)).toEqual(['Cr 4150 0.13', 'Dr 1220 0.13']);
  });
});

describe('S6b dating - the sales day if its month is open, else the first open date on or after it', () => {
  it('October closed after the day posted, November open: the entry and the row are dated 1 Nov; the day\'s own entry stays in October [kills: dating in the closed month (postEntry refuses); reopening the period; dating on today]', async () => {
    const f = await fx(sql, 'closed', { staff: '11000.00', file: '10000.00' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    const res = await correct(f, f.admin);
    expect(res.corrected).toBe(true);
    const c = (await corrections(sql, f.orgId))[0]!;
    expect(c.entry_date).toBe(NEXT_OPEN);
    const e = (await entriesOf(sql, f.orgId)).find((x) => x.id === c.journal_entry_id)!;
    expect(e.entry_date).toBe(NEXT_OPEN);
    const [p] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    expect(p!.status, 'a period is never reopened').toBe('closed');
  });

  it('control: October open: dated on the sales day itself, not on the clock [kills: always dating on today / the first open date]', async () => {
    const f = await fx(sql, 'open', { staff: '11000.00', file: '10000.00' });
    await correct(f, f.admin);
    expect((await corrections(sql, f.orgId))[0]!.entry_date).toBe(DATE);
  });

  it('every period up to today shut: a plain refusal (no UUID, says the books are closed), nothing written, nothing reopened; control: once November is open again it posts on 1 Nov [kills: a crash; a silent post into a closed month; reopening]', async () => {
    const f = await fx(sql, 'allshut', { staff: '11000.00', file: '10000.00' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-11-01'`;
    const entriesBefore = (await entriesOf(sql, f.orgId)).length;
    const sentence = await sentenceOf(correct(f, f.admin));
    expect(sentence).toMatch(/clos|period|open/i);
    expect(sentence).not.toMatch(UUID_RE);
    expect(sentence).not.toMatch(/postEntry|undefined|\[object/);
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
    expect((await entriesOf(sql, f.orgId)).length).toBe(entriesBefore);
    expect(await auditRows(sql, f.orgId, 'platform_sales.corrected')).toHaveLength(0);

    await sql`update fiscal_periods set status = 'open' where org_id = ${f.orgId} and starts_on = '2026-11-01'`;
    await correct(f, f.admin);
    expect((await corrections(sql, f.orgId))[0]!.entry_date, 'control').toBe(NEXT_OPEN);
  });
});

describe('S6b idempotent per staged day line', () => {
  it('the same line twice: one row, one correction entry, 1220 corrected once (10,000.00, not 9,000.00); the second call throws nothing [kills: a second entry; a unique violation surfacing as a crash; delta recomputed from sales_day_channels.amount]', async () => {
    const f = await fx(sql, 'twice', { staff: '11000.00', file: '10000.00' });
    await correct(f, f.admin);
    const entriesAfterFirst = (await entriesOf(sql, f.orgId)).length;
    await correct(f, f.admin);
    expect(await corrections(sql, f.orgId)).toHaveLength(1);
    expect((await entriesOf(sql, f.orgId)).length).toBe(entriesAfterFirst);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10000);
    expect(await auditRows(sql, f.orgId, 'platform_sales.corrected')).toHaveLength(1);
  });

  it('a NEWER file for the same day (a second line): the delta is against staff PLUS the first correction: 10,000 -> 10,500 posts Dr 1220 500.00 / Cr 4150 500.00, from 10,000.00 to 10,500.00; two rows [kills: delta against the staff figure (would post 500 -> 1,500 lower); the second line overwriting the first row]', async () => {
    const f = await fx(sql, 'newer', { staff: '11000.00', file: '10000.00' });
    await correct(f, f.admin);
    const line2 = await rawDayLine(sql, { orgId: f.orgId, storeId: f.storeA, channelId: f.channelId, platform: 'foodpanda', salesDate: DATE, orderValue: '10500.00', personId: f.admin.personId, version: 2 });
    await correct(f, f.admin, { dayLineId: line2 });
    const rows = await corrections(sql, f.orgId);
    expect(rows).toHaveLength(2);
    const second = rows.find((r) => r.day_line_id === line2)!;
    expect([second.from_amount, second.to_amount]).toEqual(['10000.00', '10500.00']);
    expect(lineText(await linesOf(sql, second.journal_entry_id))).toEqual(['Cr 4150 500.00', 'Dr 1220 500.00']);
    const key = (await entriesOf(sql, f.orgId)).find((e) => e.id === second.journal_entry_id)!.idempotency_key;
    expect(key).toBe(`sales_day:${f.dayId}:platform_correction:${line2}`);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10500);
  });
});

describe('S6b who may correct - record_ar_collection with the line\'s store scope', () => {
  it('a manager of ANOTHER store is refused with AuthorizationError and nothing is written; control: the line\'s own manager posts the same line [kills: no gate; a gate without the store scope; the gate after the read]', async () => {
    const f = await fx(sql, 'scope', { staff: '11000.00', file: '10000.00' });
    const err = await correct(f, f.managerB).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
    expect(await auditRows(sql, f.orgId, 'platform_sales.corrected')).toHaveLength(0);

    await correct(f, f.managerA);
    expect(await corrections(sql, f.orgId), 'control: the manager of the line\'s store posts').toHaveLength(1);
  });
});

describe('S6b receivable code - only 1220 until slice 8 fixes outstandingFor', () => {
  it('a channel whose receivable account is 1250: refused with a plain sentence, nothing written [kills: posting to a receivable the settlement does not clear; a hard-coded 1220 that ignores the channel]', async () => {
    const f = await fx(sql, 'code', { staff: '11000.00', file: '10000.00', receivable: '1250' });
    expect(Number(await netDebit(sql, f.orgId, '1250')), 'control: the day raised 11,000 on 1250').toBe(11000);
    const sentence = await sentenceOf(correct(f, f.admin));
    expect(sentence.length).toBeGreaterThan(10);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
    expect(Number(await netDebit(sql, f.orgId, '1250'))).toBe(11000);
  });
});

describe('S6b an unverified day', () => {
  it('a day still open (nothing posted): refused with a plain sentence, nothing written [kills: posting a correction with no staff entry to correct]', async () => {
    const f = await fx(sql, 'unverified', { staff: '11000.00', file: '10000.00', verified: false });
    const sentence = await sentenceOf(correct(f, f.admin));
    expect(sentence.length).toBeGreaterThan(10);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
    expect((await dayRow(f.dayId))[0]!.status, 'a file never verifies a day').toBe('open');
  });
});

describe('S6b fixes - a voided day re-entered on the same date is a new day', () => {
  it('day 11,000, file 10,000, corrected (-1,000), day voided, re-entered 11,000 and verified, corrected again: posts -1,000 AGAIN; 1220 = 10,000.00 and 4150 = -10,000.00; two rows, one per sales day [kills: the old day\'s row answering for the new day (books stay 11,000); a unique on the line alone (23505)]', async () => {
    const f = await fx(sql, 'reenter', { staff: '11000.00', file: '10000.00' });
    await correct(f, f.admin);
    await asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.admin, f.dayId, 'typed on the wrong day'));
    expect(Number(await netDebit(sql, f.orgId, '1220')), 'control: the void took everything back').toBe(0);

    const day2 = await asOrg(f.orgId, (tx) =>
      D.createSalesDay(tx, f.submitter, {
        storeId: f.storeA, businessDate: DATE, totalSales: '11000.00', unliSales: '0.00', alaCarteSales: '11000.00', cashCollected: '0.00',
        channels: [{ channelId: f.channelId, amount: '11000.00' }],
      }),
    );
    expect(day2.id, 'control: a new sales day').not.toBe(f.dayId);
    await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.admin, day2.id, f.submitter));
    expect(Number(await netDebit(sql, f.orgId, '1220')), 'control: the new day raised 11,000').toBe(11000);

    const res = await correct(f, f.admin);
    expect(res.corrected).toBe(true);
    const rows = await corrections(sql, f.orgId);
    expect(rows.map((r) => [r.sales_day_id, r.from_amount, r.to_amount])).toEqual([[f.dayId, '11000.00', '10000.00'], [day2.id, '11000.00', '10000.00']]);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(10000);
    expect(Number(await netDebit(sql, f.orgId, '4150'))).toBe(-10000);
    await correct(f, f.admin);
    expect(await corrections(sql, f.orgId), 'a repeat on the new day is still a no-op').toHaveLength(2);
  });
});

describe('S6b fixes - only a pending line is posted', () => {
  it('a rejected line: refused in plain words, nothing written [kills: posting the figure of a day a person rejected]', async () => {
    const f = await fx(sql, 'rejected', { staff: '11000.00', file: '10000.00' });
    await sql`update settlement_day_lines set review_state = 'rejected', decision_reason = 'wrong file', decided_by = ${f.admin.personId}, decided_at = now() where id = ${f.lineId}`;
    const sentence = await sentenceOf(correct(f, f.admin));
    expect(sentence).toMatch(/rejected/i);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
    expect(Number(await netDebit(sql, f.orgId, '1220'))).toBe(11000);
  });

  it('a booked line: refused in plain words, nothing written [kills: posting a correction after the settlement booked the day]', async () => {
    const f = await fx(sql, 'booked', { staff: '11000.00', file: '10000.00' });
    const [set] = await sql<{ id: string }[]>`
      insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by)
      values (${f.orgId}, ${f.storeA}, ${f.channelId}, ${f.dayId}, ${DATE}, '0', '0', '0', ${f.bankId}, ${DATE}, ${f.admin.personId}) returning id`;
    await sql`update settlement_day_lines set review_state = 'booked', decided_by = ${f.admin.personId}, decided_at = now(), settlement_id = ${set!.id} where id = ${f.lineId}`;
    const sentence = await sentenceOf(correct(f, f.admin));
    expect(sentence).toMatch(/booked/i);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
  });
});

describe('S6b fixes - the reason is plain text, kept stripped', () => {
  it('zero-width characters only: refused like a blank reason; a control character: refused; 501 characters: refused; nothing written [kills: an invisible reason posting; a NUL reaching Postgres; an unbounded memo]', async () => {
    const f = await fx(sql, 'reason', { staff: '11000.00', file: '10000.00' });
    for (const reason of ['​⁠﻿', '', 'bad\u0000reason', 'esc\u001b[0m', 'x'.repeat(501)]) {
      const sentence = await sentenceOf(correct(f, f.admin, { reason }));
      expect(sentence, JSON.stringify(reason.slice(0, 12))).toMatch(/reason|text/i);
      expect(sentence).not.toMatch(UUID_RE);
    }
    expect(await corrections(sql, f.orgId)).toHaveLength(0);
  });

  it('a reason with a zero-width character posts, and the row and the entry memo hold the STRIPPED text; 500 characters is fine [kills: the raw text stored; the cap one too low]', async () => {
    const f = await fx(sql, 'reasonok', { staff: '11000.00', file: '10000.00' });
    await correct(f, f.admin, { reason: ' File​ is the truth⁠ ' });
    const c = (await corrections(sql, f.orgId))[0]!;
    expect(c.reason).toBe('File is the truth');
    const [e] = await sql<{ memo: string }[]>`select memo from journal_entries where id = ${c.journal_entry_id}`;
    expect(e!.memo).toMatch(/: File is the truth$/);
    const g = await fx(sql, 'reason500', { staff: '11000.00', file: '10000.00' });
    expect((await correct(g, g.admin, { reason: 'x'.repeat(500) })).corrected).toBe(true);
  });
});

describe('S6b fixes - the clock can never be in the future', () => {
  it('October and November shut, December open, `today` 2099 passed to the production function: ignored, nothing is dated after the real Manila date [kills: a caller dating an entry in the future]', async () => {
    const f = await fx(sql, 'future', { staff: '11000.00', file: '10000.00' });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2026-12-01', '2026-12-31', 'open')`;
    await correctProd(f, f.admin, { today: '2099-01-01' }).then(() => null, () => null);
    const today = (await sql<{ today: string }[]>`select ((now() at time zone 'Asia/Manila')::date)::text as today`)[0]!.today;
    for (const c of await corrections(sql, f.orgId)) expect(c.entry_date <= today, `entry dated ${c.entry_date}, today is ${today}`).toBe(true);
    for (const e of await entriesOf(sql, f.orgId)) expect(e.entry_date <= today, `entry dated ${e.entry_date}`).toBe(true);
  });
});
