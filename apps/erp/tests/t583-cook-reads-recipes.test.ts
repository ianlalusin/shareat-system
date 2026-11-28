/**
 * T-583 S2 (Ian, 16 Nov: "cooks can read recipes") - a cook reads the cookbook, never changes it.
 * A cook = holds `record_stock_movement` (by position), holds neither `post_production` nor `manage_recipes`.
 *
 * MUTANTS: route key back to post_production -> "a cook reads" red; the key removed -> "no-role staff are refused" red;
 *   the /new entry dropped (it would inherit record_stock_movement) -> "/new refuses a cook" red; the detail page showing the edit form
 *   without canManage -> "a cook sees /[id] read-only" red; an authorize('manage_recipes') removed from the domain -> "writes keep their gate" red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_MATRIX } from '@shareat/auth';
import { capabilitiesForRoute } from '../src/lib/route-capability';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: () => {
    throw new Error('redirect');
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));

const held = { current: new Set<string>() };
vi.mock('@shareat/auth', async (orig) => ({ ...(await orig<typeof import('@shareat/auth')>()), heldCapabilities: async () => held.current }));
vi.mock('../src/lib/session', () => ({ requireSession: async () => ({ actor: { orgId: 'org-1', personId: 'p-1' } }) }));
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}), listStores: async () => [] }));
vi.mock('../src/app/inventory/production/lib', () => ({ withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/app/inventory/production/recipes/actions', () => ({
  createRecipeAction: async () => {},
  editRecipeAction: async () => {},
  retireRecipeAction: async () => {},
  restoreRecipeAction: async () => {},
}));
vi.mock('../src/app/inventory/production/recipes/lib', async (orig) => ({
  ...(await orig<typeof import('../src/app/inventory/production/recipes/lib')>()),
  recipeDetail: async () => ({
    id: 'r1',
    name: 'Broth',
    status: 'active',
    outputItemId: 'i1',
    outputName: 'Broth',
    outputUnit: 'l',
    outputQuantity: '4',
    lines: [{ itemId: 'i2', itemName: 'Bones', quantity: '2', unit: 'kg', baseUnit: 'kg' }],
  }),
  recipeItemOptions: async () => [{ id: 'i1', code: 'B', name: 'Broth', baseUnit: 'l' }],
  recipeList: async () => [],
}));

const RECIPES = '/inventory/production/recipes';
let requirePageAccess: typeof import('../src/lib/page-access').requirePageAccess;
let Detail: typeof import('../src/app/inventory/production/recipes/[id]/page').default;
beforeAll(async () => {
  requirePageAccess = (await import('../src/lib/page-access')).requirePageAccess;
  Detail = (await import('../src/app/inventory/production/recipes/[id]/page')).default;
}, 30_000);

const cook = () => {
  held.current = new Set(['record_stock_movement']);
};
const renderDetail = async () => renderToStaticMarkup((await Detail({ params: Promise.resolve({ id: 'r1' }), searchParams: Promise.resolve({}) })) as never);

describe('T-583 S2 a cook reads recipes', () => {
  it('a cook reads the list and a recipe; no-role staff are refused both', async () => {
    cook();
    expect((await requirePageAccess(RECIPES)).refusal).toBeNull();
    expect((await requirePageAccess(`${RECIPES}/r1`)).refusal).toBeNull();
    held.current = new Set();
    expect((await requirePageAccess(RECIPES)).refusal).not.toBeNull();
    expect((await requirePageAccess(`${RECIPES}/r1`)).refusal).not.toBeNull();
  });
  it('a cook sees /[id] read-only: the ingredients, no edit form, no retire or restore', async () => {
    cook();
    const h = await renderDetail();
    expect(h).toContain('Bones');
    expect(h).not.toContain('Save recipe');
    expect(h).not.toContain('<form');
    expect(h).not.toMatch(/Retire recipe|Restore recipe/);
  });
  it('a manage_recipes holder gets the edit controls on /[id]', async () => {
    held.current = new Set(['record_stock_movement', 'manage_recipes']);
    expect(await renderDetail()).toContain('Save recipe');
  });
});

describe('T-583 S2 a cook does not write recipes', () => {
  it('/new is its own manage_recipes key and refuses a cook', async () => {
    expect(capabilitiesForRoute(`${RECIPES}/new`)).toEqual(['manage_recipes']);
    cook();
    expect((await requirePageAccess(`${RECIPES}/new`)).refusal).not.toBeNull();
    held.current = new Set(['manage_recipes']);
    expect((await requirePageAccess(`${RECIPES}/new`)).refusal).toBeNull();
  });
  it('the writes keep their own gate: the matrix denies staff and every domain write authorizes manage_recipes first', () => {
    expect(CAPABILITY_MATRIX.manage_recipes.staff).toBe(false);
    const src = readFileSync(path.resolve(__dirname, '../../../packages/domain/src/production/recipes.ts'), 'utf8');
    expect((src.match(/authorize\(tx, actor, 'manage_recipes'/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
