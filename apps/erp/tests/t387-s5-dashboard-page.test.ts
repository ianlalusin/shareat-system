/**
 * T-387 S5 - the editorial dashboard, SSR leg. `docs/tasks/387-warm-theme-and-grill-night-dark.md` S5 + L6.
 *
 * Harness: `renderToStaticMarkup` over the async server page with the data layer mocked
 * (`t343-s5-5r-prepaid-refund-render.test.ts` precedent). The page is `apps/erp/src/app/page.tsx`.
 *
 * PINNED page contract (text markers, case-insensitive, read from tag-stripped SSR output):
 *   - hero: the range's total sales `125,000.00`; delta vs previous equal-length range (`previousRange`)
 *     `25,000.00` and `25%`; previous total `100,000.00` is NOT required as text
 *   - expenses `50,000.00` (cost of sales + operating), net income `71,234.56`, AR `11,111.11`, AP `22,222.22`
 *   - by channel: channel names + totals; by store: the heading "By store" ONLY when more than one store is in scope
 *   - waiting on you: hard open findings 13, low stock 17, open disputes 14, open floats 12
 *   - right now: on shift 21 (a count from `attendanceDaysRepo.countOpenToday(tx, orgId, storeIds)`), on the road 9
 *     (`inFlightOrders` stage 'dispatched'), books "ties"
 *   - presets: links containing `range=today`, `range=7d`, `range=30d`, `range=mtd`
 *   - "On shift" is a number, never a name: no roster name appears anywhere
 * Every number is in the SSR text even though the hero is a count-up (CountUp renders its final value in SSR).
 *
 * RED today: the current page renders Tiles, has no presets, no "By store", no on-shift/on-the-road band.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called unexpectedly');
  },
}));

const STORE_A = { id: 'store-a', name: 'Alpha Branch', code: 'ALP' };
const STORE_B = { id: 'store-b', name: 'Beta Branch', code: 'BET' };

const scopeState = { stores: [STORE_A] as Array<typeof STORE_A>, storeId: undefined as string | undefined };
const reportScopeMock = vi.fn();
vi.mock('../src/app/reports/lib', () => ({
  reportScope: (...args: unknown[]) => reportScopeMock(...args),
  runReport: async (_orgId: string, fn: (tx: unknown) => unknown) => fn(TX),
}));
const TX = { __tx: true };

vi.mock('../src/app/findings/lib', async () => ({
  lastCompletedPeriod: () => '2026-09',
  findingsFor: async () => ({
    feed: {
      findings: [
        ...Array.from({ length: 13 }, () => ({ severity: 'hard', status: 'open' })),
        ...Array.from({ length: 5 }, () => ({ severity: 'soft', status: 'open' })),
        ...Array.from({ length: 4 }, () => ({ severity: 'hard', status: 'resolved' })),
      ],
    },
    readiness: {},
  }),
}));

vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

const countOpenTodayMock = vi.fn();
const salesCalls: Array<{ groupBy: string; fromDate: string; toDate: string }> = [];

const rollupState = { prevTotal: '100000.00' };
const m = (v: string) => v; // Money is a branded decimal string; the page formats it

function rollup(input: { groupBy: string; fromDate: string; toDate: string }) {
  salesCalls.push({ groupBy: input.groupBy, fromDate: input.fromDate, toDate: input.toDate });
  const isPrev = input.fromDate === '2026-09-28'; // previousRange('2026-10-05','2026-10-11')
  const total = isPrev ? rollupState.prevTotal : '125000.00';
  const periods =
    input.groupBy === 'store'
      ? [
          { period: null, storeId: STORE_A.id, total: m('75000.00') },
          { period: null, storeId: STORE_B.id, total: m('50000.00') },
        ]
      : input.groupBy === 'day'
        ? [
            { period: '2026-10-05', storeId: null, total: m(isPrev ? (rollupState.prevTotal === '0.00' ? '0.00' : '40000.00') : '50000.00') },
            { period: '2026-10-06', storeId: null, total: m(isPrev ? (rollupState.prevTotal === '0.00' ? '0.00' : '60000.00') : '75000.00') },
          ]
        : [{ period: '2026-10', storeId: null, total: m(total) }];
  return {
    periods,
    ledgerTotal: m(total),
    channels: [
      { channelId: 'c1', channelName: 'Dine-in Channel', isRemittedDaily: true, total: m('90000.00') },
      { channelId: 'c2', channelName: 'GrabFood Channel', isRemittedDaily: false, total: m('35000.00') },
    ],
    channelTotal: m(total),
    modes: [],
    modeTotal: m(total),
    reconciles: true,
    basis: {},
  };
}

vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/domain')>();
  return {
    ...actual,
    getSalesRollup: async (_tx: unknown, input: { groupBy: string; fromDate: string; toDate: string }) => rollup(input),
    getIncomeStatement: async () => ({
      revenue: '125000.00',
      costOfSales: '30000.00',
      operatingExpenses: '20000.00',
      netIncome: '71234.56',
      operatingIncome: '75000.00',
      otherIncomeExpense: '0.00',
      grossProfit: '95000.00',
    }),
    getBalanceSheet: async () => ({ assets: '8420000.00', liabilities: '3100000.00', equity: '5320000.00', ties: true }),
    getArAgingReport: async () => ({ totals: { total: '11111.11' } }),
    getApAgingReport: async () => ({ totals: { total: '22222.22' } }),
    // T-401 S6 (release 2026-10-16): the dashboard also asks for the usage check scorecard; an empty one renders no rows.
    usageCheckScorecard: async () => [],
  };
});

vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...actual,
    cashRequestsRepo: {
      ...(actual as { cashRequestsRepo?: object }).cashRequestsRepo,
      openFloats: async () =>
        Array.from({ length: 12 }, () => ({ storeId: STORE_A.id })),
    },
    commissaryKpisRepo: {
      ...(actual as { commissaryKpisRepo?: object }).commissaryKpisRepo,
      inFlightOrders: async () => [
        { stage: 'submitted', orderCount: 2, totalValue: '1.00' },
        { stage: 'dispatched', orderCount: 9, totalValue: '9.00' },
      ],
      openDisputes: async () => ({
        count: 14, oldestAgeDays: 3, totalValue: '100.00', deferredCount: 0,
        buckets: { fresh: 14, ageing: 0, overdue: 0 },
      }),
      receivedInRange: async () => ({
        orderCount: 1, goodsDispatchedValue: '1.00', goodsReceivedValue: '1.00',
        shortReceivedValue: '0.00', unrecordedValue: '0.00',
      }),
    },
    employmentRepo: {
      ...(actual as { employmentRepo?: object }).employmentRepo,
      listActiveRoster: async () => [{ displayName: 'Maria Santos' }, { displayName: 'Juan Dela Cruz' }],
    },
    lowStockRepo: {
      ...(actual as { lowStockRepo?: object }).lowStockRepo,
      lowStock: async () => Array.from({ length: 17 }, (_, i) => ({ itemId: `i${i}` })),
    },
    attendanceDaysRepo: {
      ...(actual as { attendanceDaysRepo?: object }).attendanceDaysRepo,
      countOpenToday: (...args: unknown[]) => countOpenTodayMock(...args),
    },
  };
});

let DashboardPage: typeof import('../src/app/page').default;

beforeAll(async () => {
  DashboardPage = (await import('../src/app/page')).default;
}, 90_000); // cold import of the real domain + db graph: ~21s alone, longer under a full run

beforeEach(() => {
  salesCalls.length = 0;
  rollupState.prevTotal = '100000.00';
  countOpenTodayMock.mockReset();
  countOpenTodayMock.mockResolvedValue(21);
  scopeState.stores = [STORE_A];
  scopeState.storeId = undefined;
  reportScopeMock.mockReset();
  reportScopeMock.mockImplementation(async () => ({
    actor: { orgId: 'org-1', personId: 'p-1' },
    orgName: 'Shareat',
    orgCode: 'SHA',
    stores: scopeState.stores,
    storeId: scopeState.storeId,
    coversWholeOrg: true,
  }));
});

async function render(sp: Record<string, string> = {}): Promise<{ html: string; text: string }> {
  const element = await DashboardPage({
    searchParams: Promise.resolve({ from: '2026-10-05', to: '2026-10-11', ...sp }),
  });
  const html = renderToStaticMarkup(element as never);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  return { html, text };
}

describe('T-387 S5 - every block shows its value as text in the SSR output', () => {
  it('hero total, delta against the previous equal-length range, and the previous range was actually queried', async () => {
    const { text } = await render();
    expect(text).toContain('125,000.00');
    expect(text).toContain('25,000.00'); // delta, absolute
    expect(text).toMatch(/25(\.0+)?\s?%/); // delta, percent
    const day = salesCalls.filter((c) => c.groupBy === 'day');
    expect(day.map((c) => `${c.fromDate}..${c.toDate}`).sort()).toEqual(
      ['2026-09-28..2026-10-04', '2026-10-05..2026-10-11'].sort(),
    );
  });

  it('expenses, net income, AR and AP', async () => {
    const { text } = await render();
    expect(text).toContain('50,000.00');
    expect(text).toContain('71,234.56');
    expect(text).toContain('11,111.11');
    expect(text).toContain('22,222.22');
  });

  it('by channel: names and totals', async () => {
    const { text } = await render();
    expect(text).toMatch(/by channel/i);
    expect(text).toContain('Dine-in Channel');
    expect(text).toContain('GrabFood Channel');
    expect(text).toContain('90,000.00');
    expect(text).toContain('35,000.00');
  });

  it('waiting on you: hard open findings 13, low stock 17, open disputes 14, open floats 12', async () => {
    const { text } = await render();
    expect(text).toMatch(/waiting on you/i);
    for (const n of ['13', '17', '14', '12']) {
      expect(text, `count ${n} missing`).toMatch(new RegExp(`(^|\\s)${n}(\\s|$)`));
    }
  });

  it('right now: on shift 21 (from countOpenToday), on the road 9 (dispatched only), books tie', async () => {
    const { text } = await render();
    expect(text).toMatch(/on shift/i);
    expect(text).toMatch(/(^|\s)21(\s|$)/);
    expect(text).toMatch(/on the road/i);
    expect(text).toMatch(/(^|\s)9(\s|$)/);
    expect(text).toMatch(/\bties\b|balanced/i);
    expect(countOpenTodayMock).toHaveBeenCalledTimes(1);
    const [tx, orgId, storeIds] = countOpenTodayMock.mock.calls[0]!;
    expect(tx).toBe(TX);
    expect(orgId).toBe('org-1');
    expect([...(storeIds as string[])]).toEqual([STORE_A.id]);
  });

  it('on shift is a number, never a name', async () => {
    const { text } = await render();
    expect(text).not.toContain('Maria Santos');
    expect(text).not.toContain('Juan Dela Cruz');
  });
});

describe('T-387 S5 - "By store" only when more than one store is in scope', () => {
  it('one store in scope: no By store block, and groupBy "store" is not needed', async () => {
    const { text } = await render();
    expect(text).not.toMatch(/by store/i);
    expect(text).not.toContain('Beta Branch');
  });

  it('two stores in scope: By store block with both names and their totals', async () => {
    scopeState.stores = [STORE_A, STORE_B];
    const { text } = await render();
    expect(text).toMatch(/by store/i);
    expect(text).toContain('Alpha Branch');
    expect(text).toContain('Beta Branch');
    expect(text).toContain('75,000.00');
    expect(text).toContain('50,000.00');
    expect(countOpenTodayMock.mock.calls[0]![2]).toEqual([STORE_A.id, STORE_B.id]);
  });

  it('two stores but the report narrowed to one (?store=): no By store block', async () => {
    scopeState.stores = [STORE_A, STORE_B];
    scopeState.storeId = STORE_A.id;
    const { text } = await render({ store: STORE_A.id });
    expect(text).not.toMatch(/by store/i);
    expect([...(countOpenTodayMock.mock.calls[0]![2] as string[])]).toEqual([STORE_A.id]);
  });
});

describe('T-387 S5 - presets', () => {
  it('Today, 7 days, 30 days and Month-to-date are ?range= links', async () => {
    const { html } = await render();
    for (const r of ['today', '7d', '30d', 'mtd']) {
      expect(html, `preset link range=${r}`).toMatch(new RegExp(`href="[^"]*range=${r}(&|")`));
    }
  });

  it('the custom from/to form is still there', async () => {
    const { html } = await render();
    expect(html).toMatch(/name="from"/);
    expect(html).toMatch(/name="to"/);
  });

  it('the page still gates on view_financial_reports', async () => {
    await render();
    expect(reportScopeMock).toHaveBeenCalledWith('/', 'view_financial_reports', undefined);
  });
});

describe('T-387 S5 - degenerate previous totals', () => {
  it('previous total 0: no percent chip, no Infinity or NaN anywhere', async () => {
    rollupState.prevTotal = '0.00';
    const { text } = await render();
    expect(text).toContain('125,000.00');
    expect(text).not.toMatch(/Infinity|NaN/);
    expect(text).not.toMatch(/[▲▼]\s?\d/); // the chip is the arrow plus the percent
  });

  it('equal totals say "same as last period", never "0.00 more than"', async () => {
    rollupState.prevTotal = '125000.00';
    const { text } = await render();
    expect(text).toMatch(/same as last period/i);
    expect(text).not.toMatch(/0\.00 (more|less) than/);
    expect(text).not.toMatch(/Infinity|NaN/);
  });

  it('a real change still reads "more than" with its absolute amount', async () => {
    const { text } = await render();
    expect(text).toMatch(/25,000\.00 more than/);
  });
});
