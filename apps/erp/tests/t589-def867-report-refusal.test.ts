import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-589 B1 / DEF-867 - a manager on /reports/balance-sheet or /reports/trial-balance used to land on the error boundary, because
 * `reportScope` called `requireSession` and `authorizeForScope` THROWS for a refused person. Now `reportScope` gates with
 * `requirePageAccess(path)` and hands the refusal card back. The real `requirePageAccess` and route map run here; only the
 * session, the principal transaction, the held capabilities and the data gate are faked.
 *
 * MUTANT: put `requireSession(path)` back in `reportScope` (app/reports/lib.ts) -> the manager cases go red (authorize throws).
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
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ name: 'Shareat', code: 'SHR' }],
    orderBy: async () => [],
  };
  return { ...actual, withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => chain })) };
});

import { reportScope } from '../src/app/reports/lib';
import TrialBalancePage from '../src/app/reports/trial-balance/page';
import BalanceSheetPage from '../src/app/reports/balance-sheet/page';
import { capabilityForRoute } from '../src/lib/route-capability';

const MANAGER = ['view_financial_reports', 'record_ar_collection'];
const ADMIN = [...MANAGER, 'view_trial_balance'];
const sp = { searchParams: Promise.resolve({}) };

beforeEach(() => {
  H.held = new Set(MANAGER);
});

describe('DEF-867 - report pages refuse with the card, not the error boundary', () => {
  it('the balance-sheet route key equals its data gate', () => {
    expect(capabilityForRoute('/reports/balance-sheet')).toBe('view_trial_balance');
  });

  it('a manager without view_trial_balance gets the refusal card on trial-balance and balance-sheet (no throw)', async () => {
    for (const Page of [TrialBalancePage, BalanceSheetPage]) {
      const out = await Page(sp);
      const html = renderToStaticMarkup(out as never);
      expect(html).toContain('You do not have access to this screen');
      expect(html).toContain('view_trial_balance');
    }
  });

  it('reportScope itself returns the refusal for the manager, and the scope for an admin', async () => {
    const refused = await reportScope('/reports/balance-sheet', 'view_trial_balance', undefined);
    expect('refusal' in refused).toBe(true);

    H.held = new Set(ADMIN);
    const ok = await reportScope('/reports/balance-sheet', 'view_trial_balance', undefined);
    expect('refusal' in ok).toBe(false);
    if (!('refusal' in ok)) expect(ok.actor.orgId).toBe('org-1');
  });

  it('a route that stays open in the map still reaches the data gate, which still throws (defence in depth)', async () => {
    await expect(reportScope('/reports/journal-lines', 'view_trial_balance', undefined)).rejects.toThrow(/AuthorizationError/);
  });
});
