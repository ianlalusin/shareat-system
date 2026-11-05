/**
 * T-511 S3 - shared test helpers for the settlement file readers (NOT a test file: vitest only collects *.test.ts).
 *
 * Everything here is TEST-SIDE and independent of the production readers: a tiny zip writer (node:zlib), a tiny OOXML
 * writer (inline strings, no shared strings), CSV edit helpers over `@shareat/core/csv`, and the "leak" scanners that prove
 * no order id, transaction id, bank value or customer field reaches a reader's output.
 */
import fs, { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { parseCsv } from '@shareat/core/csv';
import { readSheet } from 'read-excel-file/node';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';

export const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'settlement-intake');

/** A fresh Buffer of one fixture file (a copy each time, so no test can poison another). */
export function fixture(name: string): Buffer {
  return Buffer.from(readFileSync(join(FIXTURE_DIR, name)));
}

/** Runs `run` (sync throw or async rejection) and returns the SettlementIntakeRefusal it raised; fails if it did not refuse. */
export async function refusalOf(run: () => unknown): Promise<SettlementIntakeRefusal> {
  try {
    await run();
  } catch (e) {
    if (e instanceof SettlementIntakeRefusal) return e;
    throw e;
  }
  throw new Error('expected a SettlementIntakeRefusal but the call returned normally');
}

export const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** True when `text` names `n` as a whole number (a line number in a sentence). */
export function mentionsNumber(text: string, n: number): boolean {
  return new RegExp(`(^|\\D)${n}(\\D|$)`).test(text);
}

/* ------------------------------------------------------------------ zip writer */

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** default 'deflate'; 'store' keeps the bytes as they are (incompressible size tests). */
  method?: 'deflate' | 'store';
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A well-formed zip with TRUTHFUL headers (declared sizes equal real sizes). */
export function zipBytes(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.method === 'store' ? 0 : 8;
    const body = method === 0 ? e.data : deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12); // 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, name, body]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** `n` small honest entries named `${prefix}0.${ext}` ... */
export function manyEntries(n: number, ext: string, prefix = 'f'): ZipEntry[] {
  return Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}.${ext}`, data: Buffer.from(`entry ${i}`) }));
}

export const SIX_MB_OF_ZEROS = (): Buffer => Buffer.alloc(6 * 1024 * 1024);

/* ------------------------------------------------------------------ xlsx writer */

export type Cell = string | number | Date | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const excelSerial = (d: Date): number => (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86_400_000;

const COLS: string[] = Array.from({ length: 64 }, (_, i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26))));

/** Cell references are required by read-excel-file; a null cell is simply left out. */
function sheetXml(rows: Cell[][]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  rows.forEach((row, r) => {
    const n = r + 1;
    out.push(`<row r="${n}">`);
    row.forEach((v, c) => {
      if (v === null) return;
      const ref = `${COLS[c]}${n}`;
      if (typeof v === 'number') out.push(`<c r="${ref}"><v>${v}</v></c>`);
      else if (v instanceof Date) out.push(`<c r="${ref}" s="1"><v>${excelSerial(v)}</v></c>`);
      else out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`);
    });
    out.push('</row>');
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

/** A minimal valid .xlsx (inline strings; dates are style 1 = built-in numFmt 14, the same `mm-dd-yy` the real files carry). */
export function xlsxBytes(sheets: Sheet[]): Buffer {
  const ct =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('') +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const wb =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';
  return zipBytes([
    { name: '[Content_Types].xml', data: Buffer.from(ct) },
    { name: '_rels/.rels', data: Buffer.from(rels) },
    { name: 'xl/workbook.xml', data: Buffer.from(wb) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRels) },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows)) })),
  ]);
}

/* ------------------------------------------------------------------ Foodpanda workbook builders */

/** The 34 real Appendix A headers (the two long ones carry LF; read-excel-file hands back CRLF, both are tested elsewhere). */
export const FP34_HEADERS: string[] = [
  'Official Document Number(A)',
  'Invoice Number (B)',
  'Invoice Date (C)',
  'Partner Name (D)',
  'Vendor Code (E)',
  'Order Code (F)',
  'Reversal (G)',
  'Order Date (H)',
  'Delivery Mode (I)',
  'Customer Refund (Wastage)',
  'Gross Food Value / Product Value By Customer (K)',
  'Container Charges Paid By Customer (L)',
  'MOV Paid By Customer (M)',
  'Partner Delivery Fee Paid By Customer (N)',
  'Voucher Paid By Vendor (O)',
  'Discount Paid By Vendor (P)',
  'Pandabox Voucher Paid By Vendor (Q)',
  'Sales Revenue Via foodpanda After Partner Funded Discounts (R) =K+L+M+N-O-P-Q',
  'Surcharge Fee (S)',
  '1/2% Withholding Tax (T)',
  'Waiting Time Fee (U)',
  'Cancellation Fee (V)',
  'foodpanda Commission Base (W)',
  'foodpanda Commission Percentage (X)',
  'foodpanda Commission (Y)',
  'Pandabox Fee Paid By Vendor (Z)',
  'Customer Targeting Fee Percentage (AA)',
  'Customer Targeting Fee Paid By Vendor (AB)',
  'Delivery Fee Campaign Paid By Vendor (AC)',
  'Tax On Partner Charges (AD) =(U+V+Y+Z+AB+AC)*12%',
  'Expanded Withholding Tax (AE) = (Y+Z+AB)*2%',
  'Already Received Amount By Vendor (AF)',
  'Cancelled Orders (Wastage)\n*Partial=(K*40%)-T\n**Full=R-T-U-Y-Z-AB-AC-AD+AE-AF',
  'Balance to be paid to Partner (AH)= R+S-T-U-V-Y-Z-AB-AC-AD+AE-AF\nWastage - Partial= (K*40%)-T',
];

/** The 32 real headers of the July 15 file: no Surcharge Fee, no Cancellation Fee, every letter after R shifted. */
export const FP32_HEADERS: string[] = [
  ...FP34_HEADERS.slice(0, 18),
  '1/2% Withholding Tax (S)',
  'Waiting Time Fee (T)',
  'foodpanda Commission Base (U)',
  'foodpanda Commission Percentage (V)',
  'foodpanda Commission (W)',
  'Pandabox Fee Paid By Vendor (X)',
  'Customer Targeting Fee Percentage (Y)',
  'Customer Targeting Fee Paid By Vendor (Z)',
  'Delivery Fee Campaign Paid By Vendor (AA)',
  'Tax On Partner Charges (AB) =(T+W+X+Z+AA)*12%',
  'Expanded Withholding Tax (AC) = (W+X+Z)*2%',
  'Already Received Amount By Vendor (AD)',
  'Cancelled Orders (Wastage)\n*Partial=(K*40%)-S\n**Full=R-S-T-W-X-Z-AA-AB+AC-AD',
  'Balance to be paid to Partner (AF)= R-S-T-W-X-Z-AA-AB+AC-AD\nWastage - Partial= (K*40%)-S',
];

export const FPB_HEADERS: string[] = [
  'Official Document Number',
  'Invoice Number',
  'Invoice Date',
  'Category',
  'Description',
  'Vendor Code',
  'Subject to VAT rate',
  'Quantity',
  'Unit Price',
  'Net Total',
  'EWT',
];

export const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/**
 * One order row of the 34 layout whose identities hold (R = K+L+M+N-O-P-Q; balance = R+S-T-U-V-Y-Z-AB-AC-AD+AE-AF):
 * 100.00 gross, 0.50 withholding tax, 22.32 commission, 2.68 tax on charges -> balance 74.50.
 */
export function fp34Order(code: string, over: Record<number, Cell> = {}, invoice = '200999999999', vendor = 'ZZ99'): Cell[] {
  const row: Cell[] = [
    '2000000009999999', invoice, day('2026-10-15'), 'SharEat - Test Store', vendor, code, null, day('2026-10-10'), 'FOODPANDA', 'N',
    100, 0, 0, 0, 0, 0, 0, 100,
    0, 0.5, 0, 0, 100, '22.32', 22.32, 0, '15.0', 0, 0, 2.68, 0, 0, 0, 74.5,
  ];
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v;
  return row;
}

/** The same row in the 32 layout (drops Surcharge Fee at 18 and Cancellation Fee at 21). */
export function fp32Order(code: string, over34: Record<number, Cell> = {}): Cell[] {
  return fp34Order(code, over34).filter((_, i) => i !== 18 && i !== 21);
}

export interface FpBuild {
  layout?: '34' | '32';
  orders?: number;
  /** replaces the default order rows entirely (header NOT included) */
  orderRows?: Cell[][];
  /** replaces the header row */
  headers?: string[];
  /** Appendix B rows (header NOT included) */
  chargeRows?: Cell[][];
  sheetNames?: [string, string];
}

export function fpChargeRow(category: string, description: string, net: number, vat = '12%', vendor = 'zz99'): Cell[] {
  return ['2000000009999999', '200999999999', day('2026-10-19'), category, description, vendor, vat, 1, net, net, 0];
}

/** A baseline valid Foodpanda invoice workbook (default: 3 orders of balance 74.50 each, plus 1 CPC item and the Platform Fee). */
export function fpWorkbook(b: FpBuild = {}): Buffer {
  const layout = b.layout ?? '34';
  const headers = b.headers ?? (layout === '34' ? FP34_HEADERS : FP32_HEADERS);
  const mk = layout === '34' ? fp34Order : fp32Order;
  const orders = b.orderRows ?? Array.from({ length: b.orders ?? 3 }, (_, i) => mk(`zz99-${String(i).padStart(4, '0')}-ab${i}`));
  const charges =
    b.chargeRows ??
    [
      fpChargeRow('Organic Placement (CPC)', 'Organic Placement (CPC)  2026-10-08  : ZZ99', 10),
      fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz99', 223.21),
    ];
  const names = b.sheetNames ?? ['Appendix A', 'Appendix B'];
  return xlsxBytes([
    { name: names[0], rows: [headers, ...orders] },
    { name: names[1], rows: [FPB_HEADERS, ...charges] },
  ]);
}

/* ------------------------------------------------------------------ Grab CSV helpers */

export interface GrabCsv {
  headers: string[];
  rows: string[][];
}

export function parseGrab(buf: Buffer): GrabCsv {
  const recs = parseCsv(buf.toString('utf8'));
  const [head, ...rest] = recs;
  return { headers: (head as { cells: string[] }).cells, rows: rest.map((r) => r.cells) };
}

const quoteCell = (c: string): string => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

export function toCsv(g: GrabCsv, opts: { bom?: boolean; eol?: '\n' | '\r\n'; finalEol?: boolean } = {}): Buffer {
  const eol = opts.eol ?? '\n';
  const body = [g.headers, ...g.rows].map((r) => r.map(quoteCell).join(',')).join(eol) + (opts.finalEol === false ? '' : eol);
  return Buffer.from((opts.bom === false ? '' : '﻿') + body, 'utf8');
}

export function colIndex(g: GrabCsv, name: string): number {
  const i = g.headers.indexOf(name);
  if (i < 0) throw new Error(`test helper: no column ${name}`);
  return i;
}

export function setCell(g: GrabCsv, row: number, column: string, value: string): void {
  (g.rows[row] as string[])[colIndex(g, column)] = value;
}

export function getCell(g: GrabCsv, row: number, column: string): string {
  return (g.rows[row] as string[])[colIndex(g, column)] ?? '';
}

export const STORE_A = '11111111-aaaa-4aaa-8aaa-111111111111';
export const STORE_B = '22222222-bbbb-4bbb-8bbb-222222222222';

/** A short synthetic payment row (about 220 bytes with 68 columns) so 10,001 of them stay under the 3 MB cap. */
export function grabPaymentRow(headers: string[], i: number, store = STORE_A): string[] {
  const row = headers.map(() => '');
  const put = (h: string, v: string): void => {
    row[headers.indexOf(h)] = v;
  };
  put('Store Name', 'SharEat - Synthetic');
  put('Store ID', store);
  put('Updated On', '2 Oct 2026 9:30 AM');
  put('Created On', '1 Oct 2026 9:05 AM');
  put('Type', 'GrabFood');
  put('Category', 'Payment ');
  put('Status', 'Transferred');
  put('Settlement ID', `SPHSYNTH${String(i % 7).padStart(4, '0')}`);
  put('Amount', '100');
  put('Discount (Merchant-Funded)', '0');
  put('Net Sales', '100');
  put('Channel Commission', '-25');
  put('Total', '75');
  return row;
}

export function grabHeaders(): string[] {
  return parseGrab(fixture('grab-malvar-oct-transactions.csv')).headers;
}

export function syntheticGrab(rows: number, store = STORE_A): Buffer {
  const headers = grabHeaders();
  return toCsv({ headers, rows: Array.from({ length: rows }, (_, i) => grabPaymentRow(headers, i, store)) });
}

/* ------------------------------------------------------------------ leak scanners */

export function leafStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) leafStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) leafStrings(v, out);
  return out;
}

export function keyNames(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keyNames(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keyNames(v, out);
    }
  }
  return out;
}

/**
 * The values that must NEVER reach an output, taken from the fixture itself: a value of 8+ characters may not appear ANYWHERE inside
 * any string of the output; a shorter one (a 4-character masked bank value) may not equal any string of the output.
 */
export function assertNoLeak(result: unknown, sensitive: Iterable<string>, bannedKeys: RegExp): string[] {
  const problems: string[] = [];
  const leaves = leafStrings(result);
  for (const key of keyNames(result)) if (bannedKeys.test(key)) problems.push(`banned key name: ${key}`);
  for (const s of sensitive) {
    if (s.length === 0) continue;
    const hit = s.length >= 8 ? leaves.some((l) => l.includes(s)) : leaves.some((l) => l === s);
    if (hit) problems.push(`leaked value: ${s}`);
  }
  return problems;
}

export const GRAB_BANNED_KEYS = /transaction|linked|order|booking|bank|receiving|appeal|customer|refund|incident|terminal|partner|merchant/i;
/** Foodpanda keeps `customerRefund` (a boolean per the spec) and `invoiceNumber`; everything else about the customer or the order code is banned. */
export const FP_BANNED_KEYS = /orderCode|order_code|customer(?!Refund)|phone|email|address|officialDocument|bank|transaction/i;

/** Sensitive Grab Transaction-file cells (ids, links, order ids, funding source). */
export function grabTransactionSensitive(buf: Buffer): Set<string> {
  const g = parseGrab(buf);
  const cols = [
    'Transaction ID', 'Linked Transaction ID', 'Partner transaction ID 1', 'Partner transaction ID 2', 'Long Order ID', 'Short Order ID',
    'Booking ID', 'Appeal link', 'Customer refund Item', 'Receiving account / Source of fund', 'Terminal ID',
  ];
  const out = new Set<string>();
  for (const c of cols) {
    const i = g.headers.indexOf(c);
    for (const r of g.rows) if (i >= 0 && (r[i] ?? '') !== '') out.add(r[i] as string);
  }
  return out;
}

export function grabTransferSensitive(buf: Buffer): Set<string> {
  const g = parseGrab(buf);
  const out = new Set<string>();
  for (const c of ['Bank Statement Code', 'Bank Name', 'Bank Account']) {
    const i = g.headers.indexOf(c);
    for (const r of g.rows) if ((r[i] ?? '') !== '') out.add(r[i] as string);
  }
  return out;
}

/** Order Codes and Official Document Numbers of a Foodpanda workbook, read with the library directly (the oracle). */
export async function foodpandaSensitive(workbook: Buffer): Promise<Set<string>> {
  const out = new Set<string>();
  const a = (await readSheet(workbook, 'Appendix A').catch(() => [])) as unknown[][];
  const [head, ...rest] = a;
  if (head) {
    const codeAt = head.findIndex((h) => String(h).startsWith('Order Code'));
    const docAt = head.findIndex((h) => String(h).startsWith('Official Document Number'));
    for (const r of rest) {
      if (typeof r[codeAt] === 'string' && r[codeAt] !== '') out.add(r[codeAt] as string);
      if (r[docAt] !== null && r[docAt] !== undefined) out.add(String(r[docAt]));
    }
  }
  const b = (await readSheet(workbook, 'Appendix B').catch(() => [])) as unknown[][];
  for (const r of b.slice(1)) {
    if (r[0] !== null && r[0] !== undefined) out.add(String(r[0]));
    if (typeof r[4] === 'string' && r[4].startsWith('PandaGO')) out.add(r[4]);
  }
  return out;
}

export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ disk-write spies */

const WRITERS = [
  'writeFile', 'writeFileSync', 'createWriteStream', 'appendFile', 'appendFileSync', 'mkdtemp', 'mkdtempSync', 'mkdir', 'mkdirSync',
  'copyFile', 'copyFileSync', 'rename', 'renameSync', 'cp', 'cpSync',
] as const;

/** Spies on every fs write entry point (callback, sync and promise forms); the call is passed through so a real write would still show on disk. */
export function spyOnFsWrites(): { calls: () => string[]; restore: () => void } {
  const spies: { name: string; spy: ReturnType<typeof vi.spyOn> }[] = [];
  const target = fs as unknown as Record<string, unknown>;
  for (const w of WRITERS) if (typeof target[w] === 'function') spies.push({ name: `fs.${w}`, spy: vi.spyOn(target, w as never) });
  const prom = fs.promises as unknown as Record<string, unknown>;
  for (const w of ['writeFile', 'appendFile', 'mkdtemp', 'mkdir', 'copyFile', 'rename', 'cp'])
    if (typeof prom[w] === 'function') spies.push({ name: `fs.promises.${w}`, spy: vi.spyOn(prom, w as never) });
  return {
    calls: () => spies.filter((s) => s.spy.mock.calls.length > 0).map((s) => s.name),
    restore: () => spies.forEach((s) => s.spy.mockRestore()),
  };
}

