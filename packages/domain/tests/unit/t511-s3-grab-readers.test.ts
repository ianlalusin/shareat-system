/**
 * T-511 S3 (B) - the Grab Transactions and Transfers readers and the strict date parser.
 * `docs/tasks/511-settlement-upload-s3-spec.md` items 3 and 4.
 *
 * The expected values come from THREE places that do not share code with the readers: numbers hand-checked against the redacted
 * files (spec and discovery), a test-side oracle that reads the same cells with `parseCsv` and a test-side date parser, and
 * generated files made by editing a real fixture. Choices where the spec leaves room are marked "CHOICE" below.
 */
import { describe, expect, it } from 'vitest';
import { money, type Money } from '@shareat/core/money';
import { READER_VERSION } from '../../src/settlement-intake';
import { parseGrabDateTime, readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import {
  GRAB_BANNED_KEYS,
  STORE_B,
  assertNoLeak,
  fixture,
  getCell,
  grabPaymentRow,
  grabTransactionSensitive,
  grabTransferSensitive,
  mentionsNumber,
  parseGrab,
  refusalOf,
  setCell,
  syntheticGrab,
  toCsv,
  type GrabCsv,
} from './t511-s3-helpers';

/* ---------------------------------------------------------------- test-side oracle */

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

function oracleDateTime(text: string): { date: string; time: string } {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/.exec(text.trim());
  if (!m) throw new Error(`oracle cannot read ${text}`);
  const hour = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
  return { date: `${m[3]}-${MONTHS[m[2] as string]}-${String(Number(m[1])).padStart(2, '0')}`, time: `${String(hour).padStart(2, '0')}:${m[5]}` };
}

const KIND_OF: Record<string, string> = { Payment: 'payment', Loans: 'loan', Adjustment: 'adjustment', Advertisement: 'advertisement' };
const orNull = (raw: string): Money | null => (raw === '' ? null : money(raw));

interface Row {
  line: number;
  createdOn: { date: string; time: string };
  kind: string;
  subcategory: string | null;
  status: string;
  settlementId: string | null;
  amount: Money | null;
  discount: Money | null;
  netSales: Money | null;
  channelCommission: Money | null;
  total: Money | null;
  description?: string;
}

function kindCounts(rows: { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

const TX_FILES = [
  { file: 'grab-lipa-oct-transactions.csv', rows: 586, storeName: 'SharEat Lipa - San Carlos', from: '2026-10-01', to: '2026-10-31', kinds: { payment: 537, loan: 46, adjustment: 2, cancelled: 1 } },
  { file: 'grab-malvar-oct-transactions.csv', rows: 148, storeName: 'SharEat - Malvar', from: '2026-10-01', to: '2026-10-31', kinds: { payment: 139, loan: 4, adjustment: 2, cancelled: 3 } },
  { file: 'grab-banay-oct-transactions.csv', rows: 208, storeName: 'SharEat - Banay-Banay', from: '2026-10-01', to: '2026-10-31', kinds: { payment: 193, loan: 7, adjustment: 5, cancelled: 3 } },
  { file: 'grab-banay-sep15-30-transactions.csv', rows: 95, storeName: 'SharEat - Banay-Banay', from: '2026-09-15', to: '2026-09-30', kinds: { payment: 93, adjustment: 1, cancelled: 1 } },
  { file: 'grab-malvar-jun-advertisement-transactions.csv', rows: 210, storeName: 'SharEat - Malvar', from: '2026-06-01', to: '2026-07-15', kinds: { payment: 192, loan: 5, adjustment: 4, cancelled: 6, advertisement: 3 } },
];

const TR_FILES = [
  { file: 'grab-lipa-oct-transfers.csv', rows: 31, processing: 1 },
  { file: 'grab-malvar-oct-transfers.csv', rows: 31, processing: 1 },
  { file: 'grab-banay-oct-transfers.csv', rows: 31, processing: 1 },
  { file: 'grab-banay-sep15-30-transfers.csv', rows: 16, processing: 0 },
  { file: 'grab-malvar-jun-jul-transfers.csv', rows: 43, processing: 0 },
];

const ROW_KEYS = ['amount', 'channelCommission', 'createdOn', 'discount', 'kind', 'line', 'netSales', 'settlementId', 'status', 'subcategory', 'total'];

const plain = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

/* ---------------------------------------------------------------- Transactions: the real files */

describe('readGrabTransactions: the five real Transaction files', () => {
  it.each(TX_FILES)('$file reads: $rows rows, store, period, kinds, reader version', ({ file, rows, storeName, from, to, kinds }) => {
    const bytes = fixture(file);
    const out = readGrabTransactions(bytes);
    const raw = parseGrab(bytes);
    expect(out.rowCount).toBe(rows);
    expect(out.rows).toHaveLength(rows);
    expect(out.storeName).toBe(storeName);
    expect(out.storeId).toBe(getCell(raw, 0, 'Store ID'));
    expect(out.periodFrom).toBe(from);
    expect(out.periodTo).toBe(to);
    expect(out.readerVersion).toBe(READER_VERSION);
    expect(kindCounts(out.rows)).toEqual(kinds);
    expect(Object.keys(plain(out)).sort()).toEqual(['periodFrom', 'periodTo', 'readerVersion', 'rowCount', 'rows', 'storeId', 'storeName']);
  });

  it('READER_VERSION is settlement-intake-reader/1', () => {
    expect(READER_VERSION).toBe('settlement-intake-reader/1');
  });

  it.each(TX_FILES)('$file: every row equals what an independent reading of the same cells gives', ({ file }) => {
    const bytes = fixture(file);
    const out = readGrabTransactions(bytes);
    const raw = parseGrab(bytes);
    raw.rows.forEach((cells, i) => {
      const cell = (name: string): string => getCell(raw, i, name);
      const got = out.rows[i] as Row;
      const category = cell('Category').trim();
      const status = cell('Status');
      expect(got.line).toBe(i + 2);
      expect(got.createdOn).toEqual(oracleDateTime(cell('Created On')));
      expect(got.kind).toBe(status === 'Cancelled' && category === '' ? 'cancelled' : KIND_OF[category]);
      expect(got.subcategory ?? '').toBe(cell('Subcategory').trim());
      expect(got.status).toBe(status);
      expect(got.settlementId ?? '').toBe(cell('Settlement ID'));
      expect(got.amount).toBe(orNull(cell('Amount')));
      expect(got.discount).toBe(orNull(cell('Discount (Merchant-Funded)')));
      expect(got.netSales).toBe(orNull(cell('Net Sales')));
      expect(got.channelCommission).toBe(orNull(cell('Channel Commission')));
      expect(got.total).toBe(orNull(cell('Total')));
      void cells;
    });
  });

  it('anchors the oracle on known rows: the first Malvar order, a cancelled order, the compensation and the withholding-tax rows', () => {
    const out = readGrabTransactions(fixture('grab-malvar-oct-transactions.csv'));
    const first = out.rows[0] as Row;
    expect(first).toMatchObject({
      line: 2, kind: 'payment', status: 'Completed', settlementId: 'SPHXDIDXRNAB', createdOn: { date: '2026-10-31', time: '11:14' },
      amount: '125.00', discount: '0.00', netSales: '125.00', channelCommission: '-31.25', total: '93.75',
    });
    const cancelled = (out.rows as Row[]).find((r) => r.status === 'Cancelled') as Row;
    expect(cancelled).toMatchObject({ kind: 'cancelled', settlementId: null, createdOn: { date: '2026-10-27', time: '13:03' }, total: '0.00', amount: null, netSales: null, channelCommission: null });
    const comp = (out.rows as Row[]).find((r) => r.subcategory === 'Compensation - Orders') as Row;
    expect(comp).toMatchObject({ kind: 'adjustment', total: '130.50', createdOn: { date: '2026-10-25', time: '21:14' }, description: 'Canceled Order Compensation' });
    const wht = (out.rows as Row[]).find((r) => r.subcategory === 'Withholding Tax Remittance (non-taxable)') as Row;
    expect(wht).toMatchObject({ kind: 'adjustment', total: '-71.48', createdOn: { date: '2026-10-07', time: '11:00' }, description: 'Withholding Tax on Gross Remittance Sep 16-30, 2026' });
  });

  it('Lipa has one Loan Disbursal of +150,000.00 with no Amount, and 45 Loan Deductions that are all negative', () => {
    const rows = readGrabTransactions(fixture('grab-lipa-oct-transactions.csv')).rows as Row[];
    const disb = rows.filter((r) => r.subcategory === 'Loan Disbursal');
    expect(disb).toHaveLength(1);
    expect(disb[0]).toMatchObject({ kind: 'loan', total: '150000.00', amount: null });
    const ded = rows.filter((r) => r.subcategory === 'Loan Deduction');
    expect(ded).toHaveLength(45);
    expect(ded.every((r) => r.kind === 'loan' && (r.total as string).startsWith('-'))).toBe(true);
  });

  it('the June Malvar file has 3 Advertisement rows, with a negative Total', () => {
    const ads = (readGrabTransactions(fixture('grab-malvar-jun-advertisement-transactions.csv')).rows as Row[]).filter((r) => r.kind === 'advertisement');
    expect(ads).toHaveLength(3);
    expect(ads.every((r) => (r.total as string).startsWith('-'))).toBe(true);
  });

  it('a payment row has exactly the eleven spec keys; an adjustment row adds only description (<= 200 characters)', () => {
    const rows = readGrabTransactions(fixture('grab-banay-oct-transactions.csv')).rows as Row[];
    for (const r of rows) {
      const keys = Object.keys(plain(r)).sort();
      expect(keys).toEqual(r.kind === 'adjustment' ? [...ROW_KEYS, 'description'].sort() : ROW_KEYS);
      if (r.kind === 'adjustment') {
        expect((r.description as string).length).toBeGreaterThan(0);
        expect((r.description as string).length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('every row that is not an adjustment has no description, even when the file carries free text in that cell', () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    setCell(g, 0, 'Description', 'secret customer text about a complaint');
    const out = readGrabTransactions(toCsv(g));
    expect((out.rows[0] as Row).description ?? null).toBeNull();
    expect(JSON.stringify(out)).not.toContain('secret customer text');
  });

  it('an adjustment description is trimmed and capped at 200 characters', () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    const adj = g.rows.findIndex((_, i) => getCell(g, i, 'Category').trim() === 'Adjustment');
    setCell(g, adj, 'Description', `   ${'x'.repeat(500)}   `);
    const r = readGrabTransactions(toCsv(g)).rows[adj] as Row;
    expect(r.description as string).toMatch(/^x+$/);
    expect((r.description as string).length).toBeLessThanOrEqual(200);
    setCell(g, adj, 'Description', '   padded text   ');
    expect(((readGrabTransactions(toCsv(g)).rows[adj] as Row).description as string)).toBe('padded text');
  });
});

describe('readGrabTransactions: nothing identifying leaves the reader', () => {
  it.each(TX_FILES)('$file: no Transaction ID, Linked ID, order id, Booking ID, funding source or customer field is in the output', ({ file }) => {
    const bytes = fixture(file);
    const sensitive = grabTransactionSensitive(bytes);
    expect(sensitive.size).toBeGreaterThan(50); // the scan has something to look for
    expect(assertNoLeak(readGrabTransactions(bytes), sensitive, GRAB_BANNED_KEYS)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- Transactions: header rules */

describe('readGrabTransactions: header rules', () => {
  it('a file missing Settlement ID is GRAB_MISSING_COLUMN naming it', async () => {
    const r = await refusalOf(() => readGrabTransactions(fixture('hostile-grab-missing-settlement-id-column.csv')));
    expect(r.code).toBe('GRAB_MISSING_COLUMN');
    expect(r.userMessage).toContain('Settlement ID');
  });

  it('an extra unknown header is GRAB_UNKNOWN_COLUMN naming it', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    g.headers.push('Mystery Header');
    g.rows.forEach((r) => r.push(''));
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.code).toBe('GRAB_UNKNOWN_COLUMN');
    expect(r.userMessage).toContain('Mystery Header');
  });

  it('headers are matched by trimmed name, never by position: padded names and a reordered file read the same', () => {
    const base = readGrabTransactions(fixture('grab-malvar-oct-transactions.csv'));
    const padded = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    padded.headers = padded.headers.map((h, i) => (i % 5 === 0 ? ` ${h} ` : h));
    expect(readGrabTransactions(toCsv(padded)).rows).toEqual(base.rows);

    const reordered = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    reordered.headers.reverse();
    reordered.rows.forEach((r) => r.reverse());
    expect(readGrabTransactions(toCsv(reordered)).rows).toEqual(base.rows);
  });

  it('a Transfers file given to the Transactions reader is refused as a column problem, not read', async () => {
    const r = await refusalOf(() => readGrabTransactions(fixture('grab-malvar-oct-transfers.csv')));
    expect(['GRAB_MISSING_COLUMN', 'GRAB_UNKNOWN_COLUMN']).toContain(r.code);
  });

  it('a header-only file is GRAB_NO_ROWS (a wrong file is more likely than a store with no orders in a month)', async () => {
    expect((await refusalOf(() => readGrabTransactions(fixture('hostile-grab-header-only.csv')))).code).toBe('GRAB_NO_ROWS');
  });

  it('an empty file is FILE_EMPTY', async () => {
    expect((await refusalOf(() => readGrabTransactions(fixture('hostile-empty.csv')))).code).toBe('FILE_EMPTY');
  });

  it('Category without the trailing space is ACCEPTED and classified exactly like the trailing-space file', () => {
    const noSpace = readGrabTransactions(fixture('hostile-grab-category-no-trailing-space.csv'));
    expect(noSpace.rows.length).toBe(15);
    expect((noSpace.rows as Row[]).every((r) => r.kind === 'payment')).toBe(true);

    const spaced = parseGrab(fixture('hostile-grab-category-no-trailing-space.csv'));
    spaced.rows.forEach((_, i) => setCell(spaced, i, 'Category', 'Payment '));
    expect(readGrabTransactions(toCsv(spaced)).rows).toEqual(noSpace.rows);
  });
});

/* ---------------------------------------------------------------- Transactions: values, rows, caps */

describe('readGrabTransactions: values', () => {
  const firstPayment = (g: GrabCsv): number => g.rows.findIndex((_, i) => getCell(g, i, 'Category').trim() === 'Payment');

  it.each([
    ['Category', 'Mystery ', 'Mystery'],
    ['Status', 'Pending', 'Pending'],
  ])('an unknown %s value (%j) refuses the file naming the value', async (column, value, named) => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    setCell(g, firstPayment(g), column, value);
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.code).toBe('GRAB_UNKNOWN_VALUE');
    expect(r.userMessage).toContain(named);
  });

  it('an unknown Subcategory on a loan row and on an adjustment row refuses the file naming it', async () => {
    for (const category of ['Loans', 'Adjustment']) {
      const g = parseGrab(fixture('grab-lipa-oct-transactions.csv'));
      const i = g.rows.findIndex((_, k) => getCell(g, k, 'Category').trim() === category);
      setCell(g, i, 'Subcategory', 'Loan Rewrite Special');
      const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
      expect(r.code).toBe('GRAB_UNKNOWN_VALUE');
      expect(r.userMessage).toContain('Loan Rewrite Special');
    }
  });

  it.each([
    ['Amount', '1,2'],
    ['Amount', 'abc'],
    ['Total', '1.234'],
    ['Channel Commission', '--5'],
    ['Net Sales', '1e3'],
  ])('a bad number in %s (%j) is GRAB_BAD_VALUE naming the column and the line', async (column, value) => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    const i = firstPayment(g) + 2;
    setCell(g, i, column, value);
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.code).toBe('GRAB_BAD_VALUE');
    expect(r.userMessage).toContain(column);
    expect(mentionsNumber(r.userMessage, i + 2)).toBe(true);
  });

  it('a bad date in Created On is GRAB_BAD_VALUE naming the column', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    setCell(g, 1, 'Created On', '2026-10-31 11:14');
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.code).toBe('GRAB_BAD_VALUE');
    expect(r.userMessage).toContain('Created On');
  });

  it('money forms: 150000, 2011.5, -455, 0, -0.5 are read exactly; an empty cell is null and is NOT zero', () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    const rows = [0, 1, 2, 3].map((i) => grabPaymentRow(g.headers, i));
    const put = (i: number, h: string, v: string): void => {
      (rows[i] as string[])[g.headers.indexOf(h)] = v;
    };
    put(0, 'Amount', '150000');
    put(1, 'Amount', '2011.5');
    put(2, 'Total', '-455');
    put(3, 'Amount', '');
    put(3, 'Discount (Merchant-Funded)', '0');
    put(2, 'Channel Commission', '-0.5');
    const out = readGrabTransactions(toCsv({ headers: g.headers, rows })).rows as Row[];
    expect(out[0]?.amount).toBe(money('150000'));
    expect(out[0]?.amount).toBe('150000.00');
    expect(out[1]?.amount).toBe('2011.50');
    expect(out[2]?.total).toBe('-455.00');
    expect(out[2]?.channelCommission).toBe('-0.50');
    expect(out[3]?.amount).toBeNull();
    expect(out[3]?.discount).toBe('0.00');
    expect(out[3]?.discount).not.toBeNull();
  });

  it('two Store IDs in one file is GRAB_MIXED_STORES and the sentence prints neither id', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    const storeA = getCell(g, 0, 'Store ID');
    setCell(g, 5, 'Store ID', STORE_B);
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.code).toBe('GRAB_MIXED_STORES');
    expect(r.userMessage).not.toContain(STORE_B);
    expect(r.userMessage).not.toContain(storeA);
  });
});

describe('readGrabTransactions: row shape, caps and encoding', () => {
  it('a short row and a long row are GRAB_BAD_ROW with the line number', async () => {
    const short = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    (short.rows[7] as string[]).pop();
    const a = await refusalOf(() => readGrabTransactions(toCsv(short)));
    expect(a.code).toBe('GRAB_BAD_ROW');
    expect(mentionsNumber(a.userMessage, 9)).toBe(true);

    const long = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    (long.rows[11] as string[]).push('extra');
    const b = await refusalOf(() => readGrabTransactions(toCsv(long)));
    expect(b.code).toBe('GRAB_BAD_ROW');
    expect(mentionsNumber(b.userMessage, 13)).toBe(true);
  });

  it('an unclosed quote is GRAB_BAD_ROW', async () => {
    const bytes = Buffer.concat([fixture('grab-malvar-oct-transactions.csv'), Buffer.from('x,"never closed\n')]);
    expect((await refusalOf(() => readGrabTransactions(bytes))).code).toBe('GRAB_BAD_ROW');
  });

  it('10,000 rows are accepted and 10,001 are GRAB_TOO_MANY_ROWS', async () => {
    expect(readGrabTransactions(syntheticGrab(10_000)).rowCount).toBe(10_000);
    expect((await refusalOf(() => readGrabTransactions(syntheticGrab(10_001)))).code).toBe('GRAB_TOO_MANY_ROWS');
  });

  it('a file over 3 MB is FILE_TOO_BIG (checked before it is decoded)', async () => {
    const big = Buffer.concat([fixture('grab-lipa-oct-transactions.csv'), Buffer.alloc(3_200_000, 0x20)]);
    expect((await refusalOf(() => readGrabTransactions(big))).code).toBe('FILE_TOO_BIG');
  });

  it('the biggest real file (Lipa, 253 KB) is well under the cap', () => {
    expect(readGrabTransactions(fixture('grab-lipa-oct-transactions.csv')).rowCount).toBe(586);
  });

  it('CHOICE: invalid UTF-8 bytes are GRAB_BAD_VALUE (decoding is strict, there is no row to blame)', async () => {
    const bytes = fixture('grab-malvar-oct-transactions.csv');
    const at = bytes.indexOf('SharEat - Malvar');
    const bad = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff, 0xfe, 0xfd]), bytes.subarray(at)]);
    expect((await refusalOf(() => readGrabTransactions(bad))).code).toBe('GRAB_BAD_VALUE');
  });

  it('BOM, no BOM, CRLF, and a missing final newline all read the same rows', () => {
    const base = readGrabTransactions(fixture('grab-malvar-oct-transactions.csv'));
    const g = parseGrab(fixture('grab-malvar-oct-transactions.csv'));
    for (const opts of [{ bom: false }, { eol: '\r\n' as const }, { bom: false, eol: '\r\n' as const }, { finalEol: false }]) {
      const out = readGrabTransactions(toCsv(g, opts));
      expect(out.rows).toEqual(base.rows);
      expect(out.rowCount).toBe(base.rowCount);
      expect(out.storeId).toBe(base.storeId);
    }
  });
});

/* ---------------------------------------------------------------- parseGrabDateTime */

describe('parseGrabDateTime', () => {
  it.each([
    ['1 Oct 2026 9:05 AM', '2026-10-01', '09:05'],
    ['15 Jan 2026 12:00 AM', '2026-01-15', '00:00'],
    ['12 Oct 2026 12:05 AM', '2026-10-12', '00:05'],
    ['3 Dec 2026 12:30 PM', '2026-12-03', '12:30'],
    ['9 Oct 2026 12:59 PM', '2026-10-09', '12:59'],
    ['31 Oct 2026 11:18 PM', '2026-10-31', '23:18'],
    ['7 Nov 2026 1:00 PM', '2026-11-07', '13:00'],
    ['29 Feb 2028 11:59 PM', '2028-02-29', '23:59'],
    ['10 Jun 2026 10:10 AM', '2026-06-10', '10:10'],
  ])('%s -> %s %s', (text, date, time) => {
    expect(parseGrabDateTime(text)).toEqual({ date, time });
  });

  it.each([
    ['', 'empty'],
    ['1 Foo 2026 9:05 AM', 'bad month'],
    ['1 Oct 2026 9:05 XM', 'bad meridiem'],
    ['1 Oct 2026 9:05', 'no meridiem'],
    ['31 Sep 2026 9:05 AM', '31 September'],
    ['29 Feb 2027 9:05 AM', '29 Feb in a non-leap year'],
    ['0 Oct 2026 9:05 AM', 'day zero'],
    ['1 Oct 2026 13:05 PM', 'hour 13 with PM'],
    ['1 Oct 2026 0:30 AM', 'hour 0 on a 12-hour clock'],
    ['1 Oct 2026 9:60 AM', 'minute 60'],
    ['1 Oct 2026 9:05:30 AM', 'seconds'],
    ['Oct 1 2026 9:05 AM', 'US order'],
    ['2026-10-01 09:05', 'ISO'],
  ])('%j (%s) is GRAB_BAD_VALUE', async (text) => {
    expect((await refusalOf(() => parseGrabDateTime(text))).code).toBe('GRAB_BAD_VALUE');
  });
});

/* ---------------------------------------------------------------- Transfers */

describe('readGrabTransfers', () => {
  it.each(TR_FILES)('$file reads: $rows payouts, $processing processing', ({ file, rows, processing }) => {
    const bytes = fixture(file);
    const out = readGrabTransfers(bytes);
    const raw = parseGrab(bytes);
    expect(out.rows).toHaveLength(rows);
    expect(out.storeId).toBe(getCell(raw, 0, 'Store ID'));
    expect(out.storeName).toBe(getCell(raw, 0, 'Store Name'));
    expect(out.rows.filter((r: { status: string }) => r.status === 'processing')).toHaveLength(processing);
    raw.rows.forEach((_, i) => {
      const got = out.rows[i] as { line: number; settlementId: string; payoutDate: unknown; netTotal: Money; status: string; transferDate: unknown };
      expect(got.line).toBe(i + 2);
      expect(got.settlementId).toBe(getCell(raw, i, 'Settlement ID'));
      expect(got.payoutDate).toEqual(oracleDateTime(getCell(raw, i, 'Date')));
      expect(got.netTotal).toBe(money(getCell(raw, i, 'Net Total')));
      expect(got.status).toBe(getCell(raw, i, 'Status').toLowerCase());
      // CHOICE: transferDate has the same { date, time } shape as payoutDate, or null when the cell is empty.
      expect(got.transferDate).toEqual(getCell(raw, i, 'Transfer Date') === '' ? null : oracleDateTime(getCell(raw, i, 'Transfer Date')));
    });
  });

  it('anchors the oracle: Malvar newest payout is processing with no transfer date; the next is completed', () => {
    const rows = readGrabTransfers(fixture('grab-malvar-oct-transfers.csv')).rows;
    expect(rows[0]).toMatchObject({ line: 2, payoutDate: { date: '2026-10-31', time: '01:56' }, netTotal: '353.25', status: 'processing', transferDate: null });
    expect(rows[1]).toMatchObject({ line: 3, payoutDate: { date: '2026-10-30', time: '01:51' }, netTotal: '2820.00', status: 'completed', transferDate: { date: '2026-10-30', time: '13:47' } });
  });

  it('a payout row has exactly six keys and the bank fields are not in the output at all', () => {
    const bytes = fixture('grab-lipa-oct-transfers.csv');
    const out = readGrabTransfers(bytes);
    for (const r of out.rows) expect(Object.keys(plain(r)).sort()).toEqual(['line', 'netTotal', 'payoutDate', 'settlementId', 'status', 'transferDate']);
    expect(assertNoLeak(out, grabTransferSensitive(bytes), GRAB_BANNED_KEYS)).toEqual([]);
  });

  it.each(TR_FILES)('$file: no bank code, bank name or bank account in the output', ({ file }) => {
    const bytes = fixture(file);
    expect(grabTransferSensitive(bytes).size).toBe(3);
    expect(assertNoLeak(readGrabTransfers(bytes), grabTransferSensitive(bytes), GRAB_BANNED_KEYS)).toEqual([]);
  });

  it('an unknown Status is GRAB_UNKNOWN_VALUE naming it', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    setCell(g, 3, 'Status', 'On Hold');
    const r = await refusalOf(() => readGrabTransfers(toCsv(g)));
    expect(r.code).toBe('GRAB_UNKNOWN_VALUE');
    expect(r.userMessage).toContain('On Hold');
  });

  it('missing and extra headers are named', async () => {
    const missing = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    const at = missing.headers.indexOf('Net Total');
    missing.headers.splice(at, 1);
    missing.rows.forEach((r) => r.splice(at, 1));
    const a = await refusalOf(() => readGrabTransfers(toCsv(missing)));
    expect(a.code).toBe('GRAB_MISSING_COLUMN');
    expect(a.userMessage).toContain('Net Total');

    const extra = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    extra.headers.push('Mystery Header');
    extra.rows.forEach((r) => r.push(''));
    const b = await refusalOf(() => readGrabTransfers(toCsv(extra)));
    expect(b.code).toBe('GRAB_UNKNOWN_COLUMN');
    expect(b.userMessage).toContain('Mystery Header');
  });

  it('a Transactions file given to the Transfers reader is refused as a column problem', async () => {
    const r = await refusalOf(() => readGrabTransfers(fixture('grab-malvar-oct-transactions.csv')));
    expect(['GRAB_MISSING_COLUMN', 'GRAB_UNKNOWN_COLUMN']).toContain(r.code);
  });

  it('a bad Net Total and a bad Date are GRAB_BAD_VALUE naming the column and the line', async () => {
    const a = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    setCell(a, 4, 'Net Total', 'abc');
    const ra = await refusalOf(() => readGrabTransfers(toCsv(a)));
    expect(ra.code).toBe('GRAB_BAD_VALUE');
    expect(ra.userMessage).toContain('Net Total');
    expect(mentionsNumber(ra.userMessage, 6)).toBe(true);

    const b = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    setCell(b, 2, 'Date', '31/10/2026');
    const rb = await refusalOf(() => readGrabTransfers(toCsv(b)));
    expect(rb.code).toBe('GRAB_BAD_VALUE');
    expect(rb.userMessage).toContain('Date');
  });

  it('two Store IDs in one payout file is GRAB_MIXED_STORES; a ragged row is GRAB_BAD_ROW; empty is FILE_EMPTY; over 3 MB is FILE_TOO_BIG', async () => {
    const mixed = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    setCell(mixed, 2, 'Store ID', STORE_B);
    expect((await refusalOf(() => readGrabTransfers(toCsv(mixed)))).code).toBe('GRAB_MIXED_STORES');

    const ragged = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    (ragged.rows[2] as string[]).pop();
    const r = await refusalOf(() => readGrabTransfers(toCsv(ragged)));
    expect(r.code).toBe('GRAB_BAD_ROW');
    expect(mentionsNumber(r.userMessage, 4)).toBe(true);

    expect((await refusalOf(() => readGrabTransfers(fixture('hostile-empty.csv')))).code).toBe('FILE_EMPTY');
    const big = Buffer.concat([fixture('grab-malvar-oct-transfers.csv'), Buffer.alloc(3_200_000, 0x20)]);
    expect((await refusalOf(() => readGrabTransfers(big))).code).toBe('FILE_TOO_BIG');
  });

  it('BOM and CRLF variants read the same payouts', () => {
    const base = readGrabTransfers(fixture('grab-malvar-oct-transfers.csv'));
    const g = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    expect(readGrabTransfers(toCsv(g, { bom: false, eol: '\r\n' })).rows).toEqual(base.rows);
  });
});
