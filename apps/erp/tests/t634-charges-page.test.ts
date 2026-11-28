import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-634 - "Charges (all stores)" (the org's one list) and the store's Charges switches on `/admin/pos-tablets` (docs/tasks/634-central-charges.md).
 * Data layer mocked, markup asserted. Replaces T-627's per-store add / change / retire page test.
 */
const STORE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
type Opt = { id: string; name: string; amount: string; perUnit: boolean; status: 'active' | 'retired'; storesOn: number };
const H: { master: { options: Opt[]; canManage: boolean }; store: { rows: { option: Opt; on: boolean }[]; canManage: boolean } } = {
  master: { options: [], canManage: true },
  store: { rows: [], canManage: true },
};

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/pos-tablets',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/lib/flash', () => ({ withFlash: vi.fn(async (p: Promise<unknown>) => p), redirectWithFlash: vi.fn() }));
vi.mock('../src/lib/page-access', () => ({ requirePageAccess: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'admin-1' }, refusal: null })) }));
vi.mock('../src/app/staff/lib', async () => ({ staffStoresFor: vi.fn(async () => [STORE]) }));
vi.mock('../src/app/admin/pos-tablets/actions', () => ({
  registerTabletAction: vi.fn(), revokeTabletAction: vi.fn(), clearLockAction: vi.fn(), createTillAction: vi.fn(), linkTillAction: vi.fn(), setTillPrinterAction: vi.fn(),
  savePresetAction: vi.fn(), retirePresetAction: vi.fn(), createChargeOptionAction: vi.fn(), updateChargeOptionAction: vi.fn(), setChargeOptionStatusAction: vi.fn(), setStoreChargeAction: vi.fn(), addTablesAction: vi.fn(), retireTableAction: vi.fn(),
}));
vi.mock('../src/app/copy-from-store/actions', () => ({ copyFromStoreAction: vi.fn(), previewCopyAction: vi.fn() }));
vi.mock('../src/app/admin/pos-tablets/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/admin/pos-tablets/lib')>();
  return {
    ...actual,
    loadPosTablets: vi.fn(async () => ({ active: null, revoked: [], terminals: [] })),
    loadTills: vi.fn(async () => ({ terminals: [], freePairings: [] })),
    loadCopyStores: vi.fn(async () => [{ id: 'store-2', name: 'Other', code: 'OTH' }]),
    loadDiscounts: vi.fn(async () => ({ presets: [], canManage: false })),
    loadChargeOptions: vi.fn(async () => H.master),
    loadStoreCharges: vi.fn(async () => H.store),
    loadTables: vi.fn(async () => ({ active: [], retired: [], canManage: false })), // T-633
  };
});


beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 120_000);

async function page(): Promise<string> {
  const Page = (await import('../src/app/admin/pos-tablets/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}
const between = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const master = async () => between(await page(), 'data-charge-options', 'name="store"');
const storeSection = async () => between(await page(), 'data-charges', 'data-tills');
const outsideDialogs = (html: string): string => html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');
const rowsOf = (html: string, attr: string): string[] => html.match(new RegExp(`<tr[^>]*${attr}[^>]*>[\\s\\S]*?<\\/tr>`, 'g')) ?? [];

const LEFTOVER = { id: 'o-1', name: 'Leftover', amount: '100.00', perUnit: true, status: 'active' as const, storesOn: 2 };
const GRILLER = { id: 'o-2', name: 'Extra griller', amount: '150.00', perUnit: false, status: 'active' as const, storesOn: 0 };
const OLD = { id: 'o-3', name: 'Corkage', amount: '200.00', perUnit: false, status: 'retired' as const, storesOn: 0 };

beforeEach(() => {
  H.master = { options: [LEFTOVER, GRILLER, OLD], canManage: true };
  H.store = { rows: [{ option: LEFTOVER, on: true }, { option: GRILLER, on: false }], canManage: true };
});

describe('T-634 Charges (all stores): the org list', () => {
  it('sits above the store picker and the store sections', async () => {
    const html = await page();
    expect(html.indexOf('data-charge-options')).toBeLessThan(html.indexOf('name="store"'));
    expect(html.indexOf('data-charge-options')).toBeLessThan(html.indexOf('data-charges='));
  });

  it('lists each active charge with its amount and how many stores use it; a retired one sits in a collapsed block with Restore', async () => {
    const html = await master();
    const [leftover, griller] = rowsOf(html, 'data-charge-option');
    expect(leftover).toContain('Leftover');
    expect(leftover).toMatch(/100\.00 each/);
    expect(leftover).toMatch(/>2</);
    expect(griller).toMatch(/150\.00 once per bill/);
    expect(griller).toContain('Not used yet');
    expect(html).toContain('1 of 2 switched on at a store');
    expect(html).toMatch(/<summary[^>]*>Retired charges \(1\)<\/summary>/);
    expect(html).toMatch(/aria-label="Restore Corkage"/);
  });

  it('Add opens a form for name, amount and per unit; each row has a quiet Edit (amount; Retire appears once Edit is pressed)', async () => {
    const html = await master();
    expect(outsideDialogs(html)).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Add charge<\/button>/);
    expect(html).toContain('name="name"');
    const [leftover] = rowsOf(html, 'data-charge-option');
    expect(leftover).toMatch(/aria-label="Edit Leftover"/);
    expect(leftover).toContain('name="chargeOptionId"');
  });

  it('without manage_menu (a store manager) the list is read-only: no Add, Edit, Retire or Restore', async () => {
    H.master = { ...H.master, canManage: false };
    const html = await master();
    expect(rowsOf(html, 'data-charge-option')).toHaveLength(2);
    expect(html).not.toContain('Add charge');
    expect(html).not.toMatch(/aria-label="Edit /);
    expect(html).not.toContain('Restore');
    expect(html).not.toContain('name="chargeOptionId"');
  });
});

describe('T-634 the store Charges section: on/off switches', () => {
  it('each brand charge with its status; On is one tap, Off asks once; no amount or name field at the store', async () => {
    const html = await storeSection();
    const [leftover, griller] = rowsOf(html, 'data-charge');
    expect(leftover).toContain('Leftover');
    expect(leftover).toMatch(/>On<\/span>/);
    expect(leftover).toMatch(/name="on"[^>]*value="0"/);
    expect(leftover).toContain('Off');
    expect(griller).toMatch(/>Off<\/span>/);
    expect(griller).toMatch(/name="on"[^>]*value="1"/);
    expect(griller).toMatch(/aria-label="Switch Extra griller on at SharEat Lipa"/);
    expect(html).toContain('1 of 2 on');
    expect(html).not.toContain('name="amount"');
    expect(html).not.toContain('Copy from another store');
  });

  it('a person without manage_store_settings sees the statuses only', async () => {
    H.store = { ...H.store, canManage: false };
    const html = await storeSection();
    expect(rowsOf(html, 'data-charge')).toHaveLength(2);
    expect(html).not.toContain('name="on"');
  });

  it('says where charges come from when there are none', async () => {
    H.store = { rows: [], canManage: true };
    expect(await storeSection()).toContain('No charges yet. They are added once for all stores, in the list above.');
  });
});
