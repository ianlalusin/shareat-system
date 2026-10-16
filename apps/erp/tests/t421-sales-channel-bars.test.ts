/**
 * T-421 cases 7-12 - `docs/tasks/421-dashboard-channel-bars.md`. The dashboard sales chart draws one stacked bar per day,
 * split by sales channel, under the (unchanged) smooth line.
 *
 * TESTER, not BUILDER. Two harnesses, both `renderToStaticMarkup` (the t387-s5 precedent):
 *  - the chart alone: `SalesLine` with the new optional `bars` / `legend` props (cases 7, 9, 10, 12);
 *  - the async server page with the data layer mocked (cases 8, 11 and the wiring: `channelDays: true` on the current
 *    range only, the aria-label naming the channels).
 *
 * ## The contract these pin (the spec names the data, not the markup; where it is silent this is how it is read)
 *  - one block = one `<rect>` that CONTAINS a `<title>` ("Mon 12 Oct · Grab · ₱1,234"), so a block is found by its
 *    title and the day it belongs to is the title's first part (before " · ");
 *  - a block's colour is the segment's `color` string written on the `<rect>` itself (attribute or inline style);
 *  - stacked: the blocks of one day touch (each one's top is the next one's bottom), centred on the band
 *    `x = (i + 0.5) * 1000 / n`, 60% of the band wide, the stack bottom on the baseline;
 *  - a negative block is a hatched `<rect>` (its fill refers to a `<pattern>`: `url(#...)`), of non-negative height,
 *    standing on top of the net total (its lower edge is the line point's y for that day);
 *  - the legend is a `<ul>` of `<li>` (swatch + visible name), one per entry, in the order given;
 *  - the line is the `dash-line` path; its end points are read from `d`.
 *
 * ## Why red on HEAD
 * `SalesLine` ignores `bars` and `legend`; the page passes neither and does not ask the rollup for `channelDays`.
 * Case 12 (no `bars` -> the line exactly as today) is GREEN already: it is the guard against changing the line.
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
interface Block { title: string; day: string; attrs: string; x: number; y: number; w: number; h: number }
const attr = (attrs: string, name: string): number => {
  const m = new RegExp(`(?:^|\\s)${name}="(-?[\\d.]+)"`).exec(attrs);
  return m ? Number(m[1]) : NaN;
};
function blocksOf(html: string): Block[] {
  return [...html.matchAll(/<rect\b([^>]*)>\s*<title>([^<]*)<\/title>\s*<\/rect>/g)].map((m) => ({
    attrs: m[1]!,
    title: m[2]!,
    day: m[2]!.split(' · ')[0]!,
    x: attr(m[1]!, 'x'), y: attr(m[1]!, 'y'), w: attr(m[1]!, 'width'), h: attr(m[1]!, 'height'),
  }));
}
/** The line's points, read from the `dash-line` path: the M pair, then the last pair of every C segment. */
function linePoints(html: string): Array<[number, number]> {
  const tag = [...html.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]).find((t) => /class="dash-line"/.test(t))!;
  const d = /\sd="([^"]+)"/.exec(tag)![1]!;
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const pts: Array<[number, number]> = [[n[0]!, n[1]!]];
  for (let i = 2; i + 5 < n.length; i += 6) pts.push([n[i + 4]!, n[i + 5]!]);
  return pts;
}
const pathD = (html: string, cls: string): string => {
  const tag = [...html.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]).find((t) => new RegExp(`class="${cls}"`).test(t))!;
  return /\sd="([^"]+)"/.exec(tag)![1]!;
};
const baselineOf = (bs: Block[]): number => Math.max(...bs.map((b) => b.y + b.h));
const hatched = (b: Block): boolean => /url\(#/.test(b.attrs);

// ---- SalesLine fixtures --------------------------------------------------------------------------------------------
const C = { walk: 'var(--brand-ink)', grab: 'var(--progress)', fp: 'var(--info)', corr: 'var(--closed)' };
const seg = (name: string, value: number, color: string) => ({ key: name, name, value, color });
const base = { chartLabel: 'Sales per day', curName: 'This range', prevName: 'Last range', peakText: '400', peakLabel: 'busiest' };

// 3 days x 2 channels: 100 = 60+40, 250 = 100+150, 50 = Grab only.
const days3 = [
  { label: 'Mon', day: 'Mon 12 Oct', text: '100.00', current: 100, previous: 80 },
  { label: 'Tue', day: 'Tue 13 Oct', text: '250.00', current: 250, previous: 120 },
  { label: 'Wed', day: 'Wed 14 Oct', text: '50.00', current: 50, previous: 60 },
];
const bars3 = [
  { segments: [seg('Walk-in', 60, C.walk), seg('Grab', 40, C.grab)] },
  { segments: [seg('Walk-in', 100, C.walk), seg('Grab', 150, C.grab)] },
  { segments: [seg('Grab', 50, C.grab)] },
];
const legend2 = [
  { key: 'w', name: 'Walk-in', color: C.walk },
  { key: 'g', name: 'Grab', color: C.grab },
];
const chart = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(SalesLine, { ...base, ...props } as never));

// =====================================================================================================================
describe('T-421 case 7 - one stack per day, each stack as tall as the line is at that day', () => {
  it('3 days x 2 channels: 3 stacks of 5 blocks; stack height = BASE - line y; stacked (touching), centred on the band, 60% wide', () => {
    const html = chart({ points: days3, bars: bars3, legend: legend2 });
    const bs = blocksOf(html);
    expect(bs, 'one block per segment: 2 + 2 + 1').toHaveLength(5);
    const stacks = ['Mon 12 Oct', 'Tue 13 Oct', 'Wed 14 Oct'].map((d) => bs.filter((b) => b.day === d));
    expect(stacks.map((s) => s.length)).toEqual([2, 2, 1]);

    const line = linePoints(html);
    expect(line).toHaveLength(3);
    const base0 = baselineOf(bs);
    const band = 1000 / 3;
    stacks.forEach((stack, i) => {
      const sorted = [...stack].sort((a, b) => a.y - b.y);
      const height = stack.reduce((n, b) => n + b.h, 0);
      expect(Math.abs(height - (base0 - line[i]![1])), `day ${i}: stack height vs the line's height`).toBeLessThan(0.6);
      expect(Math.abs(sorted[0]!.y - line[i]![1]), `day ${i}: the stack top is the line point`).toBeLessThan(0.6);
      for (let k = 0; k + 1 < sorted.length; k++) {
        expect(Math.abs(sorted[k]!.y + sorted[k]!.h - sorted[k + 1]!.y), `day ${i}: blocks touch (stacked, not grouped)`).toBeLessThan(0.3);
      }
      for (const b of stack) {
        expect(Math.abs(b.x + b.w / 2 - (i + 0.5) * band), `day ${i}: centred on the band`).toBeLessThan(0.6);
        expect(Math.abs(b.w - 0.6 * band), `day ${i}: 60% of the band`).toBeLessThan(0.6);
        expect(Math.abs(b.x - stack[0]!.x), `day ${i}: one x for the whole stack`).toBeLessThan(0.1);
      }
    });
    expect(Math.abs(base0 - 350), 'stacks stand on the baseline').toBeLessThan(0.1);
  });

  it('the line moves to the band centres when bars are given (so the end bars are not cut in half)', () => {
    const line = linePoints(chart({ points: days3, bars: bars3, legend: legend2 }));
    const band = 1000 / 3;
    line.forEach(([x], i) => expect(Math.abs(x - (i + 0.5) * band), `point ${i}`).toBeLessThan(0.6));
  });

  it('the previous-range dashed line gets no bars: the blocks are only the current range\'s', () => {
    const html = chart({ points: days3, bars: bars3, legend: legend2 });
    expect(blocksOf(html).every((b) => /^(Mon|Tue|Wed) /.test(b.title))).toBe(true);
    expect(blocksOf(html)).toHaveLength(5);
  });

  it('every block title reads day, channel, peso amount: "Tue 13 Oct · Grab · ₱150"', () => {
    const titles = blocksOf(chart({ points: days3, bars: bars3, legend: legend2 })).map((b) => b.title);
    expect(titles.some((t) => /^Tue 13 Oct · Grab · ₱150(\.00)?$/.test(t)), titles.join(' | ')).toBe(true);
  });

  it('page wiring: the current range is asked for channelDays, the previous range is not', async () => {
    await renderPage();
    const day = rollupCalls.filter((c) => c.groupBy === 'day');
    expect(day.find((c) => c.fromDate === '2026-10-05')?.channelDays, 'current range').toBe(true);
    expect(day.find((c) => c.fromDate === '2026-09-28')?.channelDays, 'previous range').toBeFalsy();
    expect(rollupCalls.filter((c) => c.groupBy !== 'day').every((c) => !c.channelDays)).toBe(true);
  });
});

describe('T-421 case 8 - a channel keeps the donut\'s colour on every day', () => {
  it('the day where only Grab sold draws Grab in the donut\'s Grab colour (var(--progress)), not the first palette colour', async () => {
    const { html } = await renderPage();
    const bs = blocksOf(html);
    const grab = bs.filter((b) => b.title.includes('GrabFood Channel'));
    const dine = bs.filter((b) => b.title.includes('Dine-in Channel'));
    expect(grab.length, 'a Grab block on both days').toBe(2);
    expect(dine.length, 'one Dine-in block').toBe(1);
    for (const b of grab) {
      expect(b.attrs, b.title).toContain('var(--progress)');
      expect(b.attrs, `${b.title} must not take the first palette colour`).not.toContain('var(--brand-ink)');
    }
    expect(dine[0]!.attrs).toContain('var(--brand-ink)');
    // The donut paints the same two channels with the same two colours.
    expect(html).toMatch(/<circle[^>]*stroke:var\(--progress\)/);
  });
});

describe('T-421 case 9 - the legend names every channel once, in donut order; the aria-label names them', () => {
  it('SalesLine: a <ul> of <li>, one per entry in the given order, each with its swatch colour and a visible name', () => {
    const legend3 = [...legend2, { key: 'f', name: 'Foodpanda', color: C.fp }];
    const html = chart({ points: days3, bars: bars3, legend: legend3 });
    const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
    expect(items, 'three legend entries').toHaveLength(3);
    expect(items.map((li) => li.replace(/<[^>]+>/g, '').trim())).toEqual(['Walk-in', 'Grab', 'Foodpanda']);
    expect(items[0]).toContain(C.walk);
    expect(items[1]).toContain(C.grab);
    expect(items[2]).toContain(C.fp);
    expect(html).toMatch(/<ul\b/);
  });

  it('page: the chart\'s aria-label ends "bars split by channel: Dine-in Channel, GrabFood Channel" (donut order)', async () => {
    const { html } = await renderPage();
    const label = /aria-label="([^"]*bars split by channel[^"]*)"/.exec(html);
    expect(label, 'aria-label mentions the split').not.toBeNull();
    expect(label![1]).toMatch(/bars split by channel: Dine-in Channel, GrabFood Channel$/);
  });
});

describe('T-421 case 10 - a negative "POS corrections" block never draws a negative bar', () => {
  const pts = [
    { label: 'Mon', day: 'Mon 12 Oct', text: '400.00', current: 400, previous: 100 },
    { label: 'Tue', day: 'Tue 13 Oct', text: '250.00', current: 250, previous: 100 },
    { label: 'Wed', day: 'Wed 14 Oct', text: '100.00', current: 100, previous: 100 },
  ];
  const bars = [
    { segments: [seg('Walk-in', 400, C.walk)] },
    { segments: [seg('Foodpanda', 300, C.fp), seg('POS corrections', -50, C.corr)] }, // net 250
    { segments: [seg('Walk-in', 100, C.walk)] },
  ];

  it('the correction is a hatched rect of positive height standing on the net total; no block has a negative or NaN height', () => {
    const html = chart({ points: pts, bars, legend: legend2 });
    const bs = blocksOf(html);
    for (const b of bs) {
      expect(Number.isFinite(b.h) && b.h >= 0, `${b.title}: height ${b.h}`).toBe(true);
      expect(Number.isFinite(b.y), `${b.title}: y`).toBe(true);
    }
    const corr = bs.find((b) => b.title.includes('POS corrections'))!;
    expect(corr, 'the correction block exists').toBeDefined();
    expect(hatched(corr), 'filled by a pattern').toBe(true);
    expect(html, 'the pattern is defined').toMatch(/<pattern\b/);
    expect(bs.filter((b) => !b.title.includes('POS corrections')).every((b) => !hatched(b)), 'only the correction is hatched').toBe(true);

    const line = linePoints(html);
    const base0 = baselineOf(bs);
    const perUnit = (base0 - line[1]![1]) / 250; // the line's height per peso, from the net total
    expect(Math.abs(corr.h - 50 * perUnit), 'hatched height = the 50.00 correction').toBeLessThan(0.8);
    expect(Math.abs(corr.y + corr.h - line[1]![1]), 'its lower edge is the net total (the line point)').toBeLessThan(0.8);
    expect(corr.y + corr.h, 'it never reaches below the net total').toBeLessThanOrEqual(line[1]![1] + 0.8);
  });
});

describe('T-421 case 11 - a day whose split does not match the ledger shows no bar and says so', () => {
  it('control: all reconciled -> both days draw their blocks and the sentence is absent', async () => {
    const { text, html } = await renderPage();
    expect(blocksOf(html)).toHaveLength(3);
    expect(text).not.toMatch(/does not match the ledger/i);
  });

  it('2026-10-06 unreconciled -> its two blocks are not drawn (only 10-05\'s Grab remains) and the one-line note appears', async () => {
    state.unreconciledDays = ['2026-10-06'];
    const { text, html } = await renderPage();
    const bs = blocksOf(html);
    expect(bs, 'only the reconciled day has blocks').toHaveLength(1);
    expect(bs[0]!.title).toContain('GrabFood Channel');
    expect(bs.some((b) => b.title.includes('Dine-in Channel')), 'the hidden day\'s Dine-in block is gone').toBe(false);
    expect(text).toMatch(/The channel split does not match the ledger on .+; those bars are hidden\./);
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
    expect(blocksOf(html)).toHaveLength(0);
    expect(html).not.toMatch(/<li\b/);
    expect(html).not.toMatch(/<pattern\b/);
  });
});
