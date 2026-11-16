/**
 * T-511 S8b (1) - the reader gives each Appendix B charge its Official Document Number and reads "Appendix C" (Outstanding Amount From Previous Periods) into `priorItems`.
 * docs/tasks/511-settlement-upload-s8-spec.md "S8b" item 1. The real weekly (299999000010) prints three items on Appendix C, the official document numbers of three small
 * PandaGO-era charge invoices, signed as Foodpanda prints them: (2999999900000001, -100), (3999999900000002, +100), (2999999900000003, -100).
 */
import { describe, expect, it } from 'vitest';
import { readSheetsInWorker } from '../../src/settlement-intake/xlsx-worker-host';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { FPB_HEADERS, FPC_HEADERS, day, fpChargeRow, fpPriorRow, fpWorkbook, refusalOf, xlsxBytes, type Cell } from './t511-s3-helpers';

type Charge = { category: string; officialDocument: string | null };
type Prior = { document: string; date: string | null; amount: string; remaining: string | null };
type Invoice = { orders: Record<string, unknown>[]; charges: Charge[]; priorItems: Prior[] };
const read = async (wb: Buffer): Promise<Invoice> => (await readFoodpandaInvoice(wb)) as unknown as Invoice;

const TEST_THREE: Cell[][] = [fpPriorRow('2999999900000001', -100), fpPriorRow('3999999900000002', 100), fpPriorRow('2999999900000003', -100)];

describe('S8b reader - Appendix B charges carry their Official Document Number', () => {
  it('each charge has the document number printed on its own row, as text; an order never has the field [kills: the number dropped; a number read as a float; the field leaking onto orders]', async () => {
    const inv = await read(
      fpWorkbook({
        chargeRows: [
          fpChargeRow('Organic Placement (CPC)', 'Organic Placement (CPC)  2026-10-08  : ZZ99', 10, '12%', 'zz99', '2999999900000009'),
          fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz99', 200.00, '12%', 'zz99', '3999999900000002'),
        ],
      }),
    );
    expect(inv.charges.map((c) => c.officialDocument)).toEqual(['2999999900000009', '3999999900000002']);
    for (const o of inv.orders) expect('officialDocument' in o).toBe(false);
  });

  it('a numeric cell is read as its digits; a blank cell is null; a document column that is absent altogether is null on every charge [kills: NaN / 2e15; "" kept as a document; a missing column refused]', async () => {
    const numeric = await read(fpWorkbook({ chargeRows: [[2999999900000001, '200999999999', day('2026-10-19'), 'Platform Fee', 'PF', 'zz99', '12%', 1, 1, 1, 0]] }));
    expect(numeric.charges[0]?.officialDocument).toBe('2999999900000001');
    const blank = await read(fpWorkbook({ chargeRows: [fpChargeRow('Platform Fee', 'PF', 1, '12%', 'zz99', '   ')] }));
    expect(blank.charges[0]?.officialDocument).toBeNull();
    const without = await read(
      fpWorkbook({ chargeHeaders: FPB_HEADERS.slice(1), chargeRows: [fpChargeRow('Platform Fee', 'PF', 1).slice(1)] }),
    );
    expect(without.charges[0]?.officialDocument).toBeNull();
  });

  it('audit 8: a document number is only letters, digits and . _ / - (1 to 40): a zero-width space, a bidi override, an inner space or an accent is FOODPANDA_BAD_VALUE, in Appendix B and in Appendix C [kills: an invisible character that makes two equal-looking numbers differ, or reorders a sentence]', async () => {
    for (const bad of ['2000\u200b000', '2000000005\u202e092538', '\u20662999999900000001', '2000 000005092538', 'Caf\u00e9-1', '2999999900000001\u200d']) {
      expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ chargeRows: [fpChargeRow('Platform Fee', 'PF', 1, '12%', 'zz99', bad)] })))).code, `B ${JSON.stringify(bad)}`).toBe('FOODPANDA_BAD_VALUE');
      expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: [[bad, '31.10.2026', null, -100, -100]] })))).code, `C ${JSON.stringify(bad)}`).toBe('FOODPANDA_BAD_VALUE');
    }
    const fine = await read(fpWorkbook({ chargeRows: [fpChargeRow('Platform Fee', 'PF', 1, '12%', 'zz99', 'AB-12/3.x_y')] }));
    expect(fine.charges[0]?.officialDocument).toBe('AB-12/3.x_y');
  });

  it('a document number over 40 characters, or with a control character, is refused by name, never stored [kills: hostile text reaching the table and the sentences]', async () => {
    const long = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ chargeRows: [fpChargeRow('Platform Fee', 'PF', 1, '12%', 'zz99', '2'.repeat(41))] })));
    expect(long.code).toBe('FOODPANDA_BAD_VALUE');
    const control = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ chargeRows: [fpChargeRow('Platform Fee', 'PF', 1, '12%', 'zz99', '2000\u0007000')] })));
    expect(control.code).toBe('FOODPANDA_BAD_VALUE');
    expect((await read(fpWorkbook({ chargeRows: [fpChargeRow('Platform Fee', 'PF', 1, '12%', 'zz99', '2'.repeat(40))] }))).charges).toHaveLength(1);
  });
});

describe('S8b reader - Appendix C becomes priorItems', () => {
  it('no Appendix C sheet: priorItems is an empty list [kills: undefined / null instead of []; a refusal for the old two-sheet workbook]', async () => {
    expect((await read(fpWorkbook())).priorItems).toEqual([]);
  });

  it('the real three rows, in the order printed, with the signed amount, an ISO date from DD.MM.YYYY and the document as text [kills: the sign lost; the date read month-first; the order changed; Remaining Amount read instead of Invoice Amount]', async () => {
    const inv = await read(fpWorkbook({ priorRows: TEST_THREE }));
    expect(inv.priorItems).toEqual([
      { document: '2999999900000001', date: '2026-10-31', amount: '-100.00', remaining: '-100.00' },
      { document: '3999999900000002', date: '2026-10-31', amount: '100.00', remaining: '100.00' },
      { document: '2999999900000003', date: '2026-10-31', amount: '-100.00', remaining: '-100.00' },
    ]);
    const remaining = await read(fpWorkbook({ priorRows: [['2999999900000001', '31.10.2026', null, -100, -37.5]] }));
    expect(remaining.priorItems[0]?.amount).toBe('-100.00');
    // S8b audit 1: the remaining amount is kept next to the amount (a half-settled item must be recognisable), as printed
    expect(remaining.priorItems[0]?.remaining).toBe('-37.50');
  });

  it('audit 1: a blank Remaining Amount cell, or no such column at all, is null (unknown), never read as equal to the amount [kills: a missing remaining read as settled in full]', async () => {
    const blank = await read(fpWorkbook({ priorRows: [['2999999900000001', '31.10.2026', null, -100, null]] }));
    expect(blank.priorItems[0]?.remaining).toBeNull();
    const without = await read(fpWorkbook({ priorHeaders: ['Invoice Number', 'Invoice Date', 'Invoice Period', 'Invoice Amount'], priorRows: [['2999999900000001', '31.10.2026', null, -100]] }));
    expect(without.priorItems[0]).toEqual({ document: '2999999900000001', date: '2026-10-31', amount: '-100.00', remaining: null });
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: [['2999999900000001', '31.10.2026', null, -100, 'x']] })))).code).toBe('FOODPANDA_BAD_VALUE');
  });

  it('a Date cell is accepted as the date; text that is no date gives null (the date is for the screen only), never a refusal [kills: a refusal over a decorative column]', async () => {
    const inv = await read(fpWorkbook({ priorRows: [['2999999900000001', day('2026-10-31'), null, -100, -100], ['3999999900000002', 'soon', null, 100, 100]] }));
    expect(inv.priorItems.map((p) => p.date)).toEqual(['2026-10-31', null]);
  });

  it('blank rows are skipped; a row with an amount and no document, or a document and no amount, is refused [kills: a blank row read as a zero item; an amount that belongs to nothing]', async () => {
    const inv = await read(fpWorkbook({ priorRows: [[null, null, null, null, null], fpPriorRow('2999999900000001', -100), ['  ', null, null, null, null]] }));
    expect(inv.priorItems).toHaveLength(1);
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: [[null, '31.10.2026', null, -100, -100]] })))).code).toBe('FOODPANDA_BAD_VALUE');
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: [['2999999900000001', '31.10.2026', null, null, null]] })))).code).toBe('FOODPANDA_BAD_VALUE');
  });

  it('an amount with more than two decimals, or text, is refused like every other money cell [kills: a float into the books]', async () => {
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: [['2999999900000001', '31.10.2026', null, -100.005, -100]] })))).code).toBe('FOODPANDA_BAD_VALUE');
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: [['2999999900000001', '31.10.2026', null, 'a hundred', -100]] })))).code).toBe('FOODPANDA_BAD_VALUE');
  });

  it('at most 50 items: 50 are read, 51 is FOODPANDA_TOO_MANY_ROWS [kills: no cap; an off-by-one]', async () => {
    const rows = (n: number): Cell[][] => Array.from({ length: n }, (_, i) => fpPriorRow(`20000000${String(i).padStart(8, '0')}`, -1));
    expect((await read(fpWorkbook({ priorRows: rows(50) }))).priorItems).toHaveLength(50);
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: rows(51) })))).code).toBe('FOODPANDA_TOO_MANY_ROWS');
  });

  it('an unknown column is refused naming it, a missing Invoice Amount is refused naming it, a repeated one too [kills: a silently ignored new column on a money sheet]', async () => {
    const extra = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorHeaders: [...FPC_HEADERS, 'Surprise Debt'], priorRows: [[...fpPriorRow('2999999900000001', -100), 1]] })));
    expect(extra.code).toBe('FOODPANDA_UNKNOWN_COLUMN');
    expect(extra.userMessage).toContain('Surprise Debt');
    const missing = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorHeaders: ['Invoice Number', 'Invoice Date', 'Invoice Period', 'Remaining Amount'], priorRows: [['2999999900000001', '31.10.2026', null, -100]] })));
    expect(missing.code).toBe('FOODPANDA_MISSING_COLUMN');
    expect(missing.userMessage).toContain('Invoice Amount');
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorHeaders: [...FPC_HEADERS, 'Invoice Amount'], priorRows: [] })))).code).toBe('FOODPANDA_UNKNOWN_COLUMN');
  });

  it('an Appendix C with a header and no rows is an empty list; the header row is never an item [kills: the header read as a document]', async () => {
    expect((await read(fpWorkbook({ priorRows: [] }))).priorItems).toEqual([]);
  });

  it('a document number over 40 characters is refused by name [kills: hostile text in the jsonb]', async () => {
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ priorRows: [['2'.repeat(41), '31.10.2026', null, -100, -100]] })))).code).toBe('FOODPANDA_BAD_VALUE');
  });
});

describe('S8b audit 7 - which Appendix B rows are Delivery Service Fees', () => {
  it('a row whose CATEGORY mentions pandago is shown only (kind pandago) whatever its description says; only the exact category "Delivery Service Fees" is a delivery fee [kills: cash on delivery booked as an expense because its description is odd]', async () => {
    const inv = (await readFoodpandaInvoice(
      fpWorkbook({
        chargeRows: [
          fpChargeRow('Pandago COD', 'Something odd', -20, '0%'),
          fpChargeRow('PANDAGO Delivery Fees', 'Delivery Service Fees', 5),
          fpChargeRow('Delivery Service Fees', 'Something odd', 5),
          fpChargeRow('Delivery Service Fees', 'PandaGO Order-10.31.2026-zz99-abc123', 5),
          fpChargeRow('Pandago COD', 'PandaGO Order-10.31.2026-zz99-abc124', -20, '0%'),
        ],
      }),
    )) as unknown as { charges: { kind: string }[] };
    expect(inv.charges.map((c) => c.kind)).toEqual(['pandago', 'pandago', 'delivery_fee', 'delivery_fee', 'pandago']);
  });
});

describe('S8b reader - the worker hands back Appendix C too', () => {
  it('rows of the third sheet equal read-excel-file called directly; a workbook without it gives null for c [kills: a worker that never reads the sheet]', async () => {
    const withC = await readSheetsInWorker(fpWorkbook({ priorRows: TEST_THREE }));
    expect(withC.c).toEqual([['Invoice Number', 'Invoice Date', 'Invoice Period', 'Invoice Amount', 'Remaining Amount'], ['2999999900000001', '31.10.2026', null, -100, -100], ['3999999900000002', '31.10.2026', null, 100, 100], ['2999999900000003', '31.10.2026', null, -100, -100]]);
    expect((await readSheetsInWorker(fpWorkbook())).c).toBeNull();
  });

  it('a workbook that has only an Appendix C is still FOODPANDA_NO_SHEETS (no orders and no charges) [kills: a C-only file accepted as an invoice]', async () => {
    const wb = xlsxBytes([{ name: 'Appendix C', rows: [FPC_HEADERS, ...TEST_THREE] }]);
    expect((await refusalOf(() => readFoodpandaInvoice(wb))).code).toBe('FOODPANDA_NO_SHEETS');
  });
});
