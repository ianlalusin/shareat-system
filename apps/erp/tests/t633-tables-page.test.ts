import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-633 - the Tables section of `/admin/pos-tablets` (docs/tasks/633-tables-screen.md). Data layer mocked, markup asserted.
 * Active table numbers as chips in numeric order, retired ones in a collapsed block, Add and Retire only for a person who may manage the store's settings.
 */
const STORE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
const H: { tables: { active: { id: string; number: number }[]; retired: { id: string; number: number }[]; canManage: boolean } } = { tables: { active: [], retired: [], canManage: true } };

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
    loadCopyStores: vi.fn(async () => null),
    loadDiscounts: vi.fn(async () => ({ presets: [], canManage: false })),
    loadChargeOptions: vi.fn(async () => ({ options: [], canManage: false })),
    loadStoreCharges: vi.fn(async () => ({ rows: [], canManage: false })),
    loadTables: vi.fn(async () => H.tables),
  };
});

beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 120_000);


beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 120_000);

async function page(): Promise<string> {
  const Page = (await import('../src/app/admin/pos-tablets/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}
async function section(): Promise<string> {
  const html = await page();
  return html.slice(html.indexOf('data-tables'), html.indexOf('data-tills'));
}
const outsideDialogs = (html: string): string => html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');
const chipNumbers = (html: string): number[] => [...html.matchAll(/<li[^>]*data-table[^>]*>(\d+)<\/li>/g)].map((m) => Number(m[1]));

beforeEach(() => {
  H.tables = {
    active: [10, 2, 1, 3].map((n) => ({ id: `t-${n}`, number: n })),
    retired: [{ id: 't-8', number: 8 }],
    canManage: true,
  };
});

describe('T-633 the Tables section', () => {
  it('sits after Charges and before Tills on the page', async () => {
    const html = await page();
    expect(html.indexOf('data-charges')).toBeLessThan(html.indexOf('data-tables'));
    expect(html.indexOf('data-tables')).toBeLessThan(html.indexOf('data-tills'));
  });

  it('lists the active numbers as chips in numeric order, with the count', async () => {
    const html = await section();
    const [activeList] = outsideDialogs(html).split('<details');
    expect(chipNumbers(activeList!)).toEqual([1, 2, 3, 10]);
    expect(html).toMatch(/Tables <span[^>]*>\(4\)<\/span>/);
  });

  it('retired numbers sit in a collapsed Retired block and are not offered for retire', async () => {
    const html = await section();
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>Retired \(1\)<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*open/);
    const retiredBlock = html.slice(html.indexOf('<details'));
    expect(chipNumbers(retiredBlock)).toEqual([8]);
    expect(html).not.toContain('value="t-8"');
  });

  it('Add takes one number or a range; Retire picks an active number and confirms', async () => {
    const html = await section();
    expect(outsideDialogs(html)).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Add tables<\/button>/);
    expect(outsideDialogs(html)).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Retire a table<\/button>/);
    expect(html).toContain('name="numbers"');
    expect(html).toContain('placeholder="1-20"');
    for (const n of [1, 2, 3, 10]) expect(html).toContain(`value="t-${n}"`);
  });

  it('the retired-block toggle is a 44px tap target on touch', async () => {
    expect(await section()).toMatch(/<summary[^>]*class="[^"]*min-h-11/);
  });

  it('a person without manage_store_settings sees the numbers only: no Add, no Retire', async () => {
    H.tables = { ...H.tables, canManage: false };
    const html = await section();
    expect(chipNumbers(html)).toEqual([1, 2, 3, 10, 8]);
    expect(html).not.toContain('Add tables');
    expect(html).not.toContain('Retire a table');
    expect(html).not.toContain('name="standId"');
  });

  it('says so plainly when the store has no tables yet', async () => {
    H.tables = { active: [], retired: [], canManage: true };
    const html = await section();
    expect(html).toContain('No tables at SharEat Lipa yet. Add a range like 1-20.');
    expect(html).not.toContain('Retire a table');
  });
});

describe('T-633 the Add result in words', () => {
  it('counts what was added, what already existed and what stays retired', async () => {
    const { addTablesSentence } = await import('../src/app/admin/pos-tablets/lib');
    expect(addTablesSentence({ added: 18, existed: 2, retired: 0 })).toBe('Added 18 tables; 2 already existed. The tablet shows them after its next refresh.');
    expect(addTablesSentence({ added: 1, existed: 0, retired: 0 })).toBe('Added 1 table. The tablet shows them after its next refresh.');
    expect(addTablesSentence({ added: 0, existed: 3, retired: 1 })).toBe('No tables added; 3 already existed; 1 table is retired and stays retired (a retired number is never reused).');
  });
});
