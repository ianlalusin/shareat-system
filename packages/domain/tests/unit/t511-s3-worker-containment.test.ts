/**
 * T-511 S3 (I) - containment of read-excel-file. We cannot predict what the library will do with a hostile worksheet (prefixed
 * attributes, huge tokens, millions of empty rows), so the library runs in a worker thread with a memory limit and a wall-clock timeout
 * (`readSheetsInWorker`); the main thread never blocks and its heap is unaffected. A cheap preflight refuses what it can know for sure
 * (DOCTYPE / ENTITY, rels targets leaving the zip, oversized rels). Written BEFORE the worker existed (red first).
 *
 * Every hostile case is built so the library really does the expensive work (many rows each carrying a far cell, a huge row number, ...),
 * and must end in XLSX_TOO_HEAVY (memory limit) or XLSX_TOO_SLOW (timeout) within about 6 s, with this process's heap unaffected.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readSheet } from 'read-excel-file/node';
import { add, money, type Money } from '@shareat/core/money';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import { tieGrabPayouts } from '../../src/settlement-intake/grab-payouts';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { openSettlementZip, normalizeXlsx } from '../../src/settlement-intake/safe-zip';
import { readSheetsInWorker } from '../../src/settlement-intake/xlsx-worker-host';
import { UUID_SHAPE, fixture, fpWorkbook, refusalOf, spyOnFsWrites, zipBytes } from './t511-s3-helpers';

// Pass-through wrapper that counts how many workers were started: a refusal by the preflight must not start one.
const started = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...real,
    Worker: function (this: unknown, ...args: ConstructorParameters<typeof real.Worker>) {
      started.count += 1;
      return new real.Worker(...args);
    },
  };
});

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MB = 1024 * 1024;
const dataUrl = (js: string): URL => new URL(`data:text/javascript,${encodeURIComponent(js)}`);

/** A workbook whose worksheet part has the given raw XML, stored at `partName` and reached through the workbook rels. */
function withSheet(sheet: string, partName = 'xl/worksheets/sheet1.xml', relTarget?: string, extra: { name: string; data: Buffer }[] = []): Buffer {
  const target = relTarget ?? partName.replace(/^xl\//, '');
  const rel = (n: string, t: string, ty: string): string => `<Relationship Id="${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${ty}" Target="${t}"/>`;
  return zipBytes([
    { name: '[Content_Types].xml', data: Buffer.from(`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'xl/workbook.xml', 'officeDocument')}</Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Appendix A" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', target, 'worksheet')}${rel('rId2', 'styles.xml', 'styles')}</Relationships>`) },
    { name: 'xl/styles.xml', data: Buffer.from(`${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`) },
    { name: partName, data: Buffer.from(sheet) },
    ...extra,
  ]);
}
const doc = (sheetData: string): string => `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
const strCell = (attrs: string): string => `<c ${attrs} t="inlineStr"><is><t>x</t></is></c>`;
/** n rows, each with one cell whose address comes from `attrs(i)`: the library fills the whole row up to the far column. */
const manyRows = (n: number, attrs: (i: number) => string): string => Array.from({ length: n }, (_, i) => `<row r="${i + 1}">${strCell(attrs(i + 1))}</row>`).join('');

type Hostile = [string, () => Buffer];
const HOSTILE: Hostile[] = [
  ['a prefixed attribute <c r="A20000" x:r="XFD20000"> on 3,000 rows', () => withSheet(doc(manyRows(3000, (i) => `r="A${i}" x:r="XFD${i}"`)))],
  ['<row x:r="30000000">', () => withSheet(doc('<row x:r="30000000"/>'))],
  ['a row number in exponent form <row r="1e7">', () => withSheet(doc('<row r="1e7"/>'))],
  ['a single-quoted far cell reference on 5,000 rows', () => withSheet(doc(manyRows(5000, (i) => `r='XFD${i}'`)))],
  ['an entity-encoded far cell reference on 5,000 rows', () => withSheet(doc(manyRows(5000, (i) => `r="XF&#68;${i}"`)))],
  ['a 2 MB tag name', () => withSheet(doc(`<${'a'.repeat(2 * MB)}/>`))],
  ['a 4 MB attribute value', () => withSheet(doc(`<c z="${'a'.repeat(4 * MB)}" r="A1"/>`))],
  ['300,000 attributes on one element', () => withSheet(doc(`<c ${Array.from({ length: 300_000 }, (_, i) => `a${i}="1"`).join(' ')} r="A1"/>`))],
  ['1.2 million empty <row/> elements', () => withSheet(doc('<row/>'.repeat(1_200_000)))],
  ['a far-cell sheet reached through the rels, stored outside xl/worksheets/', () => withSheet(doc(manyRows(5000, (i) => `r="XFD${i}"`)), 'xl/other/sub/s.xml', 'other/sub/s.xml')],
];

describe('read-excel-file runs in a worker: a hostile worksheet ends in XLSX_TOO_HEAVY or XLSX_TOO_SLOW, never a frozen or dead process', () => {
  let heapBefore = 0;
  beforeAll(() => {
    heapBefore = process.memoryUsage().heapUsed;
  });
  afterAll(() => {
    const grown = (process.memoryUsage().heapUsed - heapBefore) / MB;
    console.log(`TEST_HEAP_GROWTH_MB ${grown.toFixed(1)}`);
    expect(grown).toBeLessThan(100);
  });

  it.each(HOSTILE)('%s', { timeout: 15_000 }, async (label, build) => {
    const wb = build();
    expect(wb.length).toBeLessThan(2 * MB);
    const t0 = Date.now();
    const r = await refusalOf(() => readFoodpandaInvoice(wb));
    const ms = Date.now() - t0;
    console.log(`HOSTILE_MS ${label}: ${ms} -> ${r.code}`);
    // The empty-row flood is data-dependent inside the library: it takes about 5 s (timeout) or finishes in about 1.5 s with an empty sheet,
    // which the reader then refuses by name (no header). Both are safe; what must never happen is a hang or a crash.
    const fine = label.startsWith('1.2 million') ? ['XLSX_TOO_HEAVY', 'XLSX_TOO_SLOW', 'FOODPANDA_MISSING_COLUMN'] : ['XLSX_TOO_HEAVY', 'XLSX_TOO_SLOW'];
    expect(fine).toContain(r.code);
    expect(ms).toBeLessThan(8000);
    expect(r.userMessage).not.toMatch(UUID_SHAPE);
    expect(r.userMessage).not.toContain('[hidden]');
    expect(r.userMessage.length).toBeGreaterThan(20);
  });

  it('the dimension tag alone is harmless (the library ignores it): a prefixed x:ref does not hang or crash anything', { timeout: 15_000 }, async () => {
    const wb = withSheet(`${HEAD}<worksheet><dimension x:ref="A1:XFD1048576"/><sheetData>${strCell('r="A1"')}</sheetData></worksheet>`);
    const t0 = Date.now();
    await refusalOf(() => readFoodpandaInvoice(wb)).catch(() => undefined);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('the `<c ` flood (7.9 MB, no ">" ever) ends in a named refusal within the time limit', { timeout: 15_000 }, async () => {
    const wb = withSheet(`<sheetData>${'<c '.repeat(Math.floor((7.9 * MB) / 3))}`);
    const t0 = Date.now();
    const r = await refusalOf(() => readFoodpandaInvoice(wb));
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(['XLSX_TOO_HEAVY', 'XLSX_TOO_SLOW', 'FOODPANDA_NO_SHEETS']).toContain(r.code);
  });
});

describe('the cheap preflight refuses what it can know for sure, without starting a worker', () => {
  const refused = async (wb: Buffer): Promise<string> => {
    const before = started.count;
    const r = await refusalOf(() => readFoodpandaInvoice(wb));
    expect(started.count).toBe(before);
    expect(r.userMessage).not.toMatch(UUID_SHAPE);
    return r.code;
  };

  it('a DOCTYPE with an ENTITY declaration in a worksheet, in the workbook part, and an ENTITY alone', async () => {
    const dt = '<!DOCTYPE x [<!ENTITY a "b">]>';
    expect(await refused(withSheet(`${HEAD}${dt}<worksheet><sheetData/></worksheet>`))).toBe('XLSX_MALFORMED');
    expect(await refused(withSheet(doc(''), 'xl/worksheets/sheet1.xml', undefined, [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`${HEAD}${dt}<sst/>`) }]))).toBe('XLSX_MALFORMED');
    expect(await refused(withSheet(`${HEAD}<!ENTITY a "b"><worksheet><sheetData/></worksheet>`))).toBe('XLSX_MALFORMED');
  });

  it('a rels target that leaves the zip (relative ../../x, absolute /../x, entity-encoded, single-quoted) is XLSX_MALFORMED', async () => {
    for (const target of ['../../x.xml', '../../../etc/passwd', '/../x.xml', '..&#47;..&#47;x.xml', 'worksheets/../../../x.xml']) {
      expect(await refused(withSheet(doc(''), 'xl/worksheets/sheet1.xml', target)), target).toBe('XLSX_MALFORMED');
    }
  });

  it('a rels part over 64 KB is XLSX_MALFORMED', async () => {
    const big = `${HEAD}<Relationships>${'<Relationship Id="r" Type="t" Target="x.xml"/>'.repeat(2000)}</Relationships>`;
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect(await refused(withSheet(doc(''), 'xl/worksheets/sheet1.xml', undefined, [{ name: 'xl/_rels/other.xml.rels', data: Buffer.from(big) }]))).toBe('XLSX_MALFORMED');
  });

  it('inside-the-zip targets (relative, absolute) and external links are accepted by the preflight', async () => {
    await expect(normalizeXlsx(withSheet(doc('')))).resolves.toBeInstanceOf(Buffer);
    await expect(normalizeXlsx(withSheet(doc(''), 'xl/worksheets/sheet1.xml', '/xl/worksheets/sheet1.xml'))).resolves.toBeInstanceOf(Buffer);
    await expect(normalizeXlsx(withSheet(doc(''), 'xl/worksheets/sheet1.xml', 'https://example.test/x'))).resolves.toBeInstanceOf(Buffer);
  });
});

describe('a worker that cannot do its job is a named refusal, never a hang', () => {
  const wb = (): Buffer => withSheet(doc(''));

  it('a worker file that does not exist (spawn failure) is XLSX_WORKER_UNAVAILABLE', async () => {
    const r = await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: new URL('file:///definitely/not/here/xlsx-worker.mjs') }));
    expect(r.code).toBe('XLSX_WORKER_UNAVAILABLE');
  });

  it('a worker that exits without a message is FOODPANDA_NO_SHEETS, fast', async () => {
    const t0 = Date.now();
    const r = await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: dataUrl('process.exit(0)') }));
    expect(r.code).toBe('FOODPANDA_NO_SHEETS');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a worker that reports an error message is FOODPANDA_NO_SHEETS', async () => {
    const js = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ ok: false, message: 'boom' });";
    expect((await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: dataUrl(js) }))).code).toBe('FOODPANDA_NO_SHEETS');
  });

  it('a worker that never answers (busy loop) is XLSX_TOO_SLOW at the timeout', async () => {
    const t0 = Date.now();
    const r = await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: dataUrl('for(;;){}'), timeoutMs: 300 }));
    expect(r.code).toBe('XLSX_TOO_SLOW');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a worker that hits its memory limit is XLSX_TOO_HEAVY', async () => {
    const r = await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: dataUrl('const a=[]; for(;;) a.push(new Array(1e5).fill(1));') }));
    expect(r.code).toBe('XLSX_TOO_HEAVY');
  });

  it('the sentences are plain: no UUID, no [hidden], no library error text', async () => {
    for (const [url, ms] of [[dataUrl('for(;;){}'), 200], [dataUrl('const a=[]; for(;;) a.push(new Array(1e5).fill(1));'), 5000]] as [URL, number][]) {
      const r = await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: url, timeoutMs: ms }));
      for (const text of [r.userMessage, r.message]) {
        expect(text).not.toMatch(UUID_SHAPE);
        expect(text).not.toMatch(/ERR_WORKER|RangeError|TypeError|undefined/);
        expect(text.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('legitimate workbooks read through the worker exactly as the library reads them', () => {
  it('the worker returns the same rows for Appendix A and B as read-excel-file called directly (real 336-row, B-only, 5,001 rows); latency is logged', async () => {
    const lines: string[] = [];
    for (const [label, build] of [
      ['real-336-rows', async () => (await openSettlementZip(fixture('foodpanda-lipa-oct5-34col.zip'))).workbook],
      ['real-b-only', async () => (await openSettlementZip(fixture('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip'))).workbook],
      ['variant-inline', async () => fixture('variant-xlsx-openpyxl-inline-strings.xlsx')],
      ['generated-5001-rows', async () => fpWorkbook({ orders: 5001 })],
    ] as [string, () => Promise<Buffer>][]) {
      const workbook = await build();
      const direct = {
        a: await readSheet(workbook, 'Appendix A').catch(() => null),
        b: await readSheet(workbook, 'Appendix B').catch(() => null),
      };
      const t0 = Date.now();
      const viaWorker = await readSheetsInWorker(workbook);
      lines.push(`${label}=${Date.now() - t0}ms`);
      expect(viaWorker.a).toEqual(direct.a);
      expect(viaWorker.b).toEqual(direct.b);
    }
    console.log(`WORKER_MS ${lines.join(' ')}`);
  }, 60_000);

  it('a workbook with neither sheet gives nulls for both (the reader turns that into FOODPANDA_NO_SHEETS)', async () => {
    const out = await readSheetsInWorker(fpWorkbook({ sheetNames: ['Sheet1', 'Sheet2'] }));
    expect(out).toEqual({ a: null, b: null });
  });

  it('no filesystem write happens (the worker reads from the buffer only)', async () => {
    const spies = spyOnFsWrites();
    await readSheetsInWorker(fpWorkbook());
    expect(spies.calls()).toEqual([]);
  });
});

describe('tieGrabPayouts: Settlement IDs match case-insensitively on both sides', () => {
  it('transactions with lower-case ids tie exactly like the upper-case file; an unlisted settlement keeps its own id text', () => {
    const tx = readGrabTransactions(fixture('grab-malvar-oct-transactions.csv'));
    const tr = readGrabTransfers(fixture('grab-malvar-oct-transfers.csv'));
    const base = tieGrabPayouts(tx, tr);
    const lower = { ...tx, rows: tx.rows.map((r) => ({ ...r, settlementId: r.settlementId === null ? null : r.settlementId.toLowerCase() })) };
    const out = tieGrabPayouts(lower, tr);
    expect(out.payouts.map((p) => p.state)).toEqual(base.payouts.map((p) => p.state));
    expect(out.payouts.filter((p) => p.state === 'tied')).toHaveLength(30);
    const sum = (m: Money[]): Money => add(money('0'), ...m);
    expect(sum(out.payouts.map((p) => p.rowsTotal ?? money('0')))).toBe(sum(base.payouts.map((p) => p.rowsTotal ?? money('0'))));
    expect(out.unlistedSettlements).toHaveLength(base.unlistedSettlements.length);
    // and the other way: lower-case payouts against upper-case transactions
    const lowerTr = { ...tr, rows: tr.rows.map((t) => ({ ...t, settlementId: t.settlementId.toLowerCase() })) };
    expect(tieGrabPayouts(tx, lowerTr).payouts.filter((p) => p.state === 'tied')).toHaveLength(30);
  });
});
