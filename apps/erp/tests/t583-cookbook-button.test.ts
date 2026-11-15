/**
 * T-583 S2 - the Cook tab's "Cookbook settings" button, and the read gate on the recipes screens it opens.
 * Hiding a button is not a permission (BOSS ruling): /inventory/production/recipes needs `post_production`, so staff are refused the
 * page itself, not only shown no link. Before this slice the route was NOT gated (no ROUTE_CAPABILITY entry; the pages used requireSession).
 *
 * MUTANTS: remove the ROUTE_CAPABILITY entry -> the map test and "staff are refused" go red; a recipes page back on requireSession -> the
 *   source test goes red; the button shown to staff -> "not for staff"; shown on kind=slice -> "not on slice".
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

describe('T-583 S2 Cookbook settings button', () => {
  it('shows for a holder of post_production on kind=cook, linking to the recipes screen', async () => {
    held.current = new Set(['post_production']);
    const h = await render('cook');
    expect(h).toContain('Cookbook settings');
    expect(h).toContain(`href="${RECIPES}"`);
    expect(h).toContain('min-h-11');
    expect(h).not.toMatch(/>Recipes</);
  });
  it('does not show for staff (no post_production)', async () => {
    held.current = new Set(['record_stock_movement']);
    expect(await render('cook')).not.toContain('Cookbook settings');
  });
  it('does not show on kind=slice even for a holder', async () => {
    held.current = new Set(['post_production']);
    expect(await render('slice')).not.toContain('Cookbook settings');
  });
});

describe('T-583 S2 the recipes screens are read-gated by post_production', () => {
  it('the map names the route and its children inherit it', () => {
    expect(capabilitiesForRoute(RECIPES)).toEqual(['post_production']);
    expect(capabilitiesForRoute(`${RECIPES}/new`)).toEqual(['post_production']);
    expect(capabilitiesForRoute(`${RECIPES}/0194a1b2-0000-7000-8000-000000000000`)).toEqual(['post_production']);
    expect(capabilitiesForRoute('/inventory/production')).toEqual([]);
  });
  it('a staff member without post_production is refused the page itself; a manager gets it', async () => {
    held.current = new Set(['record_stock_movement']);
    expect((await requirePageAccess(RECIPES)).refusal).not.toBeNull();
    held.current = new Set(['post_production']);
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
