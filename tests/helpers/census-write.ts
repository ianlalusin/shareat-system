/**
 * T-604 S4: the write half of the census tests. `npm run census:write` (scripts/census-write.mjs) sets CENSUS_WRITE=1 and
 * CENSUS_REPORT=<file>; each census test then calls one function here just before it asserts.
 *
 * Ratchets only tighten in write mode: a lower count is written; a higher count or a new entry is NOT written, it prints
 * `NEEDS APPROVAL: <file> <key> <old> -> <new>` (and is appended to CENSUS_REPORT) and the test stays red.
 * Outside write mode every function here does nothing.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export const censusWriting = (): boolean => process.env.CENSUS_WRITE === '1';

export function needsApproval(file: string, key: string, from: unknown, to: unknown): void {
  const line = `NEEDS APPROVAL: ${basename(file)} ${key} ${String(from)} -> ${String(to)}`;
  console.log(line);
  if (process.env.CENSUS_REPORT) appendFileSync(process.env.CENSUS_REPORT, `${line}\n`);
}

/** Writes JSON back in the file's own indent, LF only, one trailing newline. */
function writeLikeBefore(file: string, raw: string, value: unknown): void {
  const indent = /^\{\r?\n( +)"/.exec(raw)?.[1]?.length ?? 2;
  const text = `${JSON.stringify(value, null, indent)}\n`;
  if (text !== raw.replace(/\r\n/g, '\n')) writeFileSync(file, text);
}

function readRaw(file: string): { raw: string; json: Record<string, unknown> } {
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n';
  return { raw, json: JSON.parse(raw) as Record<string, unknown> };
}

/** `section` null = the counts sit at the top of the file (keys starting `_` are notes); else under `json[section]` (or `json.files`). */
function pick(json: Record<string, unknown>, section: string | null): Record<string, number> {
  const holder = section === null ? json : (json[section] as Record<string, unknown>);
  return Object.fromEntries(Object.entries(holder).filter(([k]) => !k.startsWith('_'))) as Record<string, number>;
}

function put(json: Record<string, unknown>, section: string | null, next: Record<string, number>): Record<string, unknown> {
  if (section !== null) return { ...json, [section]: next };
  const notes = Object.fromEntries(Object.entries(json).filter(([k]) => k.startsWith('_')));
  return { ...notes, ...next };
}

/** Per-file counts: lowers a baseline entry to the measured count (deletes it at 0); a raise or a new file needs approval. */
export function lowerCounts(file: string, actual: Record<string, number>, section: string | null = null): void {
  if (!censusWriting()) return;
  const { raw, json } = readRaw(file);
  const base = pick(json, section);
  const next: Record<string, number> = {};
  for (const [k, n] of Object.entries(base)) {
    const now = actual[k] ?? 0;
    if (now > n) needsApproval(file, k, n, now);
    if (now >= n) next[k] = n;
    else if (now > 0) next[k] = now;
  }
  for (const [k, now] of Object.entries(actual)) if (!(k in base) && now > 0) needsApproval(file, k, 0, now);
  writeLikeBefore(file, raw, put(json, section, next));
}

/** A list of file names: removes entries that no longer apply; a new entry needs approval. */
export function lowerList(file: string, section: string, actual: string[]): void {
  if (!censusWriting()) return;
  const { raw, json } = readRaw(file);
  const base = json[section] as string[];
  for (const k of actual) if (!base.includes(k)) needsApproval(file, k, 'absent', 'present');
  writeLikeBefore(file, raw, { ...json, [section]: base.filter((k) => actual.includes(k)) });
}

/** Per-file multisets (touch targets: heights or reasons). Entries no longer reproduced are removed; an extra needs approval. */
export function lowerMultisets(file: string, section: string, actual: Record<string, (string | number)[]>): void {
  if (!censusWriting()) return;
  const { raw, json } = readRaw(file);
  const base = json[section] as Record<string, (string | number)[]>;
  const next: Record<string, (string | number)[]> = {};
  for (const [f, items] of Object.entries(base)) {
    const left = [...(actual[f] ?? [])];
    const kept: (string | number)[] = [];
    for (const item of items) {
      const i = left.indexOf(item);
      if (i !== -1) {
        left.splice(i, 1);
        kept.push(item);
      }
    }
    for (const extra of left) needsApproval(file, `${section} ${f}`, 'absent', extra);
    if (kept.length > 0) next[f] = kept;
  }
  for (const [f, items] of Object.entries(actual)) {
    if (f in base) continue;
    for (const extra of items) needsApproval(file, `${section} ${f}`, 'absent', extra);
  }
  writeLikeBefore(file, raw, { ...json, [section]: next });
}

/** A small object of totals (written freely: totals are measurements, not ceilings). */
export function writeTotals(file: string, key: string, totals: Record<string, number>): void {
  if (!censusWriting()) return;
  const { raw, json } = readRaw(file);
  writeLikeBefore(file, raw, { ...json, [key]: totals });
}
