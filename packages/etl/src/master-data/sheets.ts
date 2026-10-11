/**
 * T-391 S2 - the CSV sheets Ian answers. UTF-8 with a BOM so Excel opens it, RFC 4180 quoting, and a parser that
 * accepts Excel's re-save (BOM, CRLF, quoted commas and quotes). `rowKey` is R11: 12 hex of sha256 over the v1 inputs a
 * row decides. `assertSheetsOutsideRepo` is R9: sheets hold names, so they never live in the work tree.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const BOM = '﻿';

const quote = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, string>>): string {
  const lines = [columns.map(quote).join(',')];
  for (const r of rows) lines.push(columns.map((c) => quote(r[c] ?? '')).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      if (started || field !== '' || row.length > 0) {
        row.push(field);
        records.push(row);
      }
      row = [];
      field = '';
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const header = records.shift();
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return records
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ''])));
}

/**
 * 'k' + the first 12 hex of sha256 over the inputs (R11). The letter keeps a spreadsheet from reading a key such as
 * 123456e78901 as a number. The separator cannot occur in a name, so ("a","bc") differs from ("ab","c").
 */
export function rowKey(...inputs: Array<string | number | null | undefined>): string {
  const hex = createHash('sha256')
    .update(inputs.map((x) => String(x ?? '')).join(String.fromCharCode(1)))
    .digest('hex')
    .slice(0, 12);
  return `k${hex}`;
}

/** realpath of the deepest existing ancestor, with the not-yet-created tail put back (so a junction is followed). */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(basename(cur));
    cur = up;
  }
  let base = cur;
  try {
    base = realpathSync.native(cur);
  } catch {
    /* keep the resolved path */
  }
  return join(base, ...tail);
}

/** Every checkout of this repository: the given root and, when it is a worktree, the main tree. */
function checkoutsOf(repoRoot: string): string[] {
  const out = [realish(repoRoot)];
  try {
    const dotgit = join(repoRoot, '.git');
    if (existsSync(dotgit) && statSync(dotgit).isFile()) {
      const gitdir = /gitdir:\s*(.+)/.exec(readFileSync(dotgit, 'utf8'))?.[1]?.trim();
      if (gitdir) {
        const commonFile = join(gitdir, 'commondir');
        const common = resolve(gitdir, existsSync(commonFile) ? readFileSync(commonFile, 'utf8').trim() : '../..');
        out.push(realish(dirname(common)));
      }
    }
  } catch {
    /* not a worktree */
  }
  return out;
}

export function assertSheetsOutsideRepo(dir: string, repoRoot: string): void {
  const d = realish(dir).toLowerCase();
  for (const root of checkoutsOf(repoRoot)) {
    const r = root.toLowerCase();
    if (d === r || d.startsWith(r.endsWith(sep) ? r : r + sep)) {
      throw new Error(`The directory ${resolve(dir)} is inside a checkout of the repository (${root}). Sheets and snapshots hold names; use a directory outside every checkout (R9).`);
    }
  }
}
