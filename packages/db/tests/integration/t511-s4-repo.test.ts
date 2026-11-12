import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S4 (TESTER, 2026-11-04) - `settlementIntakeRepo`, the only place the staging SQL is written (docs/tasks/511-settlement-upload-s4-spec.md "Repo"). Real Postgres
 * via TEST_DATABASE_URL (a `_test` DB), through the app role with the org principal set (RLS on). Nothing truncates: every org is new.
 *
 * RED today, for one reason: `settlementIntakeRepo` is not exported from `@shareat/db` (the repo file does not exist), so every call below is "not a function".
 *
 * CONTRACT (every function takes `tx` then `orgId`; money is a 2-decimal string; dates are YYYY-MM-DD):
 *  R1  `insertUpload(tx, orgId, input): Promise<{ row: UploadRow; created: boolean }>`. Input = { channelId, storeId, platform, fileKind, fileId, pdfFileId, fingerprint,
 *      readerVersion, matchedCode, periodFrom, periodTo, invoiceNumber, ordersRead, loanRowsRead, otherRowsRead, uploadedBy }. A repeat fingerprint in the org returns
 *      the EARLIER row with created false and writes nothing. `UploadRow` has `id`, `fingerprint`, `supersededBy`, `uploadedAt` (camelCase).
 *  R2  `findUploadByFingerprint(tx, orgId, fingerprint): Promise<UploadRow | null>` (not in the spec's list; needed because the repeat check must run BEFORE the file is stored,
 *      and `insertUpload` needs the stored file's id).
 *  R3  `findCurrentUploads(tx, orgId, channelId, fileKind): Promise<UploadRow[]>`: not superseded, newest first. `markSuperseded(tx, orgId, uploadId, supersededBy): Promise<void>`.
 *  R4  `currentLine(tx, orgId, channelId, salesDate): Promise<DayLineRow | null>` (not in the spec's list; ingest step 10 needs it). `insertDayLineVersion(tx, orgId, input): Promise<DayLineRow>`
 *      with Input = { channelId, storeId, platform, salesDate, version, sourceUploadId, payoutUploadId, orderValue, grossInfo, commission, marketing, platformFee, vendorDiscount,
 *      loanDeduction, loanDisbursal, netPayout, unexplained, recordedFigure, difference, payoutReference, payoutDate, paymentArrivalDate, paidState, feeMonthNote, changedSinceBooked }.
 *      `retireCurrentLine(tx, orgId, lineId): Promise<void>` flips is_current only.
 *  R5  `insertLoanLines(tx, orgId, dayLineId, lines: { kind; amount; rowOrdinal }[]): Promise<void>`;
 *      `insertOtherLines(tx, orgId, uploadId, dayLineId: string | null, lines: { kind; bookedAs; amount; lineDate; description }[]): Promise<void>`.
 *  R6  `salesDayFigure(tx, orgId, channelId, salesDate): Promise<{ recorded: string | null; verified: boolean; noSales: boolean }>`: `recorded` is the channel amount of a VERIFIED day
 *      that is not no_sales, else null.
 *  R7  `daysWithRecordedSalesAndNoLine(tx, orgId, channelId): Promise<string[]>`: ascending dates of verified, not-no_sales days with an amount above zero and NO current day line.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, settlementIntakeRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const R = settlementIntakeRepo as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t511s4r-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Lipa') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('P')}) returning id`;
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code)
    values (${orgId}, ${s!.id}, ${uid('Grab')}, false, '1220', 'grab', ${uid('code')}) returning id`;
  const file = async () => {
    const [f] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${s!.id}, 'memo_document', ${`orgs/${orgId}/stores/${s!.id}/memo_document/${uid('f')}.pdf`}, 'application/pdf', 10, 'abc', ${p!.id}) returning id`;
    return f!.id;
  };
  return { orgId, store: s!.id, person: p!.id, channel: c!.id, file };
}
type F = Awaited<ReturnType<typeof fixture>>;

const upl = async (f: F, over: Record<string, unknown> = {}) => ({
  channelId: f.channel, storeId: f.store, platform: 'grab', fileKind: 'grab_transactions', fileId: await f.file(), pdfFileId: null, fingerprint: uid('fp'),
  readerVersion: 'settlement-intake-reader/1', matchedCode: 'code-1', periodFrom: '2026-10-01', periodTo: '2026-10-31', invoiceNumber: null, ordersRead: 5, loanRowsRead: 1,
  otherRowsRead: 0, uploadedBy: f.person, ...over,
});
const day = (f: F, uploadId: string, over: Record<string, unknown> = {}) => ({
  channelId: f.channel, storeId: f.store, platform: 'grab', salesDate: '2026-10-12', version: 1, sourceUploadId: uploadId, payoutUploadId: null, orderValue: '6753.00', grossInfo: '6807.00',
  commission: '1688.25', marketing: '0.00', platformFee: '0.00', vendorDiscount: '54.00', loanDeduction: '591.24', loanDisbursal: '0.00', netPayout: '4473.51', unexplained: '0.00',
  recordedFigure: null, difference: null, payoutReference: 'SPHTEST00001', payoutDate: '2026-10-13', paymentArrivalDate: null, paidState: 'paid', feeMonthNote: null, changedSinceBooked: false,
  ...over,
});
const dbCode = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x.cause?.code ?? x.code;
};

describe('T-511 S4 repo - uploads', () => {
  it('insertUpload writes one row and findUploadByFingerprint finds it; the same fingerprint again returns the EARLIER row, created false, and writes nothing [kills: second row; error on repeat]', async () => {
    const f = await fixture('up');
    const input = await upl(f);
    const first = await asOrg(f.orgId, (tx) => R.insertUpload!(tx, f.orgId, input));
    expect(first.created).toBe(true);
    const found = await asOrg(f.orgId, (tx) => R.findUploadByFingerprint!(tx, f.orgId, input.fingerprint));
    expect(found.id).toBe(first.row.id);
    const second = await upl(f, { fingerprint: input.fingerprint }); // a different stored file, the same fingerprint
    const again = await asOrg(f.orgId, (tx) => R.insertUpload!(tx, f.orgId, second));
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from settlement_uploads where org_id = ${f.orgId}`;
    expect(n!.n).toBe(1);
    expect(await asOrg(f.orgId, (tx) => R.findUploadByFingerprint!(tx, f.orgId, 'no-such-fingerprint'))).toBeNull();
  });

  it('the same fingerprint in ANOTHER org is a new upload there, and the first org cannot see it [kills: org-wide unique; cross-org read]', async () => {
    const a = await fixture('iso-a');
    const b = await fixture('iso-b');
    const fp = uid('shared-fp');
    const ra = await asOrg(a.orgId, async (tx) => R.insertUpload!(tx, a.orgId, await upl(a, { fingerprint: fp })));
    const rb = await asOrg(b.orgId, async (tx) => R.insertUpload!(tx, b.orgId, await upl(b, { fingerprint: fp })));
    expect(ra.created && rb.created).toBe(true);
    expect(ra.row.id).not.toBe(rb.row.id);
    // org b's principal asking for org a's fingerprint, even naming org a, sees nothing (the repo filters and RLS backstops)
    expect(await asOrg(b.orgId, (tx) => R.findUploadByFingerprint!(tx, a.orgId, fp))).toBeNull();
    expect(await asOrg(b.orgId, (tx) => R.findCurrentUploads!(tx, a.orgId, a.channel, 'grab_transactions'))).toEqual([]);
  });

  it('findCurrentUploads lists the not-superseded uploads of that channel and kind, newest first; markSuperseded retires one and changes nothing else [kills: wrong kind; superseded still listed; another column rewritten]', async () => {
    const f = await fixture('cur');
    const one = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f))).row);
    const two = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f))).row);
    await asOrg(f.orgId, async (tx) => R.insertUpload!(tx, f.orgId, await upl(f, { fileKind: 'grab_transfers' })));
    const before = await asOrg(f.orgId, (tx) => R.findCurrentUploads!(tx, f.orgId, f.channel, 'grab_transactions'));
    expect(before.map((u: { id: string }) => u.id)).toEqual([two.id, one.id]);
    await asOrg(f.orgId, (tx) => R.markSuperseded!(tx, f.orgId, one.id, two.id));
    const after = await asOrg(f.orgId, (tx) => R.findCurrentUploads!(tx, f.orgId, f.channel, 'grab_transactions'));
    expect(after.map((u: { id: string }) => u.id)).toEqual([two.id]);
    const [row] = await sql<{ superseded_by: string; fingerprint: string }[]>`select superseded_by::text, fingerprint from settlement_uploads where id = ${one.id}`;
    expect(row).toEqual({ superseded_by: two.id, fingerprint: one.fingerprint });
  });
});

describe('T-511 S4 repo - day line versions', () => {
  it('currentLine, insertDayLineVersion and retireCurrentLine: one current line per channel and day; a second current insert is refused by the unique index; retire then insert version 2 works; the figures never change [kills: two current lines; retire rewriting figures]', async () => {
    const f = await fixture('lines');
    const u = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f))).row);
    expect(await asOrg(f.orgId, (tx) => R.currentLine!(tx, f.orgId, f.channel, '2026-10-12'))).toBeNull();
    const v1 = await asOrg(f.orgId, (tx) => R.insertDayLineVersion!(tx, f.orgId, day(f, u.id)));
    expect((await asOrg(f.orgId, (tx) => R.currentLine!(tx, f.orgId, f.channel, '2026-10-12'))).id).toBe(v1.id);
    // version 2 while version 1 is still current: the database says no
    const clash = await asOrg(f.orgId, (tx) => tx.transaction((sp) => R.insertDayLineVersion!(sp, f.orgId, day(f, u.id, { version: 2, orderValue: '7000.00' })))).then(() => null, (e: unknown) => e);
    expect(clash).not.toBeNull();
    expect(dbCode(clash)).toBe('23505');
    await asOrg(f.orgId, (tx) => R.retireCurrentLine!(tx, f.orgId, v1.id));
    expect(await asOrg(f.orgId, (tx) => R.currentLine!(tx, f.orgId, f.channel, '2026-10-12'))).toBeNull();
    const v2 = await asOrg(f.orgId, (tx) => R.insertDayLineVersion!(tx, f.orgId, day(f, u.id, { version: 2, orderValue: '7000.00' })));
    expect((await asOrg(f.orgId, (tx) => R.currentLine!(tx, f.orgId, f.channel, '2026-10-12'))).id).toBe(v2.id);
    const rows = await sql<{ version: number; is_current: boolean; order_value: string; review_state: string }[]>`
      select version, is_current, order_value::text, review_state from settlement_day_lines where org_id = ${f.orgId} order by version`;
    expect(rows).toEqual([
      { version: 1, is_current: false, order_value: '6753.00', review_state: 'pending' },
      { version: 2, is_current: true, order_value: '7000.00', review_state: 'pending' },
    ]);
    // the same version number twice is refused too
    const dup = await asOrg(f.orgId, (tx) => tx.transaction((sp) => R.insertDayLineVersion!(sp, f.orgId, day(f, u.id, { version: 2 })))).then(() => null, (e: unknown) => e);
    expect(dbCode(dup)).toBe('23505');
  });

  it('retireCurrentLine of a line in another org changes nothing [kills: org-blind update]', async () => {
    const a = await fixture('ret-a');
    const b = await fixture('ret-b');
    const u = await asOrg(a.orgId, async (tx) => (await R.insertUpload!(tx, a.orgId, await upl(a))).row);
    const line = await asOrg(a.orgId, (tx) => R.insertDayLineVersion!(tx, a.orgId, day(a, u.id)));
    await asOrg(b.orgId, (tx) => R.retireCurrentLine!(tx, b.orgId, line.id));
    const [row] = await sql<{ is_current: boolean }[]>`select is_current from settlement_day_lines where id = ${line.id}`;
    expect(row!.is_current).toBe(true);
  });

  it('loan lines are stored unallocated with their ordinal; a zero amount is refused by the table\'s CHECK; other lines keep kind, booking and date; a pandago line booked as anything but none is refused [kills: loan id set; CHECKs bypassed]', async () => {
    const f = await fixture('child');
    const u = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f))).row);
    const line = await asOrg(f.orgId, (tx) => R.insertDayLineVersion!(tx, f.orgId, day(f, u.id)));
    await asOrg(f.orgId, (tx) => R.insertLoanLines!(tx, f.orgId, line.id, [{ kind: 'disbursal', amount: '150000.00', rowOrdinal: 0 }, { kind: 'deduction', amount: '591.24', rowOrdinal: 1 }]));
    await asOrg(f.orgId, (tx) => R.insertOtherLines!(tx, f.orgId, u.id, line.id, [{ kind: 'withholding_tax', bookedAs: 'platformFee', amount: '5.00', lineDate: '2026-10-12', description: 'generic text' }]));
    await asOrg(f.orgId, (tx) => R.insertOtherLines!(tx, f.orgId, u.id, null, [{ kind: 'pandago', bookedAs: 'none', amount: '-476.00', lineDate: '2026-09-24', description: null }]));
    const loans = await sql<{ kind: string; amount: string; row_ordinal: number; loan_id: string | null; is_active: boolean }[]>`select kind, amount::text, row_ordinal, loan_id::text, is_active from settlement_loan_lines where org_id = ${f.orgId} order by row_ordinal`;
    expect(loans).toEqual([
      { kind: 'disbursal', amount: '150000.00', row_ordinal: 0, loan_id: null, is_active: true },
      { kind: 'deduction', amount: '591.24', row_ordinal: 1, loan_id: null, is_active: true },
    ]);
    const others = await sql<{ kind: string; booked_as: string; amount: string; day_line_id: string | null }[]>`select kind, booked_as, amount::text, day_line_id::text from settlement_other_lines where org_id = ${f.orgId} order by kind`;
    expect(others).toEqual([
      { kind: 'pandago', booked_as: 'none', amount: '-476.00', day_line_id: null },
      { kind: 'withholding_tax', booked_as: 'platformFee', amount: '5.00', day_line_id: line.id },
    ]);
    const zero = await asOrg(f.orgId, (tx) => tx.transaction((sp) => R.insertLoanLines!(sp, f.orgId, line.id, [{ kind: 'deduction', amount: '0.00', rowOrdinal: 2 }]))).then(() => null, (e: unknown) => e);
    expect(dbCode(zero)).toBe('23514');
    const booked = await asOrg(f.orgId, (tx) => tx.transaction((sp) => R.insertOtherLines!(sp, f.orgId, u.id, null, [{ kind: 'pandago', bookedAs: 'platformFee', amount: '1.00', lineDate: null, description: null }]))).then(() => null, (e: unknown) => e);
    expect(dbCode(booked)).toBe('23514');
  });
});

describe('T-511 S4 repo - what staff recorded', () => {
  async function dayOf(f: F, date: string, amount: string, o: { verified?: boolean; noSales?: boolean } = {}) {
    const [d] = await sql<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.store}, ${date}, ${amount}, 0, ${amount}, ${f.person}) returning id`;
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${d!.id}, ${f.channel}, ${amount}, ${o.noSales === true})`;
    if (o.verified !== false) {
      const [sub] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${uid('Sub')}) returning id`;
      await sql`update sales_days set status = 'submitted', submitted_by = ${sub!.id}, submitted_at = now() where id = ${d!.id} and status = 'open'`;
      await sql`update sales_days set status = 'verified', verified_by = ${f.person}, verified_at = now() where id = ${d!.id}`;
    }
    return d!.id;
  }

  it('salesDayFigure: a verified day gives its channel amount; an open day, a missing day and a no-sales day give no figure, and say why [kills: figure from an unverified day; no_sales read as a sale]', async () => {
    const f = await fixture('fig');
    await dayOf(f, '2026-10-20', '9474.00');
    await dayOf(f, '2026-10-21', '500.00', { verified: false });
    await dayOf(f, '2026-10-22', '0.00', { noSales: true });
    const at = (d: string) => asOrg(f.orgId, (tx) => R.salesDayFigure!(tx, f.orgId, f.channel, d));
    expect(await at('2026-10-20')).toEqual({ recorded: '9474.00', verified: true, noSales: false });
    expect(await at('2026-10-21')).toMatchObject({ recorded: null, verified: false });
    expect(await at('2026-10-23')).toEqual({ recorded: null, verified: false, noSales: false });
    const ns = await at('2026-10-22');
    expect(ns.noSales).toBe(true);
    expect(ns.verified).toBe(true);
    expect(ns.recorded === null || ns.recorded === '0.00').toBe(true);
  });

  it('daysWithRecordedSalesAndNoLine: verified days with sales and no current line, ascending; a day with a line, an open day and a no-sales day are not listed [kills: unverified days listed; days with a line listed]', async () => {
    const f = await fixture('noline');
    await dayOf(f, '2026-10-10', '100.00');
    await dayOf(f, '2026-10-11', '200.00');
    await dayOf(f, '2026-10-12', '300.00');
    await dayOf(f, '2026-10-13', '400.00', { verified: false });
    await dayOf(f, '2026-10-14', '0.00', { noSales: true });
    const u = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f))).row);
    await asOrg(f.orgId, (tx) => R.insertDayLineVersion!(tx, f.orgId, day(f, u.id, { salesDate: '2026-10-11' })));
    expect(await asOrg(f.orgId, (tx) => R.daysWithRecordedSalesAndNoLine!(tx, f.orgId, f.channel))).toEqual(['2026-10-10', '2026-10-12']);
    // another org's principal gets nothing for this channel
    const other = await fixture('noline-other');
    expect(await asOrg(other.orgId, (tx) => R.daysWithRecordedSalesAndNoLine!(tx, f.orgId, f.channel))).toEqual([]);
  });
});
