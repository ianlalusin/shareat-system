/**
 * T-511 S8b (BUILDER) - the world the earlier-invoice tests run in (NOT a test file). It builds on the S7a world (Lipa with its real Foodpanda code O6JZ, a destination
 * account, Oct and Nov 2026 open, managers, sales days verified through the real domain) and adds the files of the REAL "lipa nov 11" zip, in miniature:
 *  - a charge-only invoice (Appendix B alone, one row with its OFFICIAL document number), like 299999000001 / 299999000002 / 299999000003,
 *  - a weekly statement with order rows whose identities hold, Appendix B charges that carry the weekly's own document number, and an Appendix C of earlier items.
 * Bytes only; staging goes through the real `ingestSettlementFile`.
 */
import type postgres from 'postgres';
import { zipBytes, xlsxBytes, fpWorkbook, FPB_HEADERS, FPC_HEADERS, day as isoDay, fp34Order, fpChargeRow, type Cell } from '../../unit/t511-s3-helpers';
import { LIPA_FP } from './t511-s5-world';

export * from './t511-s7a-world';

/** The official document numbers printed on the three small invoices of the real file (the original, its reversal and the re-bill), each 89.29 + 12% VAT = 100.00. */
export const TEST_DOCS = { original: '2999999900000001', reversal: '3999999900000002', rebill: '2999999900000003' } as const;
/** The invoice numbers of the same three. */
export const TEST_INVOICES = { original: '299999000001', reversal: '299999000002', rebill: '299999000003' } as const;

let seq = 0;
export const stamp = (p: string): string => `${p}-${Date.now()}-${++seq}`;

export interface SmallInvoice {
  invoice: string;
  doc: string;
  /** the printed Net Total: 89.29 or -89.29 */
  net: number;
  /** default: a description no PandaGO rule matches, so the staged line is a bookable `period_charge`. The real originals read "PandaGO Order-10.31.2026-...", a `pandago` line. */
  description?: string;
  category?: string;
  /** the Invoice Date (default 2026-11-04) */
  date?: string;
  /** makes the bytes (and so the fingerprint) unique without changing what the workbook says */
  pdfTag?: string;
  /** the vendor code printed (default Lipa's O6JZ) */
  vendor?: string;
  /** how many IDENTICAL rows the Appendix B prints (default 1): two real same-day, same-net fees look exactly alike */
  copies?: number;
  /** more rows of the SAME document with other figures (a document that prints several rows) */
  also?: { net: number; description: string }[];
}

/** A charge-only invoice zip (workbook with Appendix B alone + a stub PDF) for Lipa's real vendor code. */
export function smallInvoice(o: SmallInvoice): Buffer {
  const row: Cell[] = [
    o.doc, o.invoice, isoDay(o.date ?? '2026-11-04'), o.category ?? 'Delivery Service Fees', o.description ?? 'Courier fee 10.31.2026', o.vendor ?? LIPA_FP, '12%', 1, o.net, o.net, 0,
  ];
  const more: Cell[][] = (o.also ?? []).map((a) => [o.doc, o.invoice, isoDay(o.date ?? '2026-11-04'), o.category ?? 'Delivery Service Fees', a.description, o.vendor ?? LIPA_FP, '12%', 1, a.net, a.net, 0]);
  const workbook = xlsxBytes([{ name: 'Appendix B', rows: [FPB_HEADERS, ...Array.from({ length: o.copies ?? 1 }, () => row), ...more] }]);
  return zipBytes([
    { name: `20261031_${o.invoice}.xls`, data: workbook },
    { name: `20261031_${o.invoice}.pdf`, data: Buffer.from(`%PDF-1.4 stub ${o.pdfTag ?? o.invoice}`) },
  ]);
}

/** A cents integer as the two-decimal number a cell holds. */
export const cell = (cents: bigint | number): number => Number(cents) / 100;

export interface WeeklyOrder {
  date: string;
  /** column K and R, the revenue after discounts, in centavos */
  revenue: bigint;
  /** column Y, in centavos; default 20% of the revenue */
  commission?: bigint;
  /** column AD, in centavos; default 12% of the commission (a test that needs an exact balance sets both) */
  tax?: bigint;
}

/**
 * One order row whose identities hold (R = K; balance = R - withholding - commission - tax on charges): withholding is 0.5% of R rounded half up, the tax on charges 12% of the
 * commission rounded half up (the system never reads that column as a figure of its own; only the identity matters, so the day explains its whole payout).
 */
export function weeklyOrderRow(code: string, o: WeeklyOrder, invoice: string, doc: string): { row: Cell[]; balance: bigint; withholding: bigint } {
  const half = (n: bigint, num: bigint, den: bigint): bigint => (2n * n * num + den) / (2n * den);
  const withholding = half(o.revenue, 5n, 1000n);
  const commission = o.commission ?? half(o.revenue, 20n, 100n);
  const tax = o.tax ?? half(commission, 12n, 100n);
  const balance = o.revenue - withholding - commission - tax;
  const row = fp34Order(
    code,
    { 0: doc, 7: isoDay(o.date), 10: cell(o.revenue), 17: cell(o.revenue), 19: cell(withholding), 22: cell(o.revenue), 24: cell(commission), 29: cell(tax), 33: cell(balance) },
    invoice,
    LIPA_FP,
  );
  return { row, balance, withholding };
}

export interface Weekly {
  invoice: string;
  /** the weekly's own document number, printed on every Appendix B row (as the real file does) */
  doc?: string;
  orders: WeeklyOrder[];
  /** CPC ads: dated inside their description, so each lands on the sales day of that date */
  ads?: { date: string; net: number }[];
  /** the weekly platform fee, placed on the last day that can pay it */
  fee?: number;
  /** Appendix B rows of any other category (a period charge of the weekly itself) */
  other?: { category: string; description: string; net: number }[];
  /** Appendix C rows: use `fpPriorRow` */
  prior?: Cell[][];
  tag?: string;
}

/** A weekly statement zip for Lipa's real vendor code. Returns the zip and the sum of the order balances in centavos. */
export function weekly(o: Weekly): { zip: Buffer; balance: bigint; withholding: bigint } {
  const doc = o.doc ?? '2999999900000009';
  const t = o.tag ?? stamp('wk');
  let balance = 0n;
  let withholding = 0n;
  const orderRows = o.orders.map((ord, i) => {
    const built = weeklyOrderRow(`${LIPA_FP.toLowerCase()}-${String(i).padStart(4, '0')}-${t}`, ord, o.invoice, doc);
    balance += built.balance;
    withholding += built.withholding;
    return built.row;
  });
  const vendor = LIPA_FP.toLowerCase();
  const charges: Cell[][] = [
    ...(o.ads ?? []).map((a) => fpChargeRow('Organic Placement (CPC)', `Organic Placement (CPC)  ${a.date}  : O6JZ`, a.net, '12%', vendor, doc, o.invoice)),
    ...(o.fee === undefined ? [] : [fpChargeRow('Platform Fee', 'PF for the month of October 2026 (W1):o6jz', o.fee, '12%', vendor, doc, o.invoice)]),
    ...(o.other ?? []).map((x) => fpChargeRow(x.category, x.description, x.net, '12%', vendor, doc, o.invoice)),
  ];
  const book = fpWorkbook({ orderRows, chargeRows: charges, ...(o.prior ? { priorRows: o.prior } : {}) });
  return {
    zip: zipBytes([
      { name: `20261107_${o.invoice}.xls`, data: book },
      { name: `20261107_${o.invoice}.pdf`, data: Buffer.from(`%PDF-1.4 stub ${t}`) },
    ]),
    balance,
    withholding,
  };
}

/** The staged charge line of a document number (the latest one), by raw read. */
export const lineOfDoc = async (sql: postgres.Sql, orgId: string, doc: string, uploadId?: string): Promise<string> =>
  (
    await sql<{ id: string }[]>`
      select ol.id::text as id from settlement_other_lines ol
       where ol.org_id = ${orgId} and ol.official_document = ${doc} ${uploadId ? sql`and ol.upload_id = ${uploadId}` : sql``} order by ol.id desc limit 1`
  )[0]!.id;

export const zipFile = (b: Buffer): { bytes: Buffer; contentType: string } => ({ bytes: b, contentType: 'application/zip' });
export { FPC_HEADERS };
