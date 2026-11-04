/**
 * T-511 S3 - audit fiftieth pass: file-supplied text that names an Object.prototype member (`constructor`, `toString`, `__proto__`...)
 * must refuse like any other unknown value, with a named code and a sentence naming the value. Never accepted, never an unnamed TypeError.
 */
import { describe, expect, it } from 'vitest';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { deductionFor } from '../../src/settlement-intake/deduction-mapping';
import { FP34_HEADERS, FPB_HEADERS, fixture, fp34Order, fpChargeRow, fpWorkbook, getCell, parseGrab, refusalOf, setCell, toCsv, UUID_SHAPE, xlsxBytes, type GrabCsv } from './t511-s3-helpers';

const PROTO = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'] as const;

const firstPayment = (g: GrabCsv): number => g.rows.findIndex((_, i) => getCell(g, i, 'Category').trim() === 'Payment');
const clean = (r: { userMessage: string }, named: string): void => {
  expect(r.userMessage).toContain(named);
  expect(r.userMessage).not.toMatch(UUID_SHAPE);
};

describe('Grab Transactions: Object.prototype names are unknown values', () => {
  const lipa = (): GrabCsv => parseGrab(fixture('grab-lipa-oct-transactions.csv'));

  it.each(PROTO.flatMap((name) => [[name, ''], [name, 'Loan Deduction']] as const))(
    'Category %s with Subcategory %j is GRAB_UNKNOWN_VALUE naming it',
    async (name, subcategory) => {
      const g = lipa();
      const i = firstPayment(g);
      setCell(g, i, 'Category', `${name} `);
      setCell(g, i, 'Subcategory', subcategory);
      const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
      expect(r.code).toBe('GRAB_UNKNOWN_VALUE');
      clean(r, name);
    },
  );

  it.each(PROTO)('Subcategory %s (on a loan row and on a payment row) is GRAB_UNKNOWN_VALUE naming it', async (name) => {
    for (const category of ['Loans', 'Payment']) {
      const g = lipa();
      const i = g.rows.findIndex((_, k) => getCell(g, k, 'Category').trim() === category);
      setCell(g, i, 'Subcategory', name);
      const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
      expect(r.code).toBe('GRAB_UNKNOWN_VALUE');
      clean(r, name);
    }
  });

  it.each(PROTO)('Status %s is GRAB_UNKNOWN_VALUE naming it', async (name) => {
    const g = lipa();
    setCell(g, firstPayment(g), 'Status', name);
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.code).toBe('GRAB_UNKNOWN_VALUE');
    clean(r, name);
  });

  it.each(PROTO)('an extra header named %s is GRAB_UNKNOWN_COLUMN naming it', async (name) => {
    const g = lipa();
    g.headers.push(name);
    g.rows.forEach((row) => row.push(''));
    const r = await refusalOf(() => readGrabTransactions(toCsv(g)));
    expect(r.code).toBe('GRAB_UNKNOWN_COLUMN');
    clean(r, name);
  });
});

describe('Grab Transfers: Object.prototype names are refused', () => {
  const malvar = (): GrabCsv => parseGrab(fixture('grab-malvar-oct-transfers.csv'));

  it.each(PROTO)('Status %s is GRAB_UNKNOWN_VALUE naming it', async (name) => {
    const g = malvar();
    setCell(g, 3, 'Status', name);
    const r = await refusalOf(() => readGrabTransfers(toCsv(g)));
    expect(r.code).toBe('GRAB_UNKNOWN_VALUE');
    clean(r, name);
  });

  it.each(PROTO)('an extra header named %s is GRAB_UNKNOWN_COLUMN naming it', async (name) => {
    const g = malvar();
    g.headers.push(name);
    g.rows.forEach((row) => row.push(''));
    const r = await refusalOf(() => readGrabTransfers(toCsv(g)));
    expect(r.code).toBe('GRAB_UNKNOWN_COLUMN');
    clean(r, name);
  });
});

describe('Foodpanda: Object.prototype names are refused', () => {
  it.each(PROTO)('an Appendix A header named %s is FOODPANDA_UNKNOWN_COLUMN naming it', async (name) => {
    const headers = [...FP34_HEADERS.slice(0, 10), name, ...FP34_HEADERS.slice(10)];
    const rows = [fp34Order('zz99-0001-aa')].map((r) => [...r.slice(0, 10), 0, ...r.slice(10)]);
    const r = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ headers, orderRows: rows })));
    expect(r.code).toBe('FOODPANDA_UNKNOWN_COLUMN');
    clean(r, name);
  });

  it.each(PROTO)('an Appendix B header named %s is FOODPANDA_UNKNOWN_COLUMN naming it', async (name) => {
    const book = xlsxBytes([
      { name: 'Appendix A', rows: [FP34_HEADERS, fp34Order('zz99-0001-aa')] },
      { name: 'Appendix B', rows: [[...FPB_HEADERS, name], [...fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz99', 223.21), 0]] },
    ]);
    const r = await refusalOf(() => readFoodpandaInvoice(book));
    expect(r.code).toBe('FOODPANDA_UNKNOWN_COLUMN');
    clean(r, name);
  });
});

describe('deductionFor: Object.prototype names are unknown columns', () => {
  it.each(PROTO)('%s refuses for both platforms and never returns a function', async (name) => {
    const g = await refusalOf(() => deductionFor('grab', name));
    expect(g.code).toBe('GRAB_UNKNOWN_COLUMN');
    clean(g, name);
    const f = await refusalOf(() => deductionFor('foodpanda', name));
    expect(f.code).toBe('FOODPANDA_UNKNOWN_COLUMN');
    clean(f, name);
  });
});
