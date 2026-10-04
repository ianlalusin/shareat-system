/**
 * T-374 S2 / DEF-577 - the standing guard: nothing in `apps/erp/src` may take a date from the UTC (or
 * server-local) calendar of the CURRENT instant, and the few places that still do arithmetic on a UTC or
 * Manila-shifted date are a closed, counted allowlist.
 *
 * Spec: docs/tasks/374-money-push-follow-ups.md R2 + "S2" (G1-G3). The scanner is `tests/unit/lib/utc-today-census.ts`.
 *
 * ⭐ RED FIRST. On HEAD this fails naming ~40 real sites (the register's 19, the C/D sites the register missed,
 * and the review's `prepaid/lib.ts:96`). It goes green when the S2 builder converts them through `toBusinessDate`.
 *
 * ALLOWED is the state AFTER conversion. Each entry is a count plus one reason from a closed list. A new site or
 * a raised count fails; a count that FALLS must be lowered in the same commit (the t343 ratchet shape).
 *
 * Scope: `apps/erp/src` only (S1's and S4's domain files are measured by their own integration tests).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findUtcToday, scanTree, type UtcTodayFinding } from './lib/utc-today-census';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_DIRS = ['apps/erp/src', ...readdirSync(join(REPO_ROOT, 'packages')).map((p) => `packages/${p}/src`).filter((d) => existsSync(join(REPO_ROOT, d)))];

type Reason = 'utc-calendar-arithmetic' | 'manila-offset-ratchet' | 'manila-locale' | 'seed-window-parity';
interface Allowed {
  count: number;
  reason: Reason;
}

/**
 * Every finding that is NOT a conversion target. `count` is the number of findings in the file (all kinds), so a
 * file that gains a second `+ 8 * 3_600_000` fails even though its reason is unchanged.
 *
 * A `current`-kind finding is only tolerated in a file whose reason is `seed-window-parity` (see CURRENT_OK).
 */
export const ALLOWED: Record<string, Allowed> = {
  // `new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7)` (:24) and the same shift in periodOptions (:40).
  'apps/erp/src/app/budgets/lib.ts': { count: 3, reason: 'manila-offset-ratchet' },
  // :43 the period key.
  'apps/erp/src/app/expenses/new/page.tsx': { count: 2, reason: 'manila-offset-ratchet' },
  // :34 the recurring screen's Manila "today".
  'apps/erp/src/app/expenses/recurring/lib.ts': { count: 2, reason: 'manila-offset-ratchet' },
  // :127-129 the 90-day window: one offset, two `.toISOString().slice(0, 10)` of the shifted value.
  'apps/erp/src/app/findings/lib.ts': { count: 3, reason: 'manila-offset-ratchet' },
  // :293-294 `now.getUTCFullYear()/getUTCMonth()` ON PURPOSE (parity with the fiscal-period seed job's window,
  // scheduler/index.ts:1060) and :298 `Date.UTC(...)` -> ISO date. Census E "OUT", spec R2 blind spot.
  'apps/erp/src/app/findings/page.tsx': { count: 3, reason: 'seed-window-parity' },
  // :112 the shifted Manila "yesterday" for the terminal lane's shift-day query, :118 its ISO date.
  'apps/erp/src/lib/terminal/lane.ts': { count: 2, reason: 'manila-offset-ratchet' },
  // packages/*/src (spec R2). Correct by construction: Date.UTC-built dates or the Manila-shifted ms offset.
  'packages/core/src/datetime.ts': { count: 1, reason: 'utc-calendar-arithmetic' },
  'packages/db/src/repo/fiscal-periods.ts': { count: 3, reason: 'utc-calendar-arithmetic' },
  'packages/domain/src/attendance/sweep.ts': { count: 1, reason: 'manila-offset-ratchet' },
  'packages/domain/src/fiscal-periods/holes.ts': { count: 3, reason: 'utc-calendar-arithmetic' },
  'packages/domain/src/payroll/periods.ts': { count: 2, reason: 'utc-calendar-arithmetic' },
  'packages/domain/src/recurring-expenses/index.ts': { count: 2, reason: 'manila-offset-ratchet' },
  'packages/domain/src/recurring-expenses/job.ts': { count: 2, reason: 'manila-offset-ratchet' },
  'packages/domain/src/recurring-expenses/recurrence.ts': { count: 1, reason: 'utc-calendar-arithmetic' },
  // 7 Manila-shifted period/day keys (2 findings each) + 3 Date.UTC day arithmetic (:307, :1259, :1265).
  'packages/domain/src/scheduler/index.ts': { count: 17, reason: 'manila-offset-ratchet' },
};

const REASONS = new Set<Reason>([
  'utc-calendar-arithmetic',
  'manila-offset-ratchet',
  'manila-locale',
  'seed-window-parity',
]);
const CURRENT_OK = (file: string, allowed: Record<string, Allowed>) => allowed[file]?.reason === 'seed-window-parity';

/** The guard's whole decision, over any tree (so a fixture tree can prove it is not vacuous). */
export function violations(
  tree: Map<string, UtcTodayFinding[]>,
  allowed: Record<string, Allowed>,
  exists: (file: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const [file, found] of tree) {
    const entry = allowed[file];
    for (const f of found) {
      if (f.kind === 'current' && !CURRENT_OK(file, allowed)) {
        out.push(`${file}:${f.line} UTC/server-local date of the CURRENT instant: ${f.text}`);
      }
    }
    if (!entry) {
      for (const f of found.filter((x) => x.kind !== 'current')) {
        out.push(`${file}:${f.line} unlisted ${f.kind} site: ${f.text}`);
      }
    } else if (found.length > entry.count) {
      out.push(`${file} has ${found.length} sites, ALLOWED says ${entry.count} (a new one appeared): lines ${found.map((f) => f.line).join(',')}`);
    } else if (found.length < entry.count) {
      out.push(`${file} has ${found.length} sites, ALLOWED says ${entry.count}: lower the entry in this commit`);
    }
  }
  for (const [file, entry] of Object.entries(allowed)) {
    if (!exists(file)) out.push(`${file} is in ALLOWED but does not exist (stale entry)`);
    else if (!tree.has(file)) out.push(`${file} is in ALLOWED (count ${entry.count}) but has no sites left: remove the entry`);
    if (!REASONS.has(entry.reason)) out.push(`${file} has reason "${entry.reason}", not in the closed list`);
  }
  return out;
}

describe('G1: findUtcToday on fixture strings (shape, not names)', () => {
  const kinds = (src: string) => findUtcToday(src).map((f) => f.kind);

  it.each([
    ['new Date().toISOString().slice(0, 10)', 'const d = new Date().toISOString().slice(0, 10);'],
    ['now.toISOString().slice(0, 10)', 'function f(now: Date) { return now.toISOString().slice(0, 10); }'],
    ['new Date().toISOString().split("T")[0]', "const d = new Date().toISOString().split('T')[0];"],
    ['new Date(Date.now()).toISOString().slice(0, 7)', 'const d = new Date(Date.now()).toISOString().slice(0, 7);'],
    ['new Date().getFullYear()', 'const y = new Date().getFullYear();'],
    ['now.getUTCMonth() on a parameter (R2 review)', 'function f(now = new Date()) { return now.getUTCMonth(); }'],
    ['local const now = new Date(); now.getUTCFullYear() (R2 review)', 'function f() { const now = new Date(); return now.getUTCFullYear(); }'],
    ['a local named other than now', 'function f() { const t = new Date(); return t.getUTCDate(); }'],
    ['toISOString().slice(0,16) of a current instant', 'const s = new Date().toISOString().slice(0, 16);'],
  ])('flags %s as a current-instant hit', (_n, src) => {
    expect(kinds(src)).toContain('current');
  });

  it.each([
    ['toBusinessDate()', 'const d = toBusinessDate();'],
    ['toBusinessDate(row.openedAt)', 'const d = toBusinessDate(row.openedAt);'],
    ['a bare timestamp', 'const t = new Date().toISOString();'],
    ['a shifted local now (budgets/lib.ts shape)', 'function f() { const now = new Date(Date.now() + 8 * 3_600_000); return now.getUTCFullYear(); }'],
    ['getUTCDate on a Date.UTC-built date', 'const last = new Date(Date.UTC(2026, 3, 0)).getUTCDate();'],
  ])('does not flag %s as a current-instant hit', (_n, src) => {
    expect(kinds(src)).not.toContain('current');
  });

  it('classifies a Date.UTC-built date as allowlist material (extract), not current', () => {
    expect(kinds('const e = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);')).toEqual(['extract']);
  });

  it('flags a current-instant slice(0, 16) (UTC date+time) and classifies a stored one as extract', () => {
    expect(kinds('const s = new Date().toISOString().slice(0, 16);')).toContain('current');
    expect(kinds('const s = r.startedAt.toISOString().slice(0, 16);')).toEqual(['extract']);
  });

  it('classifies a stored instant printed as its UTC date as extract (a conversion target unless allowlisted)', () => {
    expect(kinds('const s = w.openedAt.toISOString().slice(0, 10);')).toEqual(['extract']);
  });

  it('counts the hard-coded Manila offset, with numeric separators or without', () => {
    expect(kinds('const a = Date.now() + 8 * 3_600_000; const b = 8 * 3600000;')).toEqual(['offset', 'offset']);
  });

  it('ignores an offset that only appears in a comment or string', () => {
    expect(kinds("// 8 * 3_600_000\nconst s = '8 * 3_600_000';")).toEqual([]);
  });

  it('resolves a parameter named now by scope: a shadowing shifted local is not current', () => {
    const src = 'function f(now: Date) { { const now = new Date(Date.now() + 1); return now.getUTCDate(); } }';
    expect(kinds(src)).not.toContain('current');
  });

  // ✎R2 mutant fixture: the exact payroll/lib.ts `periodsForMonth` shape the first-written guard missed.
  it('MUTANT (R2): payroll periodsForMonth with now.getUTCFullYear() is caught', () => {
    const src = `export function periodsForMonth(cfg: C, now = new Date()): PayPeriod[] {
  return derivePeriods(cfg, now.getUTCFullYear(), now.getUTCMonth() + 1);
}`;
    const hits = findUtcToday(src).filter((f) => f.kind === 'current');
    expect(hits.map((h) => h.line)).toEqual([2, 2]);
  });

  // ✎R2 mutant fixture: scheduler-status.tsx monthsSince, a LOCAL now, in a .tsx file.
  it('MUTANT (R2): scheduler-status monthsSince with a local now is caught', () => {
    const src = `function monthsSince(date: Date): number {
  const now = new Date();
  return (now.getUTCFullYear() - date.getUTCFullYear()) * 12 + (now.getUTCMonth() - date.getUTCMonth());
}`;
    expect(findUtcToday(src, 'scheduler-status.tsx').filter((f) => f.kind === 'current')).toHaveLength(2);
  });

  it('STATED BLIND SPOT: a Date handed to a helper that calls getUTC* on its own parameter is invisible', () => {
    const src = 'function monthBounds(d: Date) { return d.getUTCFullYear(); }\nconst x = monthBounds(new Date());';
    expect(findUtcToday(src)).toEqual([]);
  });
});

describe('G2/G3 decision logic on a fixture tree (non-vacuity control)', () => {
  const fx = (n: number, kind: UtcTodayFinding['kind'] = 'extract') =>
    Array.from({ length: n }, (_v, i): UtcTodayFinding => ({ line: i + 1, kind, text: 'x' }));
  const allowed: Record<string, Allowed> = { 'a.ts': { count: 2, reason: 'manila-offset-ratchet' } };
  const exists = (f: string) => f === 'a.ts';

  it('passes a tree that matches ALLOWED exactly', () => {
    expect(violations(new Map([['a.ts', fx(2, 'offset')]]), allowed, exists)).toEqual([]);
  });
  it('fails a current-instant hit in an ordinary file, naming file:line', () => {
    const v = violations(new Map([['a.ts', fx(2, 'offset')], ['b.ts', [{ line: 7, kind: 'current', text: 'new Date().toISOString().slice(0, 10)' }]]]), allowed, exists);
    expect(v.some((m) => m.startsWith('b.ts:7 '))).toBe(true);
  });
  it('fails a new unlisted file', () => {
    expect(violations(new Map([['a.ts', fx(2)], ['new.ts', fx(1)]]), allowed, exists).join('\n')).toMatch(/new\.ts:1 unlisted/);
  });
  it('fails a raised count', () => {
    expect(violations(new Map([['a.ts', fx(3)]]), allowed, exists).join('\n')).toMatch(/a\.ts has 3 sites, ALLOWED says 2/);
  });
  it('fails a lowered count (ratchet)', () => {
    expect(violations(new Map([['a.ts', fx(1)]]), allowed, exists).join('\n')).toMatch(/lower the entry/);
  });
  it('MUTANT: deleting an ALLOWED entry turns its sites red', () => {
    expect(violations(new Map([['a.ts', fx(2)]]), {}, exists).length).toBeGreaterThan(0);
  });
  it('G3: an entry for a file that no longer exists fails', () => {
    expect(violations(new Map([['a.ts', fx(2)]]), { ...allowed, 'gone.ts': { count: 1, reason: 'manila-locale' } }, exists).join('\n')).toMatch(/gone\.ts is in ALLOWED but does not exist/);
  });
  it('a reason outside the closed list fails', () => {
    const bad = { 'a.ts': { count: 2, reason: 'because' as Reason } };
    expect(violations(new Map([['a.ts', fx(2)]]), bad, exists).join('\n')).toMatch(/closed list/);
  });
  it('a current-instant hit is tolerated only under seed-window-parity', () => {
    const t = new Map([['a.ts', fx(2, 'current')]]);
    expect(violations(t, { 'a.ts': { count: 2, reason: 'seed-window-parity' } }, exists)).toEqual([]);
    expect(violations(t, { 'a.ts': { count: 2, reason: 'manila-offset-ratchet' } }, exists).length).toBeGreaterThan(0);
  });
});

describe('G2: apps/erp/src + packages/*/src tree', () => {
  const tree = new Map([...SCAN_DIRS.flatMap((d) => [...scanTree(REPO_ROOT, d)])]);

  it('the walk is not vacuous: it reads the app and finds the known ratcheted sites', () => {
    expect(tree.size).toBeGreaterThan(5);
    expect(tree.get('apps/erp/src/lib/terminal/lane.ts')?.some((f) => f.kind === 'offset')).toBe(true);
    expect(tree.get('apps/erp/src/app/findings/lib.ts')?.some((f) => f.kind === 'offset')).toBe(true);
  });

  it('zero current-instant hits; every other site matches ALLOWED exactly (names file:line)', () => {
    const v = violations(tree, ALLOWED, (f) => existsSync(join(REPO_ROOT, f)));
    expect(v, `\n${v.join('\n')}\n`).toEqual([]);
  });
});
