/**
 * T-540 — put the ERP pages on the standard page header.
 *
 * `Page` has always accepted `title` / `description` and rendered them through `PageHeader`;
 * until T-540 no page used them, so every page hand-wrote its own `<h1>` plus
 * `<PageDescription>`, and the title row drifted page to page.
 *
 * This test pins the pages actually converted by T-540 (a constant list, not a scan, exactly as
 * `docs/tasks/540-page-header-sweep.md` §5 asks) against three things:
 *
 * 1. the page passes `title="` on its `<Page` and keeps **no** hand-written `<h1>`;
 * 2. the `title` value is the exact words the `<h1>` used to carry — nothing renamed;
 * 3. the hand-written `<PageDescription>` block and its import are gone, so the description is
 *    not rendered twice.
 *
 * The 18 pages the work order's §3 rule 2 excluded (an adjacent action control, a rich-text
 * description, or a breadcrumb inside the same header block) are listed under **Builder notes**
 * in the work order; they are deliberately not in this list.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', 'src', 'app');

/** The pages T-540 converted, with the exact title text each hand-written `<h1>` used to render. */
const CONVERTED: ReadonlyArray<{ readonly file: string; readonly title: string }> = [
  { file: 'admin/users/page.tsx', title: 'Users and roles' },
  { file: 'attendance/leave/page.tsx', title: 'Leave' },
  { file: 'expenses/reimbursements/page.tsx', title: 'Reimbursements' },
  { file: 'liabilities/unpaid/page.tsx', title: 'Everything unpaid' },
  { file: 'reports/trial-balance/page.tsx', title: 'Trial Balance' },
  { file: 'reports/income-statement/page.tsx', title: 'Income Statement' },
  { file: 'reports/balance-sheet/page.tsx', title: 'Balance Sheet' },
];

const read = (rel: string): string => readFileSync(resolve(appRoot, rel), 'utf8');

/**
 * The opening `<Page ...>` tag only, as source text. `[^>]*` is safe here because a `Page` opening
 * tag carries no nested `>` (its props are string / bare literals), the same reasoning
 * `t348-def440-page-width.test.ts` relies on when it matches `<Page density=...>`.
 */
function pageOpenTag(src: string): string {
  const m = /<Page\b[^>]*>/.exec(src);
  return m ? m[0] : '';
}

function titleProp(tag: string): string | undefined {
  const m = /\btitle="([^"]*)"/.exec(tag);
  return m?.[1];
}

describe('T-540 — converted pages use the Page title prop', () => {
  it('every converted page passes title=" on <Page> and keeps no <h1>', () => {
    const problems: string[] = [];
    for (const { file } of CONVERTED) {
      const tag = pageOpenTag(read(file));
      if (tag === '') problems.push(`${file}: no <Page ...> opening tag found`);
      else if (titleProp(tag) === undefined) problems.push(`${file}: <Page> has no title="..."`);
      if (read(file).includes('<h1')) problems.push(`${file}: still carries a hand-written <h1>`);
    }
    expect(problems).toEqual([]);
  });

  it('no converted page lost its words', () => {
    const problems: string[] = [];
    for (const { file, title } of CONVERTED) {
      const actual = titleProp(pageOpenTag(read(file)));
      if (actual !== title) {
        problems.push(`${file}: expected title="${title}", found ${actual === undefined ? 'none' : `title="${actual}"`}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('T-540 — the hand-written description is not rendered twice', () => {
  it('every converted page dropped its <PageDescription> block and its import', () => {
    const problems: string[] = [];
    for (const { file } of CONVERTED) {
      const src = read(file);
      if (src.includes('<PageDescription')) problems.push(`${file}: still renders <PageDescription>`);
      if (src.includes("from '@/components/shell/PageDescription'")) {
        problems.push(`${file}: still imports PageDescription`);
      }
    }
    expect(problems).toEqual([]);
  });
});
