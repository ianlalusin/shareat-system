/**
 * T-511 S3 (F) - every refusal code is reachable, named, and safe to show.
 * `docs/tasks/511-settlement-upload-s3-spec.md` item 1: UPPER_SNAKE codes, sentences that never carry a Store ID, an order id,
 * `[hidden]` (what `refuse()` turns a UUID into) or a library error.
 *
 * One trigger per code, none shared with the code's own feature tests, so a code that becomes unreachable fails here by name.
 */
import { describe, expect, it } from 'vitest';
import { RefusalError } from '../../src/shared/refusal';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';
import { openSettlementZip, normalizeXlsx } from '../../src/settlement-intake/safe-zip';
import { readSheetsInWorker } from '../../src/settlement-intake/xlsx-worker-host';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import { tieGrabPayouts } from '../../src/settlement-intake/grab-payouts';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { deductionFor } from '../../src/settlement-intake/deduction-mapping';
import {
  FP34_HEADERS,
  STORE_B,
  UUID_SHAPE,
  fixture,
  fpChargeRow,
  fpWorkbook,
  fp34Order,
  getCell,
  grabTransactionSensitive,
  manyEntries,
  parseGrab,
  refusalOf,
  setCell,
  syntheticGrab,
  toCsv,
  zipBytes,
  type Cell,
} from './t511-s3-helpers';

const EXPECTED_CODES = [
  'FILE_EMPTY', 'FILE_TOO_BIG', 'ZIP_NOT_A_ZIP', 'ZIP_TOO_MANY_ENTRIES', 'ZIP_TOO_BIG_EXPANDED', 'ZIP_UNSAFE_NAME', 'ZIP_NESTED_ARCHIVE',
  'ZIP_ENTRY_NOT_ALLOWED', 'ZIP_SIZE_MISMATCH', 'ZIP_NO_WORKBOOK', 'GRAB_MISSING_COLUMN', 'GRAB_UNKNOWN_COLUMN', 'GRAB_BAD_ROW', 'GRAB_BAD_VALUE',
  'GRAB_UNKNOWN_VALUE', 'GRAB_MIXED_STORES', 'GRAB_TOO_MANY_ROWS', 'GRAB_NO_ROWS', 'FOODPANDA_MISSING_COLUMN', 'FOODPANDA_UNKNOWN_COLUMN',
  'FOODPANDA_UNKNOWN_LAYOUT', 'FOODPANDA_NO_SHEETS', 'FOODPANDA_MIXED_INVOICE', 'FOODPANDA_TOO_MANY_ROWS', 'FOODPANDA_BAD_VALUE', 'XLSX_MALFORMED', 'XLSX_TOO_HEAVY', 'XLSX_TOO_SLOW', 'XLSX_WORKER_UNAVAILABLE',
];

const dataUrl = (js: string): URL => new URL(`data:text/javascript,${encodeURIComponent(js)}`);
const malvar = (): ReturnType<typeof parseGrab> => parseGrab(fixture('grab-malvar-oct-transactions.csv'));

const TRIGGERS: Record<string, () => unknown> = {
  FILE_EMPTY: () => openSettlementZip(fixture('hostile-empty.zip')),
  FILE_TOO_BIG: () => openSettlementZip(zipBytes([{ name: 'a.xls', data: Buffer.alloc(1_100_000, 7), method: 'store' }])),
  ZIP_NOT_A_ZIP: () => openSettlementZip(fixture('hostile-not-a-zip.zip')),
  ZIP_TOO_MANY_ENTRIES: () => openSettlementZip(fixture('hostile-zip-11-entries.zip')),
  ZIP_TOO_BIG_EXPANDED: () => openSettlementZip(fixture('hostile-zip-expands-over-5mb.zip')),
  ZIP_UNSAFE_NAME: () => openSettlementZip(fixture('hostile-zip-path-traversal.zip')),
  ZIP_NESTED_ARCHIVE: () => openSettlementZip(fixture('hostile-zip-nested-archive.zip')),
  ZIP_ENTRY_NOT_ALLOWED: () => openSettlementZip(fixture('hostile-zip-bad-extension.zip')),
  ZIP_SIZE_MISMATCH: () => openSettlementZip(fixture('hostile-zip-lying-size.zip')),
  ZIP_NO_WORKBOOK: () => openSettlementZip(zipBytes(manyEntries(2, 'pdf'))),
  GRAB_MISSING_COLUMN: () => readGrabTransactions(fixture('hostile-grab-missing-settlement-id-column.csv')),
  GRAB_UNKNOWN_COLUMN: () => {
    const g = malvar();
    g.headers.push('Mystery Header');
    g.rows.forEach((r) => r.push(''));
    return readGrabTransactions(toCsv(g));
  },
  GRAB_BAD_ROW: () => {
    const g = malvar();
    (g.rows[3] as string[]).pop();
    return readGrabTransactions(toCsv(g));
  },
  GRAB_BAD_VALUE: () => {
    const g = malvar();
    setCell(g, 2, 'Total', 'abc');
    return readGrabTransactions(toCsv(g));
  },
  GRAB_UNKNOWN_VALUE: () => {
    const g = malvar();
    setCell(g, 2, 'Status', 'Pending');
    return readGrabTransactions(toCsv(g));
  },
  GRAB_MIXED_STORES: () => {
    const g = malvar();
    setCell(g, 4, 'Store ID', STORE_B);
    return readGrabTransactions(toCsv(g));
  },
  GRAB_TOO_MANY_ROWS: () => readGrabTransactions(syntheticGrab(10_001)),
  GRAB_NO_ROWS: () => readGrabTransactions(fixture('hostile-grab-header-only.csv')),
  FOODPANDA_MISSING_COLUMN: () => readFoodpandaInvoice(fixture('hostile-xlsx-missing-order-date.xlsx')),
  FOODPANDA_UNKNOWN_COLUMN: () => readFoodpandaInvoice(fixture('hostile-xlsx-unknown-extra-column.xlsx')),
  FOODPANDA_UNKNOWN_LAYOUT: () => {
    const drop = 21;
    const headers = FP34_HEADERS.filter((_, i) => i !== drop);
    const rows = [fp34Order('zz99-0001-aa')].map((r: Cell[]) => r.filter((_, i) => i !== drop));
    return readFoodpandaInvoice(fpWorkbook({ headers, orderRows: rows }));
  },
  FOODPANDA_NO_SHEETS: () => readFoodpandaInvoice(fpWorkbook({ sheetNames: ['Sheet1', 'Sheet2'] })),
  FOODPANDA_MIXED_INVOICE: () => readFoodpandaInvoice(fpWorkbook({ orderRows: [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb', {}, '200999999998')] })),
  FOODPANDA_TOO_MANY_ROWS: () =>
    readFoodpandaInvoice(fpWorkbook({ chargeRows: Array.from({ length: 201 }, (_, i) => fpChargeRow('Organic Placement (CPC)', `Organic Placement (CPC)  2026-10-08  : ZZ99 ${i}`, 1)) })),
  FOODPANDA_BAD_VALUE: () => readFoodpandaInvoice(fpWorkbook({ orderRows: [fp34Order('zz99-0001-aa', { 10: 10.005 })] })),
  XLSX_MALFORMED: () => normalizeXlsx(zipBytes([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<!DOCTYPE x [<!ENTITY a "b">]><sheetData/>') }])),
  XLSX_TOO_HEAVY: () => readSheetsInWorker(zipBytes([]), { workerUrl: dataUrl('const a=[]; for(;;) a.push(new Array(1e5).fill(1));') }),
  XLSX_TOO_SLOW: () => readSheetsInWorker(zipBytes([]), { workerUrl: dataUrl('for(;;){}'), timeoutMs: 200 }),
  XLSX_WORKER_UNAVAILABLE: () => readSheetsInWorker(zipBytes([]), { workerUrl: new URL('file:///definitely/not/here/xlsx-worker.mjs') }),
};

const SENSITIVE = [...grabTransactionSensitive(fixture('grab-malvar-oct-transactions.csv'))].filter((s) => s.length >= 6);

describe('the refusal codes', () => {
  it('there are exactly the 29 codes (the 25 of the spec plus XLSX_MALFORMED, XLSX_TOO_HEAVY, XLSX_TOO_SLOW and XLSX_WORKER_UNAVAILABLE), each with one trigger here', () => {
    expect(Object.keys(TRIGGERS).sort()).toEqual([...EXPECTED_CODES].sort());
    expect(new Set(EXPECTED_CODES).size).toBe(29);
  });

  it.each(EXPECTED_CODES)('%s is reachable and raised as a SettlementIntakeRefusal (a RefusalError) with that code', async (code) => {
    const r = await refusalOf(TRIGGERS[code] as () => unknown);
    expect(r).toBeInstanceOf(SettlementIntakeRefusal);
    expect(r).toBeInstanceOf(RefusalError);
    expect(r.code).toBe(code);
    expect(r.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it.each(EXPECTED_CODES)('%s: the sentence is a presentable sentence with no UUID, no [hidden], no order id and no library error', async (code) => {
    const r = await refusalOf(TRIGGERS[code] as () => unknown);
    for (const text of [r.userMessage, r.message]) {
      expect(text.trim().length).toBeGreaterThan(15);
      expect(text).not.toMatch(UUID_SHAPE);
      expect(text).not.toContain('[hidden]');
      expect(text).not.toMatch(/undefined|\[object|TypeError|RangeError|ENOENT|at .*\(.*:\d+:\d+\)/);
      for (const s of SENSITIVE) expect(text).not.toContain(s);
    }
  });

  it('a refusal names the offending column, value or line, never the row: bad value and bad row on the Malvar file', async () => {
    const g = malvar();
    const orderId = getCell(g, 2, 'Long Order ID');
    const txId = getCell(g, 2, 'Transaction ID');
    setCell(g, 2, 'Total', 'abc');
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.userMessage).toContain('Total');
    expect(r.userMessage).not.toContain(orderId);
    expect(r.userMessage).not.toContain(txId);
  });

  it('the tie and the mapping refuse with the same class', async () => {
    const a = readGrabTransactions(fixture('grab-lipa-oct-transactions.csv'));
    const b = readGrabTransfers(fixture('grab-malvar-oct-transfers.csv'));
    expect((await refusalOf(() => tieGrabPayouts(a, b))).code).toBe('GRAB_MIXED_STORES');
    expect(await refusalOf(() => deductionFor('grab', 'Nope'))).toBeInstanceOf(SettlementIntakeRefusal);
  });
});
