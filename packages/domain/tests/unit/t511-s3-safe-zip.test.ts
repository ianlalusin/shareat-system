/**
 * T-511 S3 (A) - the safe zip reader. `docs/tasks/511-settlement-upload-s3-spec.md` item 2.
 *
 * Pins the ORDER of the checks as well as each refusal: length 0, over 3 MB, not a zip, unsafe name at open, more than 40
 * entries, nested archive (BEFORE the allow-list), name allow-list, declared sizes over 15 MB (nothing inflated), read every entry
 * with a byte cap (size mismatch), and only THEN at least one workbook (T-511 S8a: the caps were 1 MB / 10 files / 5 MB; a zip may now
 * hold several invoice workbooks, each paired with the pdf of the same name).
 */
import { readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSettlementZip, openSettlementZipMembers, normalizeXlsx, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, ZIP_MAX_EXPANDED, ZIP_MAX_WORKBOOKS } from '../../src/settlement-intake/safe-zip';
import { PURPOSE_LIMITS } from '../../src/files/limits';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';
import { FIXTURE_DIR, SIXTEEN_MB_OF_ZEROS, fixture, manyEntries, refusalOf, spyOnFsWrites, zipBytes } from './t511-s3-helpers';

const MB = 1024 * 1024;

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

  it('41 entries and a 16 MB expansion are refused by name (generated: the two old fixtures sat under the new caps)', async () => {
    expect((await refusalOf(() => openSettlementZip(zipBytes(manyEntries(41, 'pdf'))))).code).toBe('ZIP_TOO_MANY_ENTRIES');
    expect((await refusalOf(() => openSettlementZip(zipBytes([{ name: 'a.xls', data: SIXTEEN_MB_OF_ZEROS() }])))).code).toBe('ZIP_TOO_BIG_EXPANDED');
  });

  it('the bad-extension refusal names the entry', async () => {
    const r = await refusalOf(() => openSettlementZip(fixture('hostile-zip-bad-extension.zip')));
    expect(r.userMessage).toContain('payload.exe');
  });

  it('a zip that expands over 15 MB is refused from DECLARED sizes: nothing is inflated (the 16 MB entry is never read)', async () => {
    // A reader that inflated the 16 MB pdf before refusing would take far longer than a listing; 1.5 s is generous even on a busy machine.
    const bomb = zipBytes([{ name: 'a.pdf', data: SIXTEEN_MB_OF_ZEROS() }]);
    const t0 = Date.now();
    await refusalOf(() => openSettlementZip(bomb));
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

  it('a zip over 3 MB (a real, well-formed 3.2 MB zip) is FILE_TOO_BIG before it is opened', async () => {
    const big = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(3_200_000, 7), method: 'store' },
      { name: 'a.pdf', data: Buffer.from('%PDF-1.4') },
    ]);
    expect(big.length).toBeGreaterThan(3_200_000);
    expect((await refusalOf(() => openSettlementZip(big))).code).toBe('FILE_TOO_BIG');
  });
});

describe('openSettlementZip: the ORDER of the checks (generated zips with honest headers)', () => {
  it('41 entries with bad names: the entry count is checked before any name', async () => {
    const r = await refusalOf(() => openSettlementZip(zipBytes(manyEntries(41, 'exe'))));
    expect(r.code).toBe('ZIP_TOO_MANY_ENTRIES');
  });

  it('exactly 40 entries is allowed by the count (it then fails on the missing workbook, not on the count)', async () => {
    const r = await refusalOf(() => openSettlementZip(zipBytes(manyEntries(40, 'pdf'))));
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
      { name: 'big.pdf', data: SIXTEEN_MB_OF_ZEROS() },
      { name: 'payload.exe', data: Buffer.from('x') },
    ]);
    const r = await refusalOf(() => openSettlementZip(z));
    expect(r.code).toBe('ZIP_ENTRY_NOT_ALLOWED');
    expect(r.userMessage).toContain('payload.exe');
  });

  it('the 15 MB cap is on the SUM of declared sizes: two honest 8 MB entries are refused even though neither alone is over', async () => {
    const z = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(8 * MB) },
      { name: 'a.pdf', data: Buffer.alloc(8 * MB) },
    ]);
    expect((await refusalOf(() => openSettlementZip(z))).code).toBe('ZIP_TOO_BIG_EXPANDED');
  });

  it('a pdf-only zip that expands over 15 MB reports the size, not the missing workbook (size check precedes the workbook check)', async () => {
    const z = zipBytes([{ name: 'big.pdf', data: SIXTEEN_MB_OF_ZEROS() }]);
    expect((await refusalOf(() => openSettlementZip(z))).code).toBe('ZIP_TOO_BIG_EXPANDED');
  });

  it('a zip just under the cap (14.9 MB expanded of zeros) is accepted', async () => {
    const z = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(7 * MB) },
      { name: 'a.pdf', data: Buffer.alloc(7_900_000) },
    ]);
    const out = await openSettlementZip(z);
    expect(out.workbook.length).toBe(7 * MB);
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

describe('openSettlementZip: each S8a cap has a test on both sides of the line', () => {
  it('the caps are 40 files, 3 MB compressed (the per-file upload limit) and 15 MB opened', () => {
    expect(ZIP_MAX_ENTRIES).toBe(40);
    expect(ZIP_MAX_BYTES).toBe(3 * MB);
    expect(ZIP_MAX_BYTES).toBe(PURPOSE_LIMITS.channel_settlement_file.maxBytes);
    expect(ZIP_MAX_EXPANDED).toBe(15 * MB);
    expect(ZIP_MAX_WORKBOOKS).toBe(20);
  });

  it('workbooks: 20 invoices (20 pairs = 40 entries) are opened, a 21st is refused in plain words [kills: no workbook cap; a cap off by one]', async () => {
    const pairs = (n: number): { name: string; data: Buffer }[] =>
      Array.from({ length: n }, (_, i) => [
        { name: `inv${i}.xls`, data: Buffer.from(`wb ${i}`) },
        { name: `inv${i}.pdf`, data: Buffer.from(`pdf ${i}`) },
      ]).flat();
    expect(await openSettlementZipMembers(zipBytes(pairs(20)))).toHaveLength(20);
    const onlyBooks = Array.from({ length: 21 }, (_, i) => ({ name: `inv${i}.xls`, data: Buffer.from(`wb ${i}`) }));
    const r = await refusalOf(() => openSettlementZipMembers(zipBytes(onlyBooks)));
    expect(r.code).toBe('ZIP_TOO_MANY_ENTRIES');
    expect(r.userMessage).toBe('The zip holds 21 invoices, more than the 20 one zip may hold, so it was refused. Split it into smaller zips.');
    // 21 pairs is 42 entries: the file-count cap speaks first, as before
    expect((await refusalOf(() => openSettlementZipMembers(zipBytes(pairs(21))))).userMessage).toBe('The zip holds more than 40 files, so it was refused.');
  });

  it('entries: 40 pass the count, 41 are ZIP_TOO_MANY_ENTRIES', async () => {
    expect((await refusalOf(() => openSettlementZip(zipBytes(manyEntries(40, 'pdf'))))).code).toBe('ZIP_NO_WORKBOOK');
    expect((await refusalOf(() => openSettlementZip(zipBytes(manyEntries(41, 'pdf'))))).code).toBe('ZIP_TOO_MANY_ENTRIES');
  });

  it('compressed size: exactly 3 MB is opened, one byte more is FILE_TOO_BIG', async () => {
    const overhead = zipBytes([{ name: 'a.xls', data: Buffer.alloc(0), method: 'store' }]).length;
    const exact = zipBytes([{ name: 'a.xls', data: Buffer.alloc(3 * MB - overhead, 7), method: 'store' }]);
    expect(exact.length).toBe(3 * MB);
    expect((await openSettlementZip(exact)).workbook.length).toBe(3 * MB - overhead);
    const over = zipBytes([{ name: 'a.xls', data: Buffer.alloc(3 * MB - overhead + 1, 7), method: 'store' }]);
    expect(over.length).toBe(3 * MB + 1);
    expect((await refusalOf(() => openSettlementZip(over))).code).toBe('FILE_TOO_BIG');
  });

  it('opened size: exactly 15 MB is accepted, one byte more is ZIP_TOO_BIG_EXPANDED', async () => {
    const ok = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(7 * MB) },
      { name: 'a.pdf', data: Buffer.alloc(8 * MB) },
    ]);
    expect((await openSettlementZip(ok)).workbook.length).toBe(7 * MB);
    const over = zipBytes([
      { name: 'a.xls', data: Buffer.alloc(7 * MB) },
      { name: 'a.pdf', data: Buffer.alloc(8 * MB + 1) },
    ]);
    expect((await refusalOf(() => openSettlementZip(over))).code).toBe('ZIP_TOO_BIG_EXPANDED');
  });
});

describe('openSettlementZipMembers: many workbooks, each with the pdf of the same name', () => {
  it('gives one member per workbook, in listing order, paired by base name (case does not matter); an unpaired pdf is ignored', async () => {
    const z = zipBytes([
      { name: 'b.xls', data: Buffer.from('wb-b') },
      { name: 'a.PDF', data: Buffer.from('pdf-a') },
      { name: 'a.xls', data: Buffer.from('wb-a') },
      { name: 'b.pdf', data: Buffer.from('pdf-b') },
      { name: 'stray.pdf', data: Buffer.from('pdf-stray') },
      { name: 'c.xls', data: Buffer.from('wb-c') },
    ]);
    const members = await openSettlementZipMembers(z);
    expect(members.map((m) => m.name)).toEqual(['b.xls', 'a.xls', 'c.xls']);
    expect(members.map((m) => m.workbook.toString())).toEqual(['wb-b', 'wb-a', 'wb-c']);
    expect(members.map((m) => m.pdf?.toString() ?? null)).toEqual(['pdf-b', 'pdf-a', null]);
    expect(members.map((m) => m.pdfName)).toEqual(['b.pdf', 'a.PDF', null]);
  });

  it('a folder keeps two same-named workbooks apart: a/x.xls takes a/x.pdf, never b/x.pdf', async () => {
    const members = await openSettlementZipMembers(
      zipBytes([
        { name: 'b/x.pdf', data: Buffer.from('pdf-b') },
        { name: 'a/x.xls', data: Buffer.from('wb-a') },
        { name: 'a/x.pdf', data: Buffer.from('pdf-a') },
      ]),
    );
    expect(members).toHaveLength(1);
    expect(members[0]?.pdf?.toString()).toBe('pdf-a');
  });

  it('a zip with no workbook gives no members; the one-workbook reader still insists on exactly one', async () => {
    const onePdf = zipBytes([{ name: 'a.pdf', data: Buffer.from('%PDF-1.4') }]);
    expect(await openSettlementZipMembers(onePdf)).toEqual([]);
    const two = zipBytes([
      { name: 'a.xls', data: Buffer.from('x') },
      { name: 'b.xls', data: Buffer.from('y') },
    ]);
    expect(await openSettlementZipMembers(two)).toHaveLength(2);
    expect((await refusalOf(() => openSettlementZip(two))).code).toBe('ZIP_NO_WORKBOOK');
  });

  it('every hostile-file protection still applies to a many-workbook zip (nested archive, bad name)', async () => {
    const nested = zipBytes([
      { name: 'a.xls', data: Buffer.from('x') },
      { name: 'b.xls', data: Buffer.from('y') },
      { name: 'inner.zip', data: Buffer.from('z') },
    ]);
    expect((await refusalOf(() => openSettlementZipMembers(nested))).code).toBe('ZIP_NESTED_ARCHIVE');
    const exe = zipBytes([
      { name: 'a.xls', data: Buffer.from('x') },
      { name: 'b.xls', data: Buffer.from('y') },
      { name: 'payload.exe', data: Buffer.from('z') },
    ]);
    expect((await refusalOf(() => openSettlementZipMembers(exe))).code).toBe('ZIP_ENTRY_NOT_ALLOWED');
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
