import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S7a (TESTER, 8 Nov 2026) - the three repo functions approve and void stand on (docs/tasks/511-settlement-upload-s7-spec.md Ruling 2, 7 and "Files").
 * Real Postgres via TEST_DATABASE_URL (a `_test` DB), through the app role with the org principal set (RLS on). Every org is new.
 *
 * RED TODAY, for one reason: `markBooked`, `markUnbooked` and the uploader read are not exported by `settlementIntakeRepo` (each leg says "is not a function").
 *
 * CONTRACT (every function takes `tx` then `orgId`; modelled on `markRejected` / `markReopened`):
 *  P1  `markBooked(tx, orgId, lineId, { decidedBy, settlementId }): Promise<boolean>`: compare-and-set. Only a CURRENT line that is still PENDING becomes `booked`, with
 *      `decided_by`, `decided_at` (now) and `settlement_id` set together (the `settlement_day_lines_review_shape_check` CHECK). true = this call did it; false = it
 *      affected 0 rows (someone decided first, the line was replaced, or it is not pending): the caller then says why in words.
 *  P2  `markUnbooked(tx, orgId, settlementId)`: the CURRENT line that is `booked` with that `settlement_id` goes back to `pending`, `decided_by`, `decided_at` and
 *      `settlement_id` cleared. Returns the line that was returned (a truthy value: the row) or null/false when none was (nothing booked by it, or the line is no longer current:
 *      a replaced line stays `booked` as history). It never touches any other line.
 *  P3  `uploaderIdsOfLine(tx, orgId, lineId): Promise<string[]>`: the person ids who uploaded the line's SOURCE upload and its PAYOUT upload (a Grab line has both, a Foodpanda
 *      line only its invoice), distinct. This is the only read the uploader rule (Ruling 1) needs.
 *  P4  The unique partial index on `settlement_id` still refuses a second line booked against one settlement (23505) and nothing in the new writes loosens it.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
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
  const code = uid(`t511s7r-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Lipa') returning id`;
  const person = async (): Promise<string> => (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('P')}) returning id`)[0]!.id;
  const p1 = await person();
  const p2 = await person();
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code)
    values (${orgId}, ${s!.id}, ${uid('Grab')}, false, '1220', 'grab', ${uid('code')}) returning id`;
  const file = async () => {
    const [f] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${s!.id}, 'memo_document', ${`orgs/${orgId}/stores/${s!.id}/memo_document/${uid('f')}.pdf`}, 'application/pdf', 10, 'abc', ${p1}) returning id`;
    return f!.id;
  };
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${orgId}, ${s!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  let n = 0;
  /** a settlement row to point a booked line at (the line's CHECK and foreign key need one); a new sales day each time */
  const settlement = async (): Promise<string> => {
    n += 1;
    const date = `2026-01-${String(9 + n).padStart(2, '0')}`;
    const [day] = await sql<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s!.id}, ${date}, '0', '0', '0', ${p1}) returning id`;
    const [set] = await sql<{ id: string }[]>`
      insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by)
      values (${orgId}, ${s!.id}, ${c!.id}, ${day!.id}, ${date}, '0', '0', '0', ${acct!.id}, ${date}, ${p1}) returning id`;
    return set!.id;
  };
  return { orgId, store: s!.id, p1, p2, channel: c!.id, file, settlement };
}
type F = Awaited<ReturnType<typeof fixture>>;

const upl = async (f: F, by: string, over: Record<string, unknown> = {}) => ({
  channelId: f.channel, storeId: f.store, platform: 'grab', fileKind: 'grab_transactions', fileId: await f.file(), pdfFileId: null, fingerprint: uid('fp'),
  readerVersion: 'settlement-intake-reader/1', matchedCode: 'code-1', periodFrom: '2026-10-01', periodTo: '2026-10-31', invoiceNumber: null, ordersRead: 5, loanRowsRead: 1,
  otherRowsRead: 0, uploadedBy: by, ...over,
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

/** One pending current line (its own upload). */
async function pendingLine(f: F, over: Record<string, unknown> = {}, by = f.p1): Promise<string> {
  const input = await upl(f, by);
  const u = await asOrg(f.orgId, (tx) => R.insertUpload!(tx, f.orgId, input));
  const line = await asOrg(f.orgId, (tx) => R.insertDayLineVersion!(tx, f.orgId, day(f, u.row.id, over)));
  return line.id as string;
}
const row = async (id: string) =>
  (
    await sql<{ review_state: string; decided_by: string | null; decided_at: Date | null; settlement_id: string | null; is_current: boolean; decision_reason: string | null }[]>`
      select review_state, decided_by::text, decided_at, settlement_id::text, is_current, decision_reason from settlement_day_lines where id = ${id}`
  )[0]!;
const book = (f: F, lineId: string, settlementId: string, by = f.p2) => asOrg(f.orgId, (tx) => R.markBooked!(tx, f.orgId, lineId, { decidedBy: by, settlementId }));
const hit = (r: unknown): boolean => r !== null && r !== undefined && r !== false && !(Array.isArray(r) && r.length === 0);

describe('T-511 S7a repo - markBooked is a compare-and-set', () => {
  it('a current pending line becomes booked with decided_by, decided_at and settlement_id together (the review_shape CHECK holds); a second identical call affects 0 rows and changes nothing [kills: an unconditional update; a second call that overwrites the decider or the settlement]', async () => {
    const f = await fixture('book');
    const lineId = await pendingLine(f);
    const s1 = await f.settlement();
    expect(await book(f, lineId, s1)).toBe(true);
    const first = await row(lineId);
    expect([first.review_state, first.decided_by, first.settlement_id, first.decision_reason]).toEqual(['booked', f.p2, s1, null]);
    expect(first.decided_at).toBeInstanceOf(Date);

    const s2 = await f.settlement();
    expect(await book(f, lineId, s2, f.p1), 'already booked: not pending any more').toBe(false);
    expect(await row(lineId), 'unchanged').toEqual(first);
  });

  it('a REJECTED line and a line that is no longer CURRENT are refused (false), unchanged [kills: booking over a rejection; booking a retired version]', async () => {
    const f = await fixture('refuse');
    const rejected = await pendingLine(f);
    expect(await asOrg(f.orgId, (tx) => R.markRejected!(tx, f.orgId, rejected, { reason: 'Wrong file', decidedBy: f.p1 }))).toBe(true);
    const s = await f.settlement();
    expect(await book(f, rejected, s)).toBe(false);
    expect((await row(rejected)).review_state).toBe('rejected');

    const stale = await pendingLine(f, { salesDate: '2026-10-13' });
    await asOrg(f.orgId, (tx) => R.retireCurrentLine!(tx, f.orgId, stale));
    expect(await book(f, stale, s), 'a stale line (a newer file replaced it) is refused').toBe(false);
    expect(await row(stale)).toMatchObject({ review_state: 'pending', settlement_id: null, decided_by: null, is_current: false });
  });

  it('another org cannot book this org\'s line (RLS and the org filter): false, unchanged [kills: a missing org filter]', async () => {
    const a = await fixture('iso-a');
    const b = await fixture('iso-b');
    const lineId = await pendingLine(a);
    const s = await b.settlement();
    expect(await asOrg(b.orgId, (tx) => R.markBooked!(tx, b.orgId, lineId, { decidedBy: b.p1, settlementId: s }))).toBe(false);
    expect((await row(lineId)).review_state).toBe('pending');
  });

  it('the unique partial index still refuses a second line booked against ONE settlement (23505), and the CHECK still refuses booked without a settlement (23514) [kills: the guards dropped to make the new writes pass]', async () => {
    const f = await fixture('unique');
    const a = await pendingLine(f);
    const b = await pendingLine(f, { salesDate: '2026-10-13' });
    const s = await f.settlement();
    expect(await book(f, a, s)).toBe(true);
    const err = await book(f, b, s).then(() => null, (e: unknown) => e);
    expect(dbCode(err), 'unique violation').toBe('23505');
    expect((await row(b)).review_state, 'the failed update left the line pending').toBe('pending');
    const bad = await sql`update settlement_day_lines set review_state = 'booked' where id = ${b}`.then(() => null, (e: unknown) => e);
    expect(dbCode(bad), 'check violation: booked needs decided_by, decided_at and a settlement').toBe('23514');
  });
});

describe('T-511 S7a repo - markUnbooked returns the day to pending', () => {
  it('the current booked line of a settlement goes back to pending with decided_by, decided_at and settlement_id cleared; a second call finds nothing; another line and another settlement are untouched [kills: a half-cleared line (the CHECK); a repeat that matches again; clearing every line]', async () => {
    const f = await fixture('unbook');
    const a = await pendingLine(f);
    const other = await pendingLine(f, { salesDate: '2026-10-13' });
    const sa = await f.settlement();
    const so = await f.settlement();
    await book(f, a, sa);
    await book(f, other, so);

    const back = await asOrg(f.orgId, (tx) => R.markUnbooked!(tx, f.orgId, sa));
    expect(hit(back), 'the line that was returned').toBe(true);
    if (back && typeof back === 'object' && 'id' in back) expect(back.id).toBe(a);
    expect(await row(a)).toMatchObject({ review_state: 'pending', decided_by: null, decided_at: null, settlement_id: null, decision_reason: null, is_current: true });
    expect(await row(other), 'the other settlement stays booked').toMatchObject({ review_state: 'booked', settlement_id: so });
    expect(hit(await asOrg(f.orgId, (tx) => R.markUnbooked!(tx, f.orgId, sa))), 'nothing is booked by it any more').toBe(false);
  });

  it('a line that is NOT current stays booked as history: only the current line is returned [kills: unbooking a retired version (history rewritten)]', async () => {
    const f = await fixture('unbook-history');
    const v1 = await pendingLine(f);
    const s = await f.settlement();
    await book(f, v1, s);
    await asOrg(f.orgId, (tx) => R.retireCurrentLine!(tx, f.orgId, v1));
    const v2 = await asOrg(f.orgId, async (tx) => {
      const up = await R.insertUpload!(tx, f.orgId, await upl(f, f.p1));
      return (await R.insertDayLineVersion!(tx, f.orgId, day(f, up.row.id, { version: 2 }))).id as string;
    });
    expect(hit(await asOrg(f.orgId, (tx) => R.markUnbooked!(tx, f.orgId, s))), 'the settlement is booked only on a retired line').toBe(false);
    expect(await row(v1)).toMatchObject({ review_state: 'booked', settlement_id: s, is_current: false });
    expect(await row(v2)).toMatchObject({ review_state: 'pending', settlement_id: null });
  });

  it('a settlement that no line carries (a hand-recorded one) returns nothing and writes nothing [kills: an error for a settlement with no day]', async () => {
    const f = await fixture('unbook-none');
    const s = await f.settlement();
    expect(hit(await asOrg(f.orgId, (tx) => R.markUnbooked!(tx, f.orgId, s)))).toBe(false);
  });
});

describe('T-511 S7a repo - the uploader read', () => {
  it('a Grab line returns BOTH uploaders (the Transactions upload and the Transfers upload) when they are two people, one id when it is one person [kills: only the source upload read; duplicates]', async () => {
    const f = await fixture('uploaders');
    const src = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f, f.p1))).row.id as string);
    const pay = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f, f.p2, { fileKind: 'grab_transfers' }))).row.id as string);
    const two = await asOrg(f.orgId, async (tx) => (await R.insertDayLineVersion!(tx, f.orgId, day(f, src, { payoutUploadId: pay }))).id as string);
    const got = await asOrg(f.orgId, (tx) => R.uploaderIdsOfLine!(tx, f.orgId, two));
    expect([...new Set<string>(got)].sort()).toEqual([f.p1, f.p2].sort());
    expect(got.length, 'distinct').toBe(2);

    const src2 = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f, f.p1))).row.id as string);
    const pay2 = await asOrg(f.orgId, async (tx) => (await R.insertUpload!(tx, f.orgId, await upl(f, f.p1, { fileKind: 'grab_transfers' }))).row.id as string);
    const same = await asOrg(f.orgId, async (tx) => (await R.insertDayLineVersion!(tx, f.orgId, day(f, src2, { salesDate: '2026-10-13', payoutUploadId: pay2 }))).id as string);
    expect(await asOrg(f.orgId, (tx) => R.uploaderIdsOfLine!(tx, f.orgId, same))).toEqual([f.p1]);
  });

  it('a line with no payout upload (Foodpanda: the invoice) returns its one uploader; an unknown line returns none [kills: a null payout upload read as an error or as "nobody"]', async () => {
    const f = await fixture('uploaders-fp');
    const lineId = await pendingLine(f, {}, f.p2);
    expect(await asOrg(f.orgId, (tx) => R.uploaderIdsOfLine!(tx, f.orgId, lineId))).toEqual([f.p2]);
    expect(await asOrg(f.orgId, (tx) => R.uploaderIdsOfLine!(tx, f.orgId, '00000000-0000-4000-8000-000000000000'))).toEqual([]);
  });
});
