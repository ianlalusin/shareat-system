/**
 * T-343 S5.5r — DEF-460, the browser half. `docs/tasks/343-def-417-human-readable-refusals.md`
 * §S5.5r item 1, TESTER path B1.
 *
 * ⛔ TESTER, not BUILDER. `apps/erp/src/app/prepaid/[id]/page.tsx`'s refund `<input>`
 * (`name="refundAmount"`) still carries `type="number" step="0.01" min="0"` — a `type="number"` box
 * silently drops the comma out of a typed `1,000` (submits `1000`, S5.5p's server-side refusal
 * never runs). §S5.5s's own measured premise applies here too.
 *
 * Harness: `renderToStaticMarkup`, per `t343-s6b-admin-users-labels.test.ts`'s own header.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called unexpectedly — the render fixture resolves a detail');
  },
}));

const ACTOR = { orgId: 'org-1', personId: 'actor-admin-1' };
const requirePageAccessMock = vi.fn();
requirePageAccessMock.mockResolvedValue({ actor: ACTOR, refusal: null });
vi.mock('../src/lib/page-access', () => ({
  requirePageAccess: (...args: unknown[]) => requirePageAccessMock(...args),
}));

// ⛔ NOT a stub — forwards to the real module (the bare `@/...` specifier the root
// `vitest.config.mts` never resolves; s5-5p/s5-5q precedent).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components/shell/DetailLayout', () => ({
  DetailLayout: ({ summary, children }: { summary: unknown; children: unknown }) => [summary, children],
}));

const getDetailMock = vi.fn();
vi.mock('../src/app/prepaid/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/prepaid/lib')>();
  return {
    ...actual,
    getDetail: (...args: unknown[]) => getDetailMock(...args),
  };
});

function activeItemDetail() {
  return {
    id: 'item-1',
    orgId: 'org-1',
    storeId: 'store-1',
    name: 'Fire insurance 2026',
    category: 'insurance' as const,
    coverageStartDate: '2026-01-01',
    coverageMonths: 12,
    totalCost: '24000.00',
    status: 'active' as const,
    needsReview: false,
    sourceExpenseId: null,
    writtenOffOn: null,
    writeOffReason: null,
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    amortised: '0.00',
    remaining: '24000.00',
    monthsPosted: 0,
    schedule: [],
  };
}

function formsIn(html: string): string[] {
  return html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
}

let PrepaidItemPage: typeof import('../src/app/prepaid/[id]/page').default;

beforeAll(async () => {
  PrepaidItemPage = (await import('../src/app/prepaid/[id]/page')).default;
}, 30_000);

describe('B1 — the refund box is a text input, not a native number spinner', () => {
  it(
    'wanted: no type="number", no min=, inputMode="decimal" kept — was red before this fix: type="number" step="0.01" min="0"',
    async () => {
      getDetailMock.mockResolvedValueOnce(activeItemDetail());
      const element = await PrepaidItemPage({
        params: Promise.resolve({ id: 'item-1' }),
        searchParams: Promise.resolve({}),
      });
      const html = renderToStaticMarkup(element as never);

      const refundForm = formsIn(html).find((f) => f.includes('name="refundAmount"'));
      expect(refundForm, 'expected a form carrying the refundAmount box').toBeTruthy();

      const inputTag = /<input\b[^>]*name="refundAmount"[^>]*>/.exec(refundForm!)?.[0];
      expect(inputTag, 'expected the refundAmount <input> tag').toBeTruthy();
      expect(inputTag).not.toMatch(/type="number"/);
      expect(inputTag).not.toMatch(/\bmin="/);
      expect(inputTag).not.toMatch(/\bstep="/);
      expect(inputTag).not.toMatch(/\bmax="/);
      expect(inputTag).toMatch(/inputMode="decimal"/);
    },
    30000,
  );
});
