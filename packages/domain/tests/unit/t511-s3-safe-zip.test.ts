/**
 * T-511 S3 (A) - the safe zip reader. `docs/tasks/511-settlement-upload-s3-spec.md` item 2.
 *
 * Pins the ORDER of the checks as well as each refusal: length 0, over 1 MB, not a zip, unsafe name at open, more than 10
 * entries, nested archive (BEFORE the allow-list), name allow-list, declared sizes over 5 MB (nothing inflated), read every entry
 * with a byte cap (size mismatch), and only THEN exactly one workbook.
 */
import { readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSettlementZip, normalizeXlsx } from '../../src/settlement-intake/safe-zip';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';
import { FIXTURE_DIR, SIX_MB_OF_ZEROS, fixture, manyEntries, refusalOf, spyOnFsWrites, zipBytes } from './t511-s3-helpers';

const ORDER_ZIPS = [
  'foodpanda-banay-oct19-34col.zip',
  'foodpanda-malvar-oct12-34col.zip',
  'foodpanda-lipa-oct5-34col.zip',
  'foodpanda-lipa-oct19-34col-feerow.zip',
  'foodpanda-lipa-jul15-32col.zip',
  'foodpanda-lipa-oct5a-appendix-b-only-pandago.zip',
];

function tmpSuspects(): string[] {
  return readdirSync(os.tmpdir()).filter((n) => /escape|payload|settlement|yauzl|\.pdf$|\.xls|\.zip$/i.test(n));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openSettlementZip: the six real Foodpanda zips', () => {
  it.each(ORDER_ZIPS)('%s gives the workbook (starts with PK) and the synthetic PDF stub', async (name) => {
    const out = await openSettlementZip(fixture(name));
    expect(Buffer.isBuffer(out.workbook)).toBe(true);
    expect(out.workbook.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(out.workbook.length).toBeGreaterThan(1000);
    expect(Buffer.isBuffer(out.pdf)).toBe(true);
    expect((out.pdf as Buffer).subarray(0, 4).toString('latin1')).toBe('%PDF');
    // The PDF stub is a few hundred bytes, never the 90 KB real invoice (fixtures are redacted).
    expect((out.pdf as Buffer).length).toBeLessThan(2000);
  });

  it('the workbook handed back is the .xls entry (the Malvar workbook is 19,309 bytes), not the pdf', async () => {
    const out = await openSettlementZip(fixture('foodpanda-malvar-oct12-34col.zip'));
    expect(out.workbook.length).toBe(19309);
  });

  it('a zip with only the workbook and no pdf gives pdf null', async () => {
    const out = await openSettlementZip(zipBytes([{ name: '20261015_200593770746.xls', data: Buffer.from('PK-not-parsed-here') }]));
    expect(out.pdf).toBeNull();
    expect(out.workbook.toString()).toBe('PK-not-parsed-here');
  });

  it('writes nothing to disk and creates no temp file (fs write spies stay silent)', async () => {
    const before = new Set(tmpSuspects());
    const spies = spyOnFsWrites();
    for (const name of ORDER_ZIPS) await openSettlementZip(fixture(name));
    expect(spies.calls()).toEqual([]);
    expect(tmpSuspects().filter((n) => !before.has(n))).toEqual([]);
  });
});

describe('openSettlementZip: hostile fixtures, one refusal each', () => {
  it.each([
    ['hostile-zip-11-entries.zip', 'ZIP_TOO_MANY_ENTRIES'],
    ['hostile-zip-expands-over-5mb.zip', 'ZIP_TOO_BIG_EXPANDED'],
    ['hostile-zip-lying-size.zip', 'ZIP_SIZE_MISMATCH'],
    ['hostile-zip-nested-archive.zip', 'ZIP_NESTED_ARCHIVE'],
    ['hostile-zip-bad-extension.zip', 'ZIP_ENTRY_NOT_ALLOWED'],
    ['hostile-zip-path-traversal.zip', 'ZIP_UNSAFE_NAME'],
    ['hostile-not-a-zip.zip', 'ZIP_NOT_A_ZIP'],
    ['hostile-empty.zip', 'FILE_EMPTY'],
  ])('%s -> %s', async (name, code) => {
    const r = await refusalOf(() => openSettlementZip(fixture(name)));
    expect(r).toBeInstanceOf(SettlementIntakeRefusal);
    expect(r.code).toBe(code);
    expect(r.userMessage.length).toBeGreaterThan(10);
  });

  it('the bad-extension refusal names the entry', async () => {
    const r = await refusalOf(() => openSettlementZip(fixture('hostile-zip-bad-extension.zip')));
    expect(r.userMessage).toContain('payload.exe');
  });

  it('the expands-over-5mb zip is refused from DECLARED sizes: nothing is inflated (the 6 MB entry is never read)', async () => {
    // A reader that inflated the 6 MB pdf before refusing would take far longer than a listing; 1.5 s is generous even on a busy machine.
    const t0 = Date.now();
    await refusalOf(() => openSettlementZip(fixture('hostile-zip-expands-over-5mb.zip')));
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('path traversal never touches disk: no fs write call, no ../escape.pdf next to the temp dir, the cwd or the fixtures', async () => {
    const before = new Set(tmpSuspects());
    const spies = spyOnFsWrites();
    const r = await refusalOf(() => openSettlementZip(fixture('hostile-zip-path-traversal.zip')));
    expect(r.code).toBe('ZIP_UNSAFE_NAME');
    expect(spies.calls()).toEqual([]);
    expect(tmpSuspects().filter((n) => !before.has(n))).toEqual([]);
    for (const base of [os.tmpdir(), process.cwd(), FIXTURE_DIR, join(FIXTURE_DIR, 'sub')]) {
      expect(existsSync(join(base, '..', 'escape.pdf'))).toBe(false);
      expect(existsSync(join(base, 'escape.pdf'))).toBe(false);
    }
  });

  it('a file cut off in the middle is not a zip', async () => {
    const whole = fixture('foodpanda-malvar-oct12-34col.zip');
    const r = await refusalOf(() => openSettlementZip(whole.subarray(0, 60)));
    expect(r.code).toBe('ZIP_NOT_A_ZIP');
  });

  it('an empty buffer is FILE_EMPTY (length 0 is checked before anything else)', async () => {
    expect((await refusalOf(() => openSettlementZip(Buffer.alloc(0)))).code).toBe('FILE_EMPTY');
  });

  it('a zip over 1 MB (a real, well-formed 1.1 MB zip) is FILE_TOO_BIG before it is opened', async () => {
    const big = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(1_100_000, 7), method: 'store' },
      { name: 'a.pdf', data: Buffer.from('%PDF-1.4') },
    ]);
    expect(big.length).toBeGreaterThan(1_100_000);
    expect((await refusalOf(() => openSettlementZip(big))).code).toBe('FILE_TOO_BIG');
  });
});

describe('openSettlementZip: the ORDER of the checks (generated zips with honest headers)', () => {
  it('11 entries with bad names: the entry count is checked before any name', async () => {
    const r = await refusalOf(() => openSettlementZip(zipBytes(manyEntries(11, 'exe'))));
    expect(r.code).toBe('ZIP_TOO_MANY_ENTRIES');
  });

  it('exactly 10 entries is allowed by the count (it then fails on the missing workbook, not on the count)', async () => {
    const r = await refusalOf(() => openSettlementZip(zipBytes(manyEntries(10, 'pdf'))));
    expect(r.code).toBe('ZIP_NO_WORKBOOK');
  });

  it.each(['zip', 'xlsx', 'gz', '7z', 'rar', 'tar'])('a nested .%s is ZIP_NESTED_ARCHIVE even when a .exe is listed BEFORE it (nested check precedes the allow-list)', async (ext) => {
    const z = zipBytes([
      { name: 'first.exe', data: Buffer.from('x') },
      { name: `inner.${ext}`, data: Buffer.from('x') },
      { name: 'doc.xls', data: Buffer.from('x') },
    ]);
    expect((await refusalOf(() => openSettlementZip(z))).code).toBe('ZIP_NESTED_ARCHIVE');
  });

  it('a disallowed name beats the expanded-size check (names before sizes), and the entry is named', async () => {
    const z = zipBytes([
      { name: 'big.pdf', data: SIX_MB_OF_ZEROS() },
      { name: 'payload.exe', data: Buffer.from('x') },
    ]);
    const r = await refusalOf(() => openSettlementZip(z));
    expect(r.code).toBe('ZIP_ENTRY_NOT_ALLOWED');
    expect(r.userMessage).toContain('payload.exe');
  });

  it('the 5 MB cap is on the SUM of declared sizes: two honest 3 MB entries are refused even though neither alone is over', async () => {
    const z = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(3 * 1024 * 1024) },
      { name: 'a.pdf', data: Buffer.alloc(3 * 1024 * 1024) },
    ]);
    expect((await refusalOf(() => openSettlementZip(z))).code).toBe('ZIP_TOO_BIG_EXPANDED');
  });

  it('a pdf-only zip that expands over 5 MB reports the size, not the missing workbook (size check precedes the workbook check)', async () => {
    const z = zipBytes([{ name: 'big.pdf', data: SIX_MB_OF_ZEROS() }]);
    expect((await refusalOf(() => openSettlementZip(z))).code).toBe('ZIP_TOO_BIG_EXPANDED');
  });

  it('a zip just under the cap (4.9 MB expanded of zeros) is accepted', async () => {
    const z = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(2 * 1024 * 1024) },
      { name: 'a.pdf', data: Buffer.alloc(3_000_000) },
    ]);
    const out = await openSettlementZip(z);
    expect(out.workbook.length).toBe(2 * 1024 * 1024);
  });

  it('the lying-size zip (only a pdf) reports the size problem, not ZIP_NO_WORKBOOK: every entry is READ before the workbook is required', async () => {
    expect((await refusalOf(() => openSettlementZip(fixture('hostile-zip-lying-size.zip')))).code).toBe('ZIP_SIZE_MISMATCH');
  });

  it('no workbook: a pdf only, two workbooks, and a valid zip with no entries are all ZIP_NO_WORKBOOK', async () => {
    const onlyPdf = zipBytes([{ name: 'a.pdf', data: Buffer.from('%PDF-1.4') }]);
    const two = zipBytes([
      { name: 'a.xls', data: Buffer.from('x') },
      { name: 'b.xls', data: Buffer.from('y') },
    ]);
    const none = zipBytes([]);
    for (const z of [onlyPdf, two, none]) expect((await refusalOf(() => openSettlementZip(z))).code).toBe('ZIP_NO_WORKBOOK');
  });
});

describe('normalizeXlsx: the same listing and streaming checks on the inner workbook (max 30 entries, 5 MB expanded)', () => {
  it('accepts every real workbook: the five order workbooks, the B-only workbook, the inline-strings variant and the two hostile-column workbooks', async () => {
    for (const name of ORDER_ZIPS) {
      const { workbook } = await openSettlementZip(fixture(name));
      await expect(normalizeXlsx(workbook)).resolves.toBeInstanceOf(Buffer);
    }
    for (const name of ['variant-xlsx-openpyxl-inline-strings.xlsx', 'hostile-xlsx-unknown-extra-column.xlsx', 'hostile-xlsx-missing-order-date.xlsx']) {
      await expect(normalizeXlsx(fixture(name))).resolves.toBeInstanceOf(Buffer);
    }
  });

  it('30 entries pass, 31 are ZIP_TOO_MANY_ENTRIES (a generated zip: the cap is 30)', async () => {
    await expect(normalizeXlsx(zipBytes(manyEntries(30, 'xml', 'xl/p')))).resolves.toBeInstanceOf(Buffer);
    const r = await refusalOf(() => normalizeXlsx(zipBytes(manyEntries(31, 'xml', 'xl/p'))));
    expect(r.code).toBe('ZIP_TOO_MANY_ENTRIES');
  });

  it('a declared-expansion bomb (a 12 MB shared-strings part inside a tiny file) is ZIP_TOO_BIG_EXPANDED', async () => {
    const bomb = zipBytes([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/sharedStrings.xml', data: Buffer.alloc(12 * 1024 * 1024) },
    ]);
    expect(bomb.length).toBeLessThan(100_000);
    expect((await refusalOf(() => normalizeXlsx(bomb))).code).toBe('ZIP_TOO_BIG_EXPANDED');
  });

  it('a lying inner archive (headers say 100 bytes, the stream inflates to 6 MB) is ZIP_SIZE_MISMATCH', async () => {
    expect((await refusalOf(() => normalizeXlsx(fixture('hostile-zip-lying-size.zip')))).code).toBe('ZIP_SIZE_MISMATCH');
  });

  it('something that is not a zip, and an empty buffer, are refused by name', async () => {
    expect((await refusalOf(() => normalizeXlsx(fixture('hostile-not-a-zip.zip')))).code).toBe('ZIP_NOT_A_ZIP');
    expect((await refusalOf(() => normalizeXlsx(fixture('hostile-empty.xlsx')))).code).toBe('FILE_EMPTY');
  });

  it('writes nothing to disk', async () => {
    const spies = spyOnFsWrites();
    const { workbook } = await openSettlementZip(fixture('foodpanda-banay-oct19-34col.zip'));
    await normalizeXlsx(workbook);
    await refusalOf(() => normalizeXlsx(zipBytes(manyEntries(31, 'xml'))));
    expect(spies.calls()).toEqual([]);
  });
});
