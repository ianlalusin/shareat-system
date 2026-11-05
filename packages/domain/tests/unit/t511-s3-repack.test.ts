/**
 * T-511 S3 (J) - the inner workbook is RE-PACKED before the worker sees it (round 4 audit, Blocker). read-excel-file does not use the zip's
 * central directory: it walks LOCAL headers and allocates the size each one declares (up to 4 GB, outside the V8 heap, so the worker's
 * memory limit does not cover it). yauzl, which validates the zip, never sees an unlisted local entry or a lying local header. So the
 * validated parts are written into a fresh STORED zip with true sizes and the worker gets only that.
 *
 * Each attack is built by hand here. Every one must end refused with a named code or read normally, and the whole-process RSS around the call
 * (sampled every 20 ms) must stay small. Written BEFORE the re-pack existed (red first).
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { normalizeXlsx } from '../../src/settlement-intake/safe-zip';
import { readSheetsInWorker } from '../../src/settlement-intake/xlsx-worker-host';
import { fixture, fpWorkbook, refusalOf, zipBytes } from './t511-s3-helpers';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';

const MB = 1024 * 1024;

/** Whole-process RSS sampled every 20 ms while `run` is going: the worker's Buffers count too. */
async function peakRssDelta<T>(run: () => Promise<T>): Promise<{ outcome: { ok: true; value: T } | { ok: false; error: unknown }; deltaMb: number }> {
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);
  return { outcome, deltaMb: (peak - base) / MB };
}

/** A local file header (30 bytes + name + body) with whatever sizes we like to claim. */
function localEntry(name: string, body: Buffer, o: { method?: number; compressed?: number; uncompressed: number }): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(o.method ?? 8, 8);
  h.writeUInt16LE(0x21, 12);
  h.writeUInt32LE(o.compressed ?? body.length, 18);
  h.writeUInt32LE(o.uncompressed, 22);
  h.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([h, Buffer.from(name), body]);
}

/** Inserts a local entry the central directory does not list: just before the directory, with the end record's offset patched. */
function injectUnlisted(zip: Buffer, entry: Buffer): Buffer {
  const eocd = zip.length - 22;
  const cdOffset = zip.readUInt32LE(eocd + 16);
  const out = Buffer.concat([zip.subarray(0, cdOffset), entry, zip.subarray(cdOffset)]);
  out.writeUInt32LE(cdOffset + entry.length, out.length - 22 + 16);
  return out;
}

/** The first entry's LOCAL header claims a size; the central directory (what yauzl validates) stays truthful. */
function lieInFirstLocalHeader(zip: Buffer, claimed: number): Buffer {
  const out = Buffer.from(zip);
  out.writeUInt32LE(claimed, 22);
  return out;
}

const EMPTY_DEFLATE = Buffer.from([0x03, 0x00]);
const GB = 1024 * MB;

describe('re-pack: hostile local headers are neutralised before the library sees them', () => {
  it('a 1.2 KB-class file with a hidden local entry declaring 1 GB reads normally, with a small RSS peak', { timeout: 60_000 }, async () => {
    const wb = injectUnlisted(fpWorkbook(), localEntry('x.xml', EMPTY_DEFLATE, { uncompressed: GB }));
    const { outcome, deltaMb } = await peakRssDelta(() => readFoodpandaInvoice(wb));
    console.log(`RSS_DELTA_MB hidden-1GB: ${deltaMb.toFixed(0)} ${outcome.ok ? 'read' : 'refused'}`);
    expect(outcome.ok).toBe(true);
    expect(deltaMb).toBeLessThan(500);
  });

  it('a hidden local entry declaring 4 GB (0xFFFFFFFF)', { timeout: 60_000 }, async () => {
    const wb = injectUnlisted(fpWorkbook(), localEntry('x.xml', EMPTY_DEFLATE, { uncompressed: 0xffffffff }));
    const { outcome, deltaMb } = await peakRssDelta(() => readFoodpandaInvoice(wb));
    console.log(`RSS_DELTA_MB hidden-4GB: ${deltaMb.toFixed(0)} ${outcome.ok ? 'read' : 'refused'}`);
    expect(outcome.ok).toBe(true);
    expect(deltaMb).toBeLessThan(500);
  });

  it('a LISTED entry whose local header lies (900 MB) reads normally', { timeout: 60_000 }, async () => {
    const wb = lieInFirstLocalHeader(fpWorkbook(), 900 * MB);
    const { outcome, deltaMb } = await peakRssDelta(() => readFoodpandaInvoice(wb));
    console.log(`RSS_DELTA_MB local-header-lie-900MB: ${deltaMb.toFixed(0)} ${outcome.ok ? 'read' : 'refused'}`);
    // yauzl with validateEntrySizes reads the entry by the central directory; the bytes it gets are the truth, whichever way it ends.
    expect(deltaMb).toBeLessThan(500);
    if (!outcome.ok) expect(String((outcome.error as { code?: string }).code)).toMatch(/^(ZIP_SIZE_MISMATCH|ZIP_NOT_A_ZIP|XLSX_MALFORMED)$/);
  });

  it('a hidden real deflate bomb (400 MB inflated, truthful local header) is never inflated by the library', { timeout: 120_000 }, async () => {
    const bomb = deflateRawSync(Buffer.alloc(400 * MB));
    expect(bomb.length).toBeLessThan(2 * MB);
    const wb = injectUnlisted(fpWorkbook(), localEntry('bomb.xml', bomb, { uncompressed: 400 * MB }));
    const { outcome, deltaMb } = await peakRssDelta(() => readFoodpandaInvoice(wb));
    console.log(`RSS_DELTA_MB hidden-bomb-400MB: ${deltaMb.toFixed(0)} ${outcome.ok ? 'read' : 'refused'}`);
    expect(outcome.ok).toBe(true);
    expect(deltaMb).toBeLessThan(300);
  });

  it('duplicate entry names are XLSX_MALFORMED', async () => {
    const wb = zipBytes([
      { name: 'xl/styles.xml', data: Buffer.from('<a/>') },
      { name: 'xl/styles.xml', data: Buffer.from('<b/>') },
    ]);
    expect((await refusalOf(() => normalizeXlsx(wb))).code).toBe('XLSX_MALFORMED');
    expect((await refusalOf(() => readFoodpandaInvoice(wb))).code).toBe('XLSX_MALFORMED');
  });

  it('a zip64 marker with no zip64 record behind it is refused by name', async () => {
    const wb = Buffer.from(fpWorkbook());
    const eocd = wb.length - 22;
    wb.writeUInt16LE(0xffff, eocd + 8);
    wb.writeUInt16LE(0xffff, eocd + 10);
    wb.writeUInt32LE(0xffffffff, eocd + 12);
    wb.writeUInt32LE(0xffffffff, eocd + 16);
    const r = await refusalOf(() => readFoodpandaInvoice(wb));
    expect(['ZIP_NOT_A_ZIP', 'XLSX_MALFORMED', 'ZIP_SIZE_MISMATCH']).toContain(r.code);
  });
});

describe('re-pack: what the worker gets is a clean stored zip with the true sizes', () => {
  it('only .xml and .rels parts are kept, names exactly, no compression, and a valid zip comes out', async () => {
    const wb = zipBytes([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships/>') },
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
      { name: 'xl/printerSettings/printerSettings1.bin', data: Buffer.alloc(500, 1) },
      { name: 'docProps/thumbnail.jpeg', data: Buffer.alloc(500, 2) },
    ]);
    const clean = await normalizeXlsx(wb);
    // Reading the clean zip back with the same reader proves it is a well-formed zip with matching sizes.
    const again = await normalizeXlsx(clean);
    expect(again.equals(clean)).toBe(true);
    const text = clean.toString('latin1');
    for (const name of ['[Content_Types].xml', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml']) expect(text).toContain(name);
    expect(text).not.toContain('printerSettings');
    expect(text).not.toContain('thumbnail');
    // stored: every local header says method 0 and csize = usize
    let at = 0;
    let n = 0;
    while (clean.readUInt32LE(at) === 0x04034b50) {
      expect(clean.readUInt16LE(at + 8)).toBe(0);
      expect(clean.readUInt32LE(at + 18)).toBe(clean.readUInt32LE(at + 22));
      at += 30 + clean.readUInt16LE(at + 26) + clean.readUInt16LE(at + 28) + clean.readUInt32LE(at + 18);
      n += 1;
    }
    expect(n).toBe(3);
  });

  it('golden: the worker reads exactly the same rows from the re-packed workbook as from the original (every valid fixture)', { timeout: 60_000 }, async () => {
    const originals: [string, Buffer][] = [];
    for (const z of ['foodpanda-banay-oct19-34col.zip', 'foodpanda-malvar-oct12-34col.zip', 'foodpanda-lipa-oct5-34col.zip', 'foodpanda-lipa-oct19-34col-feerow.zip', 'foodpanda-lipa-jul15-32col.zip', 'foodpanda-lipa-oct5a-appendix-b-only-pandago.zip']) {
      originals.push([z, (await openSettlementZip(fixture(z))).workbook]);
    }
    for (const x of ['variant-xlsx-openpyxl-inline-strings.xlsx', 'hostile-xlsx-unknown-extra-column.xlsx', 'hostile-xlsx-missing-order-date.xlsx']) originals.push([x, fixture(x)]);
    originals.push(['generated-34', fpWorkbook()], ['generated-32', fpWorkbook({ layout: '32' })]);
    for (const [label, original] of originals) {
      const before = await readSheetsInWorker(original);
      const after = await readSheetsInWorker(await normalizeXlsx(original));
      expect(after, label).toEqual(before);
    }
  });
});
