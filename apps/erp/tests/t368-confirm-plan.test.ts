/**
 * T-368 S2 (DEF-441) W1 — the two reversal-confirm forms resubmit the PLAN, not a yes/no.
 * `docs/tasks/368-periods-depreciation.md` §S2: the confirm redirect carries `plan=<token>` and each page resubmits it as a
 * hidden `confirmedPlan`; `confirmReversal` is gone from both pages and both actions.
 *
 * Source pin, comments stripped (a comment that mentions the old name must not satisfy or fail a check). Red until the
 * builder updates `fixed-assets/[id]/page.tsx`, `admin/stores/[id]/page.tsx` and their two actions.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..', 'src', 'app');
const code = (rel: string) =>
  readFileSync(resolve(app, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const PAGES = ['fixed-assets/[id]/page.tsx', 'admin/stores/[id]/page.tsx'];
const ACTIONS = ['fixed-assets/actions.ts', 'admin/stores/actions.ts'];

describe('W1 — confirm forms carry confirmedPlan, not confirmReversal', () => {
  for (const rel of PAGES) {
    it(`${rel}: a hidden input named confirmedPlan, no confirmReversal`, () => {
      const src = code(rel);
      expect(src, 'the confirm form does not resubmit the plan token').toMatch(/name="confirmedPlan"/);
      expect(src, 'the yes/no flag is still in the page').not.toMatch(/confirmReversal/);
    });
  }
  for (const rel of ACTIONS) {
    it(`${rel}: reads confirmedPlan from the form, puts plan= on the confirm redirect, no confirmReversal`, () => {
      const src = code(rel);
      expect(src).toMatch(/confirmedPlan/);
      expect(src, 'the confirm redirect does not carry the token').toMatch(/plan=|set\('plan'|\bplan:|^\s*plan,\s*$/m);
      expect(src).not.toMatch(/confirmReversal/);
    });
  }
});
