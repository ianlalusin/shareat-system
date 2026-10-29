/**
 * T-421 cases 7-12, REDESIGNED (Ian, 16 Oct: bars dropped): a thick gross-sales line plus one thin smooth line per
 * channel in the donut colours (POS corrections dashed) drawn UNDER it. Harnesses: SalesLine alone, and the async page
 * with the data layer mocked (renderToStaticMarkup). SalesHover is client state shown only on pointer move: not testable here.
 * Reading the markup: gross = path class dash-line; previous = dash-fade; a channel line = any other path with
 * stroke-width 1.5, identified by stroke colour; markup order is paint order.
 */
import { createElement } from 'react';
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
const TX = { __tx: true };
const reportScopeMock = vi.fn();
vi.mock('../src/app/reports/lib', () => ({
  reportScope: (...args: unknown[]) => reportScopeMock(...args),
  runReport: async (_orgId: string, fn: (tx: unknown) => unknown) => fn(TX),
}));
vi.mock('../src/app/findings/lib', async () => ({
  lastCompletedPeriod: () => '2026-09',
  findingsFor: async () => ({ feed: { findings: [] }, readiness: {} }),
}));
// T-193: the dashboard also loads the Government payments tile; a non-holder gets null.
vi.mock('../src/app/payroll/statutory-payments/lib', () => ({ statutoryTileFor: async () => null }));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

// ---- the page's data layer ----------------------------------------------------------------------------------------
const state = {
  unreconciledDays: [] as string[],
};
const rollupCalls: Array<{ groupBy: string; fromDate: string; channelDays?: boolean }> = [];

/** Donut order: Dine-in Channel (c1, palette 0), GrabFood Channel (c2, palette 1). 10-05 sold only Grab. */
function rollup(input: { groupBy: string; fromDate: string; toDate: string; channelDays?: boolean }) {
  rollupCalls.push({ groupBy: input.groupBy, fromDate: input.fromDate, channelDays: input.channelDays });
  const isPrev = input.fromDate === '2026-09-28';
  const total = isPrev ? '100000.00' : '125000.00';
  const periods =
    input.groupBy === 'store'
      ? [{ period: null, storeId: STORE_A.id, total: '125000.00' }]
      : input.groupBy === 'day'
        ? [
            { period: '2026-10-05', storeId: null, total: isPrev ? '40000.00' : '50000.00' },
            { period: '2026-10-06', storeId: null, total: isPrev ? '60000.00' : '75000.00' },
          ]
        : [{ period: '2026-10', storeId: null, total }];
  const wantsBars = input.groupBy === 'day' && input.channelDays === true && !isPrev;
  return {
    periods,
    ledgerTotal: total,
    channels: [
      { channelId: 'c1', channelName: 'Dine-in Channel', isRemittedDaily: true, total: '45000.00' },
      { channelId: 'c2', channelName: 'GrabFood Channel', isRemittedDaily: false, total: '80000.00' },
    ],
    channelTotal: total,
    modes: [],
    modeTotal: total,
    reconciles: true,
    basis: {},
    channelDays: wantsBars
      ? [
          { day: '2026-10-05', total: '50000.00', channels: [{ channelId: 'c2', channelName: 'GrabFood Channel', total: '50000.00' }] },
          {
            day: '2026-10-06',
            total: '75000.00',
            channels: [
              { channelId: 'c1', channelName: 'Dine-in Channel', total: '45000.00' },
              { channelId: 'c2', channelName: 'GrabFood Channel', total: '30000.00' },
            ],
          },
        ]
      : [],
    unreconciledDays: wantsBars ? state.unreconciledDays : [],
  };
}

vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/domain')>();
  return {
    ...actual,
    getSalesRollup: async (_tx: unknown, input: { groupBy: string; fromDate: string; toDate: string; channelDays?: boolean }) => rollup(input),
    getIncomeStatement: async () => ({
      revenue: '125000.00', costOfSales: '30000.00', operatingExpenses: '20000.00', netIncome: '71234.56',
      operatingIncome: '75000.00', otherIncomeExpense: '0.00', grossProfit: '95000.00',
    }),
    getBalanceSheet: async () => ({ assets: '8420000.00', liabilities: '3100000.00', equity: '5320000.00', ties: true }),
    getArAgingReport: async () => ({ totals: { total: '11111.11' } }),
    getApAgingReport: async () => ({ totals: { total: '22222.22' } }),
    usageCheckScorecard: async () => [],
  };
});

vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...actual,
    cashRequestsRepo: { ...(actual as { cashRequestsRepo?: object }).cashRequestsRepo, openFloats: async () => [] },
    commissaryKpisRepo: {
      ...(actual as { commissaryKpisRepo?: object }).commissaryKpisRepo,
      inFlightOrders: async () => [],
      openDisputes: async () => ({ count: 0, oldestAgeDays: 0, totalValue: '0.00', deferredCount: 0, buckets: { fresh: 0, ageing: 0, overdue: 0 } }),
      receivedInRange: async () => ({ orderCount: 0, goodsDispatchedValue: '0.00', goodsReceivedValue: '0.00', shortReceivedValue: '0.00', unrecordedValue: '0.00' }),
    },
    employmentRepo: { ...(actual as { employmentRepo?: object }).employmentRepo, listActiveRoster: async () => [] },
    lowStockRepo: { ...(actual as { lowStockRepo?: object }).lowStockRepo, lowStock: async () => [] },
    attendanceDaysRepo: { ...(actual as { attendanceDaysRepo?: object }).attendanceDaysRepo, countOpenToday: async () => 0 },
  };
});

let DashboardPage: typeof import('../src/app/page').default;
let SalesLine: typeof import('../src/components/dashboard/SalesLine').SalesLine;

beforeAll(async () => {
  DashboardPage = (await import('../src/app/page')).default;
  SalesLine = (await import('../src/components/dashboard/SalesLine')).SalesLine;
}, 90_000);

beforeEach(() => {
  rollupCalls.length = 0;
  state.unreconciledDays = [];
  reportScopeMock.mockReset();
  reportScopeMock.mockImplementation(async () => ({
    actor: { orgId: 'org-1', personId: 'p-1' },
    orgName: 'Shareat', orgCode: 'SHA',
    stores: [STORE_A], storeId: undefined, coversWholeOrg: true,
  }));
});

async function renderPage(): Promise<{ html: string; text: string }> {
  const element = await DashboardPage({ searchParams: Promise.resolve({ from: '2026-10-05', to: '2026-10-11' }) });
  const html = renderToStaticMarkup(element as never);
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ') };
}

// ---- reading the chart's markup -----------------------------------------------------------------------------------
const pathTags = (html: string): string[] => [...html.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
const dOf = (tag: string): string => /\sd="([^"]*)"/.exec(tag)![1]!;
const grossTag = (html: string): string => pathTags(html).find((t) => /class="dash-line"/.test(t))!;
const prevTag = (html: string): string => pathTags(html).find((t) => /class="dash-fade"/.test(t))!;
const channelTags = (html: string): string[] => pathTags(html).filter((t) => !/class="dash-/.test(t) && /stroke-width="1.5"/.test(t));
const pathD = (html: string, cls: string): string => dOf(cls === 'dash-line' ? grossTag(html) : prevTag(html));
const moves = (d: string): number => (d.match(/M /g) ?? []).length;
const lis = (html: string): string[] => [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());
const nums = (d: string): number[] => d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);

const C = { walk: 'var(--brand-ink)', grab: 'var(--progress)', fp: 'var(--info)', corr: 'var(--closed)' };
const base = { chartLabel: 'Sales per day', curName: 'This range', prevName: 'Last range', peakText: '400', peakLabel: 'busiest' };
const days3 = [
  { label: 'Mon', day: 'Mon 12 Oct', text: '100.00', current: 100, previous: 80 },
  { label: 'Tue', day: 'Tue 13 Oct', text: '250.00', current: 250, previous: 120 },
  { label: 'Wed', day: 'Wed 14 Oct', text: '50.00', current: 50, previous: 60 },
];
const ln = (key: string, name: string, color: string, values: (number | null)[], dashed = false) => ({ key, name, color, values, dashed });
const lines3 = [
  ln('w', 'Walk-in', C.walk, [60, 100, 0]),
  ln('g', 'Grab', C.grab, [40, 150, 50]),
  ln('c', 'POS corrections', C.corr, [0, 0, 0], true),
];
const legend3 = lines3.map((l) => ({ key: l.key, name: l.name, color: l.color, dashed: l.dashed }));
const chart = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(SalesLine, { ...base, ...props } as never));
const withLines = () => chart({ points: days3, lines: lines3, legend: legend3 });

describe('T-421 case 7 - gross line plus one thin line per channel, the gross on top', () => {
  it('no bars, hatch, area fill, neon gradient or drop-shadow glow anywhere', () => {
    const html = withLines();
    expect(html).not.toMatch(/<rect\b[^>]*>\s*<title>/);
    expect(html).not.toMatch(/<pattern\b/);
    expect(html).not.toMatch(/sales-neon/);
    expect(html).not.toMatch(/drop-shadow/);
    expect(html, 'no filled area under the line').not.toMatch(/<path\b[^>]*fill-opacity/);
    expect(pathTags(html).every((t) => /fill="none"/.test(t)), 'every path is a stroke only').toBe(true);
  });

  it('the gross line: stroke var(--brand-ink), width 3.5, and its d is the unchanged smooth path through the line values', () => {
    const html = withLines();
    const g = grossTag(html);
    expect(g).toMatch(/stroke-width="3.5"/);
    expect(g).toContain('stroke:var(--brand-ink)');
    expect(dOf(g)).toBe(pathD(chart({ points: days3 }), 'dash-line'));
  });

  it('one thin (1.5) line per channel in the given colours and order, all painted BEFORE the gross line; corrections dashed', () => {
    const html = withLines();
    const ch = channelTags(html);
    expect(ch).toHaveLength(3);
    [C.walk, C.grab, C.corr].forEach((c, i) => expect(ch[i], `channel ${i} colour`).toContain(`stroke:${c}`));
    for (const t of ch) expect(html.indexOf(t), 'under the gross line').toBeLessThan(html.indexOf(grossTag(html)));
    expect(ch[0]).not.toMatch(/stroke-dasharray/);
    expect(ch[1]).not.toMatch(/stroke-dasharray/);
    expect(ch[2]).toMatch(/stroke-dasharray/);
  });

  it('same y scale: the Grab line\'s Tuesday point (150) sits 150/250 of the way up to the gross Tuesday point (250)', () => {
    const html = withLines();
    const grossY = nums(dOf(grossTag(html)))[1 + 6]!;
    const grabY = nums(dOf(channelTags(html)[1]!))[1 + 6]!;
    expect(Math.abs((350 - grabY) / (350 - grossY) - 150 / 250)).toBeLessThan(0.01);
  });

  it('the invariant at render level: Walk-in + Grab equal the gross value on every fixture day', () => {
    days3.forEach((p, i) => expect(lines3[0]!.values[i]! + lines3[1]!.values[i]!, p.day).toBe(p.current));
  });

  it('page: asks the rollup for channelDays on the current range only', async () => {
    await renderPage();
    const day = rollupCalls.filter((c) => c.groupBy === 'day');
    expect(day.find((c) => c.fromDate === '2026-10-05')?.channelDays, 'current range').toBe(true);
    expect(day.find((c) => c.fromDate === '2026-09-28')?.channelDays, 'previous range').toBeFalsy();
  });
});

describe('T-421 case 8 - a channel keeps the donut\'s colour and order on the page', () => {
  it('Dine-in is the first palette colour, GrabFood the second, in that paint order, and no other thin line exists', async () => {
    const { html } = await renderPage();
    const ch = channelTags(html);
    expect(ch).toHaveLength(2);
    expect(ch[0]).toContain('stroke:var(--brand-ink)');
    expect(ch[1]).toContain('stroke:var(--progress)');
    expect(html).toMatch(/<circle[^>]*stroke:var\(--progress\)/);
  });
});

describe('T-421 case 9 - legend, caption, previous line and aria-label', () => {
  it('SalesLine: one legend row = Gross sales, the previous-period name (dashed swatch), then the channels in order', () => {
    const html = withLines();
    expect(lis(html)).toEqual(['Gross sales', 'Last range', 'Walk-in', 'Grab', 'POS corrections']);
    const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
    expect(items[1]).toMatch(/dashed/);
    expect(items[2]).toContain(C.walk);
    expect(items[3]).toContain(C.grab);
    expect(items[4]).toMatch(/dashed/);
    expect(html, 'the old this/previous caption is gone when channel lines show').not.toMatch(/<figcaption/);
    expect(html).not.toContain('This range');
  });

  it('without lines the old caption stays', () => {
    const html = chart({ points: days3 });
    expect(html).toMatch(/<figcaption/);
    expect(html).toContain('This range');
  });

  it('the previous line is fainter (0.45) only when channel lines show', () => {
    expect(prevTag(withLines())).toMatch(/stroke-opacity="0\.45"/);
    expect(prevTag(chart({ points: days3 }))).not.toMatch(/stroke-opacity/);
  });

  it('page: the aria-label ends "lines by channel: Dine-in Channel, GrabFood Channel" (donut order)', async () => {
    const { html } = await renderPage();
    const label = /aria-label="([^"]*lines by channel[^"]*)"/.exec(html);
    expect(label).not.toBeNull();
    expect(label![1]).toMatch(/lines by channel: Dine-in Channel, GrabFood Channel$/);
  });
});

describe('T-421 case 10 - corrections are a dashed thin line, never a bar or hatch', () => {
  it('a negative value is drawn as a finite dashed line, with no pattern or block', () => {
    const lines = [ln('w', 'Walk-in', C.walk, [400, 300, 100]), ln('c', 'POS corrections', C.corr, [0, -50, 0], true)];
    const pts = [
      { label: 'Mon', day: 'Mon', text: '400', current: 400, previous: 100 },
      { label: 'Tue', day: 'Tue', text: '250', current: 250, previous: 100 },
      { label: 'Wed', day: 'Wed', text: '100', current: 100, previous: 100 },
    ];
    const html = chart({ points: pts, lines, legend: lines.map((l) => ({ key: l.key, name: l.name, color: l.color, dashed: l.dashed })) });
    const corr = channelTags(html)[1]!;
    expect(corr).toMatch(/stroke-dasharray/);
    expect(html).not.toMatch(/<pattern\b|<rect\b[^>]*>\s*<title>/);
    for (const v of nums(dOf(corr))) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('T-421 case 11 - an unreconciled day breaks the channel lines and says so', () => {
  const four = [...days3, { label: 'Thu', day: 'Thu', text: '1', current: 1, previous: 1 }];

  it('SalesLine: a null value leaves a gap (a second subpath), the note is shown, the gross line stays whole', () => {
    const solid = chart({ points: four, lines: [ln('g', 'Grab', C.grab, [40, 150, 50, 1])], legend: [] });
    const broken = chart({ points: four, lines: [ln('g', 'Grab', C.grab, [40, null, 50, 1])], legend: [], note: 'NOTE-TEXT' });
    expect(moves(dOf(channelTags(solid)[0]!)), 'control: whole line').toBe(1);
    expect(moves(dOf(channelTags(broken)[0]!)), 'broken at the null day').toBe(2);
    expect(broken).toContain('NOTE-TEXT');
    expect(solid).not.toContain('NOTE-TEXT');
    expect(dOf(grossTag(broken))).toBe(dOf(grossTag(solid)));
  });

  it('page: reconciled -> unbroken lines, no sentence', async () => {
    const { html, text } = await renderPage();
    for (const t of channelTags(html)) expect(moves(dOf(t))).toBe(1);
    expect(text).not.toMatch(/does not match the ledger/i);
  });

  it('page: 2026-10-06 unreconciled -> both channel lines break there and the exact sentence appears; the gross line is whole', async () => {
    const ok = await renderPage();
    state.unreconciledDays = ['2026-10-06'];
    const { html, text } = await renderPage();
    for (const t of channelTags(html)) expect(moves(dOf(t)), 'broken').toBeGreaterThan(1);
    expect(dOf(grossTag(html))).toBe(dOf(grossTag(ok.html)));
    expect(text).toMatch(/The channel split does not match the ledger on .+; those channel lines break there\./);
  });
});

describe('T-421 case 12 - no bars prop: the chart is exactly as before', () => {
  const pts = [
    { label: 'A', current: 10, previous: 5 },
    { label: 'B', current: 40, previous: 30 },
    { label: 'C', current: 25, previous: 35 },
    { label: 'D', current: 0, previous: 20 },
  ];

  it('the current and previous path d are the current output, and no bar, legend list or pattern appears', () => {
    const html = chart({ points: pts });
    expect(pathD(html, 'dash-line')).toBe('M 0.0 272.5 C 111.1 195.0 222.2 40.0 333.3 40.0 C 444.4 40.0 555.6 104.6 666.7 156.3 C 777.8 207.9 888.9 285.4 1000.0 350.0');
    expect(pathD(html, 'dash-fade')).toBe('M 0.0 311.3 C 111.1 246.7 222.2 156.3 333.3 117.5 C 444.4 78.8 555.6 78.8 666.7 78.8 C 777.8 78.8 888.9 156.3 1000.0 195.0');
    expect(html).not.toMatch(/<rect\b[^>]*>\s*<title>/);
    expect(html).not.toMatch(/<li\b/);
    expect(html).not.toMatch(/<pattern\b/);
  });
});
