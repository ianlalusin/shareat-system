import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-375 S6 - the screens and the action seam: tests R2 (the import action runs the prior-7-days recheck AFTER it
 * commits) and W1 (the T-210 page reads stored feeds, never calls POS at render, and "Check POS again" adds a batch).
 * `docs/tasks/375-pos-v1-day-feed.md` section S6.
 *
 * TESTER, not BUILDER. Real Postgres and the REAL domain run underneath; only the session, Next's navigation helpers,
 * the `Page` shell and `fetch` (the POS bridge) are doubled. `POS_API_URL` / `POS_API_KEY` are set per test through a
 * partial mock of `env()` (the S3 web test's pattern).
 *
 * ## Why these are red on HEAD
 *  - R2: `importSalesDayAction` imports D and stops: no recheck batch exists afterwards (red on the batch-dates
 *    assertion).
 *  - W1: HEAD's page calls `fetchPosSalesLive` at render (the fetch spy records calls) and has no "At import" /
 *    "Latest check"; `recheckPosDayAction` does not exist (a TypeError when called).
 *
 * ## Pinned where the spec is silent (a question to the builder, not a test edit)
 *  - `recheckPosDayAction(formData)` in `apps/erp/src/app/sales-days/actions.ts` reads `salesDayId` and ends in a
 *    redirect (any target: the day page, or back to the report); it calls POS through the live fetchers;
 *  - the T-210 page for a store and date shows the words "At import" then "Latest check" and, under each, the POS
 *    PAID total of the basis feed / of the latest stored `sales` feed as `formatMoney` prints it (the paid total, the
 *    same figure the drift finding words as "paid then / now"); a "Delta" line reads latest minus at-import, so a
 *    ₱50.00 fall is `-₱50.00`; and the button text "Check POS again" appears for a feed day;
 *  - R2's "error is logged" is read off `logger.warn` / `logger.error` (either), the entry naming the failed date or
 *    that day's id.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({
  actor: null as null | { personId: string; orgId: string },
  posUrl: undefined as string | undefined,
  posKey: undefined as string | undefined,
}));

class Redirected extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT ${target}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new Redirected(target);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({
    actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@shareat/core/env', async (orig) => {
  const real = await orig<typeof import('@shareat/core/env')>();
  return { ...real, env: () => ({ ...real.env(), POS_API_URL: h.posUrl, POS_API_KEY: h.posKey }) };
});

import { POS_V1_FEED_PATHS } from '@shareat/db';
import { logger } from '@shareat/core/logger';
import { verifySalesDay } from '../../../../packages/domain/src/sales-days/verify';
import { posV1SalesBody, posV1SoldItemsBody, type PosV1SalesFigures } from '../../../../packages/db/src/pos-v1/fixtures';
import { D1_FIGURES, D1_SOLD_ITEMS, importTestDay } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { asOrgOn, DAY, R1_FIGURES, s6Fixture, type S6F } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import * as actions from '../../src/app/sales-days/actions';
import PosReconciliationPage from '../../src/app/reports/pos-reconciliation/page';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ---- the POS bridge ------------------------------------------------------------------------------------------------
const bridge = { figures: D1_FIGURES as PosV1SalesFigures, failDate: null as string | null, storeId: '' };
const calls: { kind: 'sales' | 'sold_items'; date: string; posStoreId: string; dayVisible: number | null }[] = [];
const fetchSpy = vi.fn(async (input: unknown) => {
  const u = new URL(String(input));
  const date = u.searchParams.get('date') ?? '';
  const kind = u.pathname.endsWith(POS_V1_FEED_PATHS.sold_items) ? 'sold_items' : 'sales';
  // Is the day being imported (DAY) visible to ANOTHER connection yet? Only meaningful for the recheck calls: a recheck
  // that runs inside the import's transaction fetches while the import is still uncommitted.
  let dayVisible: number | null = null;
  if (date !== DAY && bridge.storeId) {
    dayVisible = (await sql<{ n: number }[]>`select count(*)::int as n from sales_days where store_id = ${bridge.storeId} and business_date = ${DAY}`)[0]!.n;
  }
  calls.push({ kind, date, posStoreId: u.searchParams.get('storeId') ?? '', dayVisible });
  if (bridge.failDate && date === bridge.failDate) throw new TypeError('fetch failed');
  const body = kind === 'sold_items' ? posV1SoldItemsBody(D1_SOLD_ITEMS) : posV1SalesBody(bridge.figures);
  return new Response(JSON.stringify(body, null, 2), { status: 200 });
});
beforeEach(() => {
  calls.length = 0;
  fetchSpy.mockClear();
  bridge.figures = D1_FIGURES;
  bridge.failDate = null;
  bridge.storeId = '';
  h.posUrl = 'https://pos.example.test';
  h.posKey = 'test-key';
  vi.stubGlobal('fetch', fetchSpy);
});
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (spies.length) spies.pop()!.mockRestore();
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
/** Runs an action and returns the redirect target (every outcome of these actions is a redirect). */
async function run(as: { personId: string; orgId: string }, action: unknown, fd: FormData, name: string): Promise<URL> {
  h.actor = as;
  expect(typeof action, `${name} must exist`).toBe('function');
  const err = await Promise.resolve()
    .then(() => (action as (fd: FormData) => Promise<void>)(fd))
    .then(() => null, (e) => e);
  expect(err, `${name} ends by redirecting`).toBeInstanceOf(Redirected);
  return new URL((err as Redirected).target, 'http://x');
}

const importVerified = async (f: S6F, date: string): Promise<string> => {
  const { id } = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date }));
  await asOrgOn(f.orgId, (tx) => verifySalesDay(tx, f.manager, id));
  return id;
};
const rechecks = (f: S6F) =>
  sql<{ business_date: string; kind: string; batch_id: string; pos_store_id: string }[]>`
    select to_char(business_date, 'YYYY-MM-DD') as business_date, kind, batch_id, pos_store_id
      from pos_v1_day_feeds where store_id = ${f.storeId} and purpose = 'recheck' order by business_date, kind`;

// =====================================================================================================
describe('R2 - the import action runs the prior-7-days recheck after the import has committed', () => {
  it('verified feed days D-1..D-8: importing D rechecks D-1..D-7 (not D-8), each after the import committed; D-3\'s fetch throws -> D is imported, the other six are rechecked, the failure is logged', async () => {
    const f = await s6Fixture(sql, 'r2');
    const dates = ['2027-01-09', '2027-01-08', '2027-01-07', '2027-01-06', '2027-01-05', '2027-01-04', '2027-01-03', '2027-01-02'];
    const ids: Record<string, string> = {};
    for (const d of dates) ids[d] = await importVerified(f, d);
    expect(await rechecks(f), 'control: nothing is rechecked before the import action').toHaveLength(0);

    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');
    spies.push(warn, error);
    bridge.storeId = f.storeId;
    bridge.failDate = '2027-01-07'; // D-3
    calls.length = 0;

    const to = await run(f.admin, actions.importSalesDayAction, form({ storeId: f.storeId, businessDate: DAY }), 'importSalesDayAction');

    const days = await sql<{ id: string; source: string }[]>`select id, source from sales_days where store_id = ${f.storeId} and business_date = ${DAY}`;
    expect(days, 'D is imported').toHaveLength(1);
    expect(to.pathname).toBe(`/sales-days/${days[0]!.id}`);
    expect(to.searchParams.get('error'), 'a recheck failure never reaches the import\'s result').toBeNull();

    const rows = await rechecks(f);
    const byDate = new Map<string, { kinds: string[]; batches: Set<string>; posIds: Set<string> }>();
    for (const r of rows) {
      const e = byDate.get(r.business_date) ?? { kinds: [], batches: new Set<string>(), posIds: new Set<string>() };
      e.kinds.push(r.kind);
      e.batches.add(r.batch_id);
      e.posIds.add(r.pos_store_id);
      byDate.set(r.business_date, e);
    }
    expect([...byDate.keys()].sort(), 'D-1..D-7 except the failed D-3; never D-8, never D itself').toEqual(
      ['2027-01-03', '2027-01-04', '2027-01-05', '2027-01-06', '2027-01-08', '2027-01-09'],
    );
    for (const [d, e] of byDate) {
      expect(e.kinds.sort(), `${d}: one batch, both kinds`).toEqual(['sales', 'sold_items']);
      expect(e.batches.size).toBe(1);
      expect([...e.posIds]).toEqual([f.posStoreId]);
    }

    const recheckCalls = calls.filter((c) => c.date !== DAY);
    expect(new Set(recheckCalls.map((c) => c.date)), 'POS was asked for D-1..D-7 only').toEqual(new Set(dates.slice(0, 7)));
    expect(recheckCalls.length, 'at least one recheck call').toBeGreaterThan(0);
    for (const c of recheckCalls) expect(c.dayVisible, `${c.date}: the import had already committed when POS was asked`).toBe(1);

    const logged = [...warn.mock.calls, ...error.mock.calls].map((c) => JSON.stringify(c.map((a) => (a instanceof Error ? a.message : a))));
    expect(
      logged.some((line) => line.includes('2027-01-07') || line.includes(ids['2027-01-07']!)),
      `the failed recheck is logged (saw: ${logged.length} warn/error calls)`,
    ).toBe(true);
  });
});

// =====================================================================================================
describe('W1 - the T-210 page: stored feeds, no POS call at render, Check POS again', () => {
  const text = (html: string): string =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
      .replace(/\s+/g, ' ');
  const render = async (f: S6F) =>
    text(renderToStaticMarkup(await PosReconciliationPage({ searchParams: Promise.resolve({ store: f.storeId, date: DAY }) })));
  /** The words between "Posted basis" and "Latest check", and from "Latest check" on. */
  const columns = (page: string) => {
    const a = page.indexOf('Posted basis');
    const l = page.indexOf('Latest check');
    return { a, l, atImport: a >= 0 && l > a ? page.slice(a, l) : '', latest: l >= 0 ? page.slice(l) : '' };
  };

  it('"Posted basis" and "Latest check" both show the stored paid total with 0 POS calls; Check POS again stores a batch (2 calls, the link\'s POS id and the date) and the page then shows the new figures and the delta', async () => {
    const f = await s6Fixture(sql, 'w1');
    const dayId = await importVerified(f, DAY);
    h.actor = f.admin;
    calls.length = 0;
    fetchSpy.mockClear();

    const before = await render(f);
    expect(fetchSpy, 'rendering never calls POS').toHaveBeenCalledTimes(0);
    const c0 = columns(before);
    expect(c0.a, 'the page says "Posted basis"').toBeGreaterThanOrEqual(0);
    expect(c0.l, 'then "Latest check"').toBeGreaterThan(c0.a);
    expect(c0.atImport).toContain('₱1,050.00');
    expect(c0.latest).toContain('₱1,050.00');
    expect(before).toContain('Check POS again');

    bridge.figures = R1_FIGURES;
    const to = await run(f.admin, (actions as unknown as Record<string, unknown>).recheckPosDayAction, form({ salesDayId: dayId }), 'recheckPosDayAction');
    expect(to.searchParams.get('error'), 'the recheck succeeded').toBeNull();
    expect(calls.map((c) => c.kind).sort(), 'both kinds fetched').toEqual(['sales', 'sold_items']);
    for (const c of calls) expect({ date: c.date, posStoreId: c.posStoreId }).toEqual({ date: DAY, posStoreId: f.posStoreId });
    const stored = await rechecks(f);
    expect(stored.map((r) => r.kind).sort(), 'one batch, both kinds').toEqual(['sales', 'sold_items']);
    expect(new Set(stored.map((r) => r.batch_id)).size).toBe(1);

    fetchSpy.mockClear();
    const after = await render(f);
    expect(fetchSpy, 'still no POS call at render').toHaveBeenCalledTimes(0);
    const c1 = columns(after);
    expect(c1.atImport, 'what was posted does not move').toContain('₱1,050.00');
    expect(c1.atImport).not.toContain('₱1,000.00');
    expect(c1.latest, 'the new figures').toContain('₱1,000.00');
    expect(after).toMatch(/Delta[^₱]*-₱50\.00/);
  });
});

// =====================================================================================================
describe('W1 (T-377 S1, DEF-596) - the page after a posted correction says "Posted basis" and shows the corrected figure', () => {
  const text = (html: string): string =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
      .replace(/\s+/g, ' ');

  it('"Posted basis" and its sub-line, no "At import"; the first column is 1,000.00 not 1,050.00; "Matches"', async () => {
    const f = await s6Fixture(sql, 't377-w1');
    const dayId = await importVerified(f, DAY);
    const { insertSalesRecheck } = await import('../../../../packages/domain/tests/integration/_fixtures/pos-s6');
    const feedId = (
      await asOrgOn(f.orgId, (tx) =>
        insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: DAY, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures: R1_FIGURES }),
      )
    ).ids.sales!;
    const { postPosCorrection } = await import('../../../../packages/domain/src/sales-days/correction');
    await asOrgOn(f.orgId, (tx) =>
      postPosCorrection(tx, f.manager, { salesDayId: dayId, feedId, entryDate: '2027-01-20', reason: 'POS voided a cash receipt' }),
    );
    h.actor = f.admin;

    const page = text(renderToStaticMarkup(await PosReconciliationPage({ searchParams: Promise.resolve({ store: f.storeId, date: DAY }) })));

    expect(page).toContain('Posted basis');
    expect(page).toContain('What the ledger holds: the import, or the latest correction.');
    expect(page).not.toContain('At import');
    const a = page.indexOf('Posted basis');
    const l = page.indexOf('Latest check');
    expect(l, 'then "Latest check"').toBeGreaterThan(a);
    const first = page.slice(a, l);
    expect(first).toContain('₱1,000.00');
    expect(first).not.toContain('₱1,050.00');
    expect(page).toContain('Matches');
  });
});
