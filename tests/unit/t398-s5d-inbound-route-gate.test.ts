import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROUTE_CAPABILITY, capabilitiesForRoute, navHrefAllowed } from '../../apps/erp/src/lib/route-capability';

/**
 * T-398 S5d (TESTER) - G1: the inbound-shipment screens are read-gated by `receive_delivery`.
 * docs/tasks/398-s5/TESTS.md "S5d" row G1, S5-REFRESH.md section 4. Today `/inventory/*` is ungated by design; the longer key wins, so the
 * new key must not widen or narrow its siblings. The three T-435 guards (route-capability-coverage, no-ungated-read-surface,
 * nav-route-reachability) must stay green and are run alongside this file; the specific legs below fail first and say why.
 *
 * MUTANTS: remove the map entry -> G1a, G1b, G1c; the list page drops requirePageAccess -> G1e; the receipt-form page drops it -> G1e;
 *   the entry is widened to '/inventory/deliveries' -> G1d; the page is not linked from anywhere -> G1f.
 */
const repoRoot = path.resolve(__dirname, '../..');
const APP = 'apps/erp/src/app';
const INBOUND = '/inventory/deliveries/inbound';
const PAGES = [`${APP}/inventory/deliveries/inbound/page.tsx`, `${APP}/inventory/deliveries/inbound/[shipmentId]/page.tsx`];

/** Comments stripped, as the sibling guards do: prose describing the gate is not the gate. */
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

describe('G1 /inventory/deliveries/inbound is gated by receive_delivery', () => {
  it('G1a. the map names the route, and its requirement is receive_delivery (RED today: no entry, the route is open)', () => {
    expect(Object.keys(ROUTE_CAPABILITY), 'no ROUTE_CAPABILITY entry for the inbound screens').toContain(INBOUND);
    expect(capabilitiesForRoute(INBOUND)).toEqual(['receive_delivery']);
  });

  it('G1b. the receipt form for one shipment inherits the requirement (a dynamic segment stands for its parent)', () => {
    expect(capabilitiesForRoute(`${INBOUND}/0194a1b2-0000-7000-8000-000000000000`)).toEqual(['receive_delivery']);
  });

  it('G1c. the nav hides the link from a person who lacks the capability and shows it to one who holds it', () => {
    expect(navHrefAllowed(INBOUND, new Set(['record_ar_collection']))).toBe(false);
    expect(navHrefAllowed(INBOUND, new Set(['receive_delivery']))).toBe(true);
  });

  it('G1d. the siblings are unchanged: /inventory/deliveries and /inventory/stock stay open (the longer key wins, it does not widen)', () => {
    expect(capabilitiesForRoute('/inventory/deliveries')).toEqual([]);
    expect(capabilitiesForRoute('/inventory/stock')).toEqual([]);
  });

  it('G1e. both pages exist and call requirePageAccess in code, not in a comment (RED today: neither page exists)', () => {
    for (const rel of PAGES) {
      expect(existsSync(path.join(repoRoot, rel)), `${rel} does not exist`).toBe(true);
      const src = codeOnly(readFileSync(path.join(repoRoot, rel), 'utf8'));
      expect(src.includes('requirePageAccess('), `${rel} does not call requirePageAccess(`).toBe(true);
    }
  });

  it('G1f. the inbound list is linked from the nav or from the deliveries screen, so nav-route-reachability can see it', () => {
    const linkers = [`apps/erp/src/components/nav.tsx`, `${APP}/inventory/deliveries/page.tsx`];
    const linked = linkers.some((rel) => {
      const p = path.join(repoRoot, rel);
      return existsSync(p) && codeOnly(readFileSync(p, 'utf8')).includes(INBOUND);
    });
    expect(linked, `neither ${linkers.join(' nor ')} links to ${INBOUND}`).toBe(true);
  });
});
