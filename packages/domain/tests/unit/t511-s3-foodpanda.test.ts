/**
 * T-511 S3 (D) - the Foodpanda workbook reader and its header normaliser.
 * `docs/tasks/511-settlement-upload-s3-spec.md` item 6; numbers from `docs/discovery/grab-foodpanda-settlement-files.md`.
 *
 * CONTRACT PINNED BY THESE TESTS where the spec says "canonical table":
 *   - `normalizeFoodpandaHeader(raw)` returns the normalised header TEXT (CRLF to LF, cut at the first newline, cut at the first
 *     "=", trim, drop one trailing "(A)" / "(AH)" letter token, collapse spaces), e.g. "Balance to be paid to Partner".
 *   - `FOODPANDA_COLUMNS` is a plain object whose KEYS are those normalised texts (case is not compared). The values are free.
 * Only the Appendix A headers are asserted to be keys of FOODPANDA_COLUMNS; Appendix B headers are asserted to normalise to themselves.
 */
import { describe, expect, it } from 'vitest';
import { readSheet } from 'read-excel-file/node';
import { add, money, type Money } from '@shareat/core/money';
import { READER_VERSION } from '../../src/settlement-intake';
import { FOODPANDA_COLUMNS, normalizeFoodpandaHeader, readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { openSettlementZip, normalizeXlsx } from '../../src/settlement-intake/safe-zip';
import {
  FP32_HEADERS,
  FP34_HEADERS,
  FPB_HEADERS,
  FP_BANNED_KEYS,
  assertNoLeak,
  day,
  fixture,
  foodpandaSensitive,
  fp32Order,
  fp34Order,
  fpChargeRow,
  fpWorkbook,
  refusalOf,
  spyOnFsWrites,
  xlsxBytes,
  type Cell,
} from './t511-s3-helpers';

/* ---------------------------------------------------------------- header normaliser */

const N34 = [
  'Official Document Number', 'Invoice Number', 'Invoice Date', 'Partner Name', 'Vendor Code', 'Order Code', 'Reversal', 'Order Date',
  'Delivery Mode', 'Customer Refund (Wastage)', 'Gross Food Value / Product Value By Customer', 'Container Charges Paid By Customer',
  'MOV Paid By Customer', 'Partner Delivery Fee Paid By Customer', 'Voucher Paid By Vendor', 'Discount Paid By Vendor',
  'Pandabox Voucher Paid By Vendor', 'Sales Revenue Via foodpanda After Partner Funded Discounts', 'Surcharge Fee', '1/2% Withholding Tax',
  'Waiting Time Fee', 'Cancellation Fee', 'foodpanda Commission Base', 'foodpanda Commission Percentage', 'foodpanda Commission',
  'Pandabox Fee Paid By Vendor', 'Customer Targeting Fee Percentage', 'Customer Targeting Fee Paid By Vendor',
  'Delivery Fee Campaign Paid By Vendor', 'Tax On Partner Charges', 'Expanded Withholding Tax', 'Already Received Amount By Vendor',
  'Cancelled Orders (Wastage)', 'Balance to be paid to Partner',
];
const N32 = N34.filter((_, i) => i !== 18 && i !== 21);

const lower = (s: string): string => s.toLowerCase();
const columnKeys = (): string[] => Object.keys(FOODPANDA_COLUMNS).map(lower);

describe('normalizeFoodpandaHeader', () => {
  it('the hard-coded raw header lists are the real ones (read from the Banay 34-column and Lipa July 32-column workbooks)', async () => {
    const banay = await readSheet((await workbookOf('foodpanda-banay-oct19-34col.zip')), 'Appendix A');
    expect((banay[0] as unknown as string[]).map((h) => h.replace(/\r\n/g, '\n'))).toEqual(FP34_HEADERS);
    const jul = await readSheet((await workbookOf('foodpanda-lipa-jul15-32col.zip')), 'Appendix A');
    expect((jul[0] as unknown as string[]).map((h) => h.replace(/\r\n/g, '\n'))).toEqual(FP32_HEADERS);
    const b = await readSheet((await workbookOf('foodpanda-banay-oct19-34col.zip')), 'Appendix B');
    expect(b[0]).toEqual(FPB_HEADERS);
  });

  it('every one of the 34 real headers normalises to its text and is exactly one key of FOODPANDA_COLUMNS', () => {
    FP34_HEADERS.forEach((raw, i) => {
      const n = normalizeFoodpandaHeader(raw);
      expect(lower(n), raw).toBe(lower(N34[i] as string));
      expect(columnKeys().filter((k) => k === lower(n)), raw).toHaveLength(1);
    });
  });

  it('every one of the 32 real July headers normalises to the same texts (the letters differ, the words do not)', () => {
    FP32_HEADERS.forEach((raw, i) => {
      const n = normalizeFoodpandaHeader(raw);
      expect(lower(n), raw).toBe(lower(N32[i] as string));
      expect(columnKeys().filter((k) => k === lower(n)), raw).toHaveLength(1);
    });
  });

  it('no two headers of either layout collide, and the 32-column texts are a subset of the 34-column texts', () => {
    const n34 = FP34_HEADERS.map((h) => lower(normalizeFoodpandaHeader(h)));
    const n32 = FP32_HEADERS.map((h) => lower(normalizeFoodpandaHeader(h)));
    expect(new Set(n34).size).toBe(34);
    expect(new Set(n32).size).toBe(32);
    for (const n of n32) expect(n34).toContain(n);
    // Surcharge Fee and Cancellation Fee exist only in the 34 layout.
    expect(n34.filter((n) => !n32.includes(n)).sort()).toEqual(['cancellation fee', 'surcharge fee']);
  });

  it('the prefix collisions stay apart: three foodpanda Commission headers, two Customer Targeting Fee headers, and the two Voucher headers', () => {
    const norm = (raw: string): string => lower(normalizeFoodpandaHeader(raw));
    const commissions = ['foodpanda Commission Base (W)', 'foodpanda Commission Percentage (X)', 'foodpanda Commission (Y)'].map(norm);
    expect(new Set(commissions).size).toBe(3);
    expect(norm('foodpanda Commission (Y)')).toBe('foodpanda commission');
    expect(norm('Customer Targeting Fee Percentage (AA)')).not.toBe(norm('Customer Targeting Fee Paid By Vendor (AB)'));
    expect(norm('Voucher Paid By Vendor (O)')).not.toBe(norm('Pandabox Voucher Paid By Vendor (Q)'));
  });

  it('the awkward headers: letter glued on, formula text after "=" with and without a space, newlines (LF and CRLF), (Wastage) survives', () => {
    const cases: [string, string][] = [
      ['Official Document Number(A)', 'Official Document Number'],
      ['Balance to be paid to Partner (AH)= R+S-T-U-V-Y-Z-AB-AC-AD+AE-AF\nWastage - Partial= (K*40%)-T', 'Balance to be paid to Partner'],
      ['Balance to be paid to Partner (AH)= R+S-T-U-V-Y-Z-AB-AC-AD+AE-AF\r\nWastage - Partial= (K*40%)-T', 'Balance to be paid to Partner'],
      ['Balance to be paid to Partner (AF)= R-S-T-W-X-Z-AA-AB+AC-AD\r\nWastage - Partial= (K*40%)-S', 'Balance to be paid to Partner'],
      ['Customer Refund (Wastage)', 'Customer Refund (Wastage)'],
      ['Cancelled Orders (Wastage)\n*Partial=(K*40%)-T\n**Full=R-T-U-Y-Z-AB-AC-AD+AE-AF', 'Cancelled Orders (Wastage)'],
      ['Cancelled Orders (Wastage)\r\n*Partial=(K*40%)-S\r\n**Full=R-S-T-W-X-Z-AA-AB+AC-AD', 'Cancelled Orders (Wastage)'],
      ['Sales Revenue Via foodpanda After Partner Funded Discounts (R) =K+L+M+N-O-P-Q', 'Sales Revenue Via foodpanda After Partner Funded Discounts'],
      ['Tax On Partner Charges (AD) =(U+V+Y+Z+AB+AC)*12%', 'Tax On Partner Charges'],
      ['Expanded Withholding Tax (AE) = (Y+Z+AB)*2%', 'Expanded Withholding Tax'],
      ['Gross Food Value / Product Value By Customer (K)', 'Gross Food Value / Product Value By Customer'],
      ['  Order   Date (H)  ', 'Order Date'],
      ['Order Date(H)', 'Order Date'],
      ['Order Date', 'Order Date'],
      ['Mystery Column (ZZ)', 'Mystery Column'],
    ];
    for (const [raw, want] of cases) expect(lower(normalizeFoodpandaHeader(raw)), JSON.stringify(raw)).toBe(lower(want));
  });

  it('the Appendix B headers are unchanged by normalisation', () => {
    for (const h of FPB_HEADERS) expect(lower(normalizeFoodpandaHeader(h))).toBe(lower(h));
  });

  it('an unknown header normalises but is NOT a key of the table', () => {
    expect(columnKeys()).not.toContain('mystery column');
  });
});

/* ---------------------------------------------------------------- the real invoices */

const wbCache = new Map<string, Promise<Buffer>>();
function workbookOf(zipName: string): Promise<Buffer> {
  const hit = wbCache.get(zipName);
  if (hit) return hit;
  const p: Promise<Buffer> = openSettlementZip(fixture(zipName)).then(async (o: { workbook: Buffer }) => {
    await normalizeXlsx(o.workbook);
    return o.workbook;
  });
  wbCache.set(zipName, p);
  return p;
}

interface Order {
  orderDate: string;
  reversal: boolean;
  deliveryMode: string | null;
  customerRefund: boolean;
  gross: Money;
  vendorVoucher: Money;
  vendorDiscount: Money;
  pandaboxVoucher: Money;
  revenueAfterDiscounts: Money;
  surcharge: Money | null;
  withholdingTax: Money;
  waitingTimeFee: Money;
  cancellationFee: Money | null;
  commission: Money;
  pandaboxFee: Money;
  targetingFee: Money;
  campaignFee: Money;
  taxOnCharges: Money;
  expandedWithholdingTax: Money;
  alreadyReceived: Money;
  cancelledWastage: Money;
  balance: Money;
  revenueIdentityDifference: Money;
  balanceIdentityDifference: Money;
}
interface Charge {
  category: string;
  kind: string;
  date: string | null;
  feeMonthNote: string | null;
  vatRate: unknown;
  netTotal: Money;
  ewt: unknown;
}
interface Invoice {
  invoiceNumber: string;
  invoiceDate: string;
  vendorCode: string;
  partnerName: string | null;
  layout: string | null;
  orders: Order[];
  charges: Charge[];
  readerVersion: string;
}

const ORDER_KEYS = [
  'alreadyReceived', 'balance', 'balanceIdentityDifference', 'campaignFee', 'cancellationFee', 'cancelledWastage', 'commission', 'customerRefund',
  'deliveryMode', 'expandedWithholdingTax', 'gross', 'orderDate', 'pandaboxFee', 'pandaboxVoucher', 'revenueAfterDiscounts',
  'revenueIdentityDifference', 'reversal', 'surcharge', 'targetingFee', 'taxOnCharges', 'vendorDiscount', 'vendorVoucher', 'waitingTimeFee', 'withholdingTax',
];

const INVOICES = [
  { zip: 'foodpanda-banay-oct19-34col.zip', layout: '34', orders: 49, balance: '14512.09', invoice: '200593770746', date: '2026-10-15', vendor: 'MB92', partner: 'SharEat - Banay-Banay', charges: 17, cpc: 16, reversals: 0, refunds: 0, selfpicked: 0 },
  { zip: 'foodpanda-malvar-oct12-34col.zip', layout: '34', orders: 57, balance: '9700.16', invoice: '200820325353', date: '2026-10-07', vendor: 'A08X', partner: 'Shareat - Santiago Malvar', charges: 8, cpc: 7, reversals: 0, refunds: 0, selfpicked: 3 },
  { zip: 'foodpanda-lipa-oct19-34col-feerow.zip', layout: '34', orders: 285, balance: '70018.44', invoice: '200558881808', date: '2026-10-15', vendor: 'O6JZ', partner: 'SharEat Lipa (Samgyupsal Store)- San', charges: 9, cpc: 8, reversals: 1, refunds: 2, selfpicked: 2 },
  { zip: 'foodpanda-lipa-oct5-34col.zip', layout: '34', orders: 336, balance: '85747.71', invoice: '200244406603', date: '2026-09-30', vendor: 'O6JZ', partner: 'SharEat Lipa (Samgyupsal Store)- San', charges: 6, cpc: 5, reversals: 1, refunds: 2, selfpicked: 7 },
  { zip: 'foodpanda-lipa-jul15-32col.zip', layout: '32', orders: 313, balance: '81972.28', invoice: '200745089493', date: '2026-07-15', vendor: 'O6JZ', partner: 'SharEat Lipa (Samgyupsal Store)- San', charges: 9, cpc: 8, reversals: 1, refunds: 1, selfpicked: 4 },
];

async function read(zipName: string): Promise<Invoice> {
  return (await readFoodpandaInvoice(await workbookOf(zipName))) as unknown as Invoice;
}

describe.each(INVOICES)('readFoodpandaInvoice: $zip', (f) => {
  it(`layout ${f.layout}, ${f.orders} orders (the SUBTOTAL row is not one of them), balance sums to ${f.balance}`, async () => {
    const inv = await read(f.zip);
    expect(inv.layout).toBe(f.layout);
    expect(inv.orders).toHaveLength(f.orders);
    expect(add(...inv.orders.map((o) => o.balance))).toBe(money(f.balance));
    expect(inv.readerVersion).toBe(READER_VERSION);
  });

  it('invoice fields: number, period-end date, vendor code (any case), partner name; the keys are exactly the spec ones', async () => {
    const inv = await read(f.zip);
    expect(inv.invoiceNumber).toBe(f.invoice);
    expect(inv.invoiceDate).toBe(f.date);
    expect(inv.vendorCode.toLowerCase()).toBe(f.vendor.toLowerCase());
    expect(inv.partnerName).toBe(f.partner);
    expect(Object.keys(JSON.parse(JSON.stringify(inv))).sort()).toEqual(['charges', 'invoiceDate', 'invoiceNumber', 'layout', 'orders', 'partnerName', 'readerVersion', 'vendorCode']);
  });

  it('every order row: exactly the 24 spec keys, ISO date, and both identity differences are 0.00', async () => {
    const inv = await read(f.zip);
    for (const o of inv.orders) {
      expect(Object.keys(JSON.parse(JSON.stringify(o))).sort()).toEqual(ORDER_KEYS);
      expect(o.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.revenueIdentityDifference).toBe('0.00');
      expect(o.balanceIdentityDifference).toBe('0.00');
    }
  });

  it('flags: reversals, customer refunds and self-pickups are counted as in the file', async () => {
    const inv = await read(f.zip);
    expect(inv.orders.filter((o) => o.reversal)).toHaveLength(f.reversals);
    expect(inv.orders.filter((o) => o.customerRefund)).toHaveLength(f.refunds);
    expect(inv.orders.filter((o) => o.deliveryMode === 'SELFPICKED')).toHaveLength(f.selfpicked);
  });

  it(`${f.charges} charges: ${f.cpc} CPC ads with an ISO date and one Platform Fee of 223.21 with its month note`, async () => {
    const inv = await read(f.zip);
    expect(inv.charges).toHaveLength(f.charges);
    const cpc = inv.charges.filter((c) => c.kind === 'cpc_ad');
    expect(cpc).toHaveLength(f.cpc);
    for (const c of cpc) {
      expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.category).toBe('Organic Placement (CPC)');
    }
    const fee = inv.charges.filter((c) => c.kind === 'platform_fee');
    expect(fee).toHaveLength(1);
    expect(fee[0]?.netTotal).toBe('223.21');
    expect(fee[0]?.category).toBe('Platform Fee');
    expect(fee[0]?.feeMonthNote).toMatch(/(January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d/);
    expect(fee[0]?.date ?? null).toBeNull();
    for (const c of cpc) expect(c.feeMonthNote ?? null).toBeNull();
  });

  it('no Order Code, official document number or customer field is anywhere in the output', async () => {
    const wb = await workbookOf(f.zip);
    const sensitive = await foodpandaSensitive(wb);
    expect(sensitive.size).toBeGreaterThan(f.orders - f.reversals);
    expect(assertNoLeak(await read(f.zip), sensitive, FP_BANNED_KEYS)).toEqual([]);
  });
});

describe('readFoodpandaInvoice: anchors on known rows (these make the other checks non-circular)', () => {
  it('Banay first order: every column by header text', async () => {
    const o = (await read('foodpanda-banay-oct19-34col.zip')).orders[0] as Order;
    expect(o).toMatchObject({
      orderDate: '2026-10-10', reversal: false, deliveryMode: 'FOODPANDA', customerRefund: false, gross: '234.00', vendorVoucher: '0.00',
      vendorDiscount: '0.00', pandaboxVoucher: '0.00', revenueAfterDiscounts: '234.00', surcharge: '0.00', withholdingTax: '1.17',
      waitingTimeFee: '0.00', cancellationFee: '0.00', commission: '52.23', pandaboxFee: '0.00', targetingFee: '0.00', campaignFee: '0.00',
      taxOnCharges: '6.27', expandedWithholdingTax: '0.00', alreadyReceived: '0.00', cancelledWastage: '0.00', balance: '174.33',
    });
  });

  it('July (32 columns) first order: the letters moved, the words did not; surcharge and cancellation fee are null', async () => {
    const o = (await read('foodpanda-lipa-jul15-32col.zip')).orders[0] as Order;
    expect(o).toMatchObject({ orderDate: '2026-07-01', gross: '539.00', withholdingTax: '2.41', waitingTimeFee: '0.00', commission: '120.30', taxOnCharges: '14.44', balance: '401.85' });
    expect(o.surcharge).toBeNull();
    expect(o.cancellationFee).toBeNull();
    const inv = await read('foodpanda-lipa-jul15-32col.zip');
    expect(inv.orders.every((x) => x.surcharge === null && x.cancellationFee === null)).toBe(true);
  });

  it('a 34-column file never has null surcharge or cancellation fee', async () => {
    const inv = await read('foodpanda-lipa-oct19-34col-feerow.zip');
    expect(inv.orders.every((x) => x.surcharge !== null && x.cancellationFee !== null)).toBe(true);
  });

  it('a reversal row is negative; a customer-refund row has wastage equal to its balance', async () => {
    const inv = await read('foodpanda-lipa-oct5-34col.zip');
    const rev = inv.orders.find((o) => o.reversal) as Order;
    expect(rev).toMatchObject({ orderDate: '2026-09-21', gross: '-150.00', balance: '-111.83' });
    const refunds = inv.orders.filter((o) => o.customerRefund);
    expect(refunds).toHaveLength(2);
    const r = refunds.find((o) => o.orderDate === '2026-09-25') as Order;
    expect(r).toMatchObject({ balance: '359.36', cancelledWastage: '359.36' });
  });

  it('a fee-only row (no delivery mode, cancellation fee 50.00) is kept: deliveryMode null, balance -56.00', async () => {
    const o = (await read('foodpanda-malvar-oct12-34col.zip')).orders.find((x) => x.deliveryMode === null) as Order;
    expect(o).toMatchObject({ orderDate: '2026-10-04', gross: '0.00', cancellationFee: '50.00', balance: '-56.00', commission: '0.00' });
  });

  it('the Appendix-B-only invoice reads with no orders and 3 PandaGO charges (date from month-first M.DD.YYYY)', async () => {
    const inv = await read('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip');
    expect(inv.orders).toEqual([]);
    expect(inv.charges).toHaveLength(3);
    expect(inv.charges.every((c) => c.kind === 'pandago')).toBe(true);
    expect(inv.charges.map((c) => c.category).sort()).toEqual(['1/2% Withholding Tax', 'Delivery Service Fees', 'Pandago COD']);
    expect(inv.charges.every((c) => c.date === '2026-09-24')).toBe(true);
    expect(add(...inv.charges.map((c) => c.netTotal))).toBe('-385.03');
    expect(inv.charges.find((c) => c.category === 'Pandago COD')?.netTotal).toBe('-476.00');
    expect(inv.invoiceNumber).toBe('200199709701');
    expect(inv.invoiceDate).toBe('2026-10-02');
    expect(inv.vendorCode.toLowerCase()).toBe('o6jz');
    expect(assertNoLeak(inv, await foodpandaSensitive(await workbookOf('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip')), FP_BANNED_KEYS)).toEqual([]);
  });

  it('the inline-strings variant (another generator) reads the same as the Malvar workbook it was made from', async () => {
    const wb = fixture('variant-xlsx-openpyxl-inline-strings.xlsx');
    await normalizeXlsx(wb);
    const inv = (await readFoodpandaInvoice(wb)) as unknown as Invoice;
    expect(inv.layout).toBe('34');
    expect(inv.orders).toHaveLength(57);
    expect(add(...inv.orders.map((o) => o.balance))).toBe('9700.16');
    expect(inv.charges).toHaveLength(8);
  });

  it('reading writes nothing to disk', async () => {
    const wb = await workbookOf('foodpanda-banay-oct19-34col.zip');
    const spies = spyOnFsWrites();
    await readFoodpandaInvoice(wb);
    expect(spies.calls()).toEqual([]);
  });
});

/* ---------------------------------------------------------------- hostile and generated workbooks */

describe('readFoodpandaInvoice: refusals', () => {
  it('the extra column fixture is FOODPANDA_UNKNOWN_COLUMN naming Mystery Column', async () => {
    const r = await refusalOf(() => readFoodpandaInvoice(fixture('hostile-xlsx-unknown-extra-column.xlsx')));
    expect(r.code).toBe('FOODPANDA_UNKNOWN_COLUMN');
    expect(r.userMessage).toContain('Mystery Column');
  });

  it('the missing Order Date fixture is FOODPANDA_MISSING_COLUMN naming Order Date', async () => {
    const r = await refusalOf(() => readFoodpandaInvoice(fixture('hostile-xlsx-missing-order-date.xlsx')));
    expect(r.code).toBe('FOODPANDA_MISSING_COLUMN');
    expect(r.userMessage).toContain('Order Date');
  });

  it('an empty file is FILE_EMPTY', async () => {
    expect((await refusalOf(() => readFoodpandaInvoice(fixture('hostile-empty.xlsx')))).code).toBe('FILE_EMPTY');
  });

  it('a workbook with neither Appendix A nor Appendix B is FOODPANDA_NO_SHEETS', async () => {
    const wb = fpWorkbook({ sheetNames: ['Sheet1', 'Sheet2'] });
    expect((await refusalOf(() => readFoodpandaInvoice(wb))).code).toBe('FOODPANDA_NO_SHEETS');
  });

  it('a required header missing (Balance to be paid to Partner) is FOODPANDA_MISSING_COLUMN naming it, wherever the column sits', async () => {
    const at = FP34_HEADERS.length - 1;
    const headers = FP34_HEADERS.filter((_, i) => i !== at);
    const rows = [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb')].map((r) => r.filter((_, i) => i !== at));
    const r = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ headers, orderRows: rows })));
    expect(r.code).toBe('FOODPANDA_MISSING_COLUMN');
    expect(r.userMessage).toContain('Balance to be paid');
  });

  it('a header with unknown words in the middle of the sheet is FOODPANDA_UNKNOWN_COLUMN naming it', async () => {
    const headers = [...FP34_HEADERS.slice(0, 10), 'Surprise Levy (QQ)', ...FP34_HEADERS.slice(10)];
    const rows = [fp34Order('zz99-0001-aa')].map((r) => [...r.slice(0, 10), 0, ...r.slice(10)]);
    const r = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ headers, orderRows: rows })));
    expect(r.code).toBe('FOODPANDA_UNKNOWN_COLUMN');
    expect(r.userMessage).toContain('Surprise Levy');
  });

  it.each([
    ['Surcharge Fee present, Cancellation Fee missing', 21],
    ['Cancellation Fee present, Surcharge Fee missing', 18],
  ])('a mixed layout (%s) is FOODPANDA_UNKNOWN_LAYOUT', async (_label, drop) => {
    const headers = FP34_HEADERS.filter((_, i) => i !== drop);
    const rows = [fp34Order('zz99-0001-aa')].map((r) => r.filter((_, i) => i !== drop));
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ headers, orderRows: rows })))).code).toBe('FOODPANDA_UNKNOWN_LAYOUT');
  });

  it('two invoice numbers in one sheet is FOODPANDA_MIXED_INVOICE', async () => {
    const rows = [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb', {}, '200999999998')];
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ orderRows: rows })))).code).toBe('FOODPANDA_MIXED_INVOICE');
  });

  it('two vendor codes is FOODPANDA_MIXED_INVOICE, in Appendix A or between A and B; a case difference alone is fine', async () => {
    const inA = [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb', {}, '200999999999', 'ZZ98')];
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ orderRows: inA })))).code).toBe('FOODPANDA_MIXED_INVOICE');
    const inB = fpWorkbook({ chargeRows: [fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz98', 223.21, '12%', 'zz98')] });
    expect((await refusalOf(() => readFoodpandaInvoice(inB))).code).toBe('FOODPANDA_MIXED_INVOICE');
    const sameCase = [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb', {}, '200999999999', 'zz99')];
    const inv = (await readFoodpandaInvoice(fpWorkbook({ orderRows: sameCase }))) as unknown as Invoice;
    expect(inv.orders).toHaveLength(2);
  });

  it('a float that is not exact to two decimals (10.005) is FOODPANDA_BAD_VALUE naming the value or the column', async () => {
    const rows = [fp34Order('zz99-0001-aa', { 10: 10.005 })];
    const r = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ orderRows: rows })));
    expect(r.code).toBe('FOODPANDA_BAD_VALUE');
    expect(r.userMessage).toMatch(/10\.005|Gross Food Value/);
  });

  it('text in a money column is FOODPANDA_BAD_VALUE', async () => {
    const rows = [fp34Order('zz99-0001-aa', { 24: 'twenty' })];
    const r = await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ orderRows: rows })));
    expect(r.code).toBe('FOODPANDA_BAD_VALUE');
    expect(r.userMessage).toMatch(/twenty|Commission/i);
  });

  it('more than 200 charge rows is FOODPANDA_TOO_MANY_ROWS (200 are accepted)', async () => {
    const mk = (n: number): Cell[][] => Array.from({ length: n }, (_, i) => fpChargeRow('Organic Placement (CPC)', `Organic Placement (CPC)  2026-10-08  : ZZ99 ${i}`, 1.5));
    const ok = (await readFoodpandaInvoice(fpWorkbook({ chargeRows: mk(200) }))) as unknown as Invoice;
    expect(ok.charges).toHaveLength(200);
    expect((await refusalOf(() => readFoodpandaInvoice(fpWorkbook({ chargeRows: mk(201) })))).code).toBe('FOODPANDA_TOO_MANY_ROWS');
  });

  it('more than 5,000 order rows is FOODPANDA_TOO_MANY_ROWS', { timeout: 120_000 }, async () => {
    const wb = fpWorkbook({ orders: 5001 });
    expect((await refusalOf(() => readFoodpandaInvoice(wb))).code).toBe('FOODPANDA_TOO_MANY_ROWS');
  });
});

describe('readFoodpandaInvoice: generated invoices (the generator itself is proven by the baseline)', () => {
  it('baseline 34 layout: 3 orders of 74.50, identities 0.00, one CPC ad and the Platform Fee', async () => {
    const wb = fpWorkbook();
    await normalizeXlsx(wb);
    const inv = (await readFoodpandaInvoice(wb)) as unknown as Invoice;
    expect(inv.layout).toBe('34');
    expect(inv.invoiceNumber).toBe('200999999999');
    expect(inv.invoiceDate).toBe('2026-10-15');
    expect(inv.orders).toHaveLength(3);
    expect(add(...inv.orders.map((o) => o.balance))).toBe('223.50');
    expect(inv.orders.every((o) => o.orderDate === '2026-10-10' && o.balanceIdentityDifference === '0.00' && o.revenueIdentityDifference === '0.00')).toBe(true);
    expect(inv.charges.map((c) => c.kind)).toEqual(['cpc_ad', 'platform_fee']);
    expect(inv.charges[0]?.date).toBe('2026-10-08');
    expect(inv.charges[1]?.feeMonthNote).toContain('September 2026');
  });

  it('baseline 32 layout reads the same figures through the same names', async () => {
    const inv = (await readFoodpandaInvoice(fpWorkbook({ layout: '32' }))) as unknown as Invoice;
    expect(inv.layout).toBe('32');
    expect(add(...inv.orders.map((o) => o.balance))).toBe('223.50');
    expect(inv.orders[0]).toMatchObject({ withholdingTax: '0.50', commission: '22.32', taxOnCharges: '2.68', surcharge: null, cancellationFee: null });
  });

  it('a row that breaks the identities is RETURNED with the difference, not refused (the stage decides)', async () => {
    const rows = [fp34Order('zz99-0001-aa', { 33: 74.51 }), fp34Order('zz99-0002-bb', { 17: 101 })];
    const inv = (await readFoodpandaInvoice(fpWorkbook({ orderRows: rows }))) as unknown as Invoice;
    // CHOICE: the sign of a difference is not pinned by the spec; its size is.
    expect(['0.01', '-0.01']).toContain(inv.orders[0]?.balanceIdentityDifference);
    expect(inv.orders[0]?.revenueIdentityDifference).toBe('0.00');
    expect(['1.00', '-1.00']).toContain(inv.orders[1]?.revenueIdentityDifference);
  });

  it('a row with no Order Code and no amounts (the uncached total row) is skipped (a row WITH amounts is refused: t511-s3-audit-fixes)', async () => {
    const total: Cell[] = fp34Order('zz99-0001-aa').map((_v, i) => (i === 0 ? 'Total' : null));
    const rows = [fp34Order('zz99-0001-aa'), fp34Order('zz99-0002-bb'), total];
    const inv = (await readFoodpandaInvoice(fpWorkbook({ orderRows: rows }))) as unknown as Invoice;
    expect(inv.orders).toHaveLength(2);
  });

  it('the percent columns are text and are ignored, whatever they hold', async () => {
    const rows = [fp34Order('zz99-0001-aa', { 23: 'n/a', 26: '' })];
    const inv = (await readFoodpandaInvoice(fpWorkbook({ orderRows: rows }))) as unknown as Invoice;
    expect(inv.orders).toHaveLength(1);
  });

  it('Appendix B kinds: a PandaGO description gives its month-first date, an unrecognised category is kind other', async () => {
    const charges = [
      fpChargeRow('Delivery Service Fees', 'PandaGO Order-1.05.2026-zz99-abc123', 50),
      fpChargeRow('Pandago COD', 'PandaGO Order-12.31.2026-zz99-abc124', -20, '0%'),
      fpChargeRow('Mystery Fee', 'Something we have never seen', 5),
    ];
    const inv = (await readFoodpandaInvoice(fpWorkbook({ chargeRows: charges }))) as unknown as Invoice;
    expect(inv.charges.map((c) => c.kind)).toEqual(['pandago', 'pandago', 'other']);
    expect(inv.charges.map((c) => c.date ?? null)).toEqual(['2026-01-05', '2026-12-31', null]);
    expect(inv.charges.map((c) => c.netTotal)).toEqual(['50.00', '-20.00', '5.00']);
  });

  it('a B-only workbook built here (no Appendix A sheet at all) has no orders and takes its invoice fields from Appendix B', async () => {
    const wb = xlsxBytes([{ name: 'Appendix B', rows: [FPB_HEADERS, fpChargeRow('Platform Fee', 'PF for the month of June 2026 (W2):zz99', 223.21)] }]);
    const inv = (await readFoodpandaInvoice(wb)) as unknown as Invoice;
    expect(inv.orders).toEqual([]);
    expect(inv.charges).toHaveLength(1);
    expect(inv.invoiceNumber).toBe('200999999999');
    expect(inv.invoiceDate).toBe('2026-10-19');
    expect(inv.vendorCode.toLowerCase()).toBe('zz99');
  });

  it('an order date comes out as the printed UTC date (no timezone shift): 1 Jan and 31 Dec', async () => {
    const rows = [fp34Order('zz99-0001-aa', { 7: day('2026-01-01') }), fp34Order('zz99-0002-bb', { 7: day('2026-12-31') })];
    const inv = (await readFoodpandaInvoice(fpWorkbook({ orderRows: rows }))) as unknown as Invoice;
    expect(inv.orders.map((o) => o.orderDate)).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('32-layout rows made by fp32Order read the same as the 34 layout minus the two columns', async () => {
    const a = (await readFoodpandaInvoice(fpWorkbook({ layout: '32', orderRows: [fp32Order('zz99-0001-aa', { 24: 30.5, 33: 66.32 })] }))) as unknown as Invoice;
    expect(a.orders[0]?.commission).toBe('30.50');
    expect(a.orders[0]?.balance).toBe('66.32');
  });
});
