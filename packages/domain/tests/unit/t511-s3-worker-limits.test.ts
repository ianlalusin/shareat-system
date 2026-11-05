/**
 * T-511 S3 (K) - the worker host: at most WORKER_CONCURRENCY workers at a time (a hostile worker costs about 200 MB, ten at once peaked at
 * 2.1 GB in the round 4 audit), the timeout clock starts when a worker STARTS, every slot is released however the worker ends, and a worker
 * that cannot start is its own named refusal (XLSX_WORKER_UNAVAILABLE), not "a bad file". Written BEFORE the changes (red first).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { WORKER_CONCURRENCY, readSheetsInWorker } from '../../src/settlement-intake/xlsx-worker-host';
import { UUID_SHAPE, fpWorkbook, refusalOf, zipBytes } from './t511-s3-helpers';

// Pass-through wrapper that tracks how many workers are alive at once (from construction to the 'exit' event).
const live = vi.hoisted(() => ({ now: 0, max: 0 }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...real,
    Worker: function (this: unknown, ...args: ConstructorParameters<typeof real.Worker>) {
      const w = new real.Worker(...args);
      live.now += 1;
      live.max = Math.max(live.max, live.now);
      w.on('exit', () => {
        live.now -= 1;
      });
      return w;
    },
  };
});

const MB = 1024 * 1024;
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const dataUrl = (js: string): URL => new URL(`data:text/javascript,${encodeURIComponent(js)}`);
const wb = (): Buffer => zipBytes([]);

/** A workbook whose rows each carry a far cell: the library really does build a dense grid (heavy). */
function heavyWorkbook(): Buffer {
  const rows = Array.from({ length: 3000 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join('');
  const rel = (n: string, t: string, ty: string): string => `<Relationship Id="${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${ty}" Target="${t}"/>`;
  return zipBytes([
    { name: '[Content_Types].xml', data: Buffer.from(`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Appendix A" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'worksheets/sheet1.xml', 'worksheet')}${rel('rId2', 'styles.xml', 'styles')}</Relationships>`) },
    { name: 'xl/styles.xml', data: Buffer.from(`${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`) },
  ]);
}

describe('at most WORKER_CONCURRENCY workers run at a time', () => {
  it('the limit is 2 and is exported', () => {
    expect(WORKER_CONCURRENCY).toBe(2);
  });

  it('6 concurrent hostile calls all end refused, never more than 2 workers alive, RSS bounded', { timeout: 60_000 }, async () => {
    live.max = 0;
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    const results = await Promise.all(Array.from({ length: 6 }, () => refusalOf(() => readFoodpandaInvoice(heavyWorkbook()))));
    clearInterval(timer);
    const deltaMb = (peak - base) / MB;
    console.log(`CONCURRENCY max-live-workers=${live.max} rss-delta-mb=${deltaMb.toFixed(0)}`);
    for (const r of results) expect(['XLSX_TOO_HEAVY', 'XLSX_TOO_SLOW']).toContain(r.code);
    expect(live.max).toBeLessThanOrEqual(WORKER_CONCURRENCY);
    expect(deltaMb).toBeLessThan(700);
  });

  it('the timeout clock starts when the worker starts, not when the call queued', { timeout: 30_000 }, async () => {
    // Each stub answers after 300 ms; the timeout is 500 ms. The third and fourth calls wait ~300 ms in the queue (600 ms from the call),
    // which would time out if the clock started at the call; from the start they take 300 ms and succeed.
    const js = "import { parentPort } from 'node:worker_threads'; setTimeout(() => parentPort.postMessage({ ok: true, a: null, b: null }), 300);";
    const t0 = Date.now();
    const outs = await Promise.all(Array.from({ length: 4 }, () => readSheetsInWorker(wb(), { workerUrl: dataUrl(js), timeoutMs: 500 })));
    expect(outs).toEqual(Array.from({ length: 4 }, () => ({ a: null, b: null })));
    expect(Date.now() - t0).toBeGreaterThan(550);
  });

  it('every way a worker can end releases its slot: bad path, silent exit, a throw, a busy loop, a null message; then legitimate reads still run', { timeout: 60_000 }, async () => {
    const ends: [string, () => Promise<unknown>][] = [
      ['missing file', () => readSheetsInWorker(wb(), { workerUrl: new URL('file:///definitely/not/here/xlsx-worker.mjs') })],
      ['silent exit', () => readSheetsInWorker(wb(), { workerUrl: dataUrl('process.exit(0)') })],
      ['a throw', () => readSheetsInWorker(wb(), { workerUrl: dataUrl("throw new Error('boom');") })],
      ['a busy loop', () => readSheetsInWorker(wb(), { workerUrl: dataUrl('for(;;){}'), timeoutMs: 200 })],
      ['a null message', () => readSheetsInWorker(wb(), { workerUrl: dataUrl("import { parentPort } from 'node:worker_threads'; parentPort.postMessage(null);") })],
    ];
    for (let round = 0; round < 2; round += 1) {
      await Promise.all(ends.map(([, run]) => refusalOf(run)));
    }
    // 2 slots are free again: 3 legitimate reads at once all complete.
    const reads = await Promise.all([1, 2, 3].map(() => readFoodpandaInvoice(fpWorkbook())));
    for (const r of reads) expect(r.orders).toHaveLength(3);
  });
});

describe('a worker that cannot start is XLSX_WORKER_UNAVAILABLE', () => {
  it.each([
    ['a missing worker file', new URL('file:///definitely/not/here/xlsx-worker.mjs')],
    ['a URL that is not a file', new URL('http://example.test/xlsx-worker.mjs')],
  ])('%s', async (_label, workerUrl) => {
    const r = await refusalOf(() => readSheetsInWorker(wb(), { workerUrl }));
    expect(r.code).toBe('XLSX_WORKER_UNAVAILABLE');
    for (const text of [r.userMessage, r.message]) {
      expect(text).not.toMatch(UUID_SHAPE);
      expect(text).not.toMatch(/definitely|example\.test|file:|http:|ERR_|MODULE_NOT_FOUND/);
      expect(text).toMatch(/administrator/i);
    }
  });

  it('a worker that starts and then fails is still NO_SHEETS (the file is the likely cause), and a null message does not crash the host', async () => {
    expect((await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: dataUrl("throw new Error('boom');") }))).code).toBe('FOODPANDA_NO_SHEETS');
    const js = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage(null);";
    expect((await refusalOf(() => readSheetsInWorker(wb(), { workerUrl: dataUrl(js) }))).code).toBe('FOODPANDA_NO_SHEETS');
  });
});
