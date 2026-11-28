/**
 * T-583 S1 - /inventory/locations draws each room as a card, and an empty room says so.
 * docs/tasks/583-locations-cards.md. Harness: renderToStaticMarkup with the page's reads mocked.
 *
 * MUTANTS: itemCounts ignored (every room shows the empty state) -> "3 items"; the empty-state branch dropped -> "Record a delivery";
 *   the inactive guard dropped -> the inactive test; EmptyState `size` ignored -> the sm test.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EmptyState } from '../src/components/ui/EmptyState';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: () => {
    throw new Error('redirect');
  },
}));
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
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/app/inventory/locations/actions', () => {
  const noop = async () => {};
  return {
    createLocationAction: noop,
    deactivateLocationAction: noop,
    reactivateLocationAction: noop,
    setDefaultAction: noop,
    setupRoomsAction: noop,
    updateLocationAction: noop,
  };
});

const loc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  code: id.toUpperCase(),
  name: `Room ${id}`,
  typeId: 't1',
  typeName: 'Storage',
  role: 'storage',
  purpose: 'normal',
  isDefault: false,
  status: 'active',
  ...over,
});
const dataMock = vi.fn();
vi.mock('../src/app/inventory/locations/lib', () => ({
  listStores: async () => [{ id: 'store-1', name: 'Lipa', code: 'LP' }],
  locationsPageData: (...a: unknown[]) => dataMock(...a),
}));

let Page: typeof import('../src/app/inventory/locations/page').default;
beforeAll(async () => {
  Page = (await import('../src/app/inventory/locations/page')).default;
}, 30_000);

async function html(rooms: unknown[], itemCounts: Record<string, number>) {
  dataMock.mockResolvedValueOnce({ stockModel: 'multi_room', locations: rooms, types: [{ id: 't1', name: 'Storage' }], itemCounts });
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}

describe('T-583 S1 room cards', () => {
  it('a room holding 0 items shows the small empty state and its Record a delivery link', async () => {
    const h = await html([loc('a')], {});
    expect(h).toContain('Nothing stored here yet');
    expect(h).toContain('data-illustration="truck"');
    expect(h).toContain('href="/inventory/deliveries?store=store-1"');
    expect(h).toContain('Record a delivery');
    expect(h).not.toContain('<table');
  });
  it('a room holding 3 items says "3 items in stock" and a room holding 1 says "1 item in stock"', async () => {
    const h = await html([loc('a'), loc('b')], { a: 3, b: 1 });
    expect(h).toContain('3 items in stock');
    expect(h).toContain('1 item in stock');
    expect(h).not.toContain('Nothing stored here yet');
  });
  it('an inactive room shows neither the empty state nor Deactivate, but keeps Reactivate', async () => {
    const h = await html([loc('a', { status: 'inactive' })], {});
    expect(h).toContain('Inactive — holds nothing new.');
    expect(h).not.toContain('Nothing stored here yet');
    expect(h).not.toContain('Deactivate');
    expect(h).toContain('Reactivate');
  });
  it('the default room carries a Default pill and no Deactivate button', async () => {
    const h = await html([loc('a', { isDefault: true })], { a: 2 });
    expect(h).toContain('>Default<');
    expect(h).not.toContain('Deactivate room');
  });
});

describe('T-583 EmptyState size="sm"', () => {
  it('keeps one svg, the same drawing, at the smaller size', () => {
    const md = renderToStaticMarkup(createElement(EmptyState, { illustration: 'truck', title: 't' }));
    const sm = renderToStaticMarkup(createElement(EmptyState, { illustration: 'truck', title: 't', size: 'sm' }));
    expect(sm.match(/<svg/g)?.length).toBe(1);
    expect(sm).toContain('h-[45px] w-[60px]');
    expect(md).toContain('h-[90px] w-[120px]');
    const inner = (h: string) => /<svg[\s\S]*?<\/svg>/.exec(h)![0].replace(/class="[^"]*"/, '');
    expect(inner(sm)).toBe(inner(md));
  });
});
