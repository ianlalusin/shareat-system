/**
 * T-394 R9 - the rehearsal journal: ONE local JSON file per rehearsal (database), in REHEARSAL_DIR. No table, no migration, nothing on
 * the copy for the purge to treat as data. A step with no end mark is reported NOT TIMED, never as zero.
 * docs/tasks/394-purge-and-opening-rehearsal.md s4 R9, s6 I12.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StartSnapshot } from './checks';

type Env = Record<string, string | undefined>;

export interface JournalStep {
  code: string;
  startedAt: string;
  endedAt?: string;
  by?: string;
  result?: string;
}

/** S2: one verify/report check outcome. `detail` is FREE TEXT (may name a store or an amount): it goes to the full report only. */
export interface JournalCheck {
  name: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface Journal {
  database: string;
  openedAt: string;
  start?: { at: string; snapshot: StartSnapshot; migrationCount: number | null; /** false when the DEF-585 coverage check failed: purge refuses. */ coverageOk?: boolean };
  steps: JournalStep[];
  predump?: { dir: string; manifestPath: string };
  /** The instant the --apply child exited (the purge commit), for the R13 freeze check in S2. */
  purgeCommittedAt?: string;
  /** S2: the latest outcome of each named check (a re-run replaces the same name). */
  checks?: JournalCheck[];
}

/** REHEARSAL_DIR, default the OS temp dir; never inside the repo. Throws when it is. */
export function rehearsalDir(env: Env, repoRoot: string = process.cwd()): string {
  const dir = path.resolve(env.REHEARSAL_DIR && env.REHEARSAL_DIR.trim() !== '' ? env.REHEARSAL_DIR : path.join(tmpdir(), 'shareat-rehearsal'));
  const rel = path.relative(path.resolve(repoRoot), dir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('REHEARSAL_DIR must be outside the repository (production data stays out of the repo)');
  }
  return dir;
}

export const journalPath = (dir: string, database: string): string => path.join(dir, `${database}.journal.json`);

export function readJournal(dir: string, database: string): Journal | null {
  const p = journalPath(dir, database);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Journal) : null;
}

/** Journal and full report may name people, stores and amounts: dir 0700, file 0600 (best effort where the OS has no modes). */
export function writeSecret(file: string, text: string): void {
  const d = path.dirname(file);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    chmodSync(d, 0o700);
  } catch {
    /* no modes on this OS */
  }
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* no modes on this OS */
  }
}

export function writeJournal(dir: string, j: Journal): void {
  writeSecret(journalPath(dir, j.database), JSON.stringify(j, null, 2) + '\n');
}

export function newJournal(database: string, now: Date): Journal {
  return { database, openedAt: now.toISOString(), steps: [] };
}

/** Opens a step (or re-opens it, replacing an earlier mark of the same code). */
export function markStart(j: Journal, code: string, now: Date, by?: string): void {
  j.steps = j.steps.filter((s) => s.code !== code);
  j.steps.push({ code, startedAt: now.toISOString(), ...(by ? { by } : {}) });
}

export function markEnd(j: Journal, code: string, now: Date, result?: string, by?: string): boolean {
  const s = [...j.steps].reverse().find((x) => x.code === code);
  if (!s) return false;
  s.endedAt = now.toISOString();
  if (result) s.result = result;
  if (by) s.by = by;
  return true;
}

/** Records a check outcome, replacing an earlier one of the same name. */
export function recordCheck(j: Journal, name: string, ok: boolean, detail: string, now: Date): void {
  j.checks = (j.checks ?? []).filter((c) => c.name !== name);
  j.checks.push({ name, ok, detail, at: now.toISOString() });
}

/** Whole seconds from the marks, or 'NOT TIMED' when the end mark is missing (never zero). */
export function durationOf(s: JournalStep): number | 'NOT TIMED' | 'NOT TIMED (end before start)' {
  if (!s.endedAt) return 'NOT TIMED';
  const ms = Date.parse(s.endedAt) - Date.parse(s.startedAt);
  if (!(ms >= 0)) return 'NOT TIMED (end before start)';
  return Math.round(ms / 1000);
}

/** The newest `*.manifest.json` anywhere under `dir`, or null. */
export function newestManifest(dir: string): string | null {
  const found: { p: string; t: number }[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (n.endsWith('.manifest.json')) found.push({ p, t: st.mtimeMs });
    }
  };
  walk(dir);
  found.sort((a, b) => a.t - b.t);
  return found.length > 0 ? (found[found.length - 1] as { p: string }).p : null;
}
