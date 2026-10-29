import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_AREA,
  CAPABILITY_LABEL,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  ROLE_ONLY_CAPABILITIES,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  grantsConfer,
  type Capability,
} from '../../packages/auth/src/capabilities';

/**
 * T-398 S6a (TESTER) -- the two franchisor capabilities, pinned cell by cell; the matrix document rows; the float ban in the new code.
 * docs/tasks/398-s6/{S6-REFRESH s4 + K7,TESTS S6a C3 + M1,QUESTIONS QO-3}.md. Unit project, no database.
 * RED TODAY: `view_franchise_access_log` does not exist (every lookup is undefined); the matrix note still says "sales only"; the domain and repo
 * files do not exist.
 *
 *   view_franchise_access_log | org | super OK | admin OK | manager OK | staff NO | area franchise | ROLE ONLY
 *   view_franchise_sales      | platform | super OK | admin NO | manager NO | staff NO | area franchise | label changes
 *
 * MUTANTS: edit one cell in the doc only -> the doc legs; remove from ROLE_ONLY -> R1; staff true -> M1; add to SUPER_ADMIN_ONLY -> S1;
 *   a `Number(` / `parseFloat(` in the new money code -> F1.
 */
const LOG = 'view_franchise_access_log';
const SALES = 'view_franchise_sales';
const root = join(__dirname, '..', '..');
const row = (cap: string) => (CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[cap];

describe('T-398 S6a -- view_franchise_access_log, cell by cell', () => {
  it('is a Capability and is listed in CAPABILITIES (119 in all). Mutant: not registered', () => {
    expect((CAPABILITIES as readonly string[]).includes(LOG)).toBe(true);
    const typed: Capability = LOG as Capability;
    expect(typed).toBe(LOG);
    expect(CAPABILITIES.length).toBe(119);
  });

  it('super_admin OK, admin OK, manager OK, staff NO. Mutant: staff true (a waiter would read who looked at the franchise)', () => {
    expect(row(LOG), `${LOG} is not in CAPABILITY_MATRIX`).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
  });

  it('org scope (a store-scoped cell would let a store grant widen it). Mutant: scope store / platform', () => {
    expect((CAPABILITY_SCOPE as Record<string, string | undefined>)[LOG]).toBe('org');
  });

  it('area franchise; label "view who looked at your franchise data". Mutant: wrong area / blank label', () => {
    expect((CAPABILITY_AREA as Record<string, string | undefined>)[LOG]).toBe('franchise');
    expect((CAPABILITY_LABEL as Record<string, string | undefined>)[LOG]).toBe('view who looked at your franchise data');
  });

  it('R1 (QO-3) it is ROLE ONLY: in ROLE_ONLY_CAPABILITIES, and a person grant may not confer it. Mutant: removed from the set', () => {
    expect((ROLE_ONLY_CAPABILITIES as ReadonlySet<string>).has(LOG)).toBe(true);
    expect(grantsConfer(LOG as Capability)).toBe(false);
    // control: the set still holds the first member, and an ordinary capability is still grantable
    expect((ROLE_ONLY_CAPABILITIES as ReadonlySet<string>).has('verify_own_supplier_invoice')).toBe(true);
    expect(grantsConfer('manage_users' as Capability)).toBe(true);
  });

  it('it is not super-admin-only (admin and manager hold it) and not in the adminless-manager elevated set (a manager already holds it). Mutant: added to SUPER_ADMIN_ONLY', () => {
    expect((SUPER_ADMIN_ONLY_CAPABILITIES as readonly string[]).includes(LOG)).toBe(false);
    expect((ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).includes(LOG)).toBe(false);
  });
});

describe('T-398 S6a -- view_franchise_sales is unchanged in who holds it, and only its label changes', () => {
  it('S1 still platform scope, super_admin ONLY by matrix, area franchise, still in SUPER_ADMIN_ONLY_CAPABILITIES (Ian holds it as a grant). Mutant: admin true', () => {
    expect(row(SALES)).toEqual({ super_admin: true, admin: false, manager: false, staff: false });
    expect((CAPABILITY_SCOPE as Record<string, string>)[SALES]).toBe('platform');
    expect((CAPABILITY_AREA as Record<string, string>)[SALES]).toBe('franchise');
    expect((SUPER_ADMIN_ONLY_CAPABILITIES as readonly string[]).includes(SALES)).toBe(true);
  });

  it('the label now says it covers stock too: "view franchise sales and stock levels". Mutant: label left as "view franchise sales"', () => {
    expect((CAPABILITY_LABEL as Record<string, string>)[SALES]).toBe('view franchise sales and stock levels');
  });

  it('it is NOT role-only (Ian is held through grants, K1). Mutant: added to ROLE_ONLY_CAPABILITIES', () => {
    expect((ROLE_ONLY_CAPABILITIES as ReadonlySet<string>).has(SALES)).toBe(false);
    expect(grantsConfer(SALES as Capability)).toBe(true);
  });
});

describe('C3 -- CAPABILITY-MATRIX.md carries both rows with the same scope and cells, and names this slice\'s denial test', () => {
  const doc = readFileSync(join(root, 'docs', 'decisions', 'CAPABILITY-MATRIX.md'), 'utf8');
  const line = (cap: string) => doc.split('\n').find((l) => l.startsWith(`| \`${cap}\``));
  const cells = (l: string) => l.split('|').map((c) => c.trim()).slice(2, 7);

  it('view_franchise_access_log row: org | ✅ | ✅ | ✅ | ✗, names Q1 (a) / Q10 (a), "Role-only", and t398-s6-franchise-capabilities.test.ts. Mutant: one cell edited in the doc only', () => {
    const l = line(LOG);
    expect(l, `no row for ${LOG} in CAPABILITY-MATRIX.md`).toBeDefined();
    expect(cells(l!)).toEqual(['org', '✅', '✅', '✅', '✗']);
    expect(l).toMatch(/T-398 S6/);
    expect(l).toMatch(/Role-only/i);
    expect(l).toMatch(/t398-s6-franchise-capabilities\.test\.ts/);
  });

  it('view_franchise_sales row: platform | ✅ | ✗ | ✗ | ✗; the note says "sales and stock levels", never costs, read only through the two franchise_* definers; no longer "sales only". Mutant: note left as before (K7)', () => {
    const l = line(SALES);
    expect(l).toBeDefined();
    expect(cells(l!)).toEqual(['platform', '✅', '✗', '✗', '✗']);
    expect(l).toMatch(/sales and stock levels/);
    expect(l).not.toMatch(/sales only/);
    expect(l).toMatch(/franchise_/);
    expect(l).toMatch(/t398-s6-franchise-capabilities\.test\.ts/);
  });

  it('the denial test the rows name exists', () => {
    expect(existsSync(join(root, 'packages', 'auth', 'tests', 'integration', 't398-s6-franchise-capabilities.test.ts'))).toBe(true);
  });
});

describe('F1 / M1 -- no floats in the new money and quantity code; the domain gates every function with authorize', () => {
  const domainFile = join(root, 'packages', 'domain', 'src', 'franchise', 'index.ts');
  const repoFile = join(root, 'packages', 'db', 'src', 'repo', 'franchise.ts');

  it.each([['domain/src/franchise/index.ts', domainFile], ['db/src/repo/franchise.ts', repoFile]])('%s exists and contains no `Number(` / `parseFloat(` / `parseInt(` on money. Mutant: a float sneaks in', (_n, f) => {
    expect(existsSync(f), `RED today: ${f} does not exist`).toBe(true);
    const src = readFileSync(f, 'utf8');
    expect(src).not.toMatch(/\bNumber\(/);
    expect(src).not.toMatch(/\bparseFloat\(/);
    expect(src).not.toMatch(/\bparseInt\(/);
  });

  it('the domain file exports the four functions and calls authorize with the right capability before reading (source shape; the behavioural proof is V3/V18/C1). Mutant: a function without authorize', () => {
    expect(existsSync(domainFile), 'RED today').toBe(true);
    const src = readFileSync(domainFile, 'utf8');
    for (const fn of ['listFranchisees', 'viewFranchiseSales', 'viewFranchiseStock', 'listFranchiseAccessLog']) {
      expect(src, `${fn} not exported`).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`));
    }
    expect(src).toMatch(/authorize\([^)]*['"]view_franchise_access_log['"]/s);
    expect((src.match(/authorize\([^)]*['"]view_franchise_sales['"]/gs) ?? []).length, 'three functions are gated by view_franchise_sales').toBeGreaterThanOrEqual(3);
  });

  it('the domain index exports the franchise module', () => {
    const idx = readFileSync(join(root, 'packages', 'domain', 'src', 'index.ts'), 'utf8');
    expect(idx, 'RED today: packages/domain/src/index.ts does not export ./franchise').toMatch(/from ['"]\.\/franchise['"]/);
  });
});
