import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { capabilitiesForRoute, navHrefAllowed } from '../../apps/erp/src/lib/route-capability';

/**
 * T-497 S1 addendum (Ian, 2026-10-28; bible row 403): /admin/prerequisite-refusals is admins only, the same
 * word as the Stores page (manage_stores). A person without it is refused; a holder is admitted.
 * MUTANTS: remove the map entry -> a, b, c; page goes back to requireSession -> d.
 */
const ROUTE = '/admin/prerequisite-refusals';
const PAGE = path.resolve(__dirname, '../../apps/erp/src/app/admin/prerequisite-refusals/page.tsx');

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (l.indexOf('//') === -1 ? l : l.slice(0, l.indexOf('//'))))
    .join('\n');
}

describe('T-497 S1 - /admin/prerequisite-refusals requires manage_stores', () => {
  it('a. the map requires manage_stores', () => {
    expect(capabilitiesForRoute(ROUTE)).toEqual(['manage_stores']);
  });
  it('b. a user without manage_stores is refused (nav hides it); a holder is admitted', () => {
    expect(navHrefAllowed(ROUTE, new Set(['record_ar_collection']))).toBe(false);
    expect(navHrefAllowed(ROUTE, new Set(['manage_stores']))).toBe(true);
  });
  it('c. it is the same requirement as /admin/stores', () => {
    expect(capabilitiesForRoute(ROUTE)).toEqual(capabilitiesForRoute('/admin/stores'));
  });
  it('d. the page calls requirePageAccess for its own route and renders the refusal', () => {
    const src = codeOnly(readFileSync(PAGE, 'utf8'));
    expect(src).toContain(`requirePageAccess('${ROUTE}')`);
    expect(src).toMatch(/if \(refusal\) return refusal;/);
    expect(src).not.toContain('requireSession(');
  });
});
