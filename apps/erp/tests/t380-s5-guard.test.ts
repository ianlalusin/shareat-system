import { describe, expect, it } from 'vitest';
import { findingsForFile, findingsForSource } from './no-typed-values-in-urls';

/**
 * T-380 S5 - G-S5. Every S5 file is clean under the guard with NO PENDING cover (`findingsForFile`
 * applies no exemption). docs/tasks/380-no-typed-values-in-urls.md, S5.
 *
 * Red on HEAD: every action still has a local `back()` / template `redirect(...?error=)` (G1a), and
 * every page that reads `sp.error` / `sp.ok` still gets `sp` from the bare `searchParams` (G2).
 * Named mutant: leave one local `back()` (e.g. `backToRoster`) in `staff/actions.ts` (or any S5 action) -> that
 * file's row goes red. The last test pins the mutant's shape on an inline fixture so the guard
 * cannot silently stop seeing it.
 */
const ACTIONS = [
  'inventory/counts', 'inventory/deliveries', 'inventory/locations', 'inventory/low-stock', 'inventory/pos-map',
  'inventory/pos-usage', 'inventory/production', 'inventory/returns', 'inventory/usage', 'attendance/lane',
  'attendance/terminals', 'attendance/[dayId]', 'staff', 'staff/[employmentId]/credentials', 'wastage',
].map((d) => `app/${d}/actions.ts`);

const PAGES = [
  'app/inventory/counts/page.tsx', 'app/inventory/counts/[id]/page.tsx', 'app/inventory/deliveries/page.tsx',
  'app/inventory/deliveries/[id]/page.tsx', 'app/inventory/locations/page.tsx', 'app/inventory/low-stock/page.tsx',
  'app/inventory/pos-map/page.tsx', 'app/inventory/pos-usage/page.tsx', 'app/inventory/production/page.tsx',
  'app/inventory/production/[id]/page.tsx', 'app/inventory/returns/page.tsx', 'app/inventory/usage/page.tsx',
  'app/inventory/usage/[id]/page.tsx', 'app/attendance/[dayId]/page.tsx', 'app/attendance/lane/page.tsx',
  'app/attendance/terminals/page.tsx', 'app/staff/page.tsx', 'app/staff/hire/page.tsx',
  'app/staff/[employmentId]/page.tsx', 'app/staff/[employmentId]/credentials/page.tsx', 'app/wastage/page.tsx',
  'app/wastage/[id]/page.tsx',
];

describe('G-S5: the S5 files carry no query in a redirect and read banners through withFlash', () => {
  it.each([...ACTIONS, ...PAGES])('%s has no guard finding', (file) => {
    const found = findingsForFile(file);
    expect(found.map((f) => `${f.rule}@${f.line}: ${f.detail}`)).toEqual([]);
  });

  it('the named mutant: a local back() beside redirectWithFlash in an S5 action is flagged', () => {
    const src = `
      import { redirect } from 'next/navigation';
      import { redirectWithFlash } from '@/lib/flash';
      function backToRoster(s: string, q: Record<string, string>): never { redirect(\`/staff?\${new URLSearchParams({ store: s, ...q })}\`); }
      export async function upsertStorePositionAction() {
        backToRoster('s', { error: 'x' });
        return await redirectWithFlash('/staff', { store: 's' }, { ok: 'added' });
      }`;
    expect(findingsForSource(src, 'app/staff/actions.ts').map((f) => f.rule)).toEqual(['G1a']);
  });
});
