import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-546 (planner ruling 1) - the SAME Tills section on `/settings/pos-tablet`, for a store's manager, scoped to their store. Data layer mocked, markup asserted.
 *   - a manager sees the Tills section for each store they may pair at, built from the one TillsSection component (forms come back to this page: returnTo);
 *   - a cashier (no store holds pair_pos_tablet for them) gets no Tills section, and a person the route refuses gets the refusal and nothing is loaded;
 *   - the "One tablet per store" sentence is on the section.
 * The write side (a manager adds a till, links it, sets the printer; another store's manager and a cashier are refused) is t546-pos-tills-actions.test.ts.
 */
const MINE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
const H: { allowed: boolean; stores: unknown[]; loadedFor: string[] } = { allowed: true, stores: [MINE], loadedFor: [] };

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/lib/flash', () => ({ withFlash: vi.fn(async (p: Promise<unknown>) => p), redirectWithFlash: vi.fn() }));
vi.mock('../src/lib/page-access', () => ({
  requirePageAccess: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'mgr-1' }, refusal: H.allowed ? null : 'REFUSED' })),
}));
vi.mock('../src/app/staff/lib', async () => ({ staffStoresFor: vi.fn(async () => H.stores) }));
vi.mock('../src/app/expenses/lib', async () => ({ withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => unknown) => fn({})) }));
vi.mock('@shareat/db', async (orig) => ({ ...(await orig<typeof import('@shareat/db')>()), posTabletPairingsRepo: { listForStores: vi.fn(async () => []) } }));
vi.mock('../src/app/settings/pos-tablet/actions', () => ({ pairPosTabletAction: vi.fn(), unpairPosTabletAction: vi.fn() }));
vi.mock('../src/app/admin/pos-tablets/actions', () => ({ createTillAction: vi.fn(), linkTillAction: vi.fn(), setTillPrinterAction: vi.fn() }));
vi.mock('../src/app/admin/pos-tablets/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/admin/pos-tablets/lib')>();
  return {
    ...actual,
    loadTills: vi.fn(async (_actor: unknown, storeId: string) => {
      H.loadedFor.push(storeId);
      return { terminals: [{ id: 'till-1', terminalNo: 1, pairingId: null, pairingLabel: null, receiptPaperMm: 58, receiptCopies: 1 }], freePairings: [] };
    }),
  };
});

beforeAll(async () => {
  await import('../src/app/settings/pos-tablet/page');
}, 120_000);

async function render(): Promise<string> {
  const Page = (await import('../src/app/settings/pos-tablet/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}

beforeEach(() => {
  H.allowed = true;
  H.stores = [MINE];
  H.loadedFor = [];
});

describe('Tills on /settings/pos-tablet', () => {
  it('a manager gets the Tills section for their store, reading only that store, with forms that return to this page', async () => {
    const html = await render();
    expect(html).toContain('data-tills');
    expect(H.loadedFor).toEqual(['store-1']);
    expect(html).toContain('Till 1');
    expect(html).toMatch(/name="returnTo"[^>]*value="\/settings\/pos-tablet"/);
    expect(html).not.toContain('value="/admin/pos-tablets"');
    expect(html).toContain('One tablet per store. To replace it, un-pair the old tablet first.');
  });

  it('a person who may pair at no store (a cashier) gets no Tills section and nothing is loaded', async () => {
    H.stores = [];
    const html = await render();
    expect(html).not.toContain('data-tills');
    expect(H.loadedFor).toEqual([]);
  });

  it('a person the route refuses gets the refusal, not the page', async () => {
    H.allowed = false;
    expect(await render()).toBe('REFUSED');
    expect(H.loadedFor).toEqual([]);
  });
});
