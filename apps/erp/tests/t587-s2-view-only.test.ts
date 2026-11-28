/**
 * T-587 S2 - the "View only" pill on the Settings hub, and route keys for the two clock pages.
 *
 * A row the person can OPEN but cannot CHANGE carries a "View only" word pill. "Cannot change" is judged on the SAME capability the
 * screen's save action authorizes (`writeCap`), and the HONESTY block reads each screen's action/domain source so a renamed capability in an
 * action fails here instead of silently leaving the pill lying. Same render approach as the S1 hub test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_MATRIX, type Capability } from '@shareat/auth';
import { ROUTE_CAPABILITY, capabilitiesForRoute, navHrefAllowed } from '../src/lib/route-capability';

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
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => createElement('div', null, children as never) }));
vi.mock('@/components/shell/PageDescription', () => ({ PageDescription: ({ children }: { children: unknown }) => createElement('p', null, children as never) }));

import SettingsPage from '../src/app/settings/page';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Comments stripped, so prose that merely names a capability cannot satisfy the honesty check. */
const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (l.includes('//') ? l.slice(0, l.indexOf('//')) : l))
    .join('\n');

const HUB_CAP = 'manage_store_settings'; // the hub's own key: nobody reaches the hub without it
const D = 'packages/domain/src';
const A = 'apps/erp/src/app';

/** href -> the capability (any one of) its save action authorizes, and the files where that authorize() lives. */
const WRITE: Record<string, { caps: string[]; files: string[] }> = {
  '/menu/hours': { caps: ['manage_store_settings'], files: [`${D}/menu/dayparts.ts`] },
  '/kitchen': { caps: ['manage_store_settings'], files: [`${D}/kitchen/index.ts`] },
  '/settings/sales-channels': { caps: ['manage_store_settings'], files: [`${D}/sales-channels/index.ts`] },
  '/settings/wastage-monitor': { caps: ['manage_store_settings'], files: [`${D}/stores/service.ts`] },
  '/settings/attendance': { caps: ['manage_store_settings'], files: [`${D}/attendance/config.ts`] },
  '/budgets': { caps: ['manage_expense_budgets'], files: [`${D}/budgets/index.ts`] },
  '/expenses/recurring': { caps: ['manage_recurring_expenses'], files: [`${D}/recurring-expenses/index.ts`] },
  '/staff?view=positions': { caps: ['manage_store_settings'], files: [`${D}/people/index.ts`] },
  '/settings/organization': { caps: ['manage_chart_of_accounts'], files: [`${D}/organizations/index.ts`] },
  '/settings/expense-categories': { caps: ['manage_chart_of_accounts'], files: [`${D}/expenses/categories.ts`] },
  '/settings/business-rules': { caps: ['manage_business_rules'], files: [`${D}/business-rules/registry.ts`, `${D}/business-rules/rules.ts`] },
  '/settings/ai-hub': { caps: ['manage_ai_hub'], files: [`${D}/ai/shared.ts`] }, // T-640: the route key IS the write word, so the pill can never show
  '/payroll/rates': { caps: ['manage_payroll_rates'], files: [`${D}/payroll/rates.ts`] },
  '/settings/usage-tolerance': { caps: ['set_menu_depletion'], files: [`${D}/stock/usage-tolerance.ts`] },
  '/menu/usage-source': { caps: ['switch_usage_source', 'manage_pos_map'], files: [`${D}/pos/depletion-source.ts`] },
  '/admin/stores': { caps: ['manage_stores'], files: [`${D}/stores/service.ts`] },
  '/admin/users': { caps: ['manage_users'], files: [`${A}/admin/users/actions.ts`] },
  '/admin/access-defaults': { caps: ['grant_capability'], files: [`${D}/people/position-defaults.ts`] },
  '/settings/pos-tablet': { caps: ['pair_pos_tablet'], files: [`${A}/settings/pos-tablet/actions.ts`] },
  '/attendance/terminals': { caps: ['provision_clock_terminal'], files: [`${D}/attendance/terminals.ts`] },
  '/admin/pos-tablets': { caps: ['provision_clock_terminal'], files: [`${A}/admin/pos-tablets/actions.ts`] },
  '/attendance/lane': { caps: ['manage_attendance', 'provision_clock_terminal'], files: [`${D}/sync/health.ts`] },
  '/settings/pos-link': { caps: ['manage_chart_of_accounts'], files: [`${A}/settings/pos-link/actions.ts`] },
};
const HREFS = Object.keys(WRITE);
const route = (href: string) => href.split('?')[0]!;
const heldBy = (role: 'staff' | 'manager' | 'admin') =>
  new Set((Object.keys(CAPABILITY_MATRIX) as Capability[]).filter((c) => CAPABILITY_MATRIX[c][role]));

/** The smallest held set that opens the hub AND the row's route while holding none of the row's write capabilities. */
function lacking(href: string): Set<string> {
  const set = new Set<string>([HUB_CAP, ...capabilitiesForRoute(route(href))]);
  for (const c of WRITE[href]!.caps) set.delete(c);
  return set;
}
/** Can a person reach the hub and the row, yet hold none of its write capabilities? */
const canBeViewOnly = (href: string) => !WRITE[href]!.caps.includes(HUB_CAP) && navHrefAllowed(route(href), lacking(href));

/** The `<a ...>...</a>` of one row, or null when the row is not rendered. */
function rowOf(html: string, href: string): string | null {
  const m = html.match(new RegExp(`<a href="${href.replace(/[?.]/g, '\\$&')}"[\\s\\S]*?</a>`));
  return m ? m[0] : null;
}
async function render(held: Set<string>): Promise<string> {
  state.held = held;
  return renderToStaticMarkup(await SettingsPage());
}

beforeEach(() => {
  state.held = new Set();
});

describe('T-587 S2 - the View only pill, one test per row', () => {
  it('there is one entry per hub row (23), so no row is left untested', () => {
    const src = read(`${A}/settings/page.tsx`);
    const hubHrefs = [...src.matchAll(/<SettingsRow\s+href="([^"]+)"/g)].map((m) => m[1]);
    expect([...hubHrefs].sort()).toEqual([...HREFS].sort());
    expect(HREFS.length).toBe(23); // T-640: 22 -> 23 (+/settings/ai-hub)
  });

  it.each(HREFS)('%s: without its write capability the row is View only (hidden when the route needs that same word); with it, no pill', async (href) => {
    const row = rowOf(await render(lacking(href)), href);
    if (canBeViewOnly(href)) {
      expect(row, `${href} should be shown`).not.toBeNull();
      expect(row, `${href} should carry the pill`).toContain('View only');
    } else {
      // The route's own key is the write word (or the hub's): a person lacking it never reaches the row, so it is hidden, not teased.
      expect(row === null || !row.includes('View only'), href).toBe(true);
    }
    const row2 = rowOf(await render(new Set([...lacking(href), ...WRITE[href]!.caps])), href);
    expect(row2, `${href} shown when write is held`).not.toBeNull();
    expect(row2, href).not.toContain('View only');
  });

  it('exactly these rows can show the pill today; any other row never does [kills: a route key moved without the hub noticing]', () => {
    expect(HREFS.filter(canBeViewOnly).sort()).toEqual(
      // T-603: /expenses/recurring is read-gated by its own write word now, so it can no longer be "view only".
      ['/attendance/terminals', '/menu/usage-source', '/settings/expense-categories', '/settings/organization'].sort(),
    );
  });

  it('a super admin holds everything and sees no pill at all', async () => {
    expect(await render(new Set(Object.keys(CAPABILITY_MATRIX)))).not.toContain('View only');
  });

  it('the pill is a bordered word, not greyed text, and sits before the chevron [kills: a colour-only cue]', async () => {
    const row = rowOf(await render(lacking('/settings/organization')), '/settings/organization')!;
    expect(row).toMatch(/<span class="[^"]*rounded-full[^"]*border[^"]*text-xs[^"]*">View only<\/span>/);
    expect(row.indexOf('View only')).toBeLessThan(row.indexOf('<svg'));
    expect(row.match(/<a /g)?.length).toBe(1); // the words are inside the one link, so a screen reader hears them
  });

  it('manager session: Organisation, Expense categories and Clock terminals are View only; Recurring bills and Kitchen are not [kills: a manager told they can save]', async () => {
    const html = await render(heldBy('manager'));
    for (const h of ['/settings/organization', '/settings/expense-categories', '/attendance/terminals']) expect(rowOf(html, h), h).toContain('View only');
    for (const h of ['/expenses/recurring', '/kitchen']) expect(rowOf(html, h), h).not.toContain('View only');
  });
});

describe("T-587 S2 - HONESTY: each writeCap is the word the screen's save path really authorizes", () => {
  it.each(HREFS)('%s: every writeCap literally appears in an authorize()-bearing source file of that screen', (href) => {
    const { caps, files } = WRITE[href]!;
    const src = files.map((f) => codeOnly(read(f))).join('\n');
    expect(src, `${href}: no authorize( in ${files.join(', ')}`).toMatch(/authorize\(|mayDo\(|requirePageAccess\(/);
    for (const c of caps) expect(src, `${href}: '${c}' not found in ${files.join(', ')}`).toContain(`'${c}'`);
  });

  it('the hub source declares the same writeCap for every row as this table [kills: a hub row and its test drifting apart]', () => {
    const src = read(`${A}/settings/page.tsx`);
    for (const href of HREFS) {
      const tag = src.match(new RegExp(`<SettingsRow\\s+href="${href.replace(/[?.]/g, '\\$&')}"[\\s\\S]*?/>`));
      expect(tag, href).not.toBeNull();
      const declared = tag![0].match(/writeCap=(?:"([a-z_]+)"|\{\[([^\]]*)\]\})/);
      expect(declared, `${href} has no writeCap`).not.toBeNull();
      const got = declared![1] ? [declared![1]] : declared![2]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      expect([...got].sort(), href).toEqual([...WRITE[href]!.caps].sort());
    }
  });
});

describe('T-587 S2 - the two clock pages have route keys, so a cashier no longer sees them', () => {
  const CLOCK = ['/attendance/terminals', '/attendance/lane'];

  it('both are keyed to manage_attendance, the word their loaders already authorize', () => {
    for (const r of CLOCK) expect(ROUTE_CAPABILITY[r], r).toBe('manage_attendance');
    expect(codeOnly(read(`${D}/attendance/terminals.ts`))).toContain(`'manage_attendance'`);
    expect(codeOnly(read(`${D}/sync/health.ts`))).toContain(`'manage_attendance'`);
  });

  it('a cashier is refused, a manager and an admin are allowed [kills: a key nobody holds, or one everybody does]', () => {
    for (const r of CLOCK) {
      const accepted = capabilitiesForRoute(r);
      expect(accepted.length, r).toBeGreaterThan(0);
      expect(accepted.some((c) => CAPABILITY_MATRIX[c].staff), `${r} staff`).toBe(false);
      expect(accepted.some((c) => CAPABILITY_MATRIX[c].manager), `${r} manager`).toBe(true);
      expect(accepted.some((c) => CAPABILITY_MATRIX[c].admin), `${r} admin`).toBe(true);
    }
  });

  it('the sidebar filter hides both for a cashier and shows both to a manager', () => {
    for (const r of CLOCK) {
      expect(navHrefAllowed(r, heldBy('staff')), `${r} cashier`).toBe(false);
      expect(navHrefAllowed(r, heldBy('manager')), `${r} manager`).toBe(true);
    }
  });

  it('both pages call the gate, so the URL is refused too, not just the link hidden [kills: a hidden link over an open page]', () => {
    for (const p of ['attendance/terminals', 'attendance/lane']) {
      const src = codeOnly(read(`${A}/${p}/page.tsx`));
      expect(src, p).toContain(`requirePageAccess('/${p}')`);
      expect(src, p).toContain('if (refusal) return refusal');
    }
  });

  it('on the hub a set without manage_attendance loses the two clock rows, a manager keeps them', async () => {
    const without = await render(new Set([HUB_CAP]));
    for (const r of CLOCK) expect(rowOf(without, r), r).toBeNull();
    const withIt = await render(new Set([HUB_CAP, 'manage_attendance']));
    for (const r of CLOCK) expect(rowOf(withIt, r), r).not.toBeNull();
  });
});
