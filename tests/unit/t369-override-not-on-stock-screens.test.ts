import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * T-369 S5 T8 (I5) — the closed-month override NEVER reaches a stock screen. Ian, 2026-09-30, ruling (a):
 * "no override for stock, ever" — `docs/tasks/369-unwired-money-screens.md` §S4 and invariant I5.
 *
 *   `ClosedMonthOverride` (the control) may be imported ONLY by `expenses/reimbursements/page.tsx` and
 *   `expenses/[id]/page.tsx` (the second arrives with S5b, so it is ALLOWED here but not required).
 *   Nothing under `inventory/`, `commissary/` or `trade/` may import it, import `lib/period-override`, or
 *   mention `periodOverride` at all.
 *
 * ⚠️ A check that skips its input reports success (memory: a-check-that-skips-its-input), and today the
 * component does not exist so "nobody imports it" is trivially true. So this file ALSO pins the positive
 * half — the component exists, the reimbursement page imports it, and the stock directories were really
 * scanned (a non-empty file count) — and those legs are red until S5a is built.
 */
const repoRoot = path.resolve(__dirname, '../..');
const SRC = path.join(repoRoot, 'apps/erp/src');
const APP = path.join(SRC, 'app');
const COMPONENT = path.join(SRC, 'components', 'ClosedMonthOverride.tsx');
const ALLOWED_IMPORTERS = new Set(['app/expenses/reimbursements/page.tsx', 'app/expenses/[id]/page.tsx']);
const STOCK_DIRS = ['inventory', 'commissary', 'trade'];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
/** Comments stripped, so prose explaining the rule cannot trip it. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');

const allFiles = walk(SRC).filter((f) => f !== COMPONENT);
const importers = allFiles.filter((f) => /\bClosedMonthOverride\b/.test(codeOnly(readFileSync(f, 'utf8')))).map(rel);

describe('T8 (I5) — the override control is on an allowlist of exactly two pages', () => {
  it('ClosedMonthOverride exists (apps/erp/src/components/ClosedMonthOverride.tsx) — red until S5a', () => {
    expect(existsSync(COMPONENT), 'the component file does not exist yet').toBe(true);
  });

  it('the reimbursement page IMPORTS it (the positive half — red until S5a)', () => {
    expect(importers).toContain('app/expenses/reimbursements/page.tsx');
  });

  it('the expense page IMPORTS it too (S5b - the second allowlisted page)', () => {
    expect(importers).toContain('app/expenses/[id]/page.tsx');
  });

  it('nothing outside the allowlist imports it', () => {
    const strangers = importers.filter((f) => !ALLOWED_IMPORTERS.has(f));
    expect(strangers, `files importing ClosedMonthOverride outside the allowlist: ${strangers.join(', ')}`).toEqual([]);
  });
});

describe('T8 (I5) — no stock screen touches the override at all', () => {
  const stockFiles = STOCK_DIRS.flatMap((d) => walk(path.join(APP, d)));

  it('the scan really looked at the stock directories (a non-empty input set — otherwise this guard passes by skipping)', () => {
    expect(stockFiles.length, 'no files found under inventory/, commissary/, trade/').toBeGreaterThan(20);
    for (const dir of STOCK_DIRS) expect(stockFiles.some((f) => f.includes(`${path.sep}${dir}${path.sep}`)), `${dir}/ was not scanned`).toBe(true);
  });

  it('no file under inventory/, commissary/ or trade/ imports ClosedMonthOverride or lib/period-override, or mentions periodOverride', () => {
    const offenders = stockFiles.filter((f) => {
      const code = codeOnly(readFileSync(f, 'utf8'));
      return /\bClosedMonthOverride\b/.test(code) || /lib\/period-override/.test(code) || /\bperiodOverride\b/.test(code) || /\breadPeriodOverride\b/.test(code);
    });
    expect(offenders.map(rel), 'a stock screen touches the closed-month override (Ian, ruling (a): never for stock)').toEqual([]);
  });
});
