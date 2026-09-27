/**
 * T-343 S6d — W2: `/wastage/[id]` shows the disposition label. `docs/tasks/343-def-417-human-
 * readable-refusals.md` §S6d, following up on the S6c post-commit review (`f9cdeac`).
 *
 * ⛔ TESTER, not BUILDER. `apps/erp/src/app/wastage/[id]/page.tsx:108` still reads
 * `` `Resolved as ${row.disposition}...` `` — the raw enum value, not
 * `orderWastageDispositionLabel(row.disposition)`. Red until the builder wraps it.
 *
 * Harness: same posture as `t343-s6c-screen-labels.test.ts` — `requireSession`, the four actions
 * this page imports, and `withOrgPrincipal` (from `../src/app/expenses/lib`) are mocked; each test
 * sets `withOrgPrincipalMock.mockResolvedValueOnce(data)` to return the page's own `data` shape
 * DIRECTLY, without invoking the real callback — so the callback's `tx.select(...)` chains
 * (real `@shareat/db`/`@shareat/domain`, left unmocked, lazy-safe) never execute. Visible text is
 * defined as in S6b/S6c (tags stripped, entities decoded).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORDER_WASTAGE_DISPOSITION_LABEL } from '../../../packages/db/schema/order-wastage';

const ACTOR = { orgId: 'org-1', personId: 'actor-1' };

vi.mock('../src/lib/session', () => ({
  requireSession: vi.fn(async () => ({ actor: ACTOR })),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound() called unexpectedly — every render fixture in this file resolves');
  },
}));

vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

vi.mock('../src/app/wastage/actions', () => ({
  confirmSettlementMatchAction: vi.fn(),
  disputeOrderWastageAction: vi.fn(),
  resolveOrderWastageAction: vi.fn(),
  reverseAutoChargeAction: vi.fn(),
}));

const withOrgPrincipalMock = vi.fn(async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}));
vi.mock('../src/app/expenses/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/expenses/lib')>();
  return {
    ...actual,
    withOrgPrincipal: (...args: [string, (tx: unknown) => unknown]) => withOrgPrincipalMock(...args),
  };
});

afterEach(() => {
  withOrgPrincipalMock.mockClear();
  withOrgPrincipalMock.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}));
});

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/\s+/g, ' ')
    .trim();
}

const BASE_ROW = {
  id: 'ow-1',
  orgId: 'org-1',
  storeId: 'store-1',
  salesDayId: 'sd-1',
  channelId: 'ch-1',
  channel: 'Foodpanda',
  orderRef: 'FP-100',
  typeMode: 'instant' as const,
  amount: '150.00',
  reason: 'Remade order',
  autoCharged: false,
  settlementId: null,
  journalEntryId: null,
  openedAt: new Date('2026-01-01T00:00:00Z'),
  resolvedAt: null as Date | null,
  resolvedBy: null as string | null,
  createdBy: 'actor-1',
};

async function renderDetail(row: Record<string, unknown>) {
  withOrgPrincipalMock.mockResolvedValueOnce({
    row,
    allocations: [],
    businessDate: '2026-01-01',
    people: [],
    settlements: [],
  });
  const { default: WastageDetailPage } = await import('../src/app/wastage/[id]/page');
  return renderToStaticMarkup(
    await WastageDetailPage({ params: Promise.resolve({ id: row.id as string }), searchParams: Promise.resolve({}) }),
  );
}

describe('W2 — a resolved platform_paid row shows "Resolved as Platform paid", not the raw enum value', () => {
  it(
    'renders the label',
    async () => {
      const html = await renderDetail({
        ...BASE_ROW,
        status: 'resolved',
        disposition: 'platform_paid',
        resolvedAt: new Date('2026-01-02T00:00:00Z'),
      });
      const visibleText = stripTags(html);
      expect(visibleText).toContain(`Resolved as ${ORDER_WASTAGE_DISPOSITION_LABEL.platform_paid}.`);
      expect(visibleText).not.toContain('Resolved as platform_paid');
      expect(visibleText).not.toContain('platform_paid');
    },
    30000,
  );
});

describe('W2n (⛔) — a non-resolved row is unchanged: its own sentence renders, never "Resolved as …", disposition value notwithstanding', () => {
  it(
    'an open row with no disposition shows "Open, awaiting a disposition." and pins the Decide <select> to the three real dispositions',
    async () => {
      const html = await renderDetail({
        ...BASE_ROW,
        status: 'open',
        disposition: null,
      });
      const visibleText = stripTags(html);
      expect(visibleText).toContain('Open, awaiting a disposition.');
      expect(visibleText).not.toContain('Resolved as');

      const selectBlock = /<select name="disposition"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
      expect(selectBlock, 'expected the Decide section\'s disposition <select>').toBeTruthy();
      const optionValues = [...selectBlock!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]!);
      expect(optionValues).toEqual(['platform_paid', 'absorbed', 'charged']);
    },
    30000,
  );

  it(
    'a disputed row shows its own sentence, never "Resolved as …"',
    async () => {
      const html = await renderDetail({
        ...BASE_ROW,
        status: 'disputed',
        disposition: null,
      });
      const visibleText = stripTags(html);
      expect(visibleText).toContain('Disputed — the 15-day clock is unaffected (it runs from opened_at, uniformly).');
      expect(visibleText).not.toContain('Resolved as');
    },
    30000,
  );
});
