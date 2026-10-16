/**
 * T-419 cases 9-11 - the "Used in cooking on <date>" section of /inventory/usage. docs/tasks/419-cook-usage-on-daily-usage.md.
 *
 * TESTER. Red on HEAD: the page ignores `cooked` and renders no such section. Harness = the usage leg of
 * t343-s6c-screen-labels.test.ts: session / shell leaves mocked, the page's `./lib` mocked at its import specifier, the real page
 * rendered to static markup and read as text.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTOR = { orgId: 'org-1', personId: 'actor-1' };
const DATE = '2026-08-10';

vi.mock('../src/lib/session', () => ({
  requireSession: vi.fn(async () => ({ actor: ACTOR })),
}));
vi.mock('next/navigation', () => ({
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

const cookLine = (over: Record<string, unknown>) => ({
  recordId: 'rec-posted',
  status: 'posted',
  recipeId: 'recipe-1',
  recipeName: 'Adobo base',
  itemId: 'item-pork',
  itemCode: 'PORK-001',
  itemName: 'Pork',
  quantity: '0.500',
  unit: 'kg',
  locationId: 'loc-1',
  isDraft: false,
  ...over,
});
const POSTED = cookLine({});
const DRAFT = cookLine({
  recordId: 'rec-draft',
  status: 'draft',
  recipeId: 'recipe-2',
  recipeName: 'Sinigang base',
  itemId: 'item-soy',
  itemName: 'Soy sauce',
  quantity: '0.100',
  unit: 'ltr',
  isDraft: true,
});

// Cold import of the real page is slow; warm it once, outside the 5 s per-test default.
beforeAll(async () => {
  await import('../src/app/inventory/usage/page');
}, 120_000);

beforeEach(() => {
  usageScreenDataMock.mockResolvedValue({ locations: [{ id: 'loc-1', code: 'MAIN', name: 'Main room' }], departments: [], items: [], records: [] });
  usageQueueDataMock.mockResolvedValue({
    date: DATE,
    variances: [{ itemId: 'item-pork', itemName: 'Pork', expected: '3', actual: '2', tolerance: '0.1000', withinBand: false }],
    drafts: [],
    cooked: [POSTED, DRAFT],
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
const sectionOf = (html: string, heading: RegExp): string => {
  const m = html.match(new RegExp(`<section[^>]*>\\s*<h2[^>]*>(?:(?!</section>)[\\s\\S])*?${heading.source}[\\s\\S]*?</section>`));
  return m ? m[0] : '';
};
const cookSection = (html: string) => sectionOf(html, /Used in cooking on/);

describe('T-419 case 9 - the section, its labels and links', () => {
  it('shows the heading with the date, "Recipe: <name>" linking to the cook record, and the drafts sentence', async () => {
    const html = await render();
    const section = cookSection(html);
    expect(section, 'no "Used in cooking on" section on the page').not.toBe('');
    const t = text(section);
    expect(t).toContain(`Used in cooking on ${DATE}`);
    expect(t).toContain('Recipe: Adobo base');
    expect(t).toContain('Recipe: Sinigang base');
    expect(t).toContain('Pork');
    expect(t).toContain('Soy sauce');
    expect(t).toContain('Drafts have not taken anything yet');
    expect(section).toMatch(/href="\/inventory\/production\/rec-posted"/);
    expect(section).toMatch(/href="\/inventory\/production\/rec-draft"/);
  });

  it('the section comes after "Usage check for <date>"', async () => {
    const html = await render();
    const check = html.indexOf('Usage check for');
    const cook = html.indexOf('Used in cooking on');
    expect(cook, 'no cooking section').toBeGreaterThan(-1);
    expect(cook).toBeGreaterThan(check);
  });

  it('with no cooked lines it shows the empty sentence', async () => {
    usageQueueDataMock.mockResolvedValue({ date: DATE, variances: [], drafts: [], cooked: [] });
    const t = text(cookSection(await render()));
    expect(t).toContain('No cooking from a recipe was recorded for this date.');
  });
});

describe('T-419 case 10 - the draft badge', () => {
  it('the draft row says "Draft — not posted yet"; the posted row says "Posted" and not the draft text', async () => {
    const section = cookSection(await render());
    const rows = [...section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]!));
    const posted = rows.find((r) => r.includes('Adobo base'));
    const draft = rows.find((r) => r.includes('Sinigang base'));
    expect(posted, 'no posted row').toBeTruthy();
    expect(draft, 'no draft row').toBeTruthy();
    expect(draft).toContain('Draft — not posted yet');
    expect(posted).toContain('Posted');
    expect(posted).not.toContain('Draft — not posted yet');
    expect(posted).not.toContain('Draft');
  });
});

describe('T-419 case 11 - display only, and not merged into the check', () => {
  it('the cooking section has no form, input or button', async () => {
    const section = cookSection(await render());
    expect(section, 'no cooking section').not.toBe('');
    expect(section).not.toMatch(/<form[\s>]/);
    expect(section).not.toMatch(/<input[\s>]/);
    expect(section).not.toMatch(/<button[\s>]/);
  });

  it('the band table "Recorded" column still shows only variances[].actual (2), never the cooked 0.5', async () => {
    const check = sectionOf(await render(), /Usage check for/);
    expect(check).not.toBe('');
    const cells = [...check.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]!));
    // columns: Item, Expected, Recorded, Check
    expect(cells.slice(0, 3)).toEqual(['Pork', '3', '2']);
    expect(text(check)).not.toContain('0.5');
  });
});
