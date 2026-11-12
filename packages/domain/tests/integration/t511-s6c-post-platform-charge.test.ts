import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S6c (TESTER, 7 Nov 2026) - `postPlatformCharge`: a platform charge with no sales day (the weekly fee, or any uncategorised charge) is booked ONCE, dated on the
 * charge, Dr 6400 (fee + VAT) / Cr 1220 party the channel. docs/tasks/511-settlement-upload-s6c-spec.md Design A, B and the dual-run bullet of E. Real Postgres, real posting.
 *
 * RED TODAY, for one reason: `packages/domain/src/channel-settlements/charge.ts` does not exist, and migration 0244 (`vat_amount`, `channel_period_charges`) does not.
 * Each leg loads the module lazily (`_fixtures/t511-s6c-world.ts`), so each fails on its own "Failed to resolve import" or on the missing column.
 *
 * PINNED (the builder meets these or asks BOSS to change the tests; the spec leaves each open):
 *  P1  the module is `packages/domain/src/channel-settlements/charge.ts` (the spec names no file). `postPlatformCharge(tx, actor, { otherLineId })` returns
 *      `{ posted: false }` for a charge already posted, else `{ posted: true, chargeId, journalEntryId }` (ids equal the row's id and the entry's id, as S6b returns).
 *      `postPlatformChargeOnClock(tx, actor, input, today)` is the seam; it is NOT on the barrel. `postPlatformCharge` is on the barrel.
 *  P2  total = net + VAT in whole centavos. total > 0: Dr 6400 (one line) / Cr 1220; total < 0: the same pair reversed; the 1220 line carries party channel (the channel's id)
 *      and the upload's store; the 6400 line the store and no party. Entry: source_type 'channel_charge', source_id = the charge row's id, status posted, key
 *      `channel_charge:{otherLineId}:post`, dated on the line_date when its month is open, else the first open date on or after it (never a reopened period).
 *  P3  `channel_period_charges` columns used: id, org_id, store_id, channel_id, other_line_id, upload_id, charge_date (= line_date), net_amount, vat_amount, total_amount,
 *      entry_date, journal_entry_id, description (= the line's description), posted_by.
 *  P4  audit `channel_charge.posted`: one row per posted charge, entity_id = the charge id, store_id = the upload's store, actor = the caller. Nothing for a no-op or a refusal.
 *  P5  refusals are plain sentences (`userMessage`, no UUID); a wrong store scope is an AuthorizationError. A NULL VAT is refused in words that say what works (a corrected file, or the owner); an identical file is refused as already uploaded, so "upload again" is wrong.
 *  P6  the staged other line itself is never touched (still booked_as 'none', still current): "posted" lives in `channel_period_charges`.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, dualRunRepo } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { compareStoreWeek } from '../../../etl/src/dual-run/compare';
import { day as isoDay, fp34Order, fpChargeRow, fpWorkbook, zipBytes } from '../unit/t511-s3-helpers';
import { LIPA_FP, world as intakeWorld } from './_fixtures/t511-s4-world';
import {
  CHARGE_DATE, DATE, NEXT_OPEN, UUID_RE, asOrg, auditRows, charges, entriesOf, entryCount, linesOf, lineText, netDebit, periodCharge, postCharge, postChargeProd,
  sentenceOf, world,
} from './_fixtures/t511-s6c-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTION = 'channel_charge.posted';
/** Nothing was written: no charge row, no new entry, no audit row. */
async function untouched(f: { orgId: string }, entriesBefore: number): Promise<void> {
  expect(await charges(sql, f.orgId), 'no charge row').toHaveLength(0);
  expect(await entryCount(sql, f.orgId), 'no new journal entry').toBe(entriesBefore);
  expect(await auditRows(sql, f.orgId, ACTION), 'no audit row').toHaveLength(0);
}

describe('X1 - the entry point is exported from @shareat/domain, the clock seam is not', () => {
  it('postPlatformCharge is a function on the barrel; postPlatformChargeOnClock is NOT [kills: a function nobody can import from the apps; a seam any caller could use to date an entry in the future]', () => {
    const b = D as unknown as Record<string, unknown>;
    expect(typeof b.postPlatformCharge).toBe('function');
    expect(b.postPlatformChargeOnClock).toBeUndefined();
  });
});

describe('S6c positive - net 100.00 + VAT 12.00 posts 112.00 as one expense line', () => {
  it('Dr 6400 112.00 (store, no party, a memo that says VAT is included) / Cr 1220 112.00 (party the channel, the store); the row, the entry, the audit; the staged line untouched; 1220 now 9,888.00 and 6400 112.00 [kills: net only (VAT lost); VAT on a separate line; wrong side; no party on 1220; a 6400 line with a party; no row; no audit; the staged line flipped to booked]', async () => {
    const f = await world(sql, 'pos', { staff: '10000.00' });
    const ol = await periodCharge(sql, f);
    const before = await entryCount(sql, f.orgId);
    const res = await postCharge(f, f.admin, ol);
    expect(res.posted).toBe(true);

    const rows = await charges(sql, f.orgId);
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    const [up] = await sql<{ upload_id: string }[]>`select upload_id::text from settlement_other_lines where id = ${ol}`;
    expect({
      store: c.store_id, channel: c.channel_id, line: c.other_line_id, upload: c.upload_id, chargeDate: c.charge_date, net: c.net_amount, vat: c.vat_amount, total: c.total_amount,
      entryDate: c.entry_date, description: c.description, by: c.posted_by,
    }).toEqual({
      store: f.storeA, channel: f.channelId, line: ol, upload: up!.upload_id, chargeDate: CHARGE_DATE, net: '100.00', vat: '12.00', total: '112.00', entryDate: CHARGE_DATE,
      description: 'Platform Fee', by: f.admin.personId,
    });
    expect(res.chargeId).toBe(c.id);
    expect(res.journalEntryId).toBe(c.journal_entry_id);

    const entry = (await entriesOf(sql, f.orgId)).find((e) => e.id === c.journal_entry_id)!;
    expect(entry, "the charge's entry").toBeDefined();
    expect({ type: entry.source_type, sourceId: entry.source_id, status: entry.status, date: entry.entry_date, key: entry.idempotency_key }).toEqual({
      type: 'channel_charge', sourceId: c.id, status: 'posted', date: CHARGE_DATE, key: `channel_charge:${ol}:post`,
    });
    const lines = await linesOf(sql, c.journal_entry_id);
    expect(lineText(lines)).toEqual(['Cr 1220 112.00', 'Dr 6400 112.00']);
    const cr = lines.find((l) => l.code === '1220')!;
    const dr = lines.find((l) => l.code === '6400')!;
    expect([cr.party_type, cr.party_id, cr.store_id]).toEqual(['channel', f.channelId, f.storeA]);
    expect([dr.party_type, dr.store_id]).toEqual([null, f.storeA]);
    const [memo] = await sql<{ line_memo: string | null }[]>`
      select jl.line_memo from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${c.journal_entry_id} and a.code = '6400'`;
    expect(memo!.line_memo ?? '', 'the 6400 line says the VAT is inside it (bible row 75)').toMatch(/VAT/i);

    expect(await entryCount(sql, f.orgId)).toBe(before + 1);
    expect(await netDebit(sql, f.orgId, '6400')).toBe('112.00');
    expect(await netDebit(sql, f.orgId, '1220')).toBe('9888.00');

    const audit = await auditRows(sql, f.orgId, ACTION);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_id: c.id, store_id: f.storeA, actor_person_id: f.admin.personId });

    const [still] = await sql<{ booked_as: string; is_current: boolean }[]>`select booked_as, is_current from settlement_other_lines where id = ${ol}`;
    expect(still).toEqual({ booked_as: 'none', is_current: true });
  });
});

describe('S6c negative total - a platform credit note posts the pair reversed', () => {
  it('net -112.00, VAT 0.00: Dr 1220 112.00 (party the channel) / Cr 6400 112.00; the row says total_amount -112.00 [kills: an absolute value posted on the wrong side; a refusal of a negative; a negative amount on a line]', async () => {
    const f = await world(sql, 'neg', { staff: '10000.00' });
    const ol = await periodCharge(sql, f, { net: '-112.00', vat: '0.00' });
    const res = await postCharge(f, f.admin, ol);
    expect(res.posted).toBe(true);
    const c = (await charges(sql, f.orgId))[0]!;
    expect([c.net_amount, c.vat_amount, c.total_amount]).toEqual(['-112.00', '0.00', '-112.00']);
    const lines = await linesOf(sql, c.journal_entry_id);
    expect(lineText(lines)).toEqual(['Cr 6400 112.00', 'Dr 1220 112.00']);
    const dr = lines.find((l) => l.code === '1220')!;
    expect([dr.party_type, dr.party_id, dr.store_id]).toEqual(['channel', f.channelId, f.storeA]);
    expect(await netDebit(sql, f.orgId, '1220')).toBe('10112.00');
    expect(await netDebit(sql, f.orgId, '6400')).toBe('-112.00');
  });
});

describe('S6c money - whole centavos, no float', () => {
  it('net 0.07 + VAT 0.01: exactly 0.08 on both lines [kills: float addition (0.08000000000000002); a rounded total]', async () => {
    const f = await world(sql, 'cents');
    const ol = await periodCharge(sql, f, { net: '0.07', vat: '0.01' });
    await postCharge(f, f.admin, ol);
    const c = (await charges(sql, f.orgId))[0]!;
    expect(c.total_amount).toBe('0.08');
    expect(lineText(await linesOf(sql, c.journal_entry_id))).toEqual(['Cr 1220 0.08', 'Dr 6400 0.08']);
  });

  it('a large figure keeps its cents: net 123,456,789.02 + VAT 14,814,814.68 = 138,271,603.70 [kills: a Number() round trip]', async () => {
    const f = await world(sql, 'big');
    const ol = await periodCharge(sql, f, { net: '123456789.02', vat: '14814814.68' });
    await postCharge(f, f.admin, ol);
    const c = (await charges(sql, f.orgId))[0]!;
    expect(c.total_amount).toBe('138271603.70');
    expect(lineText(await linesOf(sql, c.journal_entry_id))).toEqual(['Cr 1220 138271603.70', 'Dr 6400 138271603.70']);
  });
});

describe('S6c VAT NULL - a line staged before S6c is refused in plain words', () => {
  it('vat_amount NULL: the sentence says to ask for a corrected file or the owner (never to upload the same file again), has no UUID, and nothing is written; control: the same line with VAT 12.00 posts [kills: NULL read as zero (the VAT lost on an old line); a crash; developer text]', async () => {
    const f = await world(sql, 'vatnull');
    const old = await periodCharge(sql, f, { vat: null });
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, old));
    expect(sentence).toMatch(/corrected file|owner/i);
    expect(sentence).not.toMatch(/upload (the|this) file again|re-?upload/i);
    expect(sentence).not.toMatch(UUID_RE);
    expect(sentence).not.toMatch(/undefined|null|\[object/);
    await untouched(f, before);

    const fresh = await periodCharge(sql, f, { vat: '12.00' });
    expect((await postCharge(f, f.admin, fresh)).posted, 'control').toBe(true);
  });
});

describe('S6c dating - the charge date if its month is open, else the first open date on or after it', () => {
  it('October closed after the invoice, November open: the entry and the row are dated 1 Nov; the charge date stays 14 Oct; October is never reopened [kills: dating in the closed month (postEntry refuses); reopening the period; dating on today; the charge date overwritten]', async () => {
    const f = await world(sql, 'closed');
    const ol = await periodCharge(sql, f);
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    expect((await postCharge(f, f.admin, ol)).posted).toBe(true);
    const c = (await charges(sql, f.orgId))[0]!;
    expect([c.entry_date, c.charge_date]).toEqual([NEXT_OPEN, CHARGE_DATE]);
    expect((await entriesOf(sql, f.orgId)).find((e) => e.id === c.journal_entry_id)!.entry_date).toBe(NEXT_OPEN);
    const [p] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-10-01'`;
    expect(p!.status, 'a period is never reopened').toBe('closed');
  });

  it('control: October open: dated on the charge date itself, not on the clock [kills: always dating on today / the first open date]', async () => {
    const f = await world(sql, 'open');
    await postCharge(f, f.admin, await periodCharge(sql, f));
    expect((await charges(sql, f.orgId))[0]!.entry_date).toBe(CHARGE_DATE);
  });

  it('every period up to today shut: a plain refusal (no UUID, says the books are closed), nothing written, nothing reopened; control: once November is open again it posts on 1 Nov [kills: a crash; a silent post into a closed month; reopening]', async () => {
    const f = await world(sql, 'allshut');
    const ol = await periodCharge(sql, f);
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, ol));
    expect(sentence).toMatch(/clos|period|open/i);
    expect(sentence).not.toMatch(UUID_RE);
    expect(sentence).not.toMatch(/postEntry|undefined|\[object/);
    await untouched(f, before);

    await sql`update fiscal_periods set status = 'open' where org_id = ${f.orgId} and starts_on = '2026-11-01'`;
    await postCharge(f, f.admin, ol);
    expect((await charges(sql, f.orgId))[0]!.entry_date, 'control').toBe(NEXT_OPEN);
  });
});

describe('S6c dating - a charge dated after today', () => {
  it('dated 20 Nov with today 5 Nov (November open): its own plain sentence (in the future), NOT "every month is closed"; nothing written; control: dated today it posts [kills: the all-closed message for a future date]', async () => {
    const f = await world(sql, 'future');
    const ol = await periodCharge(sql, f, { lineDate: '2026-11-20' });
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, ol));
    expect(sentence).toMatch(/in the future/i);
    expect(sentence).not.toMatch(/clos/i);
    expect(sentence).not.toMatch(UUID_RE);
    await untouched(f, before);
    const today = await periodCharge(sql, f, { lineDate: '2026-11-05' });
    expect((await postCharge(f, f.admin, today)).posted, 'control').toBe(true);
  });
});

describe('S6c idempotent per staged line', () => {
  it('the same line twice: { posted: false } the second time; one row, one entry, 1220 and 6400 moved once, one audit row; nothing thrown [kills: a second entry; a unique violation surfacing as a crash; a second audit row]', async () => {
    const f = await world(sql, 'twice', { staff: '10000.00' });
    const ol = await periodCharge(sql, f);
    expect((await postCharge(f, f.admin, ol)).posted).toBe(true);
    const entriesAfterFirst = await entryCount(sql, f.orgId);
    const again = await postCharge(f, f.admin, ol);
    expect(again.posted).toBe(false);
    expect(await charges(sql, f.orgId)).toHaveLength(1);
    expect(await entryCount(sql, f.orgId)).toBe(entriesAfterFirst);
    expect(await netDebit(sql, f.orgId, '6400')).toBe('112.00');
    expect(await netDebit(sql, f.orgId, '1220')).toBe('9888.00');
    expect(await auditRows(sql, f.orgId, ACTION)).toHaveLength(1);
  });

  it('two different staged lines (two charges of one invoice) each post once [kills: an idempotency key per invoice or per channel]', async () => {
    const f = await world(sql, 'two-lines');
    const a = await periodCharge(sql, f, { net: '100.00', vat: '12.00', description: 'Platform Fee' });
    const b = await periodCharge(sql, f, { net: '50.00', vat: '6.00', description: 'Other charge' });
    await postCharge(f, f.admin, a);
    await postCharge(f, f.admin, b);
    expect((await charges(sql, f.orgId)).map((c) => c.total_amount).sort()).toEqual(['112.00', '56.00']);
    expect(await netDebit(sql, f.orgId, '6400')).toBe('168.00');
  });
});

describe('S6c who may post - record_ar_collection with the upload\'s store scope', () => {
  it('a manager of ANOTHER store is refused with AuthorizationError and nothing is written; control: the upload\'s own manager posts the same line [kills: no gate; a gate without the store scope; the gate after the read]', async () => {
    const f = await world(sql, 'scope');
    const ol = await periodCharge(sql, f);
    const before = await entryCount(sql, f.orgId);
    const err = await postCharge(f, f.managerB, ol).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    await untouched(f, before);

    await postCharge(f, f.managerA, ol);
    expect(await charges(sql, f.orgId), "control: the manager of the upload's store posts").toHaveLength(1);
  });
});

describe('S6c what is refused (plain sentence, nothing written)', () => {
  async function refused(hint: string, make: (f: Awaited<ReturnType<typeof world>>) => Promise<string>, opts: { receivable?: string } = {}): Promise<void> {
    const f = await world(sql, hint, opts);
    const ol = await make(f);
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, ol));
    expect(sentence.length, sentence).toBeGreaterThan(10);
    expect(sentence).not.toMatch(UUID_RE);
    expect(sentence).not.toMatch(/undefined|\[object|postEntry/);
    await untouched(f, before);
  }

  it('a PandaGO line (booked as none, kind pandago) [kills: booking the cash PandaGO riders collected as an expense]', () =>
    refused('pandago', (f) => periodCharge(sql, f, { kind: 'pandago', bookedAs: 'none' })));

  it('an advertisement line (kind advertisement, booked as marketing) [kills: a charge of the wrong kind booked a second time (the settlement books marketing)]', () =>
    refused('advert', (f) => periodCharge(sql, f, { kind: 'advertisement', bookedAs: 'marketing' })));

  it('a period_charge booked as platformFee (the day carries it) [kills: ignoring booked_as]', () =>
    refused('bookedas', (f) => periodCharge(sql, f, { bookedAs: 'platformFee' })));

  it('a line that belongs to a sales day (day_line_id set): the settlement of that day books it [kills: booking a day\'s fee twice]', () =>
    refused('daybound', (f) => periodCharge(sql, f, { dayLineId: f.lineId })));

  it('a line that is no longer current (a newer upload replaced it) [kills: booking a superseded figure]', () =>
    refused('noncurrent', (f) => periodCharge(sql, f, { isCurrent: false })));

  it('a channel whose receivable account is 1250, not the standard 1220 (until slice 8) [kills: crediting a receivable the settlement does not clear; a hard-coded 1220 that ignores the channel]', () =>
    refused('code', (f) => periodCharge(sql, f), { receivable: '1250' }));

  it('a line with no date (line_date NULL): the sentence says the charge has no date, so it cannot be dated or booked (spec ruling 5) [kills: dating a NULL (a crash or a post on the clock); a refusal that does not name the cause]', async () => {
    const f = await world(sql, 'undated');
    const ol = await periodCharge(sql, f, { lineDate: null });
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, ol));
    expect(sentence).toMatch(/no date/i);
    expect(sentence).not.toMatch(UUID_RE);
    await untouched(f, before);
  });

  it('a zero total (net 0.00, VAT 0.00) [kills: a zero-amount entry]', () => refused('zero', (f) => periodCharge(sql, f, { net: '0.00', vat: '0.00' })));

  it('an id that is not a staged line at all, and the staged line of ANOTHER org [kills: a crash on a missing row; a cross-org read]', async () => {
    const f = await world(sql, 'unknown');
    const g = await world(sql, 'other-org');
    const theirs = await periodCharge(sql, g);
    for (const id of [crypto.randomUUID(), theirs]) {
      const sentence = await sentenceOf(postCharge(f, f.admin, id));
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toMatch(UUID_RE);
    }
    expect(await charges(sql, f.orgId)).toHaveLength(0);
    expect(await charges(sql, g.orgId), 'the other org is untouched').toHaveLength(0);
  });
});

describe('S6c the clock can never be in the future', () => {
  it('October and November shut, December open, `today` 2099 passed to the production function: ignored, nothing is dated after the real Manila date [kills: a caller dating an entry in the future]', async () => {
    const f = await world(sql, 'future');
    const ol = await periodCharge(sql, f);
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2026-12-01', '2026-12-31', 'open')`;
    // a refusal is fine (nothing open up to today); a missing module is not a refusal
    await postChargeProd(f, f.admin, ol, { today: '2099-01-01' }).then(() => null, (e: Error) => {
      if (/Cannot find module|Failed to resolve import|is not a function/.test(e.message)) throw e;
    });
    const today = (await sql<{ today: string }[]>`select ((now() at time zone 'Asia/Manila')::date)::text as today`)[0]!.today;
    for (const c of await charges(sql, f.orgId)) expect(c.entry_date <= today, `entry dated ${c.entry_date}, today is ${today}`).toBe(true);
    for (const e of await entriesOf(sql, f.orgId)) expect(e.entry_date <= today, `entry dated ${e.entry_date}`).toBe(true);
  });

  it('control: through the PRODUCTION function (real clock) a charge dated 14 Oct 2026 in an open month posts and is dated on the charge [kills: a production signature that needs a clock]', async () => {
    const f = await world(sql, 'prod');
    const res = await postChargeProd(f, f.admin, await periodCharge(sql, f));
    expect(res.posted).toBe(true);
    expect((await charges(sql, f.orgId))[0]!.entry_date).toBe(CHARGE_DATE);
  });
});

describe('S6c dual-run - a channel_charge entry is invisible to the v2 readers (it needs no new class)', () => {
  const WEEK = { weekStart: '2026-10-12', through: '2026-10-18' };

  it('after the charge posts: the 1220 sales_tender line of the week is still the day\'s 10,000.00 (the -112.00 credit is not in it), there is no 6400 category line, no document of the charge, nothing dated later [kills: a charge read as a sale tender (an UNEXPLAINED -112.00 on the channel line); a charge document that cannot be paired; an unclassified item]. V2_ONLY_EVENT is the family that explains a v2 posting with no v1 equivalent', async () => {
    const f = await world(sql, 'dualrun', { staff: '10000.00' });
    const ol = await periodCharge(sql, f);
    expect((await postCharge(f, f.admin, ol)).posted, 'control: the charge posted').toBe(true);
    const c = (await charges(sql, f.orgId))[0]!;
    expect(c.entry_date, 'control: inside the week asked for').toBe(CHARGE_DATE);

    const fig = await asOrg(f.orgId, (tx) => dualRunRepo.v2Figures(tx, f.orgId, { storeId: f.storeA, ...WEEK }));
    const tender = fig.lines.find((l) => l.kind === 'sales_tender' && l.glCode === '1220' && l.partyId === f.channelId);
    expect(tender?.amount, 'the channel line is the sale only').toBe('10000.00');
    expect(fig.lines.filter((l) => l.glCode === '6400'), 'no expense line from a charge entry').toEqual([]);
    expect(fig.datedLater).toEqual([]);
    const docs = (await asOrg(f.orgId, (tx) => dualRunRepo.v2Documents(tx, f.orgId, { storeId: f.storeA, ...WEEK }))) as unknown as { id: string; glCode: string; amount: string }[];
    expect(docs.filter((d) => d.id.includes(c.id) || d.id.includes(c.journal_entry_id)), 'no document of the charge').toEqual([]);
    expect(docs.filter((d) => d.glCode === '1220').map((d) => d.amount)).toEqual(['10000.00']);
  });

  it('REAL pipeline: the real readers (v2Figures, v2Documents) feed the real comparator with a v2 book that holds the sale AND a posted channel_charge entry; the channel line ties v1, no item is UNEXPLAINED, the week ties, and no revenue figure moved [kills: a reader that takes a charge for a sale tender (the channel line becomes 9,888.00 and UNEXPLAINED); a comparator class that is not catalogued]', async () => {
    const f = await world(sql, 'dualrun-real', { staff: '10000.00' });
    const ol = await periodCharge(sql, f);
    expect((await postCharge(f, f.admin, ol)).posted, 'control: the charge posted').toBe(true);
    const [entries] = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId} and source_type = 'channel_charge'`;
    expect(entries!.n, 'control: the v2 book really holds a channel_charge entry').toBe(1);

    const fig = await asOrg(f.orgId, (tx) => dualRunRepo.v2Figures(tx, f.orgId, { storeId: f.storeA, ...WEEK }));
    const docs = await asOrg(f.orgId, (tx) => dualRunRepo.v2Documents(tx, f.orgId, { storeId: f.storeA, ...WEEK }));
    const cents = (v: string): number => Math.round(Number(v) * 100);
    const keyOf = (l: { kind: string; glCode: string; partyType: string | null; partyId: string | null }): string =>
      l.kind === 'sales_tender' && l.partyType === 'channel' && l.partyId ? `channel:${l.partyId}` : l.glCode;
    const result = compareStoreWeek({
      orgId: f.orgId, storeId: f.storeA, weekStart: WEEK.weekStart, through: WEEK.through,
      v1: {
        lines: [{ kind: 'sales_tender', key: 'chan__fp', amount: 1000000, days: { [DATE]: 1000000 } }], tradingDays: [DATE], cashResidual: {}, scope: [],
      },
      v2: {
        lines: fig.lines.map((l) => ({ kind: l.kind, key: keyOf(l), amount: cents(l.amount), days: Object.fromEntries(l.byDay.map((d) => [d.date, cents(d.amount)])) })),
        tradingDays: [DATE],
      },
      keyMap: { 'sales_tender|chan__fp': `channel:${f.channelId}` },
      v1Docs: [{ id: 'a', kind: 'sales_tender', key: 'chan__fp', date: DATE, amount: 1000000, state: 'posted' }],
      v2Docs: docs.map((d) => ({ id: d.id, kind: d.kind, key: keyOf(d), date: d.date, amount: cents(d.amount), state: d.state, channel: d.partyType === 'channel' })),
      dispositions: [],
    } as never);
    const tender = result.lines.find((l) => l.kind === 'sales_tender' && l.key === `channel:${f.channelId}`);
    expect(tender?.v2, 'the channel line is the sale only (the -112.00 charge credit is not in it)').toBe(1000000);
    expect(tender?.class).toBe('TIES');
    expect(result.lines.flatMap((l) => l.items ?? []).filter((i) => i.class === 'UNEXPLAINED')).toEqual([]);
    expect(result.lines.filter((l) => l.class === 'UNEXPLAINED')).toEqual([]);
    expect(result.verdict).toBe('ties');
  });
});

describe('S6c re-upload - a replaced file can never book its charge a second time (audit HIGH, 7 Nov)', () => {
  let driver = inMemoryDriver();
  beforeEach(() => {
    driver = inMemoryDriver();
    setStorageDriver(driver);
  });
  /** One Lipa invoice through REAL ingest: the same period (10 Oct) and the same 223.21 charge at 12% (VAT 26.79, total 250.00); `orders` makes the file change. */
  async function upload(f: Awaited<ReturnType<typeof world>>, orders: number): Promise<void> {
    const rows = Array.from({ length: orders }, (_, i) => fp34Order(`o6jz-0000-rep${i}`, { 7: isoDay('2026-10-10'), 10: 100, 17: 100, 33: 74.5 }, '200999999999', LIPA_FP));
    const book = fpWorkbook({ orderRows: rows, chargeRows: [fpChargeRow('Some New Charge Category', 'A one-off charge', 223.21, '12%', LIPA_FP)] });
    const bytes = zipBytes([{ name: '20261015_200999999999.xls', data: book }, { name: '20261015_200999999999.pdf', data: Buffer.from(`%PDF-1.4 stub rep ${orders}`) }]);
    await asOrg(f.orgId, (tx) => ingestSettlementFile(tx, f.admin, { bytes, contentType: 'application/zip' }));
  }
  const chargeLines = (f: { orgId: string }) => sql<{ id: string; upload_id: string; superseded_by: string | null }[]>`
    select l.id::text, l.upload_id::text, u.superseded_by::text from settlement_other_lines l join settlement_uploads u on u.id = l.upload_id
     where l.org_id = ${f.orgId} and l.kind = 'period_charge' order by u.uploaded_at, l.id`;
  async function worldWithCode(hint: string) {
    const f = await world(sql, hint);
    await sql`update sales_channels set platform_store_code = ${LIPA_FP} where id = ${f.channelId}`;
    return f;
  }

  it('production supersedes by upload: the changed file for the same period marks the first upload replaced, and a SECOND period line exists; the old line is refused, the new one posts, 6400 is 250.00 once [kills: booking the replaced upload\'s line]', async () => {
    const f = await worldWithCode('rep-a');
    await upload(f, 1);
    await upload(f, 2);
    const [oldLine, newLine] = await chargeLines(f);
    expect(oldLine!.superseded_by, 'ingest marks the first upload superseded').toBe(newLine!.upload_id);
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, oldLine!.id));
    expect(sentence).toMatch(/replaced by a newer upload/i);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await entryCount(sql, f.orgId)).toBe(before);
    expect((await postCharge(f, f.admin, newLine!.id)).posted).toBe(true);
    expect(await netDebit(sql, f.orgId, '6400')).toBe('250.00');
  });

  it('booked from the first file, then the file is re-uploaded changed: the second copy of the same charge is refused naming the date and the amount, 6400 stays 250.00 [kills: the double count the audit found]', async () => {
    const f = await worldWithCode('rep-b');
    await upload(f, 1);
    const [first] = await chargeLines(f);
    expect((await postCharge(f, f.admin, first!.id)).posted).toBe(true);
    await upload(f, 2);
    const second = (await chargeLines(f)).find((l) => l.id !== first!.id)!;
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(postCharge(f, f.admin, second.id));
    expect(sentence).toMatch(/already booked/i);
    expect(sentence).toMatch(/250\.00/);
    expect(sentence).toMatch(/15 Oct|Oct(ober)? 15|2026-10-15/);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await entryCount(sql, f.orgId)).toBe(before);
    expect(await charges(sql, f.orgId)).toHaveLength(1);
    expect(await netDebit(sql, f.orgId, '6400')).toBe('250.00');
  });

  it('hand-set superseded_by on the line\'s upload alone refuses it; a charge with a different description or amount is NOT taken for a copy and posts [kills: no superseded check; a copy rule that is too wide]', async () => {
    const f = await world(sql, 'rep-c');
    const l1 = await periodCharge(sql, f);
    const l2 = await periodCharge(sql, f);
    const [u1] = await sql<{ u: string }[]>`select upload_id::text as u from settlement_other_lines where id = ${l1}`;
    const [u2] = await sql<{ u: string }[]>`select upload_id::text as u from settlement_other_lines where id = ${l2}`;
    await sql`update settlement_uploads set superseded_by = ${u2!.u} where id = ${u1!.u}`;
    expect(await sentenceOf(postCharge(f, f.admin, l1))).toMatch(/replaced by a newer upload/i);
    expect((await postCharge(f, f.admin, l2)).posted).toBe(true);
    const other = await periodCharge(sql, f, { description: 'A different charge' });
    const smaller = await periodCharge(sql, f, { net: '99.00', vat: '11.88' });
    expect((await postCharge(f, f.admin, other)).posted).toBe(true);
    expect((await postCharge(f, f.admin, smaller)).posted).toBe(true);
  });
});

describe('S6c staging writes the VAT (Design A): an uncategorised Appendix B charge reaches the database with its VAT', () => {
  let driver = inMemoryDriver();
  beforeEach(() => {
    driver = inMemoryDriver();
    setStorageDriver(driver);
  });

  it('ingest of an invoice with one order and an unrecognised 223.21 charge at 12%: one period_charge line, booked_as none, vat_amount 26.79 (not NULL); the order day carries no such line [kills: a staged VAT that never reaches the table (every new line refused for a NULL VAT)]', async () => {
    const w = await intakeWorld(sql, 'vat-ingest', { channels: true });
    const order = fp34Order('o6jz-0000-vat', { 7: isoDay('2026-10-10'), 10: 100, 17: 100, 33: 74.5 }, '200999999999', LIPA_FP);
    const book = fpWorkbook({ orderRows: [order], chargeRows: [fpChargeRow('Some New Charge Category', 'A one-off charge', 223.21, '12%', LIPA_FP)] });
    const bytes = zipBytes([{ name: '20261015_200999999999.xls', data: book }, { name: '20261015_200999999999.pdf', data: Buffer.from('%PDF-1.4 stub vat-ingest') }]);
    await asOrg(w.orgId, (tx) => ingestSettlementFile(tx, w.managerA, { bytes, contentType: 'application/zip' }));
    const rows = await sql<{ kind: string; booked_as: string; amount: string; vat_amount: string | null; day_line_id: string | null }[]>`
      select kind, booked_as, amount::text, vat_amount::text, day_line_id::text from settlement_other_lines where org_id = ${w.orgId} order by kind`;
    expect(rows.filter((r) => r.kind === 'period_charge')).toEqual([{ kind: 'period_charge', booked_as: 'none', amount: '223.21', vat_amount: '26.79', day_line_id: null }]);
  });
});
