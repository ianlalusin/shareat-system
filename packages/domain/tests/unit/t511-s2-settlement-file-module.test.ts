import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILE_PURPOSES } from '../../../db/schema/stored-files';
import { LIMIT_PURPOSES, PURPOSE_LIMITS } from '../../src/files/limits';
import { fileBytesMatchType } from '../../src/files/magic';

/**
 * T-511 S2a (TESTER, 2026-11-03) - the file module learns the settlement-statement purpose. docs/tasks/511-settlement-upload-s2-spec.md "File module (2a)".
 * Pure, no database. RED today: the purpose does not exist (PURPOSE_LIMITS / FILE_PURPOSES have no 'channel_settlement_file') and
 * `fileBytesMatchType` returns false for every zip / csv type (its `default:` branch).
 *
 * MUTANTS (each test title ends with what it kills): zip magic missing or only one of the three signatures; text check missing (anything
 * passes) or too strict (BOM refused); NUL check removed or run on the whole file instead of the first 8 KB; a PNG / JPEG / zip accepted as a csv;
 * the empty buffer accepted; csv accepted as a zip; a type list missing 'application/vnd.ms-excel' (Windows sends CSV as that) or
 * 'application/x-zip-compressed'; a size cap other than 3 MB.
 */
const PURPOSE = 'channel_settlement_file';
const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed'] as const;
const CSV_TYPES = ['text/csv', 'application/vnd.ms-excel'] as const;
const enc = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const CSV_TEXT = 'Transaction ID,Net Sales,Amount\nA-1,6753.00,6807.00\nA-2,120.50,120.50\n';
const BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);

describe('T-511 S2a - fileBytesMatchType: zip', () => {
  const zipHeader = (a: number, b: number) => Uint8Array.from([0x50, 0x4b, a, b, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x21, 0x00]);
  for (const type of ZIP_TYPES) {
    it(`${type}: accepts the three PK signatures (03 04 normal, 05 06 empty, 07 08 spanned) [kills: only one signature; zip refused]`, () => {
      expect(fileBytesMatchType(type, zipHeader(0x03, 0x04))).toBe(true);
      expect(fileBytesMatchType(type, zipHeader(0x05, 0x06))).toBe(true);
      expect(fileBytesMatchType(type, zipHeader(0x07, 0x08))).toBe(true);
    });
    it(`${type}: refuses plain text, a PNG, a lone "PK", the wrong third and fourth bytes, and the empty buffer [kills: no signature check]`, () => {
      expect(fileBytesMatchType(type, enc(CSV_TEXT))).toBe(false);
      expect(fileBytesMatchType(type, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]))).toBe(false);
      expect(fileBytesMatchType(type, Uint8Array.from([0x50, 0x4b]))).toBe(false);
      expect(fileBytesMatchType(type, zipHeader(0x01, 0x02))).toBe(false);
      expect(fileBytesMatchType(type, new Uint8Array(0))).toBe(false);
    });
  }
  it('the content type is matched case-insensitively, like the existing types', () => {
    expect(fileBytesMatchType('Application/ZIP', zipHeader(0x03, 0x04))).toBe(true);
  });
});

describe('T-511 S2a - fileBytesMatchType: csv text', () => {
  for (const type of CSV_TYPES) {
    it(`${type}: accepts plain CSV text, with and without a UTF-8 BOM [kills: text refused; BOM refused]`, () => {
      expect(fileBytesMatchType(type, enc(CSV_TEXT))).toBe(true);
      expect(fileBytesMatchType(type, concat(BOM, enc(CSV_TEXT)))).toBe(true);
    });
    it(`${type}: refuses a NUL byte inside the first 8 KB [kills: NUL check missing]`, () => {
      const withNul = concat(enc('a,b,c\n1,2,'), Uint8Array.from([0x00]), enc('3\n'));
      expect(fileBytesMatchType(type, withNul)).toBe(false);
      // a NUL right at the last byte of the window (index 8191) is still inside the first 8 KB
      const atEdge = new Uint8Array(8192).fill(0x41);
      atEdge[8191] = 0x00;
      expect(fileBytesMatchType(type, atEdge)).toBe(false);
    });
    it(`${type}: looks only at the first 8 KB (a NUL after byte 8192 does not refuse it) [kills: NUL check run over the whole file]`, () => {
      const late = new Uint8Array(9000).fill(0x41);
      late[8192] = 0x00;
      expect(fileBytesMatchType(type, late)).toBe(true);
    });
    it(`${type}: refuses a PNG, a JPEG and a zip renamed .csv (their headers carry NUL bytes) [kills: any bytes accepted as text]`, () => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
      const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
      expect(fileBytesMatchType(type, png)).toBe(false);
      expect(fileBytesMatchType(type, jpeg)).toBe(false);
      expect(fileBytesMatchType(type, zip)).toBe(false);
    });
    it(`${type}: refuses the empty buffer [kills: empty file accepted]`, () => {
      expect(fileBytesMatchType(type, new Uint8Array(0))).toBe(false);
    });
  }
});

describe('T-511 S2a - fileBytesMatchType: the existing types are untouched', () => {
  it('a JPEG still matches image/jpeg, a CSV is not an image, an unknown type is still refused', () => {
    expect(fileBytesMatchType('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(fileBytesMatchType('image/jpeg', enc(CSV_TEXT))).toBe(false);
    expect(fileBytesMatchType('application/x-msdownload', enc(CSV_TEXT))).toBe(false);
  });
});

describe('T-511 S2a - the purpose and its limits', () => {
  it('FILE_PURPOSES (the schema list) and LIMIT_PURPOSES (the db-free mirror) both carry channel_settlement_file and stay equal [kills: one list missed]', () => {
    expect(FILE_PURPOSES as readonly string[]).toContain(PURPOSE);
    expect(LIMIT_PURPOSES as readonly string[]).toContain(PURPOSE);
    expect([...LIMIT_PURPOSES].sort()).toEqual([...FILE_PURPOSES].sort());
  });
  it('PURPOSE_LIMITS: csv, ms-excel, zip and x-zip-compressed, capped at 3 MB [kills: Windows CSV type missing; wrong cap]', () => {
    const limits = (PURPOSE_LIMITS as Record<string, { types: readonly string[]; maxBytes: number } | undefined>)[PURPOSE];
    expect(limits, 'PURPOSE_LIMITS has no channel_settlement_file entry').toBeDefined();
    expect(limits!.types).toEqual(['text/csv', 'application/vnd.ms-excel', 'application/zip', 'application/x-zip-compressed']);
    expect(limits!.maxBytes).toBe(3 * 1024 * 1024);
  });
  it('the purpose accepts no image or pdf type [kills: a catch-all type list]', () => {
    const limits = (PURPOSE_LIMITS as Record<string, { types: readonly string[] } | undefined>)[PURPOSE];
    expect(limits?.types.some((t) => t.startsWith('image/') || t === 'application/pdf')).toBe(false);
  });
  it('PURPOSE_CAPABILITY maps channel_settlement_file to upload_settlement_files (source text; the map is not exported) [kills: another capability, e.g. record_ar_collection]', () => {
    const src = readFileSync(join(__dirname, '../../src/files/index.ts'), 'utf8');
    expect(src).toMatch(/channel_settlement_file\s*:\s*['"]upload_settlement_files['"]/);
  });
  it('EXTENSIONS maps csv and zip to .csv and .zip (source text; the map is not exported) [kills: falls back to .bin]', () => {
    const src = readFileSync(join(__dirname, '../../src/files/index.ts'), 'utf8');
    expect(src).toMatch(/['"]text\/csv['"]\s*:\s*['"]csv['"]/);
    expect(src).toMatch(/['"]application\/zip['"]\s*:\s*['"]zip['"]/);
  });
});
