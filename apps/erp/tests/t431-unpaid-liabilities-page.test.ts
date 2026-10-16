import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-431 case 22 (+ the links of cases 14, 18, 19) - `/liabilities/unpaid`. Data layer mocked, markup asserted.
 * docs/tasks/431-unpaid-liabilities-view.md §4-§5, §7 case 22.
 *
 * PINNED SEAMS (the BUILDER must use these; the money rules live in the domain test, not here):
 *  - the page calls `reportScope('/liabilities/unpaid', 'view_financial_reports', searchParams.store)` from `app/reports/lib`
 *    and `getUnpaidLiabilities(tx, actor, { storeId: scope.storeId })` from '@shareat/domain' (result shape: see
 *    packages/domain/tests/integration/t431-unpaid-liabilities.test.ts header). Store names come from `scope.stores`.
 *  - kind 6 (`other_ledger`) `subtotal` leaves out `internal` lines (2150), the same as `totals.booked` does.
 *
 * PINNED HOOKS:
 *  - one `<section data-kind="<kindId>">` per kind, in the order given by the result, each with an `<h2>` holding the kind title
 *  - a kind with no lines (and visible) says "Nothing unpaid"
 *  - inside a section: `<div data-layout="cards" ...class contains sm:hidden>` and `<div data-layout="table" ...class contains hidden and sm:block>`
 *  - cards: one `<a data-unpaid-line href=... data-amount="<raw>">` per line (the WHOLE card is the link)
 *  - table: a `<table>` (the `Table` component) with one `<tr data-unpaid-line data-amount="<raw>">` per line; it holds a `RowLink`
 *    (`<a href=...>` whose class has `after:absolute`)
 *  - `data-subtotal="<kindId>" data-amount="<raw>"` per visible kind; `data-total="booked|not-yet-booked|grand" data-amount="<raw>"`
 *  - within a kind, lines whose `dueOn` is before today (Manila) come first, whatever order the result gave them (the page sorts)
 *  - a kind-5 viewer without run_payroll: the words "Visible to payroll staff only", no amount, no name, and the totals say "excludes wages"
 *  - 2150 lines carry the word "internal"; money text is `peso()`; account words come from `accountLabel(code)`, never the raw code
 *  - the `/liabilities` header links to `/liabilities/unpaid` with the words "Everything unpaid"
 */
import { accountLabel } from '../src/lib/account-label';
import { peso } from '../src/lib/format';
import { capabilityForRoute } from '../src/lib/route-capability';

const ORG = 'org-1';
const SA = 'store-a';
const SB = 'store-b';
const SC = 'store-c';
const ACTOR = { orgId: ORG, personId: 'viewer-1' };

type Line = {
  storeId: string; name: string; counterparty: string | null; dueOn: string | null; amount: string; href: string;
  accountCode?: string; tag?: string; internal?: boolean;
};
type Kind = {
  id: string; title: string; visible: boolean; unavailableReason?: string; needsReviewDays?: number; lines: Line[];
  unmatched: { accountCode: string; storeId: string; amount: string }[];
  withheld?: { accountCode: string; storeId: string }[]; subtotal: string | null;
};
type Result = {
  kinds: Kind[]; banners: { accountCode: string; storeId: string; amount: string }[];
  totals: { booked: string; notYetBooked: string; grand: string; excludesWages: boolean };
};

const H: { result: Result; scope: Record<string, unknown> } = { result: null as never, scope: {} };
const getUnpaidLiabilities = vi.fn(async () => H.result);
const reportScope = vi.fn(async () => H.scope);

vi.mock('../src/app/reports/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/reports/lib')>();
  return {
    ...actual,
    reportScope: (...a: unknown[]) => (reportScope as unknown as (...x: unknown[]) => unknown)(...a),
    runReport: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});
vi.mock('../src/app/expenses/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/expenses/lib')>();
  return {
    ...actual,
    withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    listStores: vi.fn(async () => [
      { id: SA, name: 'Lipa', code: 'LIP' },
      { id: SB, name: 'Malvar', code: 'MAL' },
    ]),
  };
});
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR),
  requireSession: vi.fn(async () => ({ actor: ACTOR, sessionId: 's1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('../src/lib/page-access', () => ({
  requirePageAccess: vi.fn(async () => ({ actor: ACTOR, refusal: null })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/app/liabilities/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/liabilities/lib')>();
  return {
    ...actual,
    listRegister: vi.fn(async () => []),
    listStores: vi.fn(async () => [{ id: SA, name: 'Lipa', code: 'LIP' }]),
  };
});
vi.mock('@shareat/domain', async (orig) => {
  const actual = await orig<typeof import('@shareat/domain')>();
  return { ...actual, getUnpaidLiabilities: (...a: unknown[]) => (getUnpaidLiabilities as unknown as (...x: unknown[]) => unknown)(...a) };
});

const loadPage = () => import('../src/app/liabilities/unpaid/page');

const scopeFor = (storeId: string | undefined) => ({
  actor: ACTOR, orgName: 'Shareat', orgCode: 'SHR',
  stores: [{ id: SA, name: 'Lipa', code: 'LIP' }, { id: SB, name: 'Malvar', code: 'MAL' }, { id: SC, name: 'Tanauan', code: 'TAN' }],
  storeId, coversWholeOrg: storeId === undefined,
});

/** A full result: every kind has something, so order, links and totals can all be read. */
function fullResult(): Result {
  return {
    kinds: [
      {
        id: 'supplier_invoices', title: 'Supplier invoices unpaid', visible: true, subtotal: '6000.00',
        // Given future-first on purpose: the page must put the overdue one first.
        lines: [
          { storeId: SA, name: 'Invoice FUTURE-1', counterparty: 'Acme Supply', dueOn: '2026-12-01', amount: '1000.00', href: '/ap/invoices/inv-future' },
          { storeId: SA, name: 'Invoice OVERDUE-1', counterparty: 'Acme Supply', dueOn: '2026-02-05', amount: '5000.00', href: '/ap/invoices/inv-overdue', tag: 'from recurring: Lipa branch rent' },
        ],
        unmatched: [],
      },
      {
        id: 'recurring_drafts', title: 'Recurring bills drafted, not yet recorded', visible: true, subtotal: '25000.00',
        lines: [{ storeId: SA, name: 'Lipa branch rent', counterparty: 'Landlord', dueOn: '2026-09-05', amount: '25000.00', href: '/expenses/exp-1' }],
        unmatched: [],
      },
      { id: 'register', title: 'Other obligations', visible: true, subtotal: '0.00', lines: [], unmatched: [] },
      {
        id: 'loans', title: 'Loans', visible: true, subtotal: '45000.00',
        lines: [{ storeId: SB, name: 'Grab loan', counterparty: 'Grab', dueOn: null, amount: '45000.00', href: '/loans/loan-1' }],
        unmatched: [],
      },
      {
        id: 'wages', title: 'Wages worked, not yet paid', visible: true, subtotal: '800.00', needsReviewDays: 2,
        lines: [{ storeId: SA, name: 'Worker Wendy', counterparty: null, dueOn: null, amount: '800.00', href: `/payroll?store=${SA}` }],
        unmatched: [],
      },
      {
        id: 'other_ledger', title: 'Other amounts owed in the books', visible: true, subtotal: '1200.00',
        lines: [
          { storeId: SA, name: 'x', counterparty: null, dueOn: null, amount: '1200.00', href: `/reports/trial-balance?store=${SA}`, accountCode: '2130' },
          { storeId: SA, name: 'x', counterparty: 'Malvar', dueOn: null, amount: '650.00', href: `/reports/trial-balance?store=${SA}`, accountCode: '2150', internal: true },
        ],
        unmatched: [],
      },
    ],
    banners: [],
    totals: { booked: '52200.00', notYetBooked: '25800.00', grand: '78000.00', excludesWages: false },
  };
}

const strip = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

beforeAll(async () => {
  // Warm the import graph (cold it is slow). A missing page must fail each test below by name, not the whole file.
  await Promise.all([loadPage().catch(() => undefined), import('../src/app/liabilities/page').catch(() => undefined)]);
}, 90_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T04:00:00Z'));
  getUnpaidLiabilities.mockClear();
  reportScope.mockClear();
  H.result = fullResult();
  H.scope = scopeFor(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

async function render(sp: Record<string, string> = {}): Promise<string> {
  const Page = (await loadPage()).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(sp) })) as never);
}
const section = (html: string, id: string): string => {
  const start = html.indexOf(`data-kind="${id}"`);
  expect(start, `section ${id} present`).toBeGreaterThanOrEqual(0);
  const next = html.indexOf('data-kind="', start + 10);
  return html.slice(start, next === -1 ? undefined : next);
};

describe('T-431 case 22 - the page', () => {
  it('asks reportScope for view_financial_reports with the ?store= value, and the domain with the resolved store', async () => {
    H.scope = scopeFor(SA);
    await render({ store: SA });
    expect(reportScope).toHaveBeenCalledWith('/liabilities/unpaid', 'view_financial_reports', SA);
    const call = getUnpaidLiabilities.mock.calls[0] as unknown as unknown[];
    expect((call[2] as { storeId?: string }).storeId).toBe(SA);
  });

  it('the route is covered by the Liabilities capability', () => {
    expect(capabilityForRoute('/liabilities/unpaid')).toBe('view_financial_reports');
  });

  it('kinds appear in spec order, each as its own section with its title; empty ones say "Nothing unpaid"', async () => {
    const html = await render();
    const ids = [...html.matchAll(/<section[^>]*data-kind="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['supplier_invoices', 'recurring_drafts', 'register', 'loans', 'wages', 'other_ledger']);
    for (const k of H.result.kinds) expect(strip(section(html, k.id))).toContain(k.title);
    expect(strip(section(html, 'register'))).toContain('Nothing unpaid');
    expect(strip(section(html, 'loans'))).not.toContain('Nothing unpaid');
  });

  it('every line links to its source record, in both layouts', async () => {
    const html = await render();
    for (const k of H.result.kinds) {
      const sec = section(html, k.id);
      // Open tags / row bodies, found by plain string scanning (no regex escaping needed).
      const cardTags = [...sec.matchAll(/<a[^>]*data-unpaid-line[^>]*>/g)].map((m) => m[0]);
      const rowBodies = sec.split('<tr').slice(1).filter((r) => r.includes('data-unpaid-line')).map((r) => r.slice(0, r.indexOf('</tr>')));
      expect(cardTags.length, `${k.id}: one card per line`).toBe(k.lines.length);
      expect(rowBodies.length, `${k.id}: one row per line`).toBe(k.lines.length);
      for (const l of k.lines) {
        const href = `href="${l.href.split('&').join('&amp;')}"`;
        expect(cardTags.some((t) => t.includes(href)), `${k.id}: card ${l.href}`).toBe(true);
        expect(rowBodies.some((r) => r.includes(href)), `${k.id}: row ${l.href}`).toBe(true);
      }
    }
  });

  it('below sm: a card per line (sm:hidden); from sm up: a Table with RowLink rows (hidden sm:block)', async () => {
    const html = await render();
    const s = section(html, 'loans');
    const cards = /<div[^>]*data-layout="cards"[^>]*>/.exec(s)?.[0] ?? '';
    const table = /<div[^>]*data-layout="table"[^>]*>/.exec(s)?.[0] ?? '';
    expect(cards).toMatch(/class="[^"]*\bsm:hidden\b/);
    expect(table).toMatch(/class="[^"]*\bhidden\b[^"]*\bsm:block\b|class="[^"]*\bsm:block\b[^"]*\bhidden\b/);
    const tableHtml = s.slice(s.indexOf('data-layout="table"'));
    expect(tableHtml).toContain('<table');
    const row = /<tr[^>]*data-unpaid-line[^>]*>[\s\S]*?<\/tr>/.exec(tableHtml)?.[0] ?? '';
    expect(row).toMatch(/<a[^>]*href="\/loans\/loan-1"[^>]*class="[^"]*after:absolute|<a[^>]*class="[^"]*after:absolute[^"]*"[^>]*href="\/loans\/loan-1"/);
    // no sideways scroll on the card layout
    const cardHtml = s.slice(s.indexOf('data-layout="cards"'), s.indexOf('data-layout="table"'));
    expect(cardHtml).not.toContain('<table');
    expect(cardHtml).not.toContain('overflow-x-auto');
  });

  it('overdue lines come first, whatever order the result gave them', async () => {
    const html = await render();
    const s = section(html, 'supplier_invoices');
    const cards = s.slice(s.indexOf('data-layout="cards"'), s.indexOf('data-layout="table"'));
    expect(cards.indexOf('/ap/invoices/inv-overdue')).toBeGreaterThanOrEqual(0);
    expect(cards.indexOf('/ap/invoices/inv-overdue')).toBeLessThan(cards.indexOf('/ap/invoices/inv-future'));
    const rows = s.slice(s.indexOf('data-layout="table"'));
    expect(rows.indexOf('/ap/invoices/inv-overdue')).toBeLessThan(rows.indexOf('/ap/invoices/inv-future'));
  });

  it('subtotals add to the totals, read from raw amounts and not from display strings', async () => {
    const html = await render();
    const cents = (v: string | undefined) => Math.round(Number(v) * 100);
    const rawOf = (hook: string, value: string): string | undefined => {
      const tag = new RegExp(`<[^>]*${hook}="${value}"[^>]*>`).exec(html)?.[0];
      expect(tag, `${hook}=${value} present`).toBeDefined();
      return /data-amount="([^"]+)"/.exec(tag!)?.[1];
    };
    for (const k of H.result.kinds) {
      const sec = section(html, k.id);
      const lineSum = [...sec.matchAll(/<tr[^>]*data-unpaid-line[^>]*>/g)].reduce((t, m) => t + cents(/data-amount="([^"]+)"/.exec(m[0])?.[1]), 0);
      const internal = k.lines.filter((l) => l.internal).reduce((t, l) => t + cents(l.amount), 0);
      const shown = cents(rawOf('data-subtotal', k.id));
      expect(shown, `${k.id} subtotal`).toBe(cents(k.subtotal!));
      expect(lineSum - internal, `${k.id} lines add to subtotal`).toBe(shown);
    }
    const sub = (id: string) => cents(rawOf('data-subtotal', id));
    const booked = ['supplier_invoices', 'register', 'loans', 'other_ledger'].reduce((t, id) => t + sub(id), 0);
    const notYet = ['recurring_drafts', 'wages'].reduce((t, id) => t + sub(id), 0);
    expect(cents(rawOf('data-total', 'booked'))).toBe(booked);
    expect(cents(rawOf('data-total', 'not-yet-booked'))).toBe(notYet);
    expect(cents(rawOf('data-total', 'grand'))).toBe(booked + notYet);
  });

  it('money is shown as pesos; an account is shown in plain words, never its code', async () => {
    const html = await render();
    const text = strip(html);
    expect(text).toContain(peso('78000.00'));
    expect(text).toContain(peso('5000.00'));
    expect(text).toContain(accountLabel('2130')); // "Reimbursements payable to employees"
    expect(text).toContain(accountLabel('2150'));
    expect(text).not.toMatch(/\b21[0-9]0\b/);
  });

  it('a 2150 line is badged "internal" and no other line is', async () => {
    const html = await render();
    const s = section(html, 'other_ledger');
    const rows = [...s.matchAll(/<tr[^>]*data-unpaid-line[^>]*>[\s\S]*?<\/tr>/g)].map((m) => strip(m[0]));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => /internal/i.test(r))).toHaveLength(1);
    expect(rows.find((r) => /internal/i.test(r))).toContain('Malvar');
    expect(strip(section(html, 'loans'))).not.toMatch(/internal/i);
  });

  it('a recurring-born invoice carries its "from recurring" tag; a store name is shown instead of an id', async () => {
    const text = strip(await render());
    expect(text).toContain('from recurring: Lipa branch rent');
    expect(text).toContain('Lipa');
    expect(text).not.toContain('store-a');
  });

  it('wages: needs-review days are shown as a count "not included"', async () => {
    const text = strip(section(await render(), 'wages'));
    expect(text).toMatch(/2 days?[^.]*review/i);
    expect(text).toMatch(/not included/i);
    expect(text).toContain('Worker Wendy');
  });

  it('wages that cannot be computed show their reason', async () => {
    const r = fullResult();
    const w = r.kinds.find((k) => k.id === 'wages')!;
    w.lines = [];
    w.subtotal = '0.00';
    w.unavailableReason = 'Lipa has no attendance configuration, so wages cannot be worked out.';
    H.result = r;
    const text = strip(section(await render(), 'wages'));
    expect(text).toContain('no attendance configuration');
  });

  it('18 - without run_payroll: "Visible to payroll staff only", no amount or name, and the totals say they exclude wages', async () => {
    const r = fullResult();
    const w = r.kinds.find((k) => k.id === 'wages')!;
    w.visible = false;
    w.lines = [];
    w.subtotal = null;
    delete w.needsReviewDays;
    r.kinds.find((k) => k.id === 'other_ledger')!.withheld = [{ accountCode: '2300', storeId: SA }];
    r.totals = { booked: '52200.00', notYetBooked: '25000.00', grand: '77200.00', excludesWages: true };
    H.result = r;
    const html = await render();
    const s = section(html, 'wages');
    expect(strip(s)).toContain('Visible to payroll staff only');
    expect(s).not.toContain('Worker Wendy');
    expect(s).not.toContain('800.00');
    expect(s).not.toContain('data-unpaid-line');
    expect(s).not.toMatch(/data-subtotal="wages"/);
    expect(html).not.toContain('Worker Wendy');
    expect(strip(html)).toMatch(/excludes wages/i);
    // 2300 withheld in kind 6: the same words, no figure
    expect(strip(section(html, 'other_ledger'))).toContain('Visible to payroll staff only');
  });

  it('a non-zero "Unmatched in the books" leftover shows inside its kind and as a banner naming the account and amount', async () => {
    const r = fullResult();
    r.kinds[0]!.unmatched = [{ accountCode: '2110', storeId: SC, amount: '1234.00' }];
    r.banners = [{ accountCode: '2110', storeId: SC, amount: '1234.00' }];
    H.result = r;
    const html = await render();
    const inKind = strip(section(html, 'supplier_invoices'));
    expect(inKind).toContain('Unmatched in the books');
    expect(inKind).toContain(peso('1234.00'));
    const before = html.slice(0, html.indexOf('data-kind="supplier_invoices"'));
    expect(strip(before)).toContain(accountLabel('2110'));
    expect(strip(before)).toContain(peso('1234.00'));
    expect(strip(before)).toContain('Tanauan');
  });

  it('a line with no store is grouped under "No store": no "null" text, no store=null link, and the totals still add up', async () => {
    const r = fullResult();
    const k6 = r.kinds.find((k) => k.id === 'other_ledger')!;
    k6.lines.push({ storeId: null as unknown as string, name: 'x', counterparty: null, dueOn: null, amount: '3000.00', href: '/reports/trial-balance', accountCode: '2210' });
    k6.subtotal = '4200.00';
    r.totals = { booked: '55200.00', notYetBooked: '25800.00', grand: '81000.00', excludesWages: false };
    H.result = r;
    const html = await render();
    const text = strip(html);
    expect(text).toContain('No store');
    expect(text).not.toMatch(/null|undefined/);
    expect(html).not.toContain('store=null');
    expect(html).not.toContain('store=undefined');
  });

  it('no banner and no "Unmatched" wording when every leftover is zero', async () => {
    const text = strip(await render());
    expect(text).not.toContain('Unmatched in the books');
  });
});

describe('T-431 - the Liabilities header links to the new page', () => {
  it('/liabilities has a link to /liabilities/unpaid labelled "Everything unpaid"', async () => {
    const Page = (await import('../src/app/liabilities/page')).default;
    const html = renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
    expect(html).toMatch(/<a[^>]*href="\/liabilities\/unpaid"[^>]*>[^<]*Everything unpaid/i);
  });
});
