import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-403 R5 - the POS mapping screen offers no mapping edit control to someone who cannot use it.
 *
 * PINNED HOOKS (the builder must satisfy these):
 *  - the page decides with `authorize` from '@shareat/auth' (mocked here: it throws AuthorizationError unless the capability
 *    is in H.caps) on capability 'manage_pos_map'. Whatever helper it goes through, the call must end in that mocked export.
 *  - the "New / edit mapping" form (the one posting to upsertPosItemMapAction, with the posItemKey input) is ABSENT when the
 *    viewer lacks manage_pos_map, PRESENT when they hold it. The page itself must still render (a manager still sees maps).
 *  - the decide-request forms stay for a holder of decide_pos_map_request (unchanged by T-403).
 * Data seams mocked: lib `posMapScreenData`/`listStores`/`withOrgPrincipal`, session, actions.
 * There is no production-recipe screen in apps/erp today (createRecipe has no caller outside the domain), so R5 has no
 * recipe-screen half to test; if the builder adds one, it needs its own test.
 */
import { AuthorizationError } from '@shareat/auth';

const H: { caps: Set<string> } = { caps: new Set() };

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'viewer-1' })),
  requireSession: vi.fn(async () => ({
    actor: { orgId: 'org-1', personId: 'viewer-1' },
    sessionId: 's1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('next/navigation', () => ({
  // T-448 A3: FormModal reads the address.
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/app/inventory/pos-map/actions', () => ({
  upsertPosItemMapAction: vi.fn(),
  decideMapRequestAction: vi.fn(),
}));
vi.mock('../src/app/inventory/pos-map/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/inventory/pos-map/lib')>();
  return {
    ...actual,
    listStores: vi.fn(async () => [{ id: 'store-1', name: 'Rizal Branch', code: 'RZL' }]),
    withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    posMapScreenData: vi.fn(async () => ({
      maps: [{ id: 'm1', posItemKey: 'coke', posItemName: 'Coke', mode: 'no_stock', itemId: null, recipeId: null, status: 'active' }],
      requests: [{ id: 'r1', posItemKey: 'x', posItemName: 'X', note: null, status: 'requested' }],
      items: [{ id: 'i1', code: 'I-1', name: 'Cheese' }],
      recipes: [{ id: 'rc1', name: 'Samgyup Box' }],
      locations: [],
    })),
  };
});
vi.mock('@shareat/auth', async (orig) => {
  const actual = await orig<typeof import('@shareat/auth')>();
  return {
    ...actual,
    authorize: vi.fn(async (_tx: unknown, _actor: unknown, cap: string) => {
      if (!H.caps.has(cap)) throw new actual.AuthorizationError(`no ${cap}`, cap as never);
    }),
    // T-402 S2: render probes use the non-logging can() - same capability set, boolean answer.
    can: vi.fn(async (_tx: unknown, _actor: unknown, cap: string) => H.caps.has(cap)),
  };
});

// Warm the page's import graph once (cold it takes seconds, past the unit project's 5s default).
beforeAll(async () => {
  await import('../src/app/inventory/pos-map/page');
}, 30_000);

async function render(): Promise<string> {
  const Page = (await import('../src/app/inventory/pos-map/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}

beforeEach(() => {
  H.caps = new Set();
});

describe('T-403 R5 - /inventory/pos-map', () => {
  it('a manager (decide_pos_map_request, NOT manage_pos_map) sees the maps and the decide forms but NO mapping form', async () => {
    H.caps = new Set(['decide_pos_map_request', 'request_pos_map']);
    const html = await render();
    expect(html).toContain('Coke'); // the page still renders
    expect(html).toContain('name="requestId"'); // decide forms unchanged
    expect(html).not.toContain('name="posItemKey"');
    expect(html).not.toContain('New / edit mapping');
  });

  it('an admin (manage_pos_map) sees the mapping form', async () => {
    H.caps = new Set(['manage_pos_map', 'decide_pos_map_request', 'request_pos_map']);
    const html = await render();
    expect(html).toContain('name="posItemKey"');
    expect(html).toContain('New / edit mapping');
  });

  it('sanity: the mock really refuses (so the manager case above is a real gate, not a vacuous pass)', async () => {
    const { authorize } = await import('@shareat/auth');
    await expect(authorize({} as never, { orgId: 'o', personId: 'p' } as never, 'manage_pos_map' as never, {})).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
