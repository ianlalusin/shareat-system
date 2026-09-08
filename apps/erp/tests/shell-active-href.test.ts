/**
 * `activeHref` — which nav link is "current" for a given pathname. T-234 slice 1, §2.5.
 *
 * ⚠️ Statically imported on purpose, and this is the whole reason the function lives in
 * `sidebar-state.ts` rather than in `SidebarNav.tsx`, the client component that actually uses it:
 * `SidebarNav.tsx` imports React, `next/navigation` and `next/link`; `sidebar-state.ts` imports
 * nothing. A static import of the client file would pull that weight in even for one function —
 * `reference_vitest_resetmodules_import_timeout` is the ~4.6 s cold-import trap this sidesteps.
 */
import { describe, expect, it } from 'vitest';
import { activeHref } from '../src/components/shell/sidebar-state';

describe('activeHref — the nav link marked aria-current for a pathname', () => {
  it('matches "/" only when the pathname is exactly "/"', () => {
    expect(activeHref('/', ['/', '/sales-days'])).toBe('/');
    expect(activeHref('/sales-days', ['/', '/sales-days'])).not.toBe('/');
  });

  it('matches a prefix: a sub-path of the only href present', () => {
    expect(activeHref('/attendance/lane', ['/attendance'])).toBe('/attendance');
  });

  it('the longest matching prefix wins over a shorter one', () => {
    expect(activeHref('/attendance/terminals', ['/attendance', '/attendance/terminals'])).toBe(
      '/attendance/terminals',
    );
  });

  it('a trailing slash on the pathname is normalised before matching', () => {
    expect(activeHref('/expenses/', ['/expenses'])).toBe('/expenses');
  });

  it('an unknown path matches nothing', () => {
    expect(activeHref('/no-such-route', ['/', '/sales-days', '/expenses'])).toBeUndefined();
  });

  it('a query string on the pathname is ignored', () => {
    expect(activeHref('/sales-days?tab=open', ['/sales-days'])).toBe('/sales-days');
  });
});
