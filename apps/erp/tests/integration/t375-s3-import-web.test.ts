import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-375 S3, W1 - the sales-day screens on a linked store: `importSalesDayAction`, `reimportSalesDayAction`, and the
 * new-day page. `docs/tasks/375-pos-v1-day-feed.md` S3.
 *
 * TESTER, not BUILDER. Real Postgres and the REAL domain run underneath; only the session, Next's navigation helpers,
 * the `Page` shell and `fetch` (the POS bridge) are doubled. `POS_API_URL` / `POS_API_KEY` are set per test through a
 * partial mock of `env()` (it caches on first read, so a process.env edit would not take).
 *
 * ## Why these are red on HEAD
 * The actions and `sales-days/import.ts` do not exist: `importSalesDayAction` is undefined (a TypeError when called),
 * and the new-day page still renders the typed form (with the posSourced box) for every store.
 *
 * ## The surface the spec leaves open, pinned so the builder has one reading
 *  - `importSalesDayAction(formData)` reads `storeId` and `businessDate` (create's own names); success ends in
 *    `redirect('/sales-days/<new id>?...')`, a refusal in `redirect('/sales-days/new?...&error=<sentence>')`;
 *  - `reimportSalesDayAction(formData)` reads `salesDayId`; success ends in `redirect('/sales-days/<id>?...')`, a
 *    refusal in `redirect('/sales-days/<id>?...&error=<sentence>')` (the day's own page, as submit/verify do);
 *  - the new-day page for a LINKED store renders the text "Import from POS" and NO figure input; for an UNLINKED
 *    store the typed form, the label "Typed — this store isn't linked to POS yet.", and NO `posSourced` box and no
 *    Import button.
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

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { POS_V1_FEED_PATHS } from '@shareat/db';
import { parseBusinessDate } from '@shareat/core/datetime';
import { humanDate } from '@shareat/domain/refusal-leaf';
import { submitSalesDay, verifySalesDay } from '../../../../packages/domain/src/sales-days/verify';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { posV1SalesBody, posV1SoldItemsBody, type PosV1SalesFigures } from '../../../../packages/db/src/pos-v1/fixtures';
import { D1_FIGURES, D1_SOLD_ITEMS, linkTestStore, seedTestTenders } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { importSalesDayAction, reimportSalesDayAction } from '../../src/app/sales-days/actions';
import NewSalesDayPage from '../../src/app/sales-days/new/page';
import { urlOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const D10 = '2027-01-10';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ---- the POS bridge: fetch is stubbed; the sales response follows `bridge.figures` -----------------------------------
const bridge = { figures: D1_FIGURES as PosV1SalesFigures };
const fetchSpy = vi.fn(async (input: unknown) => {
  const target = String(input);
  if (target.includes(POS_V1_FEED_PATHS.sold_items)) return new Response(JSON.stringify(posV1SoldItemsBody(D1_SOLD_ITEMS), null, 2), { status: 200 });
  if (target.includes(POS_V1_FEED_PATHS.sales)) return new Response(JSON.stringify(posV1SalesBody(bridge.figures), null, 2), { status: 200 });
  return new Response('{}', { status: 404 });
});
beforeEach(() => {
  fetchSpy.mockClear();
  bridge.figures = D1_FIGURES;
  h.posUrl = 'https://pos.example.test';
  h.posKey = 'test-key';
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture(hint: string) {
  const code = uid(`t375s3w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas');
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const admin = await mk('Admin', 'admin', [storeId, store2Id]);
  const plainStaff = await mk('Plain Staff', 'staff', [storeId]);
  const manager = await mk('Manager', 'manager', [storeId]);
  const mkChannel = async (sid: string) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${sid}, 'Walk-in', true) returning id`)[0]!.id;
  const walkInId = await mkChannel(storeId);
  await mkChannel(store2Id);
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  const { posStoreId } = await linkTestStore(sql, { orgId, storeId, channelId: walkInId, createdBy: admin.personId });
  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });
  return { orgId, storeId, store2Id, posStoreId, admin, plainStaff, manager };
}
type F = Awaited<ReturnType<typeof fixture>>;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
/** Runs an action and returns the redirect target (every outcome of these actions is a redirect). */
async function run(as: { personId: string; orgId: string }, action: (fd: FormData) => Promise<void>, fd: FormData): Promise<URL> {
  h.actor = as;
  const err = await Promise.resolve()
    .then(() => action(fd))
    .then(() => null, (e) => e);
  expect(err, 'the action ends by redirecting').toBeInstanceOf(Redirected);
  return urlOf((err as Redirected).target);
}
const days = (storeId: string) =>
  sql<{ id: string; source: string; total_sales: string; status: string }[]>`select id, source, total_sales, status from sales_days where store_id = ${storeId} order by created_at`;
const feedCount = (storeId: string) => sql<{ n: number }[]>`select count(*)::int as n from pos_v1_day_feeds where store_id = ${storeId}`.then((r) => r[0]!.n);

describe('W1 - importSalesDayAction', () => {
  it('positive: fetch stubbed to D1\'s bodies, a linked store -> the day is created from the feed and the action redirects to it; POS was called with its OWN store id and the date', async () => {
    const f = await fixture('imp');
    const to = await run(f.admin, importSalesDayAction, form({ storeId: f.storeId, businessDate: D10 }));
    const rows = await days(f.storeId);
    expect(rows, 'the day exists').toHaveLength(1);
    expect(to.pathname).toBe(`/sales-days/${rows[0]!.id}`);
    expect(to.searchParams.get('error')).toBeNull();
    expect({ source: rows[0]!.source, total: rows[0]!.total_sales }).toEqual({ source: 'pos_v1_day_feed', total: '1100.00' });

    const urls = fetchSpy.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    expect(urls.length, 'both kinds fetched').toBe(2);
    for (const u of urls) {
      expect(u).toContain(`storeId=${f.posStoreId}`);
      expect(u).toContain(`date=${D10}`);
      expect(u, 'never the v2 store id').not.toContain(f.storeId);
    }
  });

  it('negative: POS_API_URL unset -> back to /sales-days/new with the not-configured sentence, nothing written, POS never called', async () => {
    const f = await fixture('nocfg');
    h.posUrl = undefined;
    const to = await run(f.admin, importSalesDayAction, form({ storeId: f.storeId, businessDate: D10 }));
    expect(to.pathname).toBe('/sales-days/new');
    expect(to.searchParams.get('error')).toBe("The POS connection isn't set up on this server, so sales can't be imported.");
    expect(await days(f.storeId)).toHaveLength(0);
    expect(await feedCount(f.storeId)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('negative: an actor without submit_sales_day is refused before POS is called; no day, no feed row', async () => {
    const f = await fixture('noauth');
    const to = await run(f.plainStaff, importSalesDayAction, form({ storeId: f.storeId, businessDate: D10 }));
    expect(to.pathname).toBe('/sales-days/new');
    expect(to.searchParams.get('error'), 'a refusal sentence is shown').toBeTruthy();
    expect(fetchSpy, 'authorize comes before the bridge').not.toHaveBeenCalled();
    expect(await days(f.storeId)).toHaveLength(0);
  });
});

describe('W1 - reimportSalesDayAction', () => {
  it('an open day re-imports while POS changed: figures follow POS, the redirect is to the same day', async () => {
    const f = await fixture('reimp');
    await run(f.admin, importSalesDayAction, form({ storeId: f.storeId, businessDate: D10 }));
    const [day] = await days(f.storeId);
    bridge.figures = { ...D1_FIGURES, paidTotal: 1150, methods: { Cash: 700, GCash: 450 } };
    const to = await run(f.admin, reimportSalesDayAction, form({ salesDayId: day!.id, storeId: f.storeId }));
    expect(to.pathname).toBe(`/sales-days/${day!.id}`);
    expect(to.searchParams.get('error')).toBeNull();
    expect((await days(f.storeId))[0]!.total_sales).toBe('1200.00');
    expect(await feedCount(f.storeId)).toBe(4);
  });

  it('a verified day is refused with the verified sentence on the day\'s own page; nothing changes', async () => {
    const f = await fixture('reimpv');
    await run(f.admin, importSalesDayAction, form({ storeId: f.storeId, businessDate: D10 }));
    const [day] = await days(f.storeId);
    const asAdmin = { personId: f.admin.personId, orgId: f.orgId };
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, asAdmin, day!.id));
    await asOrg(f.orgId, (tx) => verifySalesDay(tx, { personId: f.manager.personId, orgId: f.orgId }, day!.id));
    bridge.figures = { ...D1_FIGURES, paidTotal: 1150, methods: { Cash: 700, GCash: 450 } };

    const to = await run(f.admin, reimportSalesDayAction, form({ salesDayId: day!.id, storeId: f.storeId }));
    expect(to.pathname).toBe(`/sales-days/${day!.id}`);
    expect(to.searchParams.get('error')).toBe(
      `${humanDate(parseBusinessDate(D10))} is already verified. If POS changed since, it shows under Findings and is corrected there.`,
    );
    expect((await days(f.storeId))[0]!.total_sales).toBe('1100.00');
    expect(await feedCount(f.storeId)).toBe(2);
  });
});

/** React escapes quotes and ampersands; the sentences are asserted as a person reads them. */
const text = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
const FIGURE_INPUTS = /name="(totalSales|unliSales|alaCarteSales|seniorDiscount|pwdDiscount|otherDiscount|comps|serviceCharge|otherCharges|cashCollected|onlineCollected|creditSales)"/;

async function renderNew(f: F, storeId: string): Promise<string> {
  h.actor = f.admin;
  const el = await NewSalesDayPage({ searchParams: Promise.resolve({ store: storeId }) });
  return text(renderToStaticMarkup(el as never));
}

describe('W1 - the new-day page follows the link', () => {
  it('a LINKED store: an Import from POS control, NO figure input, no posSourced box', async () => {
    const f = await fixture('pgl');
    const html = await renderNew(f, f.storeId);
    expect(html).toContain('Import from POS');
    expect(html, 'no figure is typed on a linked store').not.toMatch(FIGURE_INPUTS);
    expect(html).not.toContain('posSourced');
  });

  it('an UNLINKED store: the typed form with its label, figure inputs, no posSourced box and no Import button', async () => {
    const f = await fixture('pgu');
    const html = await renderNew(f, f.store2Id);
    expect(html).toContain("Typed — this store isn't linked to POS yet.");
    expect(html, 'the typed form is still there').toMatch(FIGURE_INPUTS);
    expect(html, 'the checkbox is gone for everyone').not.toContain('posSourced');
    expect(html).not.toContain('Import from POS');
  });
});
