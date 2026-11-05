/**
 * T-511 S3 (H) - the audit fixes: money overflow, duplicate payout id, a money row with no Order Code, the
 * "not enough bytes" zip wording. Written BEFORE the fixes (red first). `s3_audit_report.md` findings 1 to 5.
 */
import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import { tieGrabPayouts } from '../../src/settlement-intake/grab-payouts';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { openSettlementZip, normalizeXlsx } from '../../src/settlement-intake/safe-zip';
import {
  STORE_A,
  fixture,
  fp34Order,
  fpWorkbook,
  getCell,
  grabHeaders,
  grabPaymentRow,
  mentionsNumber,
  parseGrab,
  refusalOf,
  setCell,
  toCsv,
  zipBytes,
  type Cell,
} from './t511-s3-helpers';

/* ---------------------------------------------------------------- 2. money overflow */

const NEAR_MAX = '999999999999.99';

describe('money overflow is a named refusal, never a raw RangeError', () => {
  function bigGrab(): Buffer {
    const headers = grabHeaders();
    const a = grabPaymentRow(headers, 0);
    const b = grabPaymentRow(headers, 7); // same Settlement ID as row 0 (i % 7)
    for (const r of [a, b]) r[headers.indexOf('Total')] = NEAR_MAX;
    return toCsv({ headers, rows: [a, b] });
  }
  const transfersFor = (settlementIds: string[]) => ({
    storeId: STORE_A,
    storeName: 'x',
    rowCount: settlementIds.length,
    readerVersion: 'x',
    rows: settlementIds.map((settlementId, i) => ({
      line: i + 2,
      settlementId,
      payoutDate: { date: '2026-10-02', time: '01:50' },
      netTotal: money('1'),
      status: 'completed' as const,
      transferDate: null,
    })),
  });

  it('Grab: two rows of 999,999,999,999.99 in one settlement refuse GRAB_BAD_VALUE when the payout is tied', async () => {
    const tx = readGrabTransactions(bigGrab());
    const r = await refusalOf(() => tieGrabPayouts(tx, transfersFor(['SPHSYNTH0000'])));
    expect(r.code).toBe('GRAB_BAD_VALUE');
    expect(r.userMessage).toMatch(/line 2/i);
  });

  it('Grab: the same rows in an unlisted settlement (no payout row yet) refuse GRAB_BAD_VALUE too', async () => {
    const tx = readGrabTransactions(bigGrab());
    expect((await refusalOf(() => tieGrabPayouts(tx, transfersFor([])))).code).toBe('GRAB_BAD_VALUE');
  });

  it.each([
    ['gross + container (revenue identity)', { 10: 999999999999.99, 11: 999999999999.99 }, 'FOODPANDA_BAD_VALUE'],
    ['revenue + expanded withholding tax (balance identity, additions)', { 17: 999999999999.99, 30: 999999999999.99 }, 'FOODPANDA_BAD_VALUE'],
    ['commission + tax on charges (balance identity, subtractions)', { 24: 999999999999.99, 29: 999999999999.99 }, 'FOODPANDA_BAD_VALUE'],
  ])('Foodpanda: %s refuses FOODPANDA_BAD_VALUE naming the sheet row', async (_label, over, code) => {
    const r = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ orderRows: [fp34Order('zz99-0001-aa', over as Record<number, Cell>)] })));
    expect(r.code).toBe(code);
    expect(mentionsNumber(r.userMessage, 2)).toBe(true);
  });
});

/* ---------------------------------------------------------------- 3. duplicate Settlement ID */

describe('readGrabTransfers: a Settlement ID repeated in one file', () => {
  it('is GRAB_BAD_ROW naming both lines and printing no id', async () => {
    const g = parseGrab(fixture('grab-malvar-oct-transfers.csv'));
    const id = getCell(g, 0, 'Settlement ID');
    setCell(g, 4, 'Settlement ID', id);
    const r = await refusalOf(() => readGrabTransfers(toCsv(g)));
    expect(r.code).toBe('GRAB_BAD_ROW');
    expect(mentionsNumber(r.userMessage, 2)).toBe(true);
    expect(mentionsNumber(r.userMessage, 6)).toBe(true);
    expect(r.userMessage).not.toContain(id);
  });

  it('the real files have unique ids and still read', () => {
    expect(readGrabTransfers(fixture('grab-malvar-oct-transfers.csv')).rows).toHaveLength(31);
  });
});

/* ---------------------------------------------------------------- 4. a row with money but no Order Code */

describe('readFoodpandaInvoice: a row with no Order Code', () => {
  const noCode = (f: (v: Cell, i: number) => Cell): Cell[] => fp34Order('zz99-0001-aa').map((v, i) => (i === 5 ? null : f(v, i)));

  it('with amounts in it is NOT the SUBTOTAL row: FOODPANDA_BAD_VALUE naming the sheet row', async () => {
    const rows = [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb'), noCode((v) => (typeof v === 'number' ? v * 3 : null))];
    const r = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ orderRows: rows })));
    expect(r.code).toBe('FOODPANDA_BAD_VALUE');
    expect(mentionsNumber(r.userMessage, 4)).toBe(true);
  });

  it('with a single amount (a lone 123,456.78 in one money column) is also refused', async () => {
    const rows = [fp34Order('zz99-0001-aa'), noCode((_v, i) => (i === 10 ? 123456.78 : null))];
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ orderRows: rows })))).code).toBe('FOODPANDA_BAD_VALUE');
  });

  it('with no amounts (the uncached SUBTOTAL row: blank cells, at most labels) is skipped', async () => {
    const rows = [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb'), noCode((_v, i) => (i === 0 ? 'Total' : null))];
    const inv = await readFoodpandaInvoice(fpWorkbook({ orderRows: rows }));
    expect(inv.orders).toHaveLength(2);
  });

  it('the real workbooks, which end in the uncached SUBTOTAL row, still read', async () => {
    const { workbook } = await openSettlementZip(fixture('foodpanda-malvar-oct12-34col.zip'));
    expect((await readFoodpandaInvoice(workbook)).orders).toHaveLength(57);
  });
});

/* ---------------------------------------------------------------- 5. zip size wording */

/** Sets the declared sizes in the FIRST central directory record of a zip. */
function declare(zip: Buffer, sizes: { compressed?: number; uncompressed?: number }): Buffer {
  const out = Buffer.from(zip);
  const at = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (sizes.compressed !== undefined) out.writeUInt32LE(sizes.compressed, at + 20);
  if (sizes.uncompressed !== undefined) out.writeUInt32LE(sizes.uncompressed, at + 24);
  return out;
}

describe('openSettlementZip: a size that is wrong in the "not enough" direction is ZIP_SIZE_MISMATCH', () => {
  const honest = (): Buffer => zipBytes([{ name: 'a.xls', data: Buffer.alloc(100, 7), method: 'store' }]);
  const deflated = (): Buffer => zipBytes([{ name: 'a.xls', data: Buffer.alloc(100, 7) }]);

  it('declared compressed size larger than the data present (the entry runs past the end of the file)', async () => {
    expect((await refusalOf(() => openSettlementZip(declare(honest(), { compressed: 900_000, uncompressed: 900_000 })))).code).toBe('ZIP_SIZE_MISMATCH');
  });

  it('declared uncompressed size larger than the stream delivers (not enough bytes), deflated and stored', async () => {
    expect((await refusalOf(() => openSettlementZip(declare(deflated(), { uncompressed: 5000 })))).code).toBe('ZIP_SIZE_MISMATCH');
    expect((await refusalOf(() => openSettlementZip(declare(honest(), { uncompressed: 5000 })))).code).toBe('ZIP_SIZE_MISMATCH');
  });

  it('the same two on the inner workbook (normalizeXlsx)', async () => {
    expect((await refusalOf(() => normalizeXlsx(declare(honest(), { compressed: 900_000, uncompressed: 900_000 })))).code).toBe('ZIP_SIZE_MISMATCH');
    expect((await refusalOf(() => normalizeXlsx(declare(deflated(), { uncompressed: 5000 })))).code).toBe('ZIP_SIZE_MISMATCH');
  });

  it('open-time failures stay ZIP_NOT_A_ZIP (a damaged tail, plain text)', async () => {
    const z = honest();
    expect((await refusalOf(() => openSettlementZip(z.subarray(0, z.length - 5)))).code).toBe('ZIP_NOT_A_ZIP');
    expect((await refusalOf(() => openSettlementZip(Buffer.from('plain text, not a zip at all')))).code).toBe('ZIP_NOT_A_ZIP');
  });
});
