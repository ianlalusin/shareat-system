/**
 * T-587 S3 - the "Find a setting" box on the Settings hub, and the three-link Setup group in the sidebar.
 *
 * The matching is a PURE function (`matchesQuery`) and the hiding is `applyFilter` over anything with `querySelectorAll`, so both run here
 * without a browser. The page is rendered the same way as the S1/S2 hub tests. Nothing here invents a synonym: only visible row text matches.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_MATRIX, type Capability, type Role } from '@shareat/auth';
import { navHrefAllowed } from '../src/lib/route-capability';
import { GROUPS } from '../src/components/nav';
import { applyFilter, matchesQuery } from '../src/app/settings/FindSetting';

const state = vi.hoisted(() => ({ held: new Set<string>() }));

vi.mock('../src/lib/page-access', async () => {
  const { capabilitiesForRoute: need } = await import('../src/lib/route-capability');
  return {
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
const heldBy = (role: Role) => new Set((Object.keys(CAPABILITY_MATRIX) as Capability[]).filter((c) => CAPABILITY_MATRIX[c][role]));

beforeEach(() => {
  state.held = new Set();
});

// The visible text of three real rows, as the page renders them (title, hint, "Also called").
const BUSINESS_RULES = 'Business rules Payout tolerance, loan rounding, and the withholding and VAT rates.';
const FAILED_PUNCHES = 'Failed clock punches Punches that did not post, waiting for a manager to look. Also called: Clock lane';
const KITCHEN = 'Kitchen stations Which kitchen station cooks each item. Also called: Kitchen setup';

describe('T-587 S3 matchesQuery - visible text only', () => {
  it('an empty or blank query shows everything [kills: a box that hides all rows until you type]', () => {
    expect(matchesQuery(KITCHEN, '')).toBe(true);
    expect(matchesQuery(KITCHEN, '   ')).toBe(true);
  });
  it('"VAT" finds Business rules through its hint [kills: matching titles only]', () => {
    expect(matchesQuery(BUSINESS_RULES, 'VAT')).toBe(true);
    expect(matchesQuery(KITCHEN, 'VAT')).toBe(false);
  });
  it('"Clock lane" finds Failed clock punches through "Also called" [kills: the old name no longer findable]', () => {
    expect(matchesQuery(FAILED_PUNCHES, 'Clock lane')).toBe(true);
  });
  it('"kitchen setup" finds Kitchen stations through "Also called"', () => {
    expect(matchesQuery(KITCHEN, 'kitchen setup')).toBe(true);
  });
  it('is case-insensitive and ignores leading and trailing spaces', () => {
    expect(matchesQuery(KITCHEN, '  KITCHEN STATIONS ')).toBe(true);
    expect(matchesQuery(BUSINESS_RULES, 'vat')).toBe(true);
  });
  it('a straight apostrophe matches the curly one the hints use', () => {
    expect(matchesQuery('Which store’s people', "store's")).toBe(true);
  });
  it('no match is false', () => {
    expect(matchesQuery(KITCHEN, 'payroll')).toBe(false);
  });
});

type Fake = { hidden: boolean; textContent: string; querySelectorAll: (sel: string) => Fake[] };
const row = (textContent: string): Fake => ({ hidden: false, textContent, querySelectorAll: () => [] });
const section = (rows: Fake[]): Fake => ({ hidden: false, textContent: '', querySelectorAll: () => rows });

describe('T-587 S3 applyFilter - hides rows and emptied sections, returns the count', () => {
  it('hides non-matching rows, hides a section with no visible row, counts what remains [kills: a heading left over an empty panel]', () => {
    const [a, b, c] = [row(KITCHEN), row(BUSINESS_RULES), row(FAILED_PUNCHES)];
    const [s1, s2] = [section([a, b]), section([c])];
    const root = { querySelectorAll: (sel: string) => (sel === '[data-settings-section]' ? [s1, s2] : []) } as unknown as ParentNode;
    expect(applyFilter(root, 'vat')).toBe(1);
    expect([a.hidden, b.hidden, c.hidden]).toEqual([true, false, true]);
    expect([s1.hidden, s2.hidden]).toEqual([false, true]);
    expect(applyFilter(root, '')).toBe(3);
    expect([a.hidden, b.hidden, c.hidden, s1.hidden, s2.hidden]).toEqual([false, false, false, false, false]);
  });
});

describe('T-587 S3 applyFilter - the footnote', () => {
  it('is hidden while a query is typed and back when it is cleared [kills: the footnote read as a result]', () => {
    const foot: Fake = { hidden: false, textContent: 'Staff advance limits: not set up yet.', querySelectorAll: () => [] };
    const root = { querySelectorAll: (sel: string) => (sel === '[data-settings-footnote]' ? [foot] : []) } as unknown as ParentNode;
    applyFilter(root, 'clock lane');
    expect(foot.hidden).toBe(true);
    applyFilter(root, '   ');
    expect(foot.hidden).toBe(false);
  });
});

describe('T-587 S3 the box on the page', () => {
  it('shows for an admin and for a manager: a labelled search input, a live result region, rows and sections tagged [kills: no box / no hooks for the filter]', async () => {
    for (const role of ['admin', 'manager'] as const) {
      state.held = heldBy(role);
      const html = renderToStaticMarkup(await SettingsPage());
      expect(html, role).toContain('Find a setting');
      expect(html, role).toMatch(/<label[^>]*for="find-setting"[^>]*>Find a setting<\/label>/);
      const input = html.match(/<input[^>]*id="find-setting"[^>]*>/)?.[0] ?? '';
      expect(input, role).toContain('type="search"');
      expect(input, role).toContain('min-h-11');
      expect(input, role).toContain('focus-visible:ring-2');
      expect(html, role).toContain('aria-live="polite"');
      expect(html, role).toContain('data-settings-section');
      expect(html, role).toContain('data-settings-row');
    }
  });

  it('every rendered row link sits in a tagged row, and every rendered section is tagged [kills: a row the filter cannot see]', async () => {
    state.held = heldBy('admin');
    const html = renderToStaticMarkup(await SettingsPage());
    const anchors = (html.match(/<a /g) ?? []).length;
    expect((html.match(/<li data-settings-row/g) ?? []).length).toBe(anchors);
    expect((html.match(/<section data-settings-section/g) ?? []).length).toBe(4);
  });

  it('the three words in the placeholder ("VAT, stations or hours") each find at least one real row, with no synonym list [kills: a promise the box cannot keep]', async () => {
    state.held = heldBy('admin');
    const html = renderToStaticMarkup(await SettingsPage());
    const rows = (html.match(/<li data-settings-row[\s\S]*?<\/li>/g) ?? []).map((r) => r.replace(/<[^>]+>/g, ' '));
    expect(rows.length).toBeGreaterThan(10);
    for (const word of ['VAT', 'stations', 'hours']) {
      expect(rows.filter((r) => matchesQuery(r, word)).length, word).toBeGreaterThan(0);
    }
    expect(html).toContain('placeholder="Try VAT, stations or hours"');
  });

  it('the "not set up yet" footnote is tagged so the filter can hide it, and it is not inside a row [kills: a footnote shown under a result]', async () => {
    state.held = heldBy('admin');
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toMatch(/<p data-settings-footnote[^>]*>Staff advance limits: not set up yet\.<\/p>/);
  });

  it('a cashier gets the refusal and no box', async () => {
    state.held = heldBy('staff');
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain('REFUSED');
    expect(html).not.toContain('Find a setting');
  });

  it('the row hrefs stay literals in page.tsx, not moved into client data [kills: reachability guard blinded]', () => {
    const src = read('apps/erp/src/app/settings/page.tsx');
    expect(src).toContain('href="/kitchen"');
    expect(read('apps/erp/src/app/settings/FindSetting.tsx')).not.toMatch(/href[=:]/);
  });
});

describe('T-587 S3 sidebar - the Setup group is three links', () => {
  const setup = GROUPS.find((g) => g.label === 'Setup')!;
  it('is exactly Settings, Users and roles, Stores [kills: a removed entry creeping back]', () => {
    expect(setup.links.map((l) => l.href)).toEqual(['/settings', '/admin/users', '/admin/stores']);
    expect(setup.links.map((l) => l.label)).toEqual(['Settings', 'Users and roles', 'Stores']);
  });
  it('an admin is shown all three; a manager only Settings (Users and Stores are admin-gated by the route map)', () => {
    const shown = (role: Role) => setup.links.filter((l) => navHrefAllowed(l.href, heldBy(role))).map((l) => l.href);
    expect(shown('admin')).toEqual(['/settings', '/admin/users', '/admin/stores']);
    expect(shown('manager')).toEqual(['/settings']);
  });
  it('every route that left the sidebar is still a literal link on the hub, so the reachability guard sees it', () => {
    const hub = read('apps/erp/src/app/settings/page.tsx');
    const navHrefs = GROUPS.flatMap((g) => g.links.map((l) => l.href));
    const removed = ['/admin/access-defaults', '/attendance/terminals', '/admin/pos-tablets', '/kitchen', '/menu/hours', '/attendance/lane', '/payroll/rates'];
    for (const href of removed) {
      expect(navHrefs, `${href} left the sidebar`).not.toContain(href);
      expect(hub, `${href} on the hub`).toContain(`href="${href}"`);
    }
  });
});
