/**
 * T-630 — the breadcrumb on every ERP page (`docs/tasks/630-breadcrumbs.md`).
 *
 * Two guards:
 * 1. `crumbSteps`, the path -> steps function: a nested path, an `[id]` page, a segment with no page of
 *    its own, and a top-level page (no crumb).
 * 2. The census: every `page.tsx` under `apps/erp/src/app` outside the written exclusions gets a
 *    breadcrumb. The trail is rendered once by `AppShell`, so "every page renders it" means three
 *    things a page could otherwise slip through: its route is in `CRUMB_PAGES` (the run-time list of
 *    which paths have a page), every `[id]` segment on its path has a label (never the raw id), and
 *    `AppShell` still mounts `<Breadcrumbs>` inside `<main>`.
 *
 * Named `.test.ts` (createElement, no JSX): the unit project's include glob is `apps/**\/*.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/customers/price-lists' }));

import { CRUMB_PAGES, NO_CRUMB_PREFIXES, SEGMENT_LABELS, crumbSteps } from '../src/components/nav-crumbs';
import { Breadcrumbs } from '../src/components/shell/Breadcrumbs';
import { capabilitiesForRoute } from '../src/lib/route-capability';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const APP_ROOT = 'apps/erp/src/app';

const labels = (steps: ReturnType<typeof crumbSteps>) => steps.map((s) => s.label);
const hrefs = (steps: ReturnType<typeof crumbSteps>) => steps.map((s) => s.href);

describe('crumbSteps: the path -> steps function', () => {
  it("nested: Customers › Price lists › the list's own name; every step but the last is a link", () => {
    const steps = crumbSteps('/customers/price-lists/0d9c', { titleOf: (p) => (p === '/customers/price-lists/0d9c' ? 'Wholesale A' : undefined) });
    expect(labels(steps)).toEqual(['Customers', 'Price lists', 'Wholesale A']);
    expect(hrefs(steps)).toEqual(['/customers', '/customers/price-lists', null]);
    expect(steps.map((s) => s.current)).toEqual([false, false, true]);
  });

  it("Ian's example: Settings › Sales channels", () => {
    expect(labels(crumbSteps('/settings/sales-channels'))).toEqual(['Settings', 'Sales channels']);
    expect(hrefs(crumbSteps('/settings/sales-channels/'))).toEqual(['/settings', null]);
  });

  it('labels come from nav.tsx where nav names the path', () => {
    expect(labels(crumbSteps('/expenses/reimbursements'))).toEqual(['Expenses', 'Reimbursements']);
    expect(labels(crumbSteps('/payroll/statutory-payments?month=2026-10'))).toEqual(['Payroll', 'Government payments']);
  });

  it('[id] page: the record name the page shows, never the raw id; before it is read, the generic label', () => {
    const before = crumbSteps('/admin/stores/7f3e2a10');
    expect(labels(before)).toEqual(['Admin', 'Stores', 'Store']);
    expect(labels(before).join(' ')).not.toContain('7f3e2a10');
    const after = crumbSteps('/admin/stores/7f3e2a10', { titleOf: (p) => (p === '/admin/stores/7f3e2a10' ? 'LIPA — Shareat Lipa' : undefined) });
    expect(labels(after)).toEqual(['Admin', 'Stores', 'LIPA — Shareat Lipa']);
  });

  it('a middle [id] step shows a title remembered from this tab, and links to the record', () => {
    const steps = crumbSteps('/admin/stores/7f3e/pos-preflight', { titleOf: (p) => (p === '/admin/stores/7f3e' ? 'Lipa' : undefined) });
    expect(labels(steps)).toEqual(['Admin', 'Stores', 'Lipa', 'POS pre-flight']);
    expect(hrefs(steps)).toEqual([null, '/admin/stores', '/admin/stores/7f3e', null]);
  });

  it('a segment with no page of its own is plain text, never a dead link', () => {
    const steps = crumbSteps('/ap/invoices/inv-9');
    expect(labels(steps)).toEqual(['Supplier invoices', 'Invoices', 'Invoice']);
    expect(hrefs(steps)).toEqual(['/ap', null, null]);
    expect(hrefs(crumbSteps('/reports/trial-balance'))).toEqual([null, null]);
  });

  it('a step the viewer cannot open is plain text', () => {
    expect(hrefs(crumbSteps('/payroll/rates', { canOpen: (p) => p !== '/payroll' }))).toEqual([null, null]);
  });

  it('no crumb: the Dashboard, a top-level page, the POS, the kiosk, and a path no page answers', () => {
    for (const p of ['/', '/settings', '/expenses', '/pos', '/pos/till', '/clock', '/sign-in', '/setup', '/nope/x', '/settings/nope']) {
      expect(crumbSteps(p), p).toEqual([]);
    }
  });
});

/** Tracked and new-but-not-ignored files, as page-container.test.ts does: a page written minutes ago is the one at risk. */
function pageRoutes(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', APP_ROOT], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((f) => f.endsWith('/page.tsx'))
    .map((f) => f.slice(APP_ROOT.length, -'/page.tsx'.length) || '/')
    .map((r) => r.replace(/\/\([^/]+\)/g, '')) // a route group "(x)" is not part of the URL
    .sort();
}

const excluded = (route: string) => route === '/' || NO_CRUMB_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`));

/** The same text with comments removed, so a mention in a doc comment is not mistaken for the element. */
function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('census: no page opts out of the breadcrumb silently', () => {
  const routes = pageRoutes();

  it('CRUMB_PAGES is exactly the set of page.tsx routes outside the written exclusions', () => {
    const inScope = routes.filter((r) => !excluded(r));
    expect([...CRUMB_PAGES].sort(), 'add the new route to CRUMB_PAGES in components/nav-crumbs.ts').toEqual(inScope);
    expect(inScope.length).toBeGreaterThan(140);
  });

  it('every exclusion matches a real page (no stale row)', () => {
    for (const p of NO_CRUMB_PREFIXES) expect(routes.some((r) => r === p || r.startsWith(`${p}/`)), p).toBe(true);
  });

  it('every nested page gets a trail of 2+ steps; every [id] on its path has a label, so no raw id is ever shown', () => {
    const missing: string[] = [];
    for (const route of CRUMB_PAGES) {
      const parts = route.split('/').filter(Boolean);
      parts.forEach((part, i) => {
        const prefix = `/${parts.slice(0, i + 1).join('/')}`;
        if (part.startsWith('[') && !SEGMENT_LABELS[prefix]) missing.push(prefix);
      });
      const concrete = route.replace(/\[[^\]]+\]/g, 'RAWID123');
      const steps = crumbSteps(concrete);
      if (parts.length >= 2) {
        expect(steps.length, route).toBe(parts.length);
        expect(labels(steps).join(' | '), route).not.toMatch(/RAWID123|…/);
      } else {
        expect(steps, route).toEqual([]);
      }
    }
    expect([...new Set(missing)], 'give each [id] segment a label in SEGMENT_LABELS').toEqual([]);
  });

  it('every SEGMENT_LABELS key is a prefix of a real page (no stale row)', () => {
    for (const key of Object.keys(SEGMENT_LABELS)) {
      expect(CRUMB_PAGES.some((r) => r === key || r.startsWith(`${key}/`)), key).toBe(true);
    }
  });

  it('AppShell mounts <Breadcrumbs> inside <main>, after the kiosk/sign-in early return', () => {
    const shell = codeOnly(readFileSync(join(repoRoot, 'apps/erp/src/components/shell/AppShell.tsx'), 'utf8'));
    const main = shell.slice(shell.indexOf('<main'), shell.indexOf('</main>'));
    expect(main).toContain('<Breadcrumbs ');
    expect(shell.indexOf('KIOSK_HEADER)) return')).toBeGreaterThan(-1);
    expect(shell.indexOf('KIOSK_HEADER)) return')).toBeLessThan(shell.indexOf('<main'));
  });

  it('renders a Breadcrumb landmark: real links for the steps above, aria-current on the last', () => {
    const html = renderToStaticMarkup(h(Breadcrumbs, { held: [...capabilitiesForRoute('/customers')] }));
    expect(html).toContain('<nav aria-label="Breadcrumb"');
    expect(html).toContain('href="/customers"');
    expect(html).toMatch(/aria-current="page"[^>]*><span[^>]*>Price lists<\/span>/);
    expect(html).toContain('min-h-11');
    expect(html).toContain('text-xs text-neutral-500');
    // a viewer whose role cannot open /customers gets the step as text, not a link to a refusal
    expect(renderToStaticMarkup(h(Breadcrumbs, { held: [] }))).not.toContain('href=');
  });
});
