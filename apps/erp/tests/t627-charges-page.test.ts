import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-627 - the Charges section of `/admin/pos-tablets` (docs/tasks/627-pos-charges.md). Data layer mocked, markup asserted.
 * The list shows each active charge as "150.00 each" or "150.00 once per bill"; Add, Change and Retire are drawn only for a person who may manage the store's settings.
 */
const STORE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
const H: { charges: { presets: unknown[]; canManage: boolean }; copy: unknown } = { charges: { presets: [], canManage: true }, copy: null };

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/pos-tablets',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/lib/flash', () => ({ withFlash: vi.fn(async (p: Promise<unknown>) => p), redirectWithFlash: vi.fn() }));
vi.mock('../src/lib/page-access', () => ({ requirePageAccess: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'admin-1' }, refusal: null })) }));
vi.mock('../src/app/staff/lib', async () => ({ staffStoresFor: vi.fn(async () => [STORE]) }));
vi.mock('../src/app/admin/pos-tablets/actions', () => ({
  registerTabletAction: vi.fn(), revokeTabletAction: vi.fn(), clearLockAction: vi.fn(), createTillAction: vi.fn(), linkTillAction: vi.fn(), setTillPrinterAction: vi.fn(),
  savePresetAction: vi.fn(), retirePresetAction: vi.fn(), saveChargeAction: vi.fn(), retireChargeAction: vi.fn(),
}));
vi.mock('../src/app/copy-from-store/actions', () => ({ copyFromStoreAction: vi.fn(), previewCopyAction: vi.fn() }));
vi.mock('../src/app/admin/pos-tablets/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/admin/pos-tablets/lib')>();
  return {
    ...actual,
    loadPosTablets: vi.fn(async () => ({ active: null, revoked: [], terminals: [] })),
    loadTills: vi.fn(async () => ({ terminals: [], freePairings: [] })),
    loadCopyStores: vi.fn(async () => H.copy),
    loadDiscounts: vi.fn(async () => ({ presets: [], canManage: false })),
    loadCharges: vi.fn(async () => H.charges),
  };
});

beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 120_000);

async function section(): Promise<string> {
  const Page = (await import('../src/app/admin/pos-tablets/page')).default;
  const html = renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
  const from = html.indexOf('data-charges');
  return html.slice(from, html.indexOf('data-tills'));
}
const outsideDialogs = (html: string): string => html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');
const rows = (html: string): string[] => html.match(/<li[^>]*data-charge[^>]*>[\s\S]*?<\/li>/g) ?? [];

const CHARGES = [
  { id: 'c-1', name: 'Leftover', amount: '100.00', perUnit: true },
  { id: 'c-2', name: 'Extra griller', amount: '150.00', perUnit: false },
];

beforeEach(() => {
  H.charges = { presets: CHARGES, canManage: true };
  H.copy = null;
});

describe('T-627 the Charges section', () => {
  it('lists each active charge as pesos each or once per bill, with Change and Retire on its row and an Add charge button', async () => {
    const html = await section();
    const [leftover, griller] = rows(html);
    expect(leftover).toContain('Leftover');
    expect(leftover).toMatch(/100\.00 each/);
    expect(griller).toContain('Extra griller');
    expect(griller).toMatch(/150\.00 once per bill/);
    for (const r of [leftover, griller]) {
      expect(r).toContain('Change');
      expect(r).toContain('Retire');
    }
    expect(outsideDialogs(html)).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Add charge<\/button>/);
    expect(html).toContain('name="perUnit"'); // the Add and Change windows are mounted
  });

  it('Change locks the name and keeps the per-unit tick; Retire carries the charge id', async () => {
    const [leftover] = rows(await section());
    expect(leftover).toMatch(/<input[^>]*name="name"[^>]*readonly=""[^>]*value="Leftover"/);
    expect(leftover).toMatch(/name="presetId"[^>]*value="c-1"/);
    expect(leftover).toMatch(/name="perUnit"[^>]*checked=""|checked=""[^>]*name="perUnit"/);
    expect(leftover).toContain('To rename a charge, retire it and add a new one.');
  });

  it('a person without manage_store_settings sees the list only: no Add, Change, Retire or Copy', async () => {
    H.charges = { presets: CHARGES, canManage: false };
    H.copy = [{ id: 'store-2', name: 'Other', code: 'OTH' }];
    const html = await section();
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('Leftover');
    expect(html).not.toContain('Add charge');
    expect(html).not.toContain('Change');
    expect(html).not.toContain('Retire');
    expect(html).not.toContain('Copy from another store');
    expect(html).not.toContain('name="presetId"');
  });

  it('keeps the Copy from another store button for an administrator, and says so plainly when there is nothing yet', async () => {
    H.charges = { presets: [], canManage: true };
    H.copy = [{ id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' }, { id: 'store-2', name: 'Other', code: 'OTH' }];
    const html = await section();
    expect(html).toContain('Copy from another store');
    expect(html).toContain('No charges at SharEat Lipa yet.');
  });
});
