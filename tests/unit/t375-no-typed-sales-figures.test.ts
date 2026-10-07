/**
 * T-375 S3, G1 - on a store linked to POS, no sales figure is typed and nothing outside the derivation writes one.
 * `docs/tasks/375-pos-v1-day-feed.md` S3 tests (G1) and invariant I9.
 *
 * TESTER, not BUILDER. Pure `fs` (no `git ls-files`: a file the builder has not added yet must still be scanned).
 *
 * ## What it pins
 *  (a) no file under `apps/erp/src` contains the word `posSourced` (the "From POS" checkbox, the form read, the page
 *      labels all go; the day page reads `source`);
 *  (b) the sales-day figure `<input name="...">` boxes exist ONLY in `SalesDayForm.tsx`;
 *  (c) `app.sales_day_derivation` (the transaction-local flag) appears only in `packages/db/src/repo/sales-days.ts`, the
 *      0185 migration and test files - and DOES appear in the repo file (so (c) is not vacuous);
 *  (d) outside `sales-days/import.ts`, no non-test file calls `salesDaysRepo.updateDerivedFigures` or
 *      `.replaceRemittedChannels`, and `import.ts` does call them;
 *  (e) `insertSalesDay` is called only from `import.ts` and `create.ts`, and `import.ts` is one of them.
 *
 * ## Why it is red on HEAD
 * (a) six files under apps/erp/src still say `posSourced`; (c), (d), (e) require `import.ts` / the repo's
 * `withSalesDayDerivation`, which do not exist. (b) is a regression guard that is green today.
 *
 * ## Positive controls
 * The scanners are run on fixture strings first: a scanner that flags nothing would pass every rule above vacuously.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const rel = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join('/');

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git', 'coverage', 'inactive projects', 'docs']);
const CODE_EXT = /\.(ts|tsx|mts|mjs|js|sql)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE_EXT.test(e.name)) out.push(p);
  }
  return out;
}
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.startsWith('tests/') || f.includes('/tests/') || f.includes('/_fixtures/');
const read = (f: string) => readFileSync(path.join(repoRoot, f), 'utf8');

const FIGURE_NAMES = 'totalSales|unliSales|alaCarteSales|seniorDiscount|pwdDiscount|otherDiscount|comps|serviceCharge|otherCharges|cashCollected|onlineCollected|creditSales';

// ---- the scanners -----------------------------------------------------------------------------------------------
const mentionsPosSourced = (text: string) => /\bposSourced\b/.test(text);
const hasFigureInput = (text: string) => new RegExp(`\\bname=\\{?["'\`](${FIGURE_NAMES})["'\`]`).test(text);
const setsDerivationFlag = (text: string) => /app\.sales_day_derivation/.test(text);
const callsDerivedWriters = (text: string) => /salesDaysRepo\.(updateDerivedFigures|replaceRemittedChannels)\s*\(/.test(text);
const callsInsertSalesDay = (text: string) => /\binsertSalesDay\s*\(/.test(text);

const ALL = ['apps', 'packages', 'tests', 'scripts'].flatMap((d) => walk(path.join(repoRoot, d))).map(rel);
const APP_SRC = ALL.filter((f) => f.startsWith('apps/erp/src/'));
const NON_TEST = ALL.filter((f) => !isTest(f));
const REPO_FILE = 'packages/db/src/repo/sales-days.ts';
const IMPORT_FILE = 'packages/domain/src/sales-days/import.ts';
const CREATE_FILE = 'packages/domain/src/sales-days/create.ts';

describe('G1 - the scanners can see (positive controls)', () => {
  it('each scanner flags its fixture string, and passes a clean one', () => {
    expect(mentionsPosSourced('<input type="checkbox" name="posSourced" />')).toBe(true);
    expect(mentionsPosSourced('const day = { source: "pos_v1_day_feed" }')).toBe(false);
    expect(hasFigureInput('<Money name="totalSales" label="Total sales" />')).toBe(true);
    expect(hasFigureInput("<input name='cashCollected' />")).toBe(true);
    expect(hasFigureInput('<input name="businessDate" />')).toBe(false);
    expect(setsDerivationFlag("select set_config('app.sales_day_derivation', 'on', true)")).toBe(true);
    expect(setsDerivationFlag("select set_config('app.reversal_posting', 'on', true)")).toBe(false);
    expect(callsDerivedWriters('await salesDaysRepo.updateDerivedFigures(tx, id, figures)')).toBe(true);
    expect(callsDerivedWriters('await salesDaysRepo.replaceRemittedChannels(tx, id, rows)')).toBe(true);
    expect(callsDerivedWriters('await salesDaysRepo.replaceChannels(tx, id, rows)')).toBe(false);
    expect(callsInsertSalesDay('const { id } = await salesDaysRepo.insertSalesDay(tx, row)')).toBe(true);
    expect(callsInsertSalesDay('await salesDaysRepo.listSalesDays(tx)')).toBe(false);
  });

  it('the walk finds the tree: the app source, the domain source and a floor of files (a scan of nothing passes)', () => {
    expect(APP_SRC.length).toBeGreaterThan(100);
    expect(NON_TEST.filter((f) => f.startsWith('packages/domain/src/')).length).toBeGreaterThan(100);
    expect(existsSync(path.join(repoRoot, 'apps/erp/src/app/sales-days/SalesDayForm.tsx'))).toBe(true);
    expect(existsSync(path.join(repoRoot, CREATE_FILE))).toBe(true);
    expect(callsInsertSalesDay(read(CREATE_FILE)), 'create.ts is a real insertSalesDay caller today').toBe(true);
  });
});

describe('G1 (a) - no file under apps/erp/src contains posSourced', () => {
  it('the checkbox, the form read and the page labels are gone', () => {
    const offenders = APP_SRC.filter((f) => mentionsPosSourced(read(f))).sort();
    expect(offenders).toEqual([]);
  });
});

describe('G1 (b) - the figure inputs exist only in SalesDayForm.tsx', () => {
  it('no other file under apps/erp/src declares a figure input; SalesDayForm.tsx still does (the unlinked typed path)', () => {
    const withInputs = APP_SRC.filter((f) => hasFigureInput(read(f))).sort();
    expect(withInputs).toEqual(['apps/erp/src/app/sales-days/SalesDayForm.tsx']);
  });
});

describe('G1 (c) - the derivation flag is written in one place', () => {
  it('app.sales_day_derivation appears only in the repo file, the 0185 and 0187 migrations and test files', () => {
    const allowed = (f: string) => f === REPO_FILE || /^packages\/db\/migrations\/018[57]_[^/]*\.sql$/.test(f) || isTest(f);
    const offenders = ALL.filter((f) => !allowed(f) && setsDerivationFlag(read(f))).sort();
    expect(offenders).toEqual([]);
  });

  it('and it DOES appear in the repo file (withSalesDayDerivation lives there)', () => {
    expect(existsSync(path.join(repoRoot, REPO_FILE))).toBe(true);
    expect(setsDerivationFlag(read(REPO_FILE)), `${REPO_FILE} must set the flag inside withSalesDayDerivation`).toBe(true);
  });
});

describe('G1 (d) - only import.ts rewrites a derived figure or a remitted channel row', () => {
  it('no other non-test file calls updateDerivedFigures or replaceRemittedChannels', () => {
    const offenders = NON_TEST.filter((f) => f !== IMPORT_FILE && f !== REPO_FILE && callsDerivedWriters(read(f))).sort();
    expect(offenders).toEqual([]);
  });

  it('and import.ts does call them', () => {
    expect(existsSync(path.join(repoRoot, IMPORT_FILE)), `${IMPORT_FILE} must exist`).toBe(true);
    expect(callsDerivedWriters(read(IMPORT_FILE))).toBe(true);
  });
});

describe('G1 (e) - insertSalesDay has exactly two callers', () => {
  it('only import.ts and create.ts (the repo file defines it, tests may call it)', () => {
    const callers = NON_TEST.filter((f) => f !== REPO_FILE && callsInsertSalesDay(read(f))).sort();
    expect(callers).toEqual([CREATE_FILE, IMPORT_FILE].sort());
  });
});
