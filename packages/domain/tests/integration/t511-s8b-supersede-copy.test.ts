import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * T-511 S8b (3, 4 and the staging of 1 and 2) - what one Foodpanda upload does to another, and which charges count as copies of each other.
 * docs/tasks/511-settlement-upload-s8-spec.md "S8b" items 3 and 4. Real Postgres, real ingest, real posting.
 *
 *  3  A statement (it read order rows) keeps channel + kind + period as its key. A CHARGE-ONLY invoice (no orders) is superseded only by the SAME invoice number with different bytes,
 *     never by period: the two real small invoices (200223033317 and 200711317519, the same order date) both stay current. A re-issue of one invoice, or the same workbook
 *     uploaded alone after it came out of a many-invoice zip, supersedes the earlier copy.
 *  4  Two charges that both carry a document number are copies only when the numbers are equal AND the old figures (date, net, description) match: the original (+100), its
 *     reversal (-100) and the re-bill (+100) all book; a re-issue of the original is still refused; a charge with no document keeps the old rule.
 *  1+2 The staged charge line keeps its document number; the upload keeps the earlier items its Appendix C printed.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

import { closeDb } from '@shareat/db';
import { ingestSettlementUpload, inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { zipBytes } from '../unit/t511-s3-helpers';
import { fpPriorRow } from '../unit/t511-s3-helpers';
import { REAL_DOCS, REAL_INVOICES, asOrg, entryCount, ingest, netDebit, postCharge, sentenceOf, setDestination, smallInvoice, weekly, zipFile, type SmallInvoice } from './_fixtures/t511-s8b-world';
import { s7World } from './_fixtures/t511-s7a-world';

const sql = postgres(url, { max: 6 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** The real descriptions: a PandaGO row names its order date month-first, so it carries a date and a period (and is a `pandago` line). */
const PANDAGO = 'PandaGO Order-10.31.2026-o6jz-xgu1tm';
const real = (which: keyof typeof REAL_INVOICES, net: number, over: Partial<SmallInvoice> = {}): SmallInvoice => ({
  invoice: REAL_INVOICES[which], doc: REAL_DOCS[which], net, description: PANDAGO, ...over,
});

interface UploadRow { id: string; invoice_number: string; superseded_by: string | null; orders_read: number; period_from: string | null; period_to: string | null }
const uploadsOf = (orgId: string): Promise<UploadRow[]> => sql<UploadRow[]>`
  select id::text, invoice_number, superseded_by::text, orders_read, period_from::text, period_to::text from settlement_uploads where org_id = ${orgId} order by uploaded_at, id`;
const currentInvoices = async (orgId: string): Promise<string[]> => (await uploadsOf(orgId)).filter((u) => u.superseded_by === null).map((u) => u.invoice_number).sort();
const lineOf = async (orgId: string, doc: string, uploadId?: string): Promise<string> =>
  (await sql<{ id: string }[]>`
    select ol.id::text as id from settlement_other_lines ol where ol.org_id = ${orgId} and ol.official_document = ${doc} ${uploadId ? sql`and ol.upload_id = ${uploadId}` : sql``} order by ol.id desc limit 1`)[0]!.id;

describe('S8b (3) supersede: a charge-only invoice is superseded only by its own invoice number', () => {
  it('the two real small invoices of one order date (200223033317 and 200711317519) both stay current, each with its charge [kills: a period key that replaces the first invoice by the second (the S4 behaviour on a real file)]', async () => {
    const w = await s7World(sql, 's8b-sup1', { loanPeriods: false });
    await ingest(w, w.managerA, zipFile(smallInvoice(real('original', 89.29))));
    await ingest(w, w.managerA, zipFile(smallInvoice(real('rebill', 89.29))));
    const ups = await uploadsOf(w.orgId);
    expect(ups.map((u) => [u.invoice_number, u.superseded_by])).toEqual([[REAL_INVOICES.original, null], [REAL_INVOICES.rebill, null]]);
    // the same period on both, which is exactly what used to make one replace the other
    expect([ups[0]!.period_from, ups[0]!.period_to]).toEqual(['2026-10-31', '2026-10-31']);
    expect([ups[1]!.period_from, ups[1]!.period_to]).toEqual(['2026-10-31', '2026-10-31']);
  });

  it('a re-issue (the same invoice number, different bytes) supersedes the earlier copy, and the earlier copy\'s charge can no longer be booked from there [kills: two current copies of one invoice]', async () => {
    const w = await s7World(sql, 's8b-sup2', { loanPeriods: false });
    const first = await ingest(w, w.managerA, zipFile(smallInvoice(real('original', 89.29, { pdfTag: 'first' }))));
    const second = await ingest(w, w.managerA, zipFile(smallInvoice(real('original', 89.29, { pdfTag: 'second' }))));
    expect(first.alreadyUploaded).toBe(false);
    expect(second.alreadyUploaded).toBe(false);
    const ups = await uploadsOf(w.orgId);
    expect(ups.map((u) => [u.id, u.superseded_by])).toEqual([[first.uploadId, second.uploadId], [second.uploadId, null]]);
  });

  it('the very same bytes again are "already uploaded": nothing new is written [kills: a second upload of identical bytes]', async () => {
    const w = await s7World(sql, 's8b-sup3', { loanPeriods: false });
    const bytes = zipFile(smallInvoice(real('original', 89.29)));
    const first = await ingest(w, w.managerA, bytes);
    const again = await ingest(w, w.managerA, bytes);
    expect(again.alreadyUploaded).toBe(true);
    expect(again.uploadId).toBe(first.uploadId);
    expect(await uploadsOf(w.orgId)).toHaveLength(1);
  });

  it('S8a shortcut: a workbook that came out of a many-invoice zip and the same workbook uploaded alone are one invoice, the later one current [kills: two current copies of one invoice from the mini zip and the single zip]', async () => {
    const w = await s7World(sql, 's8b-sup4', { loanPeriods: false });
    const a = smallInvoice(real('original', 89.29));
    const b = smallInvoice(real('rebill', 89.29));
    // one zip holding both workbooks (+ their pdfs): the upload splits it into a mini zip per invoice
    const { openSettlementZipMembers } = await import('../../src/settlement-intake/safe-zip');
    const ma = (await openSettlementZipMembers(a))[0]!;
    const mb = (await openSettlementZipMembers(b))[0]!;
    const big = zipBytes([
      { name: `20261031_${REAL_INVOICES.original}.xls`, data: ma.workbook },
      { name: `20261031_${REAL_INVOICES.original}.pdf`, data: ma.pdf! },
      { name: `20261031_${REAL_INVOICES.rebill}.xls`, data: mb.workbook },
      { name: `20261031_${REAL_INVOICES.rebill}.pdf`, data: mb.pdf! },
    ]);
    const out = await ingestSettlementUpload((fn) => asOrg(w.orgId, fn), w.managerA, { bytes: big, contentType: 'application/zip', fileName: 'big.zip' });
    expect(out.every((o) => o.outcome.ok)).toBe(true);
    expect(await currentInvoices(w.orgId)).toEqual([REAL_INVOICES.original, REAL_INVOICES.rebill].sort());
    // the first workbook alone (a one-workbook zip with its ORIGINAL bytes: another fingerprint than the mini zip)
    const alone = await ingest(w, w.managerA, zipFile(a));
    expect(alone.alreadyUploaded).toBe(false);
    const ups = await uploadsOf(w.orgId);
    expect(ups.filter((u) => u.invoice_number === REAL_INVOICES.original).map((u) => u.superseded_by !== null)).toEqual([true, false]);
    expect(await currentInvoices(w.orgId)).toEqual([REAL_INVOICES.original, REAL_INVOICES.rebill].sort());
  });
});

describe('S8b (3) supersede: statements keep channel + kind + period', () => {
  const week = (invoice: string, tag: string) =>
    weekly({ invoice, tag, orders: [{ date: '2026-11-02', revenue: 100000n }, { date: '2026-11-03', revenue: 100000n }] }).zip;

  it('two different statements of the same period: the later one replaces the earlier [kills: the S4 rule lost for statements]', async () => {
    const w = await s7World(sql, 's8b-sup5', { loanPeriods: false });
    const a = await ingest(w, w.managerA, zipFile(week('200691218801', 'a')));
    const b = await ingest(w, w.managerA, zipFile(week('200691218802', 'b')));
    const ups = await uploadsOf(w.orgId);
    expect(ups.map((u) => [u.id, u.superseded_by])).toEqual([[a.uploadId, b.uploadId], [b.uploadId, null]]);
  });

  it('a charge-only invoice is neither replaced by a statement nor replaces one, even with the same period [kills: the statement key reaching charge-only uploads]', async () => {
    const w = await s7World(sql, 's8b-sup6', { loanPeriods: false });
    // a statement whose period is exactly one day (2 Nov) and a charge-only invoice whose charge is dated 2 Nov
    const stmt = await ingest(w, w.managerA, zipFile(weekly({ invoice: '200691218803', tag: 's', orders: [{ date: '2026-11-02', revenue: 100000n }] }).zip));
    const small = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033399', doc: '2000000005099999', net: 10, description: 'PandaGO Order-11.02.2026-o6jz-aaa' })));
    expect(small.alreadyUploaded).toBe(false);
    const ups = await uploadsOf(w.orgId);
    expect(ups.map((u) => [u.id, u.superseded_by])).toEqual([[stmt.uploadId, null], [small.uploadId, null]]);
    // and a second statement of that same period still replaces only the first statement
    const stmt2 = await ingest(w, w.managerA, zipFile(weekly({ invoice: '200691218804', tag: 's2', orders: [{ date: '2026-11-02', revenue: 100000n }] }).zip));
    const after = await uploadsOf(w.orgId);
    expect(after.map((u) => [u.id, u.superseded_by])).toEqual([[stmt.uploadId, stmt2.uploadId], [small.uploadId, null], [stmt2.uploadId, null]]);
  });
});

describe('S8b (4) the duplicate-copy check keys on the official document number', () => {
  it('the original (+100), its reversal (-100) and the re-bill (+100) all book; 1220 ends at -100.00 against 6400 +100.00 (three charges, one net cost) [kills: the re-bill refused as a copy of the original; a reversal refused]', async () => {
    const w = await s7World(sql, 's8b-copy1', { loanPeriods: false });
    // bookable twins of the real three: same date, same description for the original and the re-bill (what made the old rule refuse it)
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: REAL_INVOICES.original, doc: REAL_DOCS.original, net: 89.29 })));
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: REAL_INVOICES.reversal, doc: REAL_DOCS.reversal, net: -89.29, description: 'Incorrect Invoice Amount Reversal: 200223033317' })));
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: REAL_INVOICES.rebill, doc: REAL_DOCS.rebill, net: 89.29 })));
    for (const doc of [REAL_DOCS.original, REAL_DOCS.reversal, REAL_DOCS.rebill]) expect((await postCharge(w, w.admin, await lineOf(w.orgId, doc))).posted, doc).toBe(true);
    const rows = await sql<{ total_amount: string; net_amount: string; vat_amount: string }[]>`select total_amount::text, net_amount::text, vat_amount::text from channel_period_charges where org_id = ${w.orgId} order by posted_at, id`;
    expect(rows.map((r) => [r.net_amount, r.vat_amount, r.total_amount])).toEqual([['89.29', '10.71', '100.00'], ['-89.29', '-10.71', '-100.00'], ['89.29', '10.71', '100.00']]);
    expect(await netDebit(sql, w.orgId, '1220')).toBe('-100.00');
    expect(await netDebit(sql, w.orgId, '6400')).toBe('100.00');
  });

  it('a re-issue of the original (same document, other bytes) is refused as a copy once the original is booked; nothing is written; the sentence says so in words [kills: the same charge booked twice; a UUID in the sentence]', async () => {
    const w = await s7World(sql, 's8b-copy2', { loanPeriods: false });
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: REAL_INVOICES.original, doc: REAL_DOCS.original, net: 89.29, pdfTag: 'one' })));
    expect((await postCharge(w, w.admin, await lineOf(w.orgId, REAL_DOCS.original))).posted).toBe(true);
    const again = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: REAL_INVOICES.original, doc: REAL_DOCS.original, net: 89.29, pdfTag: 'two' })));
    const entries = await entryCount(sql, w.orgId);
    const sentence = await sentenceOf(postCharge(w, w.admin, await lineOf(w.orgId, REAL_DOCS.original, again.uploadId)));
    expect(sentence).toMatch(/already booked/);
    expect(sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(await entryCount(sql, w.orgId)).toBe(entries);
    expect(await sql`select 1 from channel_period_charges where org_id = ${w.orgId}`).toHaveLength(1);
  });

  const linesOfUpload = (uploadId: string) => sql<{ id: string }[]>`select id::text from settlement_other_lines where upload_id = ${uploadId} order by id`;

  it('audit 3: a document that prints several rows books each of them, even two rows that look EXACTLY alike (same date, net and description) in ONE file: a sibling in the same upload is not a copy [kills: the second of two real same-day, same-net delivery fees refused as a copy of the first]', async () => {
    const w = await s7World(sql, 's8b-copy3', { loanPeriods: false });
    const twins = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033301', doc: '2000000005100001', net: 89.29, description: PANDAGO, copies: 2 })));
    const rows = await linesOfUpload(twins.uploadId);
    expect(rows).toHaveLength(2);
    for (const l of rows) expect((await postCharge(w, w.admin, l.id)).posted).toBe(true);
    expect(await sql`select 1 from channel_period_charges where org_id = ${w.orgId}`).toHaveLength(2);
    // the same document with other figures in the same file books too
    const several = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033302', doc: '2000000005100002', net: 50, description: 'Admin fee', also: [{ net: 70, description: 'Penalty' }] })));
    for (const l of await linesOfUpload(several.uploadId)) expect((await postCharge(w, w.admin, l.id)).posted).toBe(true);
    expect(await sql`select 1 from channel_period_charges where org_id = ${w.orgId}`).toHaveLength(4);
    expect(await netDebit(sql, w.orgId, '6400')).toBe('334.40');
  });

  it('audit 6: another BOOKED charge with the same document number from another file but different figures stops the booking in plain words (a document re-printed with other figures); the exact re-issue is still the copy refusal [kills: a changed re-issue booked on top of the original]', async () => {
    const w = await s7World(sql, 's8b-copy3b', { loanPeriods: false });
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033301', doc: '2000000005100001', net: 89.29 })));
    expect((await postCharge(w, w.admin, await lineOf(w.orgId, '2000000005100001'))).posted).toBe(true);
    const changed = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033301', doc: '2000000005100001', net: 50, pdfTag: 'reissued' })));
    const entries = await entryCount(sql, w.orgId);
    const sentence = await sentenceOf(postCharge(w, w.admin, await lineOf(w.orgId, '2000000005100001', changed.uploadId)));
    expect(sentence).toBe('Foodpanda printed this document before with different figures; ask for help before booking.');
    expect(await entryCount(sql, w.orgId)).toBe(entries);
    // the exact re-issue keeps its own refusal
    const same = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033301', doc: '2000000005100001', net: 89.29, pdfTag: 'exact-again' })));
    expect(await sentenceOf(postCharge(w, w.admin, await lineOf(w.orgId, '2000000005100001', same.uploadId)))).toMatch(/already booked/);
  });

  it('audit 4: a repeat upload of the SAME bytes fills the empty document number of that upload\'s lines (a charge staged before 0260) and writes nothing else: kind, amounts and booked state are untouched; a second repeat changes nothing [kills: a legacy charge that can never be matched; a repeat that rewrites more than the number]', async () => {
    const w = await s7World(sql, 's8b-legacy', { loanPeriods: false });
    const bytes = zipFile(smallInvoice({ invoice: '200223033301', doc: '2000000005100001', net: 89.29, description: PANDAGO }));
    const first = await ingest(w, w.managerA, bytes);
    const lineId = await lineOf(w.orgId, '2000000005100001');
    expect((await postCharge(w, w.admin, lineId)).posted).toBe(true);
    await sql`update settlement_other_lines set official_document = null where upload_id = ${first.uploadId}`; // as it was before document numbers were kept
    const shape = async () => ({
      lines: await sql`select id::text, kind, booked_as, amount::text, vat_amount::text, line_date::text, description, is_current, day_line_id from settlement_other_lines where org_id = ${w.orgId} order by id`,
      uploads: await sql`select id::text, fingerprint, superseded_by::text, prior_items from settlement_uploads where org_id = ${w.orgId} order by id`,
      counts: (await sql`select (select count(*) from settlement_day_lines where org_id = ${w.orgId})::int as d, (select count(*) from audit_log where org_id = ${w.orgId})::int as a, (select count(*) from stored_files where org_id = ${w.orgId})::int as f, (select count(*) from channel_period_charges where org_id = ${w.orgId})::int as c`)[0],
    });
    const before = await shape();
    const again = await ingest(w, w.managerA, bytes);
    expect(again.alreadyUploaded).toBe(true);
    const after = await shape();
    expect(after.lines.map((l) => ({ ...l }))).toEqual(before.lines.map((l) => ({ ...l })));
    const [filled] = await sql<{ official_document: string | null }[]>`select official_document from settlement_other_lines where id = ${lineId}`;
    expect(filled!.official_document).toBe('2000000005100001');
    expect(after.uploads).toEqual(before.uploads);
    expect(after.counts).toEqual(before.counts);
    // a second repeat has nothing left to fill
    await ingest(w, w.managerA, bytes);
    expect(await shape()).toEqual(after);
  });

  it('audit 4: a repeat upload never fills a line whose file printed no number, never overwrites a number already there, and never touches another upload\'s lines [kills: a fill that invents or replaces a document number]', async () => {
    const w = await s7World(sql, 's8b-legacy2', { loanPeriods: false });
    const noDoc = zipFile(smallInvoice({ invoice: '200223033311', doc: '', net: 5 }));
    const withDoc = zipFile(smallInvoice({ invoice: '200223033312', doc: '2000000005100012', net: 7 }));
    await ingest(w, w.managerA, noDoc);
    const kept = await ingest(w, w.managerA, withDoc);
    await sql`update settlement_other_lines set official_document = 'CHANGED' where upload_id = ${kept.uploadId}`;
    await ingest(w, w.managerA, noDoc);
    await ingest(w, w.managerA, withDoc); // its number is not empty, so it is left as it is
    const rows = await sql<{ amount: string; official_document: string | null }[]>`select amount::text, official_document from settlement_other_lines where org_id = ${w.orgId} order by amount`;
    expect(rows).toEqual([{ amount: '5.00', official_document: null }, { amount: '7.00', official_document: 'CHANGED' }]);
  });

  it('two charges with no document number keep the old rule: the same date, net and description is a copy [kills: the old protection lost for charges without a document]', async () => {
    const w = await s7World(sql, 's8b-copy4', { loanPeriods: false });
    const a = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033311', doc: '', net: 89.29 })));
    const b = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033312', doc: '', net: 89.29 })));
    const lines = await sql<{ id: string; upload_id: string; official_document: string | null }[]>`select id::text, upload_id::text, official_document from settlement_other_lines where org_id = ${w.orgId} order by upload_id`;
    expect(lines.map((l) => l.official_document)).toEqual([null, null]);
    const first = lines.find((l) => l.upload_id === a.uploadId)!;
    const second = lines.find((l) => l.upload_id === b.uploadId)!;
    expect((await postCharge(w, w.admin, first.id)).posted).toBe(true);
    expect(await sentenceOf(postCharge(w, w.admin, second.id))).toMatch(/already booked/);
  });
});

describe('S8b (1, 2) staging keeps the document number on each charge and the earlier items on the upload', () => {
  it('every Appendix B line of a weekly carries the weekly\'s document number; its upload keeps the three Appendix C items as the reader returned them; a charge-only invoice has an empty list [kills: the document dropped on the way into the table; prior_items never written]', async () => {
    const w = await s7World(sql, 's8b-stage', { loanPeriods: false });
    await setDestination(sql, w, w.fpA);
    const wk = weekly({
      invoice: '200691218807', tag: 'stage', orders: [{ date: '2026-11-02', revenue: 100000n }, { date: '2026-11-03', revenue: 100000n }],
      ads: [{ date: '2026-11-02', net: 10 }], fee: 20, other: [{ category: 'Admin Adjustment Fee', description: 'Admin Adjustment Fee', net: 5 }],
      prior: [fpPriorRow(REAL_DOCS.original, -100), fpPriorRow(REAL_DOCS.reversal, 100), fpPriorRow(REAL_DOCS.rebill, -100)],
    });
    const r = await ingest(w, w.managerA, zipFile(wk.zip));
    const docs = await sql<{ kind: string; official_document: string | null }[]>`select kind, official_document from settlement_other_lines where org_id = ${w.orgId} and upload_id = ${r.uploadId} order by kind`;
    expect(docs.length).toBeGreaterThanOrEqual(3);
    expect(docs.every((d) => d.official_document === '2000000005141222')).toBe(true);
    const [u] = await sql<{ prior_items: unknown }[]>`select prior_items from settlement_uploads where id = ${r.uploadId}`;
    expect(u!.prior_items).toEqual([
      { document: REAL_DOCS.original, date: '2026-10-31', amount: '-100.00', remaining: '-100.00' },
      { document: REAL_DOCS.reversal, date: '2026-10-31', amount: '100.00', remaining: '100.00' },
      { document: REAL_DOCS.rebill, date: '2026-10-31', amount: '-100.00', remaining: '-100.00' },
    ]);
    const small = await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: '200223033399', doc: '2000000005099999', net: 10 })));
    const [s] = await sql<{ prior_items: unknown }[]>`select prior_items from settlement_uploads where id = ${small.uploadId}`;
    expect(s!.prior_items).toEqual([]);
  });
});
