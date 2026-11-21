import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-622 - the Discounts section of `/admin/pos-tablets` (docs/tasks/622-pos-discount-presets-screen.md). Data layer mocked, markup asserted.
 * The list shows each active discount as "20%" or "off each"; Add, Change and Retire are drawn only for a person who may manage the store's settings.
 */
const STORE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
const H: { discounts: { presets: unknown[]; canManage: boolean }; copy: unknown } = { discounts: { presets: [], canManage: true }, copy: null };

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
  savePresetAction: vi.fn(), retirePresetAction: vi.fn(),
}));
vi.mock('../src/app/copy-from-store/actions', () => ({ copyFromStoreAction: vi.fn(), previewCopyAction: vi.fn() }));
vi.mock('../src/app/admin/pos-tablets/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/admin/pos-tablets/lib')>();
  return {
    ...actual,
    loadPosTablets: vi.fn(async () => ({ active: null, revoked: [], terminals: [] })),
    loadTills: vi.fn(async () => ({ terminals: [], freePairings: [] })),
    loadCopyStores: vi.fn(async () => H.copy),
    loadDiscounts: vi.fn(async () => H.discounts),
  };
});

beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 120_000);

async function section(): Promise<string> {
  const Page = (await import('../src/app/admin/pos-tablets/page')).default;
  const html = renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
  const from = html.indexOf('data-discounts');
  return html.slice(from, html.indexOf('data-tills'));
}
const outsideDialogs = (html: string): string => html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');
const rows = (html: string): string[] => html.match(/<li[^>]*data-preset[^>]*>[\s\S]*?<\/li>/g) ?? [];

const PRESETS = [
  { id: 'p-1', name: 'Staff meal', valueType: 'percent', value: '20.00' },
  { id: 'p-2', name: 'Promo 50', valueType: 'fixed', value: '50.00' },
];

beforeEach(() => {
  H.discounts = { presets: PRESETS, canManage: true };
  H.copy = null;
});

describe('T-622 the Discounts section', () => {
  it('lists each active discount as a percent or pesos off each, with Change and Retire on its row and an Add discount button', async () => {
    const html = await section();
    const [staff, promo] = rows(html);
    expect(staff).toContain('Staff meal');
    expect(staff).toContain('20%');
    expect(promo).toContain('Promo 50');
    expect(promo).toMatch(/50\.00 off each/);
    for (const r of [staff, promo]) {
      expect(r).toContain('Change');
      expect(r).toContain('Retire');
    }
    expect(outsideDialogs(html)).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Add discount<\/button>/);
    expect(html).toContain('name="valueType"'); // the Add and Change windows are mounted
  });

  it('Change locks the name; Retire carries the preset id', async () => {
    const [staff] = rows(await section());
    expect(staff).toMatch(/<input[^>]*name="name"[^>]*readonly=""[^>]*value="Staff meal"/);
    expect(staff).toMatch(/name="presetId"[^>]*value="p-1"/);
    expect(staff).toContain('To rename a discount, retire it and add a new one.');
  });

  it('a person without manage_store_settings sees the list only: no Add, Change, Retire or Copy', async () => {
    H.discounts = { presets: PRESETS, canManage: false };
    H.copy = [{ id: 'store-2', name: 'Other', code: 'OTH' }];
    const html = await section();
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('Staff meal');
    expect(html).not.toContain('Add discount');
    expect(html).not.toContain('Change');
    expect(html).not.toContain('Retire');
    expect(html).not.toContain('Copy from another store');
    expect(html).not.toContain('name="presetId"');
  });

  it('keeps the Copy from another store button for an administrator, and says so plainly when there is nothing yet', async () => {
    H.discounts = { presets: [], canManage: true };
    H.copy = [{ id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' }, { id: 'store-2', name: 'Other', code: 'OTH' }];
    const html = await section();
    expect(html).toContain('Copy from another store');
    expect(html).toContain('No named discounts at SharEat Lipa yet.');
  });
});
