import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S4 (TESTER, 2026-11-04) - `ingestSettlementFile` against a REAL Postgres (a `_test` database via TEST_DATABASE_URL). docs/tasks/511-settlement-upload-s4-spec.md
 * "ingest.ts" and "Tests", plus the three BOSS corrections of 4 Nov: (a) the fingerprint repeat-check comes AFTER the matched-store gate, (b) the stored file belongs to
 * the MATCHED store, (c) Grab kind is decided from the exact header set (unit tests). Nothing truncates: every `world()` is a new org.
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/ingest.ts` does not exist (the import below cannot resolve).
 *
 * Expected figures come from `tests/unit/t511-s4-helpers.ts` (independent oracle over the fixture text), never from the code under test.
 *
 * CONTRACT (the tester's choices where the spec leaves a signature open; the builder must meet them or ask BOSS to change the tests):
 *  I1  `ingestSettlementFile(tx, actor, { bytes: Buffer | Uint8Array, contentType: string, fileName?: string }): Promise<IngestResult>`, exported from `ingest.ts`
 *      AND reachable from `@shareat/domain`. `fileName` is optional and never decides the kind. The caller (the action) opens one `withOrgPrincipal` per file.
 *  I2  `IngestResult = { kind: 'foodpanda_invoice' | 'grab_transactions' | 'grab_transfers'; platform; channelId; storeId; storeName; uploadId: string;
 *      alreadyUploaded: boolean; uploadedOn: string | null (the earlier upload's Manila date, only when alreadyUploaded);
 *      daysStaged: number (day-line versions this call wrote); daysUnchanged: number; waitingForRows: number (Grab payouts present but with no rows);
 *      waitingFor: 'transfers_file' | 'transactions_file' | null; warnings: string[] }`.
 *      A repeat returns the EARLIER upload's id with alreadyUploaded true and daysStaged 0.
 *  I3  A day line's `source_upload_id` is the upload whose figures it carries (Foodpanda: the invoice; Grab: the Transactions upload); a Grab line's
 *      `payout_upload_id` is the Transfers upload. An unchanged day keeps its old line AND its old source upload (nothing is rewritten).
 *  I4  `difference` = order_value minus recorded_figure (file minus staff: Lipa 20 Oct 9,928.00 - 9,474.00 = +454.00), both null while the sales day is not verified.
 *      The waiting state has no column: it is the null snapshot plus a sentence in `warnings` containing "waiting for the sales day to be verified".
 *  I5  Warnings are sentences in `result.warnings`: /waiting for the Transfers file/i, /waiting for the sales day to be verified/i, /fewer days/i.
 *  I6  Audit: one `audit_log` row per ingested file, action 'settlement_upload.ingested', entity_id = the upload id, store_id = the matched store, actor = the person.
 *  I7  The store refusal for a store the actor may not upload for reads exactly "This file does not belong to your stores" (message and userMessage), nothing else.
 *  I8  A zip's PDF is stored (pdf_file_id set, under the matched store) but never parsed. NOTE FOR BOSS: spec step 7 and the S2a test
 *      `t511-s2-settlement-upload.test.ts` ("an image or a pdf type is refused for this purpose") cannot both hold with `uploadFile(purpose channel_settlement_file)`;
 *      the PDF test below is its own `it` so BOSS can rule on it.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { READER_VERSION } from '../../src/settlement-intake/version';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { grabOracle } from '../unit/t511-s4-helpers';
import { LIPA_FP, LIPA_GRAB_ID, MALVAR_FP, MALVAR_GRAB_ID, bookLine, fixture, parseGrab, salesDay, sha256, synthFoodpanda, upload, world, type World } from './_fixtures/t511-s4-world';
import { setCell, toCsv } from '../unit/t511-s3-helpers';

const sql = postgres(url, { max: 8 });
let driver = inMemoryDriver();
beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const attempt = async (w: World, actor: Actor, f: File): Promise<{ ok: true; r: Awaited<ReturnType<typeof ingest>> } | { ok: false; e: Error & { userMessage?: string; code?: string } }> => {
  try {
    return { ok: true, r: await ingest(w, actor, f) };
  } catch (e) {
    return { ok: false, e: e as Error };
  }
};
const csv = (b: Buffer): File => ({ bytes: b, contentType: 'text/csv' });
const zip = (b: Buffer): File => ({ bytes: b, contentType: 'application/zip' });

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/* ------------------------------------------------------------------ read-backs (raw connection, no RLS) */

interface Line {
  id: string; sales_date: string; version: number; is_current: boolean; review_state: string; source_upload_id: string; payout_upload_id: string | null;
  order_value: string; gross_info: string; commission: string; marketing: string; platform_fee: string; vendor_discount: string; loan_deduction: string;
  loan_disbursal: string; net_payout: string; unexplained: string; recorded_figure: string | null; difference: string | null; payout_reference: string | null;
  payout_date: string | null; payment_arrival_date: string | null; paid_state: string; fee_month_note: string | null; changed_since_booked: boolean;
  decided_by: string | null; settlement_id: string | null;
}
const lines = (orgId: string, channelId: string) => sql<Line[]>`
  select id::text, sales_date::text, version, is_current, review_state, source_upload_id::text, payout_upload_id::text,
         order_value::text, gross_info::text, commission::text, marketing::text, platform_fee::text, vendor_discount::text, loan_deduction::text,
         loan_disbursal::text, net_payout::text, unexplained::text, recorded_figure::text, difference::text, payout_reference,
         payout_date::text, payment_arrival_date::text, paid_state, fee_month_note, changed_since_booked, decided_by::text, settlement_id::text
    from settlement_day_lines where org_id = ${orgId} and channel_id = ${channelId} order by sales_date, version`;
const currentLines = async (orgId: string, channelId: string) => (await lines(orgId, channelId)).filter((l) => l.is_current);
const count = async (table: string, orgId: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where org_id = ${orgId}`;
  return r!.n;
};
const uploads = (orgId: string) => sql<{ id: string; channel_id: string; store_id: string; platform: string; file_kind: string; file_id: string; pdf_file_id: string | null; fingerprint: string;
  reader_version: string; matched_code: string | null; period_from: string | null; period_to: string | null; invoice_number: string | null; orders_read: number; loan_rows_read: number;
  other_rows_read: number; superseded_by: string | null; uploaded_by: string }[]>`
  select id::text, channel_id::text, store_id::text, platform, file_kind, file_id::text, pdf_file_id::text, fingerprint, reader_version, matched_code,
         period_from::text, period_to::text, invoice_number, orders_read, loan_rows_read, other_rows_read, superseded_by::text, uploaded_by::text
    from settlement_uploads where org_id = ${orgId} order by uploaded_at, id`;
const storedFile = async (id: string) => (await sql<{ store_id: string | null; storage_path: string; purpose: string; checksum: string }[]>`select store_id::text, storage_path, purpose, checksum from stored_files where id = ${id}`)[0]!;
const audits = (orgId: string) => sql<{ action: string; entity_id: string; store_id: string | null; actor_person_id: string | null }[]>`
  select action, entity_id::text, store_id::text, actor_person_id::text from audit_log where org_id = ${orgId} and action = 'settlement_upload.ingested'`;
const loanLines = (orgId: string) => sql<{ kind: string; amount: string; row_ordinal: number; loan_id: string | null; allocation_source: string; is_active: boolean; sales_date: string }[]>`
  select l.kind, l.amount::text, l.row_ordinal, l.loan_id::text, l.allocation_source, l.is_active, d.sales_date::text
    from settlement_loan_lines l join settlement_day_lines d on d.org_id = l.org_id and d.id = l.day_line_id where l.org_id = ${orgId} order by d.sales_date, l.row_ordinal`;
const otherLines = (orgId: string) => sql<{ kind: string; booked_as: string; amount: string; line_date: string | null; upload_id: string; sales_date: string | null }[]>`
  select o.kind, o.booked_as, o.amount::text, o.line_date::text, o.upload_id::text, d.sales_date::text
    from settlement_other_lines o left join settlement_day_lines d on d.org_id = o.org_id and d.id = o.day_line_id where o.org_id = ${orgId} order by d.sales_date nulls last, o.kind, o.amount`;

async function nothingWritten(w: World): Promise<void> {
  expect(await count('settlement_uploads', w.orgId)).toBe(0);
  expect(await count('settlement_day_lines', w.orgId)).toBe(0);
  expect(await count('settlement_loan_lines', w.orgId)).toBe(0);
  expect(await count('settlement_other_lines', w.orgId)).toBe(0);
  expect(await count('stored_files', w.orgId)).toBe(0);
  expect((await audits(w.orgId)).length).toBe(0);
  expect(driver.files.size).toBe(0);
}

/* ================================================================== a real Foodpanda invoice, end to end */

describe('T-511 S4 ingest - a real Foodpanda invoice', () => {
  it('Lipa 30 Sep (336 orders): one upload, one pending current line per order date, figures from column R, the file kept, an audit entry [kills: no upload row; wrong store or channel; orders miscounted; audit missing]', async () => {
    const w = await world(sql, 'fp-happy');
    const f = zip(upload('foodpanda-lipa-oct5-34col.zip').bytes);
    const r = await ingest(w, w.managerA, f);
    expect(r).toMatchObject({ kind: 'foodpanda_invoice', platform: 'foodpanda', channelId: w.fpA, storeId: w.storeA, alreadyUploaded: false, daysStaged: 9, daysUnchanged: 0, waitingForRows: 0 });
    const up = await uploads(w.orgId);
    expect(up.length).toBe(1);
    const u = up[0]!;
    expect(u).toMatchObject({
      id: r.uploadId, channel_id: w.fpA, store_id: w.storeA, platform: 'foodpanda', file_kind: 'foodpanda_invoice', fingerprint: sha256(f.bytes), reader_version: READER_VERSION,
      matched_code: LIPA_FP, period_from: '2026-09-21', period_to: '2026-09-30', orders_read: 336, other_rows_read: 6, loan_rows_read: 0, superseded_by: null, uploaded_by: w.managerA.personId,
    });
    expect(u.invoice_number).toMatch(/^\d{12}$/);
    const ls = await lines(w.orgId, w.fpA);
    expect(ls.length).toBe(9);
    for (const l of ls) expect(l).toMatchObject({ version: 1, is_current: true, review_state: 'pending', source_upload_id: r.uploadId, changed_since_booked: false, decided_by: null, settlement_id: null });
    const total = (pick: (l: Line) => string): string => (ls.reduce((a, l) => a + Math.round(Number(pick(l)) * 100), 0) / 100).toFixed(2);
    expect(total((l) => l.order_value)).toBe('120343.00');
    expect(total((l) => l.commission)).toBe('25677.59');
    expect(total((l) => l.unexplained)).toBe('0.00');
    const au = await audits(w.orgId);
    expect(au).toEqual([{ action: 'settlement_upload.ingested', entity_id: r.uploadId, store_id: w.storeA, actor_person_id: w.managerA.personId }]);
  });

  it('the uploaded bytes round-trip from file storage and re-read to the same invoice [kills: storing something other than the original; wrong checksum]', async () => {
    const w = await world(sql, 'fp-roundtrip');
    const orig = upload('foodpanda-malvar-oct12-34col.zip').bytes;
    const r = await ingest(w, w.managerB, zip(orig));
    const [u] = await uploads(w.orgId);
    const f = await storedFile(u!.file_id);
    const back = Buffer.from(await driver.get(f.storage_path));
    expect(sha256(back)).toBe(sha256(orig));
    expect(f.checksum).toBe(sha256(orig));
    const a = await readFoodpandaInvoice((await openSettlementZip(back)).workbook);
    const b = await readFoodpandaInvoice((await openSettlementZip(orig)).workbook);
    expect(a).toEqual(b);
    expect(r.uploadId).toBe(u!.id);
  });

  // Opus ruling 6 (4 Nov, in the spec): the PDF is NOT stored in S4 (limits.ts allows only csv and zip for this purpose; the zip, which holds the PDF, is stored whole). Test edited to match.
  it('the zip is stored whole and its PDF is not stored separately: pdf_file_id stays null, the one stored file belongs to the matched store (ruling 6)', async () => {
    const w = await world(sql, 'fp-pdf');
    await ingest(w, w.managerA, zip(upload('foodpanda-lipa-oct5-34col.zip').bytes));
    const [u] = await uploads(w.orgId);
    expect(u!.pdf_file_id).toBeNull();
    expect(await count('stored_files', w.orgId)).toBe(1);
    expect((await storedFile(u!.file_id)).store_id).toBe(w.storeA);
  });

  it('PandaGO-only invoice: an upload row and three `none` lines with no day, zero day lines [kills: PandaGO booked; a day invented; lines lost]', async () => {
    const w = await world(sql, 'fp-pandago');
    const r = await ingest(w, w.managerA, zip(upload('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip').bytes));
    expect(r).toMatchObject({ kind: 'foodpanda_invoice', daysStaged: 0 });
    expect((await lines(w.orgId, w.fpA)).length).toBe(0);
    const o = await otherLines(w.orgId);
    expect(o.length).toBe(3);
    for (const l of o) expect(l).toMatchObject({ kind: 'pandago', booked_as: 'none', upload_id: r.uploadId, sales_date: null, line_date: '2026-09-24' });
    expect(o.map((l) => l.amount).sort()).toEqual(['-476.00', '1.68', '89.29']);
  });
});

/* ================================================================== Grab: pairing, in both orders */

describe('T-511 S4 ingest - Grab Transfers and Transactions pair in either order', () => {
  const TX = 'grab-lipa-oct-transactions.csv';
  const TR = 'grab-lipa-oct-transfers.csv';
  const norm = (ls: Line[]) =>
    ls.map((l) => [l.sales_date, l.version, l.is_current, l.order_value, l.gross_info, l.commission, l.marketing, l.platform_fee, l.loan_deduction, l.loan_disbursal, l.net_payout, l.unexplained,
      l.payout_reference, l.payout_date, l.payment_arrival_date, l.paid_state, l.review_state].join('|'));

  it('Transfers first stages nothing (every payout waits for rows); Transactions first stages nothing and says it is waiting for the Transfers file; the second file then stages 30 days, identical either way [kills: staging from one file alone; order-dependent result]', async () => {
    const w1 = await world(sql, 'grab-tr-first');
    const first = await ingest(w1, w1.managerA, csv(upload(TR).bytes));
    expect(first).toMatchObject({ kind: 'grab_transfers', daysStaged: 0, waitingForRows: 31 });
    expect((await lines(w1.orgId, w1.grabA)).length).toBe(0);
    const second = await ingest(w1, w1.managerA, csv(upload(TX).bytes));
    expect(second).toMatchObject({ kind: 'grab_transactions', daysStaged: 30, waitingForRows: 1 });

    const w2 = await world(sql, 'grab-tx-first');
    const t = await ingest(w2, w2.managerA, csv(upload(TX).bytes));
    expect(t).toMatchObject({ kind: 'grab_transactions', daysStaged: 0, waitingFor: 'transfers_file' });
    expect(t.warnings.join(' | ')).toMatch(/waiting for the Transfers file/i);
    expect((await lines(w2.orgId, w2.grabA)).length).toBe(0);
    const x = await ingest(w2, w2.managerA, csv(upload(TR).bytes));
    expect(x).toMatchObject({ kind: 'grab_transfers', daysStaged: 30, waitingForRows: 1 });

    const a = await lines(w1.orgId, w1.grabA);
    const b = await lines(w2.orgId, w2.grabA);
    expect(a.length).toBe(30);
    expect(norm(b)).toEqual(norm(a));
    expect((await loanLines(w2.orgId)).map((l) => `${l.sales_date}|${l.kind}|${l.amount}|${l.row_ordinal}`)).toEqual((await loanLines(w1.orgId)).map((l) => `${l.sales_date}|${l.kind}|${l.amount}|${l.row_ordinal}`));
    expect((await otherLines(w2.orgId)).map((l) => `${l.sales_date}|${l.kind}|${l.amount}`)).toEqual((await otherLines(w1.orgId)).map((l) => `${l.sales_date}|${l.kind}|${l.amount}`));
  });

  it('every staged day equals the oracle; the first payout of the month stays waiting_for_rows (no line for 30 Sep); the Transfers upload is the payout upload, the Transactions upload the source [kills: wrong figures; a line for a payout with no rows; upload ids swapped]', async () => {
    const w = await world(sql, 'grab-oracle');
    await ingest(w, w.managerA, csv(upload(TR).bytes));
    await ingest(w, w.managerA, csv(upload(TX).bytes));
    const oracle = grabOracle(fixture(TX), fixture(TR));
    const ls = await currentLines(w.orgId, w.grabA);
    expect(ls.map((l) => l.sales_date)).toEqual([...oracle.days.keys()].sort());
    expect(ls.some((l) => l.sales_date === '2026-09-30')).toBe(false);
    const ups = await uploads(w.orgId);
    const trUp = ups.find((u) => u.file_kind === 'grab_transfers')!;
    const txUp = ups.find((u) => u.file_kind === 'grab_transactions')!;
    for (const l of ls) {
      const e = oracle.days.get(l.sales_date)!;
      expect({ ov: l.order_value, gi: l.gross_info, c: l.commission, m: l.marketing, pf: l.platform_fee, ld: l.loan_deduction, lb: l.loan_disbursal, np: l.net_payout, un: l.unexplained, ref: l.payout_reference, pd: l.payout_date, paid: l.paid_state }, l.sales_date).toEqual(
        { ov: e.orderValue, gi: e.grossInfo, c: e.commission, m: e.marketing, pf: e.platformFee, ld: e.loanDeduction, lb: e.loanDisbursal, np: e.netPayout, un: e.unexplained, ref: e.settlementId, pd: e.payoutDate, paid: e.paid ? 'paid' : 'not_paid' });
      expect(l.source_upload_id, l.sales_date).toBe(txUp.id);
      expect(l.payout_upload_id, l.sales_date).toBe(trUp.id);
      expect(l.review_state).toBe('pending');
    }
    expect(trUp).toMatchObject({ matched_code: LIPA_GRAB_ID, store_id: w.storeA, channel_id: w.grabA });
    expect(txUp).toMatchObject({ matched_code: LIPA_GRAB_ID, period_from: '2026-10-01', period_to: '2026-10-31', loan_rows_read: 46 });
  });

  it('the 13 Oct payout of 154,473.51: loan lines are stored unallocated with a row ordinal, the disbursal is not in the deposit [kills: loan id set in S4; disbursal in net payout; ordinal missing]', async () => {
    const w = await world(sql, 'grab-loan');
    await ingest(w, w.managerA, csv(upload(TX).bytes));
    await ingest(w, w.managerA, csv(upload(TR).bytes));
    const d = (await currentLines(w.orgId, w.grabA)).find((l) => l.sales_date === '2026-10-12')!;
    expect(d).toMatchObject({ loan_disbursal: '150000.00', net_payout: '4473.51', loan_deduction: '591.24', unexplained: '0.00', payout_reference: 'SPHVGHJILI4K' });
    const ll = await loanLines(w.orgId);
    expect(ll.length).toBe(45);
    for (const l of ll) {
      expect(l.loan_id).toBeNull();
      expect(l.allocation_source).toBe('auto');
      expect(l.is_active).toBe(true);
      expect(Number(l.amount)).toBeGreaterThan(0);
      expect(Number.isInteger(l.row_ordinal)).toBe(true);
    }
    expect(ll.filter((l) => l.sales_date === '2026-10-12').map((l) => `${l.kind}:${l.amount}`).sort()).toEqual(['deduction:591.24', 'disbursal:150000.00']);
    // the two adjustment rows of the Lipa file are stored as other lines on their days, with a kind and a booking
    const o = await otherLines(w.orgId);
    expect(o.length).toBe(2);
    for (const l of o) expect(['withholding_tax', 'chargeback', 'compensation']).toContain(l.kind);
  });

  it('Lipa 20 Oct: recorded 9,474.00 against file 9,928.00 snapshots difference +454.00 on the line; 12 Oct (no sales day) snapshots null [kills: no snapshot; sign; snapshot for an unverified day]', async () => {
    const w = await world(sql, 'grab-diff');
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-20', '9474.00', { verified: true });
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-19', '1.00', { verified: false });
    const a = await ingest(w, w.managerA, csv(upload(TX).bytes));
    const b = await ingest(w, w.managerA, csv(upload(TR).bytes));
    const ls = await currentLines(w.orgId, w.grabA);
    const d20 = ls.find((l) => l.sales_date === '2026-10-20')!;
    expect(d20).toMatchObject({ order_value: '9928.00', recorded_figure: '9474.00', difference: '454.00' });
    for (const date of ['2026-10-19', '2026-10-12']) expect(ls.find((l) => l.sales_date === date), date).toMatchObject({ recorded_figure: null, difference: null });
    expect([...a.warnings, ...b.warnings].join(' | ')).toMatch(/waiting for the sales day to be verified/i);
  });

  it('replacing the Transactions file re-matches only the affected day: one new version, the rest untouched; the old upload is superseded [kills: re-staging every day; no re-match; supersede missing]', async () => {
    const w = await world(sql, 'grab-replace-tx');
    await ingest(w, w.managerA, csv(upload(TR).bytes));
    const first = await ingest(w, w.managerA, csv(upload(TX).bytes));
    const g = parseGrab(fixture(TX));
    const at = g.rows.findIndex((r) => (r[g.headers.indexOf('Category')] ?? '').trim() === 'Payment' && (r[g.headers.indexOf('Settlement ID')] ?? '').trim() === 'SPHVGHJILI4K');
    const before = (g.rows[at] as string[])[g.headers.indexOf('Net Sales')] as string;
    setCell(g, at, 'Net Sales', (Number(before) + 1).toFixed(2));
    const changed = toCsv(g);
    const oracle = grabOracle(changed, fixture(TR));
    const original = grabOracle(fixture(TX), fixture(TR));
    const moved = [...oracle.days.keys()].filter((d) => oracle.days.get(d)!.orderValue !== original.days.get(d)!.orderValue);
    expect(moved).toEqual(['2026-10-12']);
    const second = await ingest(w, w.managerA, csv(changed));
    expect(second).toMatchObject({ kind: 'grab_transactions', daysStaged: 1, daysUnchanged: 29, alreadyUploaded: false });
    const all = await lines(w.orgId, w.grabA);
    expect(all.length).toBe(31);
    const twelve = all.filter((l) => l.sales_date === '2026-10-12');
    expect(twelve.map((l) => `${l.version}:${l.is_current}:${l.order_value}`)).toEqual([`1:false:6753.00`, `2:true:6754.00`]);
    expect(all.filter((l) => l.sales_date !== '2026-10-12').every((l) => l.version === 1 && l.is_current && l.source_upload_id === first.uploadId)).toBe(true);
    const ups = await uploads(w.orgId);
    expect(ups.find((u) => u.id === first.uploadId)!.superseded_by).toBe(second.uploadId);
    expect(ups.find((u) => u.id === second.uploadId)!.superseded_by).toBeNull();
  });

  it('replacing the Transfers file re-matches the affected day: a changed payout total moves net payout and the unexplained amount, one new version [kills: Transfers replacement not re-matched]', async () => {
    const w = await world(sql, 'grab-replace-tr');
    await ingest(w, w.managerA, csv(upload(TX).bytes));
    await ingest(w, w.managerA, csv(upload(TR).bytes));
    const g = parseGrab(fixture(TR));
    const at = g.rows.findIndex((r) => (r[g.headers.indexOf('Settlement ID')] ?? '').trim() === 'SPHVGHJILI4K');
    setCell(g, at, 'Net Total', '154473.01'); // the bank paid 0.50 less
    const second = await ingest(w, w.managerA, csv(toCsv(g)));
    expect(second).toMatchObject({ kind: 'grab_transfers', daysStaged: 1, daysUnchanged: 29 });
    const twelve = (await lines(w.orgId, w.grabA)).filter((l) => l.sales_date === '2026-10-12');
    expect(twelve.map((l) => `${l.version}:${l.is_current}:${l.net_payout}:${l.unexplained}`)).toEqual(['1:false:4473.51:0.00', '2:true:4473.01:-0.50']);
  });
});

/* ================================================================== idempotence, versions, booked lines, warnings */

describe('T-511 S4 ingest - the same file, a changed file, a booked line', () => {
  const orders = (revenues: [string, number][]) => revenues.map(([date, revenue]) => ({ date, revenue }));

  it('the same bytes twice: one upload row, no new lines, no second stored file, no second audit entry; the answer says it was already uploaded [kills: duplicate upload; duplicate lines; duplicate evidence]', async () => {
    const w = await world(sql, 'idem');
    const f = zip(upload('foodpanda-lipa-oct5-34col.zip').bytes);
    const first = await ingest(w, w.managerA, f);
    const files = await count('stored_files', w.orgId);
    const linesBefore = await count('settlement_day_lines', w.orgId);
    const again = await ingest(w, w.managerA, f);
    expect(again).toMatchObject({ uploadId: first.uploadId, alreadyUploaded: true, daysStaged: 0 });
    expect(again.uploadedOn).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(await count('settlement_uploads', w.orgId)).toBe(1);
    expect(await count('settlement_day_lines', w.orgId)).toBe(linesBefore);
    expect(await count('stored_files', w.orgId)).toBe(files);
    expect(driver.files.size).toBe(files);
    expect((await audits(w.orgId)).length).toBe(1);
  });

  it('a changed figure for one day: that day gets version 2 and the old one stops being current; the other day is untouched; the old upload is superseded; one current line per day [kills: edit in place; two current lines; unchanged day rewritten]', async () => {
    const w = await world(sql, 'version');
    const one = await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100], ['2026-10-11', 200]]), LIPA_FP, 'a')));
    const two = await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 150], ['2026-10-11', 200]]), LIPA_FP, 'b')));
    expect(two).toMatchObject({ daysStaged: 1, daysUnchanged: 1, alreadyUploaded: false });
    expect(two.warnings.join(' | ')).not.toMatch(/fewer days/i);
    const all = await lines(w.orgId, w.fpA);
    expect(all.map((l) => `${l.sales_date}|v${l.version}|${l.is_current}|${l.order_value}|${l.review_state}|${l.source_upload_id === one.uploadId ? 'u1' : 'u2'}`)).toEqual([
      '2026-10-10|v1|false|100.00|pending|u1',
      '2026-10-10|v2|true|150.00|pending|u2',
      '2026-10-11|v1|true|200.00|pending|u1',
    ]);
    const perDay = new Map<string, number>();
    for (const l of all.filter((x) => x.is_current)) perDay.set(l.sales_date, (perDay.get(l.sales_date) ?? 0) + 1);
    expect([...perDay.values()]).toEqual([1, 1]);
    expect((await uploads(w.orgId)).map((u) => u.superseded_by)).toEqual([two.uploadId, null]);
  });

  it('a booked line and a changed figure: a NEW pending version flagged changed_since_booked becomes current; the booked version keeps every figure, its decision and its settlement [kills: booked row edited; no flag; booked version deleted]', async () => {
    const w = await world(sql, 'booked');
    await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100], ['2026-10-11', 200]]), LIPA_FP, 'a')));
    const v1 = (await currentLines(w.orgId, w.fpA)).find((l) => l.sales_date === '2026-10-10')!;
    const { settlementId } = await bookLine(sql, w, v1.id);
    const bookedBefore = (await lines(w.orgId, w.fpA)).find((l) => l.id === v1.id)!;
    const r = await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 175], ['2026-10-11', 200]]), LIPA_FP, 'b')));
    expect(r.daysStaged).toBe(1);
    const all = await lines(w.orgId, w.fpA);
    const booked = all.find((l) => l.id === v1.id)!;
    // the booked version: everything but the pointer that says "current" is exactly as it was
    expect({ ...booked, is_current: null }).toEqual({ ...bookedBefore, is_current: null });
    expect(booked).toMatchObject({ review_state: 'booked', order_value: '100.00', settlement_id: settlementId, decided_by: w.admin.personId, is_current: false });
    const fresh = all.find((l) => l.sales_date === '2026-10-10' && l.version === 2)!;
    expect(fresh).toMatchObject({ review_state: 'pending', is_current: true, order_value: '175.00', changed_since_booked: true, decided_by: null, settlement_id: null });
    expect(all.filter((l) => l.sales_date === '2026-10-10' && l.is_current).length).toBe(1);
  });

  it('a booked line and the SAME figures in a different file: nothing is written for that day (no version, no flag) [kills: new version for identical figures; flag on identical figures]', async () => {
    const w = await world(sql, 'booked-same');
    await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100]]), LIPA_FP, 'a')));
    const v1 = (await currentLines(w.orgId, w.fpA))[0]!;
    await bookLine(sql, w, v1.id);
    const r = await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100]]), LIPA_FP, 'b')));
    expect(r).toMatchObject({ daysStaged: 0, daysUnchanged: 1, alreadyUploaded: false });
    const all = await lines(w.orgId, w.fpA);
    expect(all.length).toBe(1);
    expect(all[0]).toMatchObject({ review_state: 'booked', is_current: true, changed_since_booked: false });
  });

  it('a new file with fewer days than the one it replaces (same period) warns, replaces only the days it has, and leaves the missing day\'s line current [kills: no warning; the missing day retired]', async () => {
    const w = await world(sql, 'fewer');
    const one = await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100], ['2026-10-11', 100], ['2026-10-12', 100]]), LIPA_FP, 'a')));
    expect(one.warnings.join(' | ')).not.toMatch(/fewer days/i);
    const two = await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100], ['2026-10-12', 100]]), LIPA_FP, 'b')));
    expect(two.warnings.join(' | ')).toMatch(/fewer days/i);
    const current = await currentLines(w.orgId, w.fpA);
    expect(current.map((l) => l.sales_date)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    expect(current.find((l) => l.sales_date === '2026-10-11')!.source_upload_id).toBe(one.uploadId);
  });

  it('an unverified or missing sales day stores null recorded figure and difference, and the answer says it is waiting for the sales day to be verified; a verified day stores both [kills: snapshot from an unverified day; no waiting sentence; verified day not snapshotted]', async () => {
    const w = await world(sql, 'snapshot');
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-10', '100.00', { verified: true });
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-11', '200.00', { verified: false }); // open, not verified
    // 12 Oct: no sales day at all
    const r = await ingest(w, w.managerA, zip(synthFoodpanda(orders([['2026-10-10', 100], ['2026-10-11', 200], ['2026-10-12', 300]]), LIPA_FP, 'a')));
    const ls = await currentLines(w.orgId, w.fpA);
    expect(ls.find((l) => l.sales_date === '2026-10-10')).toMatchObject({ recorded_figure: '100.00', difference: '0.00' });
    expect(ls.find((l) => l.sales_date === '2026-10-11')).toMatchObject({ recorded_figure: null, difference: null });
    expect(ls.find((l) => l.sales_date === '2026-10-12')).toMatchObject({ recorded_figure: null, difference: null });
    expect(r.warnings.join(' | ')).toMatch(/waiting for the sales day to be verified/i);
    // the file never verifies or posts to a day
    const [days] = await sql<{ open: number; verified: number }[]>`
      select count(*) filter (where status <> 'verified')::int as open, count(*) filter (where status = 'verified')::int as verified from sales_days where org_id = ${w.orgId}`;
    expect(days).toEqual({ open: 1, verified: 1 });
    expect((await sql`select 1 from journal_entries where org_id = ${w.orgId}`).length).toBe(0);
  });
});

/* ================================================================== who may upload what, and where it is stored */

describe('T-511 S4 ingest - the gates', () => {
  const FP_LIPA = () => zip(upload('foodpanda-lipa-oct5-34col.zip').bytes);

  it('(a) a manager of B uploading A\'s ALREADY-uploaded file gets only the generic refusal: no date, no "already uploaded", no id, no store name, no code; nothing is written [kills: fingerprint repeat-check before the store gate (the leak BOSS ruled out)]', async () => {
    const w = await world(sql, 'leak');
    await ingest(w, w.managerA, FP_LIPA());
    const uploadsBefore = await count('settlement_uploads', w.orgId);
    const filesBefore = await count('stored_files', w.orgId);
    const linesBefore = await count('settlement_day_lines', w.orgId);
    const auditsBefore = (await audits(w.orgId)).length;
    const r = await attempt(w, w.managerB, FP_LIPA());
    expect(r.ok).toBe(false);
    const e = (r as { e: Error & { userMessage?: string } }).e;
    const texts = [e.message, e.userMessage].filter((t): t is string => typeof t === 'string');
    expect(texts.some((t) => t.includes('This file does not belong to your stores'))).toBe(true);
    for (const t of texts) {
      expect(t).not.toMatch(UUID);
      expect(t).not.toMatch(/already|uploaded|duplicate|earlier|before/i);
      expect(t).not.toMatch(/\b20\d\d\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
      expect(t).not.toMatch(/Lipa|Foodpanda|O6JZ|Malvar/);
      expect(t).not.toContain('[hidden]');
    }
    expect(await count('settlement_uploads', w.orgId)).toBe(uploadsBefore);
    expect(await count('stored_files', w.orgId)).toBe(filesBefore);
    expect(await count('settlement_day_lines', w.orgId)).toBe(linesBefore);
    expect((await audits(w.orgId)).length).toBe(auditsBefore);
  });

  it('a manager of B uploading A\'s file for the first time: the same generic refusal and NO rows written (rollback proof, every table, storage empty) [kills: partial write before the store gate]', async () => {
    const w = await world(sql, 'other-store');
    const r = await attempt(w, w.managerB, FP_LIPA());
    expect(r.ok).toBe(false);
    const e = (r as { e: Error & { userMessage?: string } }).e;
    expect([e.message, e.userMessage].join(' | ')).toContain('This file does not belong to your stores');
    await nothingWritten(w);
  });

  it('the same for a Grab file: B\'s manager uploads Lipa\'s Grab Transfers file and learns nothing but the generic sentence [kills: Grab path skipping the fine gate]', async () => {
    const w = await world(sql, 'other-store-grab');
    const r = await attempt(w, w.managerB, csv(upload('grab-lipa-oct-transfers.csv').bytes));
    expect(r.ok).toBe(false);
    const e = (r as { e: Error & { userMessage?: string } }).e;
    for (const t of [e.message, e.userMessage].filter((x): x is string => typeof x === 'string')) {
      expect(t).not.toMatch(UUID);
      expect(t).not.toContain('[hidden]');
    }
    expect([e.message, e.userMessage].join(' | ')).toContain('This file does not belong to your stores');
    await nothingWritten(w);
  });

  it('staff are refused by the coarse gate BEFORE any byte is read: garbage bytes still give AuthorizationError, nothing stored [kills: reading the file first; staff allowed]', async () => {
    const w = await world(sql, 'staff');
    const r = await attempt(w, w.staff, csv(Buffer.from('this is not a settlement file at all\n')));
    expect(r.ok).toBe(false);
    expect((r as { e: unknown }).e).toBeInstanceOf(AuthorizationError);
    await nothingWritten(w);
  });

  it('(b) an admin (scoped to both stores, store A first) uploads Malvar\'s invoice: the upload, the stored file and the PDF all belong to Malvar, the MATCHED store, not the actor\'s first store [kills: evidence filed under the actor\'s store]', async () => {
    const w = await world(sql, 'admin-store');
    const r = await ingest(w, w.admin, zip(upload('foodpanda-malvar-oct12-34col.zip').bytes));
    expect(r).toMatchObject({ storeId: w.storeB, channelId: w.fpB });
    const [u] = await uploads(w.orgId);
    expect(u).toMatchObject({ store_id: w.storeB, channel_id: w.fpB, matched_code: MALVAR_FP });
    const f = await storedFile(u!.file_id);
    expect(f.store_id).toBe(w.storeB);
    expect(f.storage_path).toContain(`/stores/${w.storeB}/`);
    expect(f.storage_path).not.toContain(w.storeA);
    expect(f.purpose).toBe('channel_settlement_file');
    if (u!.pdf_file_id) expect((await storedFile(u!.pdf_file_id)).store_id).toBe(w.storeB);
  });

  it('(b) the same for a Grab CSV uploaded by that admin: the stored file belongs to Malvar [kills: evidence filed under the actor\'s store on the Grab path]', async () => {
    const w = await world(sql, 'admin-store-grab');
    await ingest(w, w.admin, csv(upload('grab-malvar-oct-transfers.csv').bytes));
    const [u] = await uploads(w.orgId);
    expect(u).toMatchObject({ store_id: w.storeB, channel_id: w.grabB, matched_code: MALVAR_GRAB_ID });
    expect((await storedFile(u!.file_id)).store_id).toBe(w.storeB);
  });

  it('a code nobody has set up is refused naming what to do, never a Store ID; nothing written [kills: UUID or [hidden] in the sentence; partial write]', async () => {
    const w = await world(sql, 'no-channel', { channels: false });
    const r = await attempt(w, w.managerA, csv(upload('grab-lipa-oct-transfers.csv').bytes));
    expect(r.ok).toBe(false);
    const e = (r as { e: Error & { userMessage?: string } }).e;
    for (const t of [e.message, e.userMessage].filter((x): x is string => typeof x === 'string')) {
      expect(t).not.toMatch(UUID);
      expect(t).not.toContain('[hidden]');
      expect(t).toMatch(/Grab store is not set up/i);
    }
    await nothingWritten(w);
  });

  it('a Foodpanda vendor code nobody has set up is refused naming the code [kills: generic sentence with no code]', async () => {
    const w = await world(sql, 'no-fp-channel', { channels: false });
    const r = await attempt(w, w.managerA, zip(upload('foodpanda-lipa-oct5-34col.zip').bytes));
    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).toContain(LIPA_FP);
    await nothingWritten(w);
  });

  it('org isolation: the same bytes in another org are accepted as new there; each org sees only its own rows; a code owned only by another org is "not set up" and reveals nothing about that org [kills: org-wide fingerprint; cross-org read; cross-org match]', async () => {
    const w1 = await world(sql, 'iso-1');
    const w2 = await world(sql, 'iso-2');
    const f = zip(upload('foodpanda-lipa-oct5-34col.zip').bytes);
    const a = await ingest(w1, w1.managerA, f);
    const b = await ingest(w2, w2.managerA, f);
    expect(b.alreadyUploaded).toBe(false);
    expect(b.uploadId).not.toBe(a.uploadId);
    expect((await uploads(w1.orgId)).length).toBe(1);
    expect((await uploads(w2.orgId)).length).toBe(1);
    const seen = await asOrg(w2.orgId, async (tx) => {
      const rows = (await tx.execute(dsql`select id::text as id from settlement_uploads`)) as unknown as { id: string }[];
      return rows.map((r) => r.id);
    });
    expect(seen).toEqual([b.uploadId]);
    // a channel that exists only in org 2 under a code org 1 does not have
    await sql`update sales_channels set platform_store_code = 'ONLY2' where id = ${w2.fpB}`;
    const only2 = zip(synthFoodpanda([{ date: '2026-10-10', revenue: 100 }], 'ONLY2', 'x'));
    const r = await attempt(w1, w1.admin, only2);
    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).not.toMatch(/Malvar/);
    expect((await uploads(w1.orgId)).length).toBe(1);
  });
});

describe('T-511 S4 ingest - bad files and batches', () => {
  it('one bad file in a batch of three leaves the other two staged (one transaction per file) [kills: one transaction for the batch]', async () => {
    const w = await world(sql, 'batch');
    const good1 = zip(upload('foodpanda-lipa-oct5-34col.zip').bytes);
    const bad = csv(Buffer.from('Date,Store Name,Mystery\n1,2,3\n'));
    const good2 = csv(upload('grab-lipa-oct-transfers.csv').bytes);
    const out = [await attempt(w, w.managerA, good1), await attempt(w, w.managerA, bad), await attempt(w, w.managerA, good2)];
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect((await uploads(w.orgId)).length).toBe(2);
    expect((await currentLines(w.orgId, w.fpA)).length).toBe(9);
    const e = (out[1] as { e: Error }).e;
    expect(e.message).not.toMatch(UUID);
  });

  it('the size, type and magic-byte gates refuse before anything is stored: 3 MB + 1 byte, a PNG, CSV text declared as a zip, an empty file [kills: reading or storing before the gates]', async () => {
    const w = await world(sql, 'gates');
    const big = csv(Buffer.alloc(3 * 1024 * 1024 + 1, 0x41));
    const png = { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), contentType: 'image/png' };
    const lying = { bytes: upload('grab-lipa-oct-transfers.csv').bytes, contentType: 'application/zip' };
    const empty = csv(Buffer.alloc(0));
    for (const f of [big, png, lying, empty]) {
      const r = await attempt(w, w.managerA, f);
      expect(r.ok).toBe(false);
      expect((r as { e: Error }).e.message).not.toMatch(UUID);
    }
    expect((await attempt(w, w.managerA, big) as { e: Error & { code?: string } }).e.code).toBe('FILE_TOO_BIG');
    await nothingWritten(w);
  });

  it('an unknown Grab header (68 columns, one renamed) is refused naming the column and writes nothing [kills: read as Transactions by column count]', async () => {
    const w = await world(sql, 'unknown-header');
    const g = parseGrab(fixture('grab-lipa-oct-transactions.csv'));
    g.headers[g.headers.indexOf('Net Sales')] = 'Net Sales Adjusted';
    const r = await attempt(w, w.managerA, csv(toCsv(g)));
    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).toContain('Net Sales Adjusted');
    await nothingWritten(w);
  });

  it('a Transfers file named .xlsx and a Transactions file named Transfers.csv are read by content: the kind in the answer is the content\'s [kills: kind from the file name]', async () => {
    const w = await world(sql, 'by-content');
    const a = await asOrg(w.orgId, (tx) => ingestSettlementFile(tx, w.managerA, { bytes: upload('grab-lipa-oct-transfers.csv').bytes, contentType: 'text/csv', fileName: 'payouts.xlsx' }));
    const b = await asOrg(w.orgId, (tx) => ingestSettlementFile(tx, w.managerA, { bytes: upload('grab-lipa-oct-transactions.csv').bytes, contentType: 'text/csv', fileName: 'Transfers.csv' }));
    expect(a.kind).toBe('grab_transfers');
    expect(b.kind).toBe('grab_transactions');
  });

  it('two uploads racing the same bytes: one upload row, no duplicate lines, and any loser fails with a named refusal or reports "already uploaded", never a raw database error [kills: unique violation surfacing; duplicate staging]', async () => {
    const w = await world(sql, 'race');
    const f = zip(upload('foodpanda-lipa-oct5-34col.zip').bytes);
    const [x, y] = await Promise.all([attempt(w, w.managerA, f), attempt(w, w.managerA, f)]);
    for (const o of [x, y]) {
      if (!o.ok) expect(o.e.name, o.e.message).not.toMatch(/PostgresError|DrizzleQueryError/);
      if (!o.ok) expect(o.e.message).not.toMatch(/duplicate key|violates|settlement_uploads_org_fingerprint_key/i);
    }
    expect([x, y].some((o) => o.ok)).toBe(true);
    expect((await uploads(w.orgId)).length).toBe(1);
    expect((await lines(w.orgId, w.fpA)).length).toBe(9);
    expect((await audits(w.orgId)).length).toBe(1);
  });

  it('no refusal of any kind in this file names a UUID or says [hidden] (a sweep over the refusals the fixtures can raise)', async () => {
    const w = await world(sql, 'sweep', { channels: false });
    const cases: File[] = [
      csv(upload('grab-lipa-oct-transfers.csv').bytes),
      csv(upload('hostile-grab-header-only.csv').bytes),
      csv(upload('hostile-grab-missing-settlement-id-column.csv').bytes),
      zip(upload('hostile-zip-nested-archive.zip').bytes),
      zip(upload('foodpanda-lipa-oct5-34col.zip').bytes),
    ];
    for (const f of cases) {
      const r = await attempt(w, w.managerA, f);
      expect(r.ok).toBe(false);
      const e = (r as { e: Error & { userMessage?: string } }).e;
      for (const t of [e.message, e.userMessage].filter((x): x is string => typeof x === 'string')) {
        expect(t).not.toMatch(UUID);
        expect(t).not.toContain('[hidden]');
      }
    }
    await nothingWritten(w);
  });
});

/* ------------------------------------------------------------------ the Malvar Grab Transactions file re-read from storage gives the same rows */

describe('T-511 S4 ingest - a Grab file round-trips from storage', () => {
  it('the stored Transactions CSV re-reads with the same result as the original [kills: storing a re-encoded or truncated copy]', async () => {
    const w = await world(sql, 'grab-roundtrip');
    const orig = upload('grab-malvar-oct-transactions.csv').bytes;
    await ingest(w, w.managerB, csv(orig));
    const [u] = await uploads(w.orgId);
    const back = Buffer.from(await driver.get((await storedFile(u!.file_id)).storage_path));
    expect(sha256(back)).toBe(sha256(orig));
    expect(readGrabTransactions(back)).toEqual(readGrabTransactions(orig));
  });
});
