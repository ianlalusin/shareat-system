/**
 * T-589 - the coverage ledger guard. `docs/ui-review/PAGES.md` has one row per `apps/erp/src/app/**` page.tsx, so a new page
 * cannot ship without someone deciding whether it has had a UI review. Filesystem walk (not git), like route-capability-coverage.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const appDir = join(repoRoot, 'apps', 'erp', 'src', 'app');
const STATUSES = ['OK', 'minor', 'fix', 'not captured', 'not reviewed'];

function pageFiles(dir = appDir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) pageFiles(full, out);
    else if (e.name === 'page.tsx') out.push(relative(repoRoot, full).split(sep).join('/'));
  }
  return out;
}

function routeOf(file: string): string {
  const rel = relative(appDir, join(repoRoot, file)).split(sep).join('/').replace(/\/?page\.tsx$/, '');
  return '/' + rel.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')'))).join('/');
}

const rows = readFileSync(join(repoRoot, 'docs', 'ui-review', 'PAGES.md'), 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('| /'))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  .map(([route = '', file = '', , status = ''] = []) => ({ route, file, status }));

describe('T-589 - docs/ui-review/PAGES.md covers every ERP page', () => {
  const files = pageFiles();

  it('every page.tsx has exactly one row', () => {
    const missing = files.filter((f) => rows.filter((r) => r.file === f).length === 0).map(routeOf);
    expect(missing.map((r) => `new page, not reviewed: ${r} — add it to docs/ui-review/PAGES.md`)).toEqual([]);
    const dup = files.filter((f) => rows.filter((r) => r.file === f).length > 1);
    expect(dup).toEqual([]);
  });

  it("every row's file exists, its route matches the file, and its status is a known word", () => {
    for (const r of rows) {
      expect(existsSync(join(repoRoot, r.file)), `row ${r.route}: ${r.file} does not exist`).toBe(true);
      expect(routeOf(r.file), `row ${r.file}`).toBe(r.route);
      expect(STATUSES, `row ${r.route}: status "${r.status}"`).toContain(r.status);
    }
  });
});
