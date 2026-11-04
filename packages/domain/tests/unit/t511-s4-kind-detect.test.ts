/**
 * T-511 S4 (TESTER, 2026-11-04) - what kind of settlement file is this? Decided from the CONTENT, never from the name, and for a CSV from the EXACT header
 * set, never from the column count. docs/tasks/511-settlement-upload-s4-spec.md "ingest.ts" step 4 and BOSS correction (c) of 4 Nov.
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/ingest.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT:
 *  K1  `detectSettlementKind(bytes: Buffer): Promise<SettlementFileKind>` exported from `ingest.ts`; the answer is 'foodpanda_invoice' | 'grab_transactions' |
 *      'grab_transfers'. It takes BYTES ONLY (no file name, no content type): a name cannot influence it because it is not an input.
 *  K2  Zip signature (PK 03 04) -> 'foodpanda_invoice'. Anything else is decoded as a Grab CSV: the header set must equal the slice-3 readers' known set for
 *      Transactions (68) or Transfers (10), any order. A set that matches neither REFUSES with a `SettlementIntakeRefusal` whose message names a column the
 *      system does not know (or, when the only problem is a missing column, the missing one). It is never "read as the nearest kind".
 *  K3  `fingerprintOf(bytes: Uint8Array): string` exported from `ingest.ts`: lower-case sha256 hex of the uploaded bytes.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRAB_TRANSACTION_HEADERS } from '../../src/settlement-intake/grab-transactions';
import { GRAB_TRANSFER_HEADERS } from '../../src/settlement-intake/grab-transfers';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';
import { detectSettlementKind, fingerprintOf } from '../../src/settlement-intake/ingest';
import { UUID_SHAPE, fixture, parseGrab, toCsv } from './t511-s3-helpers';

const ZIPS = [
  'foodpanda-banay-oct19-34col.zip', 'foodpanda-malvar-oct12-34col.zip', 'foodpanda-lipa-oct19-34col-feerow.zip', 'foodpanda-lipa-oct5-34col.zip',
  'foodpanda-lipa-jul15-32col.zip', 'foodpanda-lipa-oct5a-appendix-b-only-pandago.zip',
];
const TRANSACTIONS = ['grab-lipa-oct-transactions.csv', 'grab-malvar-oct-transactions.csv', 'grab-banay-oct-transactions.csv', 'grab-banay-sep15-30-transactions.csv', 'grab-malvar-jun-advertisement-transactions.csv'];
const TRANSFERS = ['grab-lipa-oct-transfers.csv', 'grab-malvar-oct-transfers.csv', 'grab-banay-oct-transfers.csv', 'grab-banay-sep15-30-transfers.csv', 'grab-malvar-jun-jul-transfers.csv'];

async function refusalOf(run: () => Promise<unknown>): Promise<SettlementIntakeRefusal> {
  try {
    await run();
  } catch (e) {
    if (e instanceof SettlementIntakeRefusal) return e;
    throw e;
  }
  throw new Error('expected a SettlementIntakeRefusal but the call returned normally');
}

describe('T-511 S4 kind detection - from the content', () => {
  it('takes bytes only: a file name is not an input [kills: kind chosen from the name]', () => {
    expect(detectSettlementKind.length).toBe(1);
  });

  it('every real Foodpanda zip is a foodpanda_invoice (the Appendix-B-only one too)', async () => {
    for (const f of ZIPS) expect(await detectSettlementKind(fixture(f)), f).toBe('foodpanda_invoice');
  });

  it('every real Grab Transactions export is grab_transactions and every Transfers export is grab_transfers (a Transfers file saved as ".xlsx.csv" or ".xlsx" is the same bytes) [kills: kind from extension]', async () => {
    for (const f of TRANSACTIONS) expect(await detectSettlementKind(fixture(f)), f).toBe('grab_transactions');
    for (const f of TRANSFERS) expect(await detectSettlementKind(fixture(f)), f).toBe('grab_transfers');
  });

  it('the header set is matched in any order and with CRLF lines and no BOM [kills: positional header match]', async () => {
    const g = parseGrab(fixture('grab-lipa-oct-transfers.csv'));
    const order = g.headers.map((_, i) => g.headers.length - 1 - i);
    const flipped = { headers: order.map((i) => g.headers[i] as string), rows: g.rows.map((r) => order.map((i) => r[i] as string)) };
    expect(await detectSettlementKind(toCsv(flipped, { bom: false, eol: '\r\n' }))).toBe('grab_transfers');
    const t = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    const rev = t.headers.map((_, i) => t.headers.length - 1 - i);
    expect(await detectSettlementKind(toCsv({ headers: rev.map((i) => t.headers[i] as string), rows: t.rows.map((r) => rev.map((i) => r[i] as string)) }, { bom: false }))).toBe('grab_transactions');
  });
});

describe('T-511 S4 kind detection - a count of columns is not a kind (BOSS correction c)', () => {
  it('68 columns with ONE unknown header refuses naming that column; it is not read as Transactions [kills: kind by column count 68]', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    expect(g.headers.length).toBe(68);
    g.headers[g.headers.indexOf('Net Sales')] = 'Net Sales Adjusted';
    const r = await refusalOf(() => detectSettlementKind(toCsv(g)));
    expect(r.message).toContain('Net Sales Adjusted');
    expect(r.message).not.toMatch(UUID_SHAPE);
  });

  it('10 columns with ONE unknown header refuses naming that column; it is not read as Transfers [kills: kind by column count 10]', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    expect(g.headers.length).toBe(10);
    g.headers[g.headers.indexOf('Net Total')] = 'Net Totals';
    const r = await refusalOf(() => detectSettlementKind(toCsv(g)));
    expect(r.message).toContain('Net Totals');
  });

  it('68 and 10 columns of entirely different headers each refuse naming an unknown column [kills: count-based fallback]', async () => {
    for (const n of [68, 10]) {
      const headers = Array.from({ length: n }, (_, i) => `Mystery${i + 1}`);
      const bytes = toCsv({ headers, rows: [headers.map(() => 'x')] });
      const r = await refusalOf(() => detectSettlementKind(bytes));
      expect(r.message, `${n} columns`).toMatch(/Mystery\d+/);
    }
  });

  it('a Transactions file with an extra column (69) refuses naming it [kills: superset accepted]', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    const bytes = toCsv({ headers: [...g.headers, 'Loyalty Points'], rows: g.rows.map((r) => [...r, '0']) });
    expect((await refusalOf(() => detectSettlementKind(bytes))).message).toContain('Loyalty Points');
  });

  it('a Transactions file missing a column (67) refuses naming the missing one [kills: subset accepted]', async () => {
    const r = await refusalOf(() => detectSettlementKind(fixture('hostile-grab-missing-settlement-id-column.csv')));
    expect(r.message).toContain('Settlement ID');
  });

  it('the Transactions header set with Transfers rows of the same width is still judged by headers: a Transfers file whose header is renamed in two places refuses [kills: first-match wins]', async () => {
    const g = parseGrab(fixture('grab-lipa-oct-transfers.csv'));
    g.headers[g.headers.indexOf('Date')] = 'Payout Date';
    g.headers[g.headers.indexOf('Status')] = 'State';
    const r = await refusalOf(() => detectSettlementKind(toCsv(g)));
    expect(r.message).toMatch(/Payout Date|State/);
  });
});

describe('T-511 S4 kind detection - bytes that are neither', () => {
  it('an empty file is refused as empty', async () => {
    const r = await refusalOf(() => detectSettlementKind(fixture('hostile-empty.csv')));
    expect(r.code).toBe('FILE_EMPTY');
  });

  it('plain text named .zip is judged by its content (not a zip signature) and refused as a Grab file, not handed to the zip reader [kills: kind from extension]', async () => {
    const r = await refusalOf(() => detectSettlementKind(fixture('hostile-not-a-zip.zip')));
    expect(r.code).not.toMatch(/^ZIP_/);
  });

  it('an image is refused with a named refusal, never read as a CSV', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe, 0xfd]);
    await refusalOf(() => detectSettlementKind(png));
  });

  it('the header lists in the readers are what detection uses: 68 and 10 names (a reader that gains a column changes detection with it)', () => {
    expect(GRAB_TRANSACTION_HEADERS.length).toBe(68);
    expect(GRAB_TRANSFER_HEADERS.length).toBe(10);
  });
});

describe('T-511 S4 fingerprint', () => {
  it('is the lower-case sha256 hex of the bytes (so the same file twice has one fingerprint, one changed byte another) [kills: hashing the name; md5; upper case]', () => {
    const a = fixture('grab-lipa-oct-transfers.csv');
    expect(fingerprintOf(a)).toBe(createHash('sha256').update(a).digest('hex'));
    const b = Buffer.from(a);
    b[b.length - 2] = (b[b.length - 2] as number) ^ 1;
    expect(fingerprintOf(b)).not.toBe(fingerprintOf(a));
    expect(fingerprintOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
