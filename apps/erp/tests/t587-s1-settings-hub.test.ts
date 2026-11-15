/**
 * T-587 S1 - the Settings hub: four sections of ROWS, shown only to a person who may open the route, plain labels with the old
 * name kept as "also called". `docs/tasks/587-settings-navigation.md` (DECIDED section).
 *
 * The page is rendered for three real roles. What each role holds comes from CAPABILITY_MATRIX (the same table the sign-in resolves),
 * and what the page may show comes from the same ROUTE_CAPABILITY map the sidebar reads - so the hub and the sidebar cannot disagree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_MATRIX, type Capability, type Role } from '@shareat/auth';
import { capabilitiesForRoute } from '../src/lib/route-capability';
import { GROUPS } from '../src/components/nav';

const state = vi.hoisted(() => ({ held: new Set<string>() }));

vi.mock('../src/lib/page-access', async () => {
  const { capabilitiesForRoute: need } = await import('../src/lib/route-capability');
  return {
    // Same decision as the real gate: any one accepted capability opens the route.
    requirePageAccess: async (route: string) => {
      const accepted = need(route);
      const open = accepted.length === 0 || accepted.some((c) => state.held.has(c));
      return { actor: { orgId: 'o', personId: 'p' }, refusal: open ? null : createElement('p', null, 'REFUSED') };
    },
  };
});
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: async (_org: string, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@shareat/auth', async (orig) => ({ ...(await orig<typeof import('@shareat/auth')>()), heldCapabilities: async () => state.held }));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => createElement('div', null, children as never) }));
vi.mock('@/components/shell/PageDescription', () => ({ PageDescription: ({ children }: { children: unknown }) => createElement('p', null, children as never) }));

import SettingsPage from '../src/app/settings/page';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Row = { section: string; label: string; href: string; also?: string };
const ROWS: Row[] = [
  { section: 'This store', label: 'Menu hours', href: '/menu/hours' },
  { section: 'This store', label: 'Kitchen stations', href: '/kitchen', also: 'Kitchen setup' },
  { section: 'This store', label: 'Sales channels (walk-in, Grab, Foodpanda)', href: '/settings/sales-channels' },
  { section: 'This store', label: 'Wastage Monitor', href: '/settings/wastage-monitor' },
  { section: 'This store', label: 'Attendance &amp; payroll', href: '/settings/attendance' },
  { section: 'This store', label: 'Spending limits', href: '/budgets', also: 'Budgets, Expense budgets' },
  { section: 'This store', label: 'Recurring bills', href: '/expenses/recurring' },
  { section: 'This store', label: 'Store positions', href: '/staff?view=positions' },
  { section: 'Company', label: 'Organisation', href: '/settings/organization' },
  { section: 'Company', label: 'Expense categories', href: '/settings/expense-categories' },
  { section: 'Company', label: 'Business rules', href: '/settings/business-rules' },
  { section: 'Company', label: 'Payroll rates', href: '/payroll/rates' },
  { section: 'Company', label: 'Usage tolerance', href: '/settings/usage-tolerance' },
  { section: 'Company', label: 'Usage source', href: '/menu/usage-source' },
  { section: 'Company', label: 'Stores', href: '/admin/stores' },
  { section: 'People and access', label: 'Users and roles', href: '/admin/users' },
  { section: 'People and access', label: 'Position access defaults', href: '/admin/access-defaults' },
  { section: 'Devices and connections', label: 'POS tablets and cash registers', href: '/settings/pos-tablet', also: 'POS tablet, POS tablets' },
  { section: 'Devices and connections', label: 'Clock terminals', href: '/attendance/terminals' },
  { section: 'Devices and connections', label: 'Failed clock punches', href: '/attendance/lane', also: 'Clock lane' },
  { section: 'Devices and connections', label: 'Link to POS store', href: '/settings/pos-link', also: 'POS link' },
];
const SECTIONS = ['This store', 'Company', 'People and access', 'Devices and connections'];

async function render(role: Role): Promise<string> {
  state.held = new Set((Object.keys(CAPABILITY_MATRIX) as Capability[]).filter((c) => CAPABILITY_MATRIX[c][role]));
  return renderToStaticMarkup(await SettingsPage());
}
const rowLink = (html: string, href: string) => html.includes(`href="${href}"`);

beforeEach(() => {
  state.held = new Set();
});

describe('T-587 S1 hub - admin sees everything, in four sections', () => {
  it('all four section titles and every row, each a real link to its route [kills: a row dropped or mis-hrefed]', async () => {
    const html = await render('admin');
    for (const s of SECTIONS) expect(html, s).toContain(s);
    for (const r of ROWS) {
      expect(rowLink(html, r.href), `${r.label} -> ${r.href}`).toBe(true);
      expect(html, r.label).toContain(r.label);
    }
  });

  it('the rows sit under their own section, in order [kills: a row filed under the wrong heading]', async () => {
    const html = await render('admin');
    const at = SECTIONS.map((s) => html.indexOf(s));
    expect(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!))).toBe(true);
    for (const r of ROWS) {
      const i = SECTIONS.indexOf(r.section);
      const end = i + 1 < SECTIONS.length ? at[i + 1]! : html.length;
      const pos = html.indexOf(`href="${r.href}"`);
      expect(pos > at[i]! && pos < end, `${r.label} under ${r.section}`).toBe(true);
    }
  });

  it('renamed labels show, and the old names appear only as "also called" [kills: an old name left as the label]', async () => {
    const html = await render('admin');
    for (const r of ROWS.filter((x) => x.also)) expect(html).toContain(`Also called: ${r.also}`);
    const withoutAlso = html.replace(/Also called: [^<]*/g, '');
    for (const old of ['Kitchen setup', 'Clock lane', 'POS link']) expect(withoutAlso, old).not.toContain(old);
    expect(html).toContain('Wastage Monitor');
    expect(html).toContain('Business rules');
    expect(html).toContain('Menu hours');
  });

  it('every row is one link with a 44px floor and a visible focus ring [kills: a card or a small target]', async () => {
    const html = await render('admin');
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBe(ROWS.length);
    for (const a of anchors) {
      expect(a).toContain('min-h-11');
      expect(a).toContain('focus-visible:ring-2');
    }
  });
});

describe('T-587 S1 hub - a store manager sees only what the route map lets a manager open', () => {
  // Routes whose OWN key is admin-only (route-capability.ts): hidden from a manager, not teased.
  const ADMIN_ONLY = [
    '/admin/stores',
    '/admin/users',
    '/admin/access-defaults',
    '/settings/business-rules',
    '/settings/usage-tolerance',
    '/settings/pos-link',
    '/payroll/rates',
  ];

  it('hides every admin-only row and its section, shows the store rows [kills: a manager shown links that refuse them]', async () => {
    const html = await render('manager');
    for (const href of ADMIN_ONLY) expect(rowLink(html, href), href).toBe(false);
    expect(html).not.toContain('People and access');
    expect(html).toContain('This store');
    for (const href of ['/menu/hours', '/kitchen', '/settings/sales-channels', '/settings/wastage-monitor', '/settings/attendance', '/staff?view=positions'])
      expect(rowLink(html, href), href).toBe(true);
  });

  it('shows a row exactly when the sidebar map says the manager may open it [kills: a second permission list]', async () => {
    const html = await render('manager');
    for (const r of ROWS) {
      const accepted = capabilitiesForRoute(r.href.split('?')[0]!);
      const allowed = accepted.length === 0 || accepted.some((c) => CAPABILITY_MATRIX[c].manager);
      expect(rowLink(html, r.href), r.href).toBe(allowed);
    }
  });
});

describe('T-587 S1 hub - a cashier gets the refusal, no links', () => {
  it('refused, and not one section or row leaks [kills: a cashier shown the hub]', async () => {
    const html = await render('staff');
    expect(html).toContain('REFUSED');
    for (const s of SECTIONS) expect(html).not.toContain(s);
    expect(html).not.toContain('<a ');
  });
});

describe('T-587 S1 hub - source shape the guards depend on', () => {
  it('every row href is a literal at its call site, so nav-route-reachability can see it [kills: hrefs mapped from an array]', () => {
    const src = read('apps/erp/src/app/settings/page.tsx');
    for (const r of ROWS) expect(src, r.href).toContain(`href="${r.href}"`);
  });

  it('every row route has a real page, so no row is a dead link', () => {
    for (const r of ROWS) {
      const p = r.href.split('?')[0]!;
      expect(() => read(`apps/erp/src/app${p}/page.tsx`), p).not.toThrow();
    }
  });
});

describe('T-587 S1 renames - the sidebar label and the screen title agree', () => {
  const nav = GROUPS.flatMap((g) => g.links);
  it('nav says Kitchen stations and Failed clock punches, not the old words', () => {
    expect(nav.find((l) => l.href === '/kitchen')?.label).toBe('Kitchen stations');
    expect(nav.find((l) => l.href === '/attendance/lane')?.label).toBe('Failed clock punches');
    expect(nav.map((l) => l.label)).not.toContain('Kitchen setup');
    expect(nav.map((l) => l.label)).not.toContain('Clock lane');
  });

  it.each([
    ['apps/erp/src/app/kitchen/page.tsx', 'Kitchen stations', 'Kitchen setup'],
    ['apps/erp/src/app/attendance/lane/page.tsx', 'Failed clock punches', 'The clock lane'],
    ['apps/erp/src/app/settings/pos-link/page.tsx', 'Link to POS store', 'POS link'],
    ['apps/erp/src/app/settings/sales-channels/page.tsx', 'Sales channels (walk-in, Grab, Foodpanda)', 'Sales channels'],
  ])('%s: h1 and title use "%s", not "%s"', (file, fresh, old) => {
    const src = read(file);
    expect(src).toContain(`<h1 className="text-2xl font-semibold">${fresh}</h1>`);
    expect(src).toContain(`title: '${fresh} —`);
    expect(src).not.toContain(`<h1 className="text-2xl font-semibold">${old}</h1>`);
    expect(src).not.toContain(`title: '${old} —`);
  });

  it('Attendance & payroll settings has a back link to /settings', () => {
    expect(read('apps/erp/src/app/settings/attendance/page.tsx')).toContain('href="/settings"');
  });
});
