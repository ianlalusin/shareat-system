/**
 * T-583 S2 - the Cook tab's cookbook button, and the read gate on the recipes screens it opens.
 * Ian, 16 Nov: "cooks can read recipes". Hiding a button is not a permission (BOSS ruling): /inventory/production/recipes needs
 * `record_stock_movement` (a cook holds it by position), so staff with no cook role are refused the page itself. /new needs `manage_recipes`.
 * (The detail / new / edit cases for a cook live in t583-cook-reads-recipes.test.ts.)
 *
 * MUTANTS: route key back to post_production -> the map test and "a cook gets it" go red; the ROUTE_CAPABILITY entry removed -> the map test and
 *   "no-role staff are refused" go red; a recipes page back on requireSession -> the source test goes red; the full button shown to a cook ->
 *   "cook sees Recipes"; shown on kind=slice -> "not on slice".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { capabilitiesForRoute } from '../src/lib/route-capability';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: () => {
    throw new Error('redirect');
  },
}));

const held = { current: new Set<string>() };
vi.mock('@shareat/auth', async (orig) => ({ ...(await orig<typeof import('@shareat/auth')>()), heldCapabilities: async () => held.current }));
// T-603: the pages ask `storePageScope` (route gate + the viewer's stores); this harness stubs the session, so the scope is stubbed to its one store.
vi.mock('../src/lib/store-scope', () => ({
  storePageScope: async (_route: string, requested?: string) => ({
    actor: { orgId: 'org-1', personId: 'p-1' },
    stores: [{ id: 'store-1', name: 'Lipa', code: 'LP' }],
    storeId: requested ?? 'store-1',
  }),
  recordInScope: async () => true,
  listStoreIds: async () => undefined,
}));
vi.mock('../src/lib/session', () => ({ requireSession: async () => ({ actor: { orgId: 'org-1', personId: 'p-1' } }) }));
vi.mock('../src/app/expenses/lib', () => ({
  withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}),
  listStores: async () => [{ id: 'store-1', name: 'Lipa', code: 'LP' }],
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/app/inventory/production/actions', () => ({ saveProductionDraftAction: async () => {} }));
vi.mock('../src/app/inventory/production/lib', () => ({
  withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}),
  listStores: async () => [{ id: 'store-1', name: 'Lipa', code: 'LP' }],
  productionScreenData: async () => ({
    locations: [{ id: 'l1', name: 'Kitchen' }],
    items: [],
    inputItems: [],
    recipes: [{ id: 'r1', name: 'Broth', outputItemId: 'i1', outputQuantity: '4' }],
    records: [],
  }),
}));

let ProductionPage: typeof import('../src/app/inventory/production/page').default;
let requirePageAccess: typeof import('../src/lib/page-access').requirePageAccess;
beforeAll(async () => {
  ProductionPage = (await import('../src/app/inventory/production/page')).default;
  requirePageAccess = (await import('../src/lib/page-access')).requirePageAccess;
}, 30_000);

const render = async (kind: string) => renderToStaticMarkup((await ProductionPage({ searchParams: Promise.resolve({ kind }) })) as never);
const RECIPES = '/inventory/production/recipes';

describe('T-583 S2 the Cook tab cookbook button', () => {
  it('shows "Cookbook settings" for a holder of post_production on kind=cook, linking to the recipes screen', async () => {
    held.current = new Set(['post_production', 'record_stock_movement']);
    const h = await render('cook');
    expect(h).toContain('Cookbook settings');
    expect(h).toContain(`href="${RECIPES}"`);
    expect(h).toContain('min-h-11');
    expect(h).not.toMatch(/>Recipes</);
  });
  it('a cook (record_stock_movement, no post_production) sees a plain "Recipes" link with the book icon, not "Cookbook settings"', async () => {
    held.current = new Set(['record_stock_movement']);
    const h = await render('cook');
    expect(h).toMatch(/>Recipes</);
    expect(h).toContain('<svg');
    expect(h).toContain(`href="${RECIPES}"`);
    expect(h).not.toContain('Cookbook settings');
  });
  it('shows nothing to a person with neither word', async () => {
    held.current = new Set();
    const h = await render('cook');
    expect(h).not.toContain('Cookbook settings');
    expect(h).not.toContain(`href="${RECIPES}"`);
  });
  it('does not show on kind=slice even for a holder', async () => {
    held.current = new Set(['post_production', 'record_stock_movement']);
    const h = await render('slice');
    expect(h).not.toContain('Cookbook settings');
    expect(h).not.toContain(`href="${RECIPES}"`);
  });
});

describe('T-583 S2 the recipes screens are read-gated by record_stock_movement', () => {
  it('the map names the route; /[id] inherits it; /new has its own manage_recipes key (the longer prefix wins)', () => {
    expect(capabilitiesForRoute(RECIPES)).toEqual(['record_stock_movement']);
    expect(capabilitiesForRoute(`${RECIPES}/0194a1b2-0000-7000-8000-000000000000`)).toEqual(['record_stock_movement']);
    expect(capabilitiesForRoute(`${RECIPES}/new`)).toEqual(['manage_recipes']);
    // T-603: /inventory is keyed now; the production screen reads by that list (the recipes keys above are longer and win).
    expect(capabilitiesForRoute('/inventory/production')).toEqual(capabilitiesForRoute('/inventory'));
  });
  it('staff with no cook role (no record_stock_movement) are refused the page itself; a cook and a manager get it', async () => {
    held.current = new Set();
    expect((await requirePageAccess(RECIPES)).refusal).not.toBeNull();
    held.current = new Set(['record_stock_movement']);
    expect((await requirePageAccess(RECIPES)).refusal).toBeNull();
    held.current = new Set(['record_stock_movement', 'post_production']);
    expect((await requirePageAccess(RECIPES)).refusal).toBeNull();
  });
  it('all three recipes pages call requirePageAccess in code', () => {
    const root = path.resolve(__dirname, '../src/app/inventory/production/recipes');
    for (const rel of ['page.tsx', '[id]/page.tsx', 'new/page.tsx']) {
      const src = readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, rel).toContain('requirePageAccess(');
      expect(src, rel).not.toContain('requireSession(');
    }
  });
});
