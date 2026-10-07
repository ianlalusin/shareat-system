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
import { seedSearch } from './helpers/flash-jar';

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

describe('K1 (T-343 S5.5u item 3) — after a refusal, the write-off form keeps what was typed', () => {
  it(
    'wanted: Reason/Refunded/Refund-account render as defaultValues from the redirect — observed ' +
      "today (measured, not presumed): none of the three read searchParams at all — every box is " +
      'blank again after a refusal, exactly the shape the page already avoids for `mode`/`reason` ' +
      'on fixed-assets/[id]/page.tsx (grep precedent: `defaultValue={sp.reason ?? \'\'}`)',
    async () => {
      getDetailMock.mockResolvedValueOnce(activeItemDetail());
      // The page's `SearchParams` interface only names `error`/`ok` today — reason/refundAmount/
      // refundAccountCode are exactly the widening BUILDER's own fix adds (item 3). Routed through a
      // typed intermediate (not a fresh object literal in the call) so this compiles against
      // TODAY's narrower type without lying about it via a blanket `as any`.
      const postRefusalParams: Record<string, string> = {
        error: 'The refund amount — "1,000" is not a valid amount. Use at most two decimal places.',
        reason: 'Cancelled early',
        refundAmount: '1,000',
        refundAccountCode: '1110',
      };
      const element = await PrepaidItemPage({
        params: Promise.resolve({ id: 'item-1' }),
        searchParams: Promise.resolve(await seedSearch(postRefusalParams)),
      });
      const html = renderToStaticMarkup(element as never);

      const refundForm = formsIn(html).find((f) => f.includes('name="refundAmount"'));
      expect(refundForm, 'expected a form carrying the refundAmount box').toBeTruthy();

      const reasonTag = /<input\b[^>]*name="reason"[^>]*>/.exec(refundForm!)?.[0];
      const refundTag = /<input\b[^>]*name="refundAmount"[^>]*>/.exec(refundForm!)?.[0];
      const accountTag = /<input\b[^>]*name="refundAccountCode"[^>]*>/.exec(refundForm!)?.[0];
      expect(reasonTag, 'expected the reason <input> tag').toBeTruthy();
      expect(refundTag, 'expected the refundAmount <input> tag').toBeTruthy();
      expect(accountTag, 'expected the refundAccountCode <input> tag').toBeTruthy();

      expect(reasonTag, 'wanted: defaultValue="Cancelled early" — was red: no defaultValue at all').toMatch(
        /defaultValue="Cancelled early"|value="Cancelled early"/,
      );
      expect(refundTag, 'wanted: defaultValue="1,000" — was red: no defaultValue at all').toMatch(
        /defaultValue="1,000"|value="1,000"/,
      );
      expect(accountTag, 'wanted: defaultValue="1110" — was red: no defaultValue at all').toMatch(
        /defaultValue="1110"|value="1110"/,
      );
    },
    30000,
  );
});

describe('K2 (S5.5u Amendment A1 item 1) — a refused, back-dated write-off keeps its typed date too', () => {
  it(
    'writtenOffOn="2026-08-15" after a refusal: wanted defaultValue="2026-08-15" — observed today ' +
      '(measured, not presumed): the date box has no defaultValue from searchParams at all — it ' +
      "defaults to `new Date().toISOString().slice(0, 10)` (today), so a back-dated write-off " +
      're-submitted after a refusal would post in the wrong period with no cue',
    async () => {
      getDetailMock.mockResolvedValueOnce(activeItemDetail());
      const postRefusalParams: Record<string, string> = {
        error: 'The refund amount — "1,000" is not a valid amount. Use at most two decimal places.',
        reason: 'Cancelled early',
        refundAmount: '1,000',
        refundAccountCode: '1110',
        writtenOffOn: '2026-08-15',
      };
      const element = await PrepaidItemPage({
        params: Promise.resolve({ id: 'item-1' }),
        searchParams: Promise.resolve(await seedSearch(postRefusalParams)),
      });
      const html = renderToStaticMarkup(element as never);

      const refundForm = formsIn(html).find((f) => f.includes('name="refundAmount"'));
      expect(refundForm, 'expected a form carrying the refundAmount box').toBeTruthy();

      const dateTag = /<input\b[^>]*name="writtenOffOn"[^>]*>/.exec(refundForm!)?.[0];
      expect(dateTag, 'expected the writtenOffOn <input> tag').toBeTruthy();
      expect(dateTag, 'wanted: defaultValue="2026-08-15" — was red: defaultValue is today\'s date').toMatch(
        /defaultValue="2026-08-15"|value="2026-08-15"/,
      );
    },
    30000,
  );
});
