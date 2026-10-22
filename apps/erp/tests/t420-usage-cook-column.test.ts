/**
 * T-420 case 13 - the usage check table gains a "Used in cooking" column. docs/tasks/420-usage-check-counts-cook.md.
 *
 * TESTER. Red on HEAD: the band table has no such column. Harness = t419-usage-cook-section.test.ts (session / shell leaves mocked,
 * `./lib` mocked at its import specifier, the real page rendered to static markup and read as text).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTOR = { orgId: 'org-1', personId: 'actor-1' };
const DATE = '2026-08-10';

vi.mock('../src/lib/session', () => ({
  requireSession: vi.fn(async () => ({ actor: ACTOR })),
}));
vi.mock('next/navigation', () => ({
  // T-448: the page's "+ New record" FormModal reads the address to close itself after a save.
  usePathname: () => '/inventory/usage',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('notFound() called unexpectedly');
  },
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components/FilterRow', () => ({
  FilterRow: ({ children }: { children: unknown }) => children,
}));

vi.mock('../src/app/expenses/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/expenses/lib')>();
  return {
    ...actual,
    listStores: vi.fn(async () => [{ id: 'store-1', name: 'SmokeStore', code: 'SMK-1' }]),
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  };
});

const usageScreenDataMock = vi.fn();
const usageQueueDataMock = vi.fn();

vi.mock('../src/app/inventory/usage/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/inventory/usage/lib')>();
  return {
    ...actual,
    usageScreenData: (...a: unknown[]) => usageScreenDataMock(...a),
    usageQueueData: (...a: unknown[]) => usageQueueDataMock(...a),
  };
});
vi.mock('../src/app/inventory/usage/actions', () => ({
  saveUsageDraftAction: vi.fn(),
  deleteUsageDraftAction: vi.fn(),
  postUsageAction: vi.fn(),
  voidUsageAction: vi.fn(),
}));
vi.mock('../src/app/inventory/usage/NewUsageForm', () => ({ NewUsageForm: () => null }));

// Cold import of the real page is slow; warm it once, outside the 5 s per-test default.
beforeAll(async () => {
  await import('../src/app/inventory/usage/page');
}, 120_000);

const variance = (over: Record<string, unknown>) => ({
  itemId: 'item-pork', itemName: 'Pork', expected: '0.7', actual: '0.2', cooked: '0.5', tolerance: '0.1000', withinBand: true, ...over,
});

beforeEach(() => {
  usageScreenDataMock.mockResolvedValue({ locations: [{ id: 'loc-1', code: 'MAIN', name: 'Main room' }], departments: [], items: [], records: [] });
  usageQueueDataMock.mockResolvedValue({
    date: DATE,
    variances: [variance({}), variance({ itemId: 'item-rice', itemName: 'Rice', expected: '10', actual: '10', cooked: '0' })],
    drafts: [],
    cooked: [],
  });
});

function text(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
async function render(): Promise<string> {
  const { default: UsagePage } = await import('../src/app/inventory/usage/page');
  return renderToStaticMarkup(await UsagePage({ searchParams: Promise.resolve({ date: DATE }) }));
}
const checkSection = (html: string): string => {
  const m = html.match(/<section[^>]*>\s*<h2[^>]*>(?:(?!<\/section>)[\s\S])*?Usage check for[\s\S]*?<\/section>/);
  return m ? m[0] : '';
};
const cellsOf = (row: string): string[] => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => text(m[1]!));

describe('T-420 case 13 - the band table shows cooking beside, not inside, Recorded', () => {
  it('the header has a "Used in cooking" column; the Pork row reads Recorded 0.2 and Used in cooking 0.5 under their own headers. Mutant: cooked merged into Recorded', async () => {
    const check = checkSection(await render());
    expect(check, 'no "Usage check for" section').not.toBe('');
    const rows = [...check.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => cellsOf(m[1]!));
    const header = rows.find((r) => r.includes('Recorded'));
    expect(header, 'a header row with Recorded').toBeDefined();
    const cookCol = header!.findIndex((h) => h.includes('Used in cooking'));
    const recordedCol = header!.indexOf('Recorded');
    expect(cookCol, 'a "Used in cooking" column header').toBeGreaterThan(-1);
    const pork = rows.find((r) => r[0] === 'Pork');
    expect(pork, 'a Pork row').toBeDefined();
    expect(pork![recordedCol]).toBe('0.2');
    expect(pork![cookCol]).toBe('0.5');
  });

  it('an item with nothing cooked has a blank cell in that column (not "0")', async () => {
    const check = checkSection(await render());
    const rows = [...check.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => cellsOf(m[1]!));
    const header = rows.find((r) => r.includes('Recorded'))!;
    const cookCol = header.findIndex((h) => h.includes('Used in cooking'));
    expect(cookCol).toBeGreaterThan(-1);
    const rice = rows.find((r) => r[0] === 'Rice');
    expect(rice, 'a Rice row').toBeDefined();
    expect(rice![cookCol]).toBe('');
  });
});
