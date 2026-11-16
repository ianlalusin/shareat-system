import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-589 B3a - four routes had no route key, so a refused person hit the error boundary: `/sales-days`, `/reports/journal-lines`,
 * `/reports/dual-run` (+ children). Each now has the key its page's own `reportScope` gate uses, so `requirePageAccess` answers with the
 * refusal card (in plain words, never the raw capability key). `/` is deliberately NOT keyed: a person without the word gets a plain welcome.
 *
 * Real `requirePageAccess`, route map and pages run; only the session, the principal transaction, held capabilities and the data gate are faked.
 *
 * MUTANTS (each turns a case red): delete a key from `route-capability.ts` -> that card case throws (the data gate refuses);
 * delete the `holdsAny` probe in `app/page.tsx` -> the dashboard case throws; put the raw key back in `AccessRefused` -> the wording cases fail.
 */
const ACTOR = { orgId: 'org-1', personId: 'p-1' };
const H: { held: Set<string> } = { held: new Set() };

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR),
  requireSession: vi.fn(async () => ({ actor: ACTOR, sessionId: 's1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@shareat/auth', async (orig) => {
  const actual = await orig<typeof import('@shareat/auth')>();
  return {
    ...actual,
    heldCapabilities: vi.fn(async () => H.held),
    authorize: vi.fn(async (_tx: unknown, _actor: unknown, cap: string) => {
      if (!H.held.has(cap)) throw new Error(`AuthorizationError: ${cap}`);
    }),
  };
});
vi.mock('@shareat/db', async (orig) => {
  const actual = await orig<typeof import('@shareat/db')>();
  return {
    ...actual,
    accessRepo: { ...actual.accessRepo, personCoversWholeOrg: vi.fn(async () => true), storeIdsForPerson: vi.fn(async () => []) },
  };
});
vi.mock('../src/app/expenses/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/expenses/lib')>();
  const chain = { from: () => chain, where: () => chain, limit: async () => [{ name: 'Shareat', code: 'SHR' }], orderBy: async () => [] };
  return { ...actual, withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => chain })) };
});

import { capabilityForRoute } from '../src/lib/route-capability';
import JournalLinesPage from '../src/app/reports/journal-lines/page';
import DualRunPage from '../src/app/reports/dual-run/page';
import SalesDaysPage from '../src/app/sales-days/page';
import DashboardPage from '../src/app/page';

const sp = { searchParams: Promise.resolve({}) };
const html = (out: unknown) => renderToStaticMarkup(out as never);
/** What a person reads: the markup without tags or attributes. */
const words = (h: string) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  H.held = new Set();
});

describe('T-589 B3a - the unkeyed routes now have keys equal to their data gates', () => {
  it('journal-lines, dual-run (and its children) and sales-days are keyed; `/` stays open', () => {
    expect(capabilityForRoute('/reports/journal-lines')).toBe('view_trial_balance');
    expect(capabilityForRoute('/reports/dual-run')).toBe('view_financial_reports');
    expect(capabilityForRoute('/reports/dual-run/pack')).toBe('view_financial_reports');
    expect(capabilityForRoute('/reports/dual-run/store-1/2026-W01')).toBe('view_financial_reports');
    expect(capabilityForRoute('/sales-days')).toEqual(['submit_sales_day', 'verify_sales_day']);
    expect(capabilityForRoute('/sales-days/019a0000-0000-7000-8000-000000000001/edit')).toEqual(['submit_sales_day', 'verify_sales_day']);
    expect(capabilityForRoute('/')).toBeNull();
  });
});

describe('T-589 B3a - a refused person gets the card, in plain words, not the error boundary', () => {
  it.each([
    ['/reports/journal-lines', JournalLinesPage, 'view the trial balance'],
    ['/reports/dual-run', DualRunPage, 'view financial reports'],
    ['/sales-days', SalesDaysPage, 'submit a sales day or verify a sales day'],
  ])('%s', async (route, Page, label) => {
    const out = html(await (Page as (p: typeof sp) => Promise<unknown>)(sp));
    expect(out).toContain('You do not have access to this screen');
    expect(words(out)).toContain(`This screen is for people who can ${label}. Ask an administrator to give you access under Users and roles.`);
    for (const key of ['view_trial_balance', 'view_financial_reports', 'submit_sales_day', 'verify_sales_day']) {
      expect(words(out), `${route}: raw key ${key} in the text`).not.toContain(key);
    }
  });

  it('a holder is not refused (positive control: the key opens for the word it names)', async () => {
    H.held = new Set(['view_trial_balance']);
    // The data page then runs real report queries (not faked here); the point is only that the REFUSAL is not what comes back.
    const out = await Promise.resolve(JournalLinesPage(sp)).then(html, (e: Error) => `threw:${e.message}`);
    expect(out).not.toContain('You do not have access to this screen');
  });
});

describe('T-589 B3a - `/` never refuses: no financial word means a plain welcome', () => {
  it('renders the welcome, no tiles, no refusal card', async () => {
    const out = html(await DashboardPage(sp));
    expect(out).not.toContain('You do not have access to this screen');
    expect(words(out)).toContain('Welcome');
    expect(out).toContain('href="/expenses"');
  });
});
