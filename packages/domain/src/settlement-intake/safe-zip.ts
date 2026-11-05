/**
 * T-511 S3 - the safe zip reader (`docs/tasks/511-settlement-upload-s3-spec.md` item 2). Everything happens in memory from a Buffer:
 * nothing is extracted to disk, no path is read, no temp file is made.
 *
 * Order of checks (pinned by tests): length 0, over 1 MB, open fails (not a zip), unsafe name (yauzl refuses it while listing), more than
 * 10 entries, nested archive (BEFORE the allow-list), name allow-list, declared sizes over 5 MB (nothing inflated), then READ every entry
 * through a byte counter (size mismatch), and only THEN require exactly one workbook. `normalizeXlsx` runs the same listing and streaming
 * checks on the inner workbook, then re-packs it, because neither xlsx library caps its own inflation. No time limit: a synchronous parse cannot be
 * interrupted; if a slow file ever appears, a worker thread is the fix.
 */
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { intakeRefusal, megabytes, shown } from './refusal';
import { storedZip } from './zip-repack';

const MB = 1024 * 1024;
export const ZIP_MAX_BYTES = 1 * MB;
export const ZIP_MAX_EXPANDED = 5 * MB;
export const ZIP_MAX_ENTRIES = 10;
// 8 MB: a 5,000-row invoice opens to about 6.8 MB (1.4 KB a row), so the 5,000-row cap must be reachable; real files peak near 437 KB.
// What the library then does with the sheets is contained by the worker (`xlsx-worker-host.ts`), not predicted here.
export const XLSX_MAX_EXPANDED = 8 * MB;
export const XLSX_MAX_ENTRIES = 30;

const NESTED_ARCHIVE = /\.(zip|xlsx|gz|7z|rar|tar)$/i;

/** yauzl's own refusals of a name (`../x`, `/x`, `C:x`, a backslash) come out of the listing as plain errors. */
function zipProblem(e: unknown): Error {
  const text = e instanceof Error ? e.message : String(e);
  if (/invalid relative path|absolute path|invalid characters in fileName/.test(text)) {
    return intakeRefusal('ZIP_UNSAFE_NAME', 'The zip holds a file whose name points outside the zip, so it was refused.');
  }
  if (/too (many|few) bytes|not enough bytes|file data overflows file bounds|size mismatch for stored file/.test(text)) {
    return intakeRefusal('ZIP_SIZE_MISMATCH', 'A file inside the zip is not the size the zip says it is, so it was refused.');
  }
  return intakeRefusal('ZIP_NOT_A_ZIP', 'This is not a valid zip file, or it is damaged.');
}

function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    try {
      yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
        if (err || !zipfile) reject(zipProblem(err));
        else resolve(zipfile);
      });
    } catch (e) {
      reject(zipProblem(e));
    }
  });
}

/** The first `limit + 1` entries (enough to see the cap is broken without walking a huge listing). */
function listEntries(zipfile: ZipFile, limit: number): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zipfile.on('error', (e: unknown) => reject(zipProblem(e)));
    zipfile.on('end', () => resolve(entries));
    zipfile.on('entry', (entry: Entry) => {
      entries.push(entry);
      if (entries.length > limit) resolve(entries);
      else zipfile.readEntry();
    });
    zipfile.readEntry();
  });
}

/** Streams one entry through a counter: more bytes than it declared, fewer bytes, or a running total over the cap all refuse. */
function readEntry(zipfile: ZipFile, entry: Entry, running: { total: number }, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(zipProblem(err));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = (reason: Error): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(reason);
      };
      const mismatch = (): Error => intakeRefusal('ZIP_SIZE_MISMATCH', 'A file inside the zip is not the size the zip says it is, so it was refused.');
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        running.total += chunk.length;
        if (size > entry.uncompressedSize) fail(mismatch());
        else if (running.total > cap) fail(intakeRefusal('ZIP_TOO_BIG_EXPANDED', `The zip holds more than ${megabytes(cap)} MB once opened, so it was refused.`));
        else chunks.push(chunk);
      });
      stream.on('error', (e: unknown) => fail(zipProblem(e)));
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        if (size !== entry.uncompressedSize) reject(mismatch());
        else resolve(Buffer.concat(chunks, size));
      });
    });
  });
}

const isDirectory = (entry: Entry): boolean => entry.fileName.endsWith('/');

/** Reads every file entry (directories carry no bytes), in listing order. */
async function readAll(zipfile: ZipFile, entries: Entry[], cap: number): Promise<Buffer[]> {
  const running = { total: 0 };
  const out: Buffer[] = [];
  for (const entry of entries) out.push(isDirectory(entry) ? Buffer.alloc(0) : await readEntry(zipfile, entry, running, cap));
  return out;
}

function checkCount(entries: Entry[], maxEntries: number): void {
  if (entries.length > maxEntries) {
    throw intakeRefusal('ZIP_TOO_MANY_ENTRIES', `The zip holds more than ${maxEntries} files, so it was refused.`);
  }
}

function checkDeclaredSize(entries: Entry[], maxExpanded: number): void {
  const declared = entries.reduce((n, e) => n + e.uncompressedSize, 0);
  if (declared > maxExpanded) {
    throw intakeRefusal('ZIP_TOO_BIG_EXPANDED', `The zip says it holds ${megabytes(declared)} MB once opened, over the ${megabytes(maxExpanded)} MB limit, so it was refused.`);
  }
}

function checkNotEmptyOrHuge(bytes: Buffer, maxBytes: number | null): void {
  if (bytes.length === 0) throw intakeRefusal('FILE_EMPTY', 'The file is empty, so there is nothing to read.');
  if (maxBytes !== null && bytes.length > maxBytes) {
    throw intakeRefusal('FILE_TOO_BIG', `The file is ${megabytes(bytes.length)} MB, over the ${megabytes(maxBytes)} MB limit.`);
  }
}

/**
 * A Foodpanda settlement zip: one `.xls` (really an xlsx) and, usually, one `.pdf`. Returns both as Buffers; the PDF is never read.
 */
export async function openSettlementZip(zip: Buffer): Promise<{ workbook: Buffer; pdf: Buffer | null }> {
  checkNotEmptyOrHuge(zip, ZIP_MAX_BYTES);
  const zipfile = await openZip(zip);
  try {
    const entries = await listEntries(zipfile, ZIP_MAX_ENTRIES);
    checkCount(entries, ZIP_MAX_ENTRIES);
    for (const e of entries) {
      if (NESTED_ARCHIVE.test(e.fileName)) {
        throw intakeRefusal('ZIP_NESTED_ARCHIVE', `The zip holds another archive ("${shown(e.fileName)}"), which is not allowed.`);
      }
    }
    for (const e of entries) {
      if (!/\.(xls|pdf)$/i.test(e.fileName)) {
        throw intakeRefusal('ZIP_ENTRY_NOT_ALLOWED', `The zip holds "${shown(e.fileName)}", which is not an invoice workbook (.xls) or a PDF.`);
      }
    }
    checkDeclaredSize(entries, ZIP_MAX_EXPANDED);
    const bytes = await readAll(zipfile, entries, ZIP_MAX_EXPANDED);
    const workbooks = entries.flatMap((e, i) => (/\.xls$/i.test(e.fileName) ? [bytes[i] as Buffer] : []));
    if (workbooks.length !== 1) {
      throw intakeRefusal('ZIP_NO_WORKBOOK', `The zip must hold exactly one invoice workbook (.xls); it holds ${workbooks.length}.`);
    }
    const pdfAt = entries.findIndex((e) => /\.pdf$/i.test(e.fileName));
    return { workbook: workbooks[0] as Buffer, pdf: pdfAt < 0 ? null : (bytes[pdfAt] as Buffer) };
  } finally {
    zipfile.close();
  }
}

/** A rels part is a short list of links; anything bigger than this is not one. */
export const XLSX_RELS_MAX_BYTES = 64 * 1024;
const RELS_TARGET_MAX = 1024;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const xlsxMalformed = (what: string): Error => intakeRefusal('XLSX_MALFORMED', `The workbook ${what}, so it was refused.`);

/** Every `Target="..."` of a rels part (plain string search, bounded): it must stay inside the zip when resolved from the part's own folder. */
function checkRelsTargets(partName: string, part: Buffer): void {
  if (part.length > XLSX_RELS_MAX_BYTES) throw xlsxMalformed('has a relationships part that is far larger than any real one');
  const text = part.toString('utf8');
  // `xl/_rels/workbook.xml.rels` resolves from `xl/`; `_rels/.rels` from the root.
  const slash = partName.lastIndexOf('/_rels/');
  const base = (partName.startsWith('_rels/') ? '' : slash < 0 ? '' : partName.slice(0, slash)).split('/').filter((s) => s !== '');
  let at = text.indexOf('Target');
  while (at >= 0) {
    let i = at + 'Target'.length;
    while (text.charAt(i) === ' ' || text.charAt(i) === '\t' || text.charAt(i) === '\n' || text.charAt(i) === '\r') i += 1;
    if (text.charAt(i) === '=') {
      i += 1;
      while (text.charAt(i) === ' ' || text.charAt(i) === '\t' || text.charAt(i) === '\n' || text.charAt(i) === '\r') i += 1;
      const quote = text.charAt(i);
      const end = quote === '"' || quote === "'" ? text.indexOf(quote, i + 1) : -1;
      if (end < 0 || end - i - 1 > RELS_TARGET_MAX) throw xlsxMalformed('has a link target that cannot be read');
      const target = text.slice(i + 1, end);
      if (target.includes('&') || target.includes('\\')) throw xlsxMalformed('has an encoded link target');
      if (!URL_SCHEME.test(target)) {
        const stack = target.startsWith('/') ? [] : [...base];
        for (const segment of target.split('/')) {
          if (segment === '' || segment === '.') continue;
          if (segment === '..') {
            if (stack.length === 0) throw xlsxMalformed('has a link that points outside the file');
            stack.pop();
          } else stack.push(segment);
        }
      }
    }
    at = text.indexOf('Target', at + 'Target'.length);
  }
}

/** DOCTYPE or ENTITY declarations anywhere (a byte search, no parser), and rels links that leave the zip. */
function checkXlsxParts(entries: Entry[], bytes: Buffer[]): void {
  entries.forEach((entry, i) => {
    if (isDirectory(entry)) return;
    const part = bytes[i] as Buffer;
    for (const marker of ['<!DOCTYPE', '<!doctype', '<!ENTITY', '<!entity']) {
      if (part.includes(marker)) throw xlsxMalformed('declares a document type or an entity, which invoices never do');
    }
    if (/\.rels$/i.test(entry.fileName)) checkRelsTargets(entry.fileName, part);
  });
}

/**
 * Re-packs what was read: ONLY the `.xml` and `.rels` parts (the library needs nothing else), names exactly, into a fresh stored zip with
 * the true sizes. A repeated name is XLSX_MALFORMED (two parts with one name would be read differently by different readers).
 */
function repackXlsx(entries: Entry[], bytes: Buffer[]): Buffer {
  const seen = new Set<string>();
  const parts: { name: string; data: Buffer }[] = [];
  entries.forEach((entry, i) => {
    if (isDirectory(entry)) return;
    if (seen.has(entry.fileName)) throw xlsxMalformed('holds two parts with the same name');
    seen.add(entry.fileName);
    if (/\.(xml|rels)$/i.test(entry.fileName)) parts.push({ name: entry.fileName, data: bytes[i] as Buffer });
  });
  return storedZip(parts);
}

/**
 * The inner workbook is itself a zip. Same listing and streaming checks (30 entries, 8 MB once opened) BEFORE `read-excel-file` sees it,
 * because that library inflates whatever it is given; plus the checks that are certain without predicting the library: no DOCTYPE or
 * ENTITY declaration, every rels link stays inside the zip, rels parts are small. What the library does with the sheets themselves (a far
 * cell, a million empty rows, a huge token) cannot be known here and is contained by the worker (`xlsx-worker-host.ts`). A wrong CRC is
 * not checked: the library fails on corrupt data.
 *
 * Returns the RE-PACKED workbook, and ONLY that may be given to the worker: the library walks the zip's local headers and allocates what
 * they declare (up to 4 GB, outside the V8 heap), while this function validates the central directory. The re-packed zip is built from
 * exactly the bytes read here, with the true sizes (see `zip-repack.ts`).
 */
export async function normalizeXlsx(workbook: Buffer): Promise<Buffer> {
  checkNotEmptyOrHuge(workbook, null);
  const zipfile = await openZip(workbook);
  try {
    const entries = await listEntries(zipfile, XLSX_MAX_ENTRIES);
    checkCount(entries, XLSX_MAX_ENTRIES);
    checkDeclaredSize(entries, XLSX_MAX_EXPANDED);
    const bytes = await readAll(zipfile, entries, XLSX_MAX_EXPANDED);
    checkXlsxParts(entries, bytes);
    return repackXlsx(entries, bytes);
  } finally {
    zipfile.close();
  }
}
