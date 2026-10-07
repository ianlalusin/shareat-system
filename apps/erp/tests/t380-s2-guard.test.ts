import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_ROOT, findingsForFile, findingsForSource, isPending } from './no-typed-values-in-urls';

/**
 * T-380 S2 - G-S2: every S2 BUILDER file is clean of G1a / G1b / G2 findings, with NO PENDING cover
 * (`findingsForFile` applies no exemption). docs/tasks/380-no-typed-values-in-urls.md, S2.
 *
 * Red on HEAD for every action file (each builds `?error=` / `?ok=` with a local `back()` or a
 * template redirect) and for each page that reads `sp.error` / `sp.ok` / a refill key from the bare
 * `searchParams`. A page that reads none of those keys is clean on HEAD and stays clean.
 *
 * The named mutant: leave one local `back()` in `findings/actions.ts` -> that file's leg is red.
 * (The second test proves the analyzer would flag it, so the mutant cannot hide behind a blind guard.)
 */

export const S2_ACTIONS = [
  'app/prepaid/actions.ts',
  'app/fixed-assets/actions.ts',
  'app/admin/stores/actions.ts',
  'app/admin/users/actions.ts',
  'app/admin/access-defaults/actions.ts',
  'app/payroll/actions.ts',
  'app/payroll/separations/actions.ts',
  'app/payroll/thirteenth-month/actions.ts',
  'app/cutover/actions.ts',
  'app/findings/actions.ts',
];

export const S2_PAGES = [
  'app/prepaid/page.tsx',
  'app/prepaid/[id]/page.tsx',
  'app/fixed-assets/page.tsx',
  'app/fixed-assets/new/page.tsx',
  'app/fixed-assets/[id]/page.tsx',
  'app/admin/stores/page.tsx',
  'app/admin/stores/[id]/page.tsx',
  'app/admin/users/[personId]/page.tsx',
  'app/admin/access-defaults/page.tsx',
  'app/payroll/page.tsx',
  'app/payroll/separations/page.tsx',
  'app/payroll/thirteenth-month/page.tsx',
  'app/cutover/page.tsx',
  'app/cutover/opening/page.tsx',
  'app/cutover/count/page.tsx',
  'app/findings/page.tsx',
];

describe('G-S2 - the S2 files are converted (no PENDING cover)', () => {
  it('every S2 file exists, and none is still listed PENDING', () => {
    for (const f of [...S2_ACTIONS, ...S2_PAGES]) {
      expect(existsSync(join(SRC_ROOT, f)), `${f} should exist`).toBe(true);
      expect(isPending(f), `${f} must be removed from PENDING in no-typed-values-in-urls.ts`).toBe(false);
    }
  });

  for (const f of S2_ACTIONS) {
    it(`${f} has no G1a/G1b findings`, () => {
      const found = findingsForFile(f);
      expect(found.map((x) => `${x.rule}@${x.line} ${x.detail}`)).toEqual([]);
    });
  }

  for (const f of S2_PAGES) {
    it(`${f} reads banner and refill keys only through withFlash`, () => {
      const found = findingsForFile(f);
      expect(found.map((x) => `${x.rule}@${x.line} ${x.detail}`)).toEqual([]);
    });
  }

  it('the named mutant is caught: a local back() left in findings/actions.ts is a G1a finding', () => {
    const src = `
      import { redirect } from 'next/navigation';
      function back(p: string, q: Record<string, string>): never {
        redirect(\`\${p}?\${new URLSearchParams(q)}\`);
      }
      export async function resolveFindingAction() {
        back('/findings', { error: 'x' });
      }
    `;
    expect(findingsForSource(src, 'app/findings/actions.ts').map((x) => x.rule)).toEqual(['G1a']);
  });
});
