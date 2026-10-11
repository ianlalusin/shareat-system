import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-375 S5 (S5-lite) W1 - the POS usage screen reads the stored feed. `docs/tasks/375-pos-v1-day-feed.md` S5 test W1
 * (the domain half is `packages/domain/tests/integration/t375-s5-usage-from-feed.test.ts`).
 *
 * TESTER, not BUILDER. Real Postgres and the REAL domain underneath; only the session, Next's navigation helpers and
 * the `Page` shell are doubled (the S4 day-page test's pattern). `fetch` is a recording spy that throws, and
 * `POS_API_URL` is unset.
 *
 * ## Why these are red on HEAD
 * `buildPlanAction` reaches HEAD's live `fetchPosSoldItemsLive`, which throws "POS_API_URL ... not configured"; the
 * action catches it and redirects with `error=`, so the "Plan built" assertion fails first. The page strings
 * ("from POS's sold items fetched", "(at import)", "(at a later check)", the no-feed sentence) do not exist yet.
 *
 * ## Pinned where the spec is silent
 *  - `buildPlanAction` success is `ok=Plan built — N line(s).` with `pull` set (the existing action, unchanged);
 *  - the page strings are read as a person reads them (React escapes the apostrophe), by SUBSTRING, so the times
 *    between the words are free: "from POS's sold items fetched" and "(at import)" / "(at a later check)", then
 *    "A plan older than an hour is refused at finalize.";
 *  - the no-feed line is the spec's sentence verbatim, and replaces the hour line.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

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

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import * as D from '@shareat/domain';
import { importTestDay, linkTestStore, seedTestTenders } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { insertRecheckBatch } from '../../../../packages/domain/tests/integration/_fixtures/pos-sold-items';
import PosUsagePage from '../../src/app/inventory/pos-usage/page';
import { buildPlanAction, finalizeSectionAction } from '../../src/app/inventory/pos-usage/actions';
import { paramsOf, urlOf } from '../helpers/flash-jar';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const D10 = '2027-01-10';
const D9 = '2027-01-09';

const fetchSpy = vi.fn(async (..._args: unknown[]) => {
  throw new Error('LIVE POS FETCH: usage must read the stored feed, never call POS');
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** React escapes quotes and ampersands; the sentences are asserted as a person reads them. */
const text = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

async function fixture(hint: string) {
  const code = uid(`t375s5w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, ${name}, 'multi_room') returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas'); // never linked
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  for (const s of [storeId, store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  const mkChannel = async (sid: string) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${sid}, 'Walk-in', true) returning id`)[0]!.id;
  const walkIn = await mkChannel(storeId);
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  const { posStoreId } = await linkTestStore(sql, { orgId, storeId, channelId: walkIn, createdBy: p!.id });
  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (sid: string) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sid}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${p!.id}) returning id`)[0]!.id;
  const kitchen = await mkRoom(storeId);
  const kitchen2 = await mkRoom(store2Id);
  const [cheese] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Cheese', 'meat_slab', 'kg', ${p!.id}) returning id`;
  const admin = { personId: p!.id, orgId };
  await asOrg(orgId, (tx) =>
    D.upsertPosItemMap(tx, admin, { orgId, storeId, posItemKey: 'item-a', posItemName: 'item-a', mode: 'direct', itemId: cheese!.id, quantityPerSale: '1' }),
  );
  h.actor = admin;
  return { orgId, storeId, store2Id, walkIn, kitchen, kitchen2, posStoreId, admin, adminId: p!.id };
}
type F = Awaited<ReturnType<typeof fixture>>;

const importDay = (f: F, date: string) => asOrg(f.orgId, (tx) => importTestDay(tx, f.admin, { storeId: f.storeId, businessDate: date }));

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
/** Runs the build-plan action; returns where it redirected. */
async function build(f: F, storeId: string, dayId: string, locationId: string): Promise<{ path: string; q: URLSearchParams }> {
  h.actor = f.admin;
  try {
    await buildPlanAction(form({ storeId, salesDayId: dayId, locationId }));
  } catch (err) {
    if (err instanceof RedirectSignal) {
      const u = urlOf(err.to);
      return { path: u.pathname, q: u.searchParams };
    }
    throw err;
  }
  throw new Error('buildPlanAction returned without redirecting');
}
async function renderPage(f: F, params: { store: string; day: string; pull?: string }): Promise<string> {
  h.actor = f.admin;
  const el = await PosUsagePage({ searchParams: Promise.resolve(params) });
  return text(renderToStaticMarkup(el as never));
}

describe('W1 - the POS usage screen reads the stored feed and never calls POS', () => {
  it('buildPlanAction on D redirects with "Plan built"; the pull shows "from POS\'s sold items fetched ... (at import)" and the hour line; 0 fetch calls', async () => {
    const f = await fixture('imp');
    const { id: dayId } = await importDay(f, D10);

    const r = await build(f, f.storeId, dayId, f.kitchen);
    expect(r.path).toBe('/inventory/pos-usage');
    expect(r.q.get('error'), 'no error').toBeNull();
    expect(r.q.get('ok') ?? '').toMatch(/^Plan built/);
    const pull = r.q.get('pull');
    expect(pull, 'the redirect names the pull').toBeTruthy();

    const html = await renderPage(f, { store: f.storeId, day: dayId, pull: pull! });
    expect(html).toContain("from POS's sold items fetched");
    expect(html).toContain('(at import)');
    expect(html).not.toContain('(at a later check)');
    expect(html).toContain('A plan older than an hour is refused at finalize.');
    expect(html, 'the old live-snapshot line is gone').not.toContain('Snapshot taken');
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('after a recheck and a rebuild the line says "(at a later check)"; 0 fetch calls throughout', async () => {
    const f = await fixture('chk');
    const { id: dayId } = await importDay(f, D10);
    const first = await build(f, f.storeId, dayId, f.kitchen);
    expect(first.q.get('ok') ?? '').toMatch(/^Plan built/);

    await asOrg(f.orgId, (tx) =>
      insertRecheckBatch(tx, {
        orgId: f.orgId, storeId: f.storeId, businessDate: D10, posStoreId: f.posStoreId, fetchedBy: f.adminId,
        soldItems: [{ key: 'item-a', physicalQty: 4 }],
      }),
    );
    const second = await build(f, f.storeId, dayId, f.kitchen);
    expect(second.q.get('ok') ?? '').toMatch(/^Plan built/);

    const html = await renderPage(f, { store: f.storeId, day: dayId, pull: second.q.get('pull')! });
    expect(html).toContain("from POS's sold items fetched");
    expect(html).toContain('(at a later check)');
    expect(html).not.toContain('(at import)');
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('a pull built before S5-lite (no pin) shows the build-again line, not an hour line', async () => {
    const f = await fixture('nopin');
    const { id: dayId } = await importDay(f, D10);
    const [raw] = await sql<{ id: string }[]>`
      insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at, status)
      values (${f.orgId}, ${f.storeId}, ${dayId}, ${f.kitchen}, now(), 'planned') returning id`;
    const html = await renderPage(f, { store: f.storeId, day: dayId, pull: raw!.id });
    expect(html).toContain("Built before usage read POS's stored sold items — build the plan again before finalizing.");
    expect(html).not.toContain('(at import)');
  });

  it('negative: an UNLINKED store -> the redirect carries the unlinked sentence (no ok, no pull)', async () => {
    const f = await fixture('unl');
    const [typed] = await sql<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by)
      values (${f.orgId}, ${f.store2Id}, ${D9}, 1000, 600, 400, 1000, ${f.adminId}) returning id`;
    const r = await build(f, f.store2Id, typed!.id, f.kitchen2);
    expect(r.q.get('ok')).toBeNull();
    expect(r.q.get('pull')).toBeNull();
    expect(r.q.get('error')).toBe("Batangas isn't linked to a POS store yet, so its usage can't be pulled. An admin links it under Settings › POS link.");
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

// =====================================================================================================
// T-377 S2 (DEF-597) W1-W3 - the "Finish this pull" button. `docs/tasks/377-pos-smoke-follow-ups.md` section S2.
// TESTER only. A "stuck" pull (direct stamped, recipe and orphan empty, status planned) is made by raw SQL, the state
// a pull reached before the fix; the domain half is `packages/domain/tests/integration/t377-s2-empty-sections.test.ts`.
//
// Mutants: the button condition ignores the stamps (checks only "all sections empty") -> W1 first leg red;
//          drop the `viewOnly` guard -> W2 red; the `finish` branch sends [firstUnstampedSection] -> W3 E10 leg red.
// =====================================================================================================
const ZERO_FIGURES = { paidTotal: 0, receiptCount: 0, packageOnly: 0, discounts: 0, charges: 0, methods: {} };
const FINISH = 'Finish this pull — nothing left to post';

/** The <form> that carries the finish button, or null. */
const finishForm = (html: string): string | null =>
  html.match(/<form[^>]*>(?:(?!<\/form>)[\s\S])*Finish this pull(?:(?!<\/form>)[\s\S])*<\/form>/)?.[0] ?? null;
const HIDDEN_FINISH = /name="finish"[^>]*value="1"|value="1"[^>]*name="finish"/;

type PullState = { status: string; direct: Date | null; recipe: Date | null; orphan: Date | null };
const pullState = async (id: string): Promise<PullState> =>
  (
    await sql<PullState[]>`select status, direct_finalized_at as direct, recipe_finalized_at as recipe, orphan_finalized_at as orphan from pos_usage_pulls where id = ${id}`
  )[0]!;

/** Builds the plan through the real action and returns the pull id. */
async function built(f: F, dayId: string): Promise<string> {
  const r = await build(f, f.storeId, dayId, f.kitchen);
  expect(r.q.get('ok') ?? '', 'fixture: the plan builds').toMatch(/^Plan built/);
  return r.q.get('pull')!;
}
/** A pull stuck the old way: direct stamped, nothing else, still planned. */
async function stuck(pullId: string) {
  await sql`update pos_usage_pulls set direct_finalized_at = now() where id = ${pullId}`;
}
async function setItemAMap(f: F, mode: 'direct' | 'no_stock') {
  const [m] = await sql<{ id: string }[]>`select id from pos_item_maps where store_id = ${f.storeId} and pos_item_key = 'item-a' and status = 'active'`;
  const [cheese] = await sql<{ id: string }[]>`select id from items where org_id = ${f.orgId} and name = 'Cheese'`;
  const base = { orgId: f.orgId, storeId: f.storeId, posItemKey: 'item-a', posItemName: 'item-a', editMapId: m!.id };
  const out = await asOrg(f.orgId, (tx) =>
    D.upsertPosItemMap(tx, f.admin, mode === 'direct' ? { ...base, mode, itemId: cheese!.id, quantityPerSale: '1' } : { ...base, mode }),
  );
  if (!out.ok) throw new Error(`fixture: map edit refused: ${'reason' in out ? out.reason : ''}`);
}
async function finalizeVia(f: F, fields: Record<string, string>): Promise<{ q: URLSearchParams }> {
  h.actor = f.admin;
  try {
    await finalizeSectionAction(form(fields));
  } catch (err) {
    if (err instanceof RedirectSignal) return { q: paramsOf(err.to) };
    throw err;
  }
  throw new Error('finalizeSectionAction returned without redirecting');
}

describe('T-377 S2 W1 - the finish button shows for a pull with nothing left to review', () => {
  it('direct stamped, recipe and orphan empty -> the button, in a form with hidden finish=1 and NO section input', async () => {
    const f = await fixture('t377w1a');
    const { id: dayId } = await importDay(f, D10);
    const pullId = await built(f, dayId);
    await stuck(pullId);

    const html = await renderPage(f, { store: f.storeId, day: dayId, pull: pullId });
    const form1 = finishForm(html);
    expect(form1, `the page carries "${FINISH}"`).not.toBeNull();
    expect(form1).toContain(FINISH);
    expect(form1).toMatch(HIDDEN_FINISH);
    expect(form1, 'no section input (REV-3)').not.toMatch(/name="section"/);
    expect(form1).not.toMatch(/name="confirmedKeys"/);
  });

  it('a PHP 0 day (all three sections empty and unstamped) -> the same button', async () => {
    const f = await fixture('t377w1b');
    const { id: dayId } = await asOrg(f.orgId, (tx) => importTestDay(tx, f.admin, { storeId: f.storeId, businessDate: D9, soldItems: [], figures: ZERO_FIGURES }));
    const pullId = await built(f, dayId);
    const form1 = finishForm(await renderPage(f, { store: f.storeId, day: dayId, pull: pullId }));
    expect(form1).not.toBeNull();
    expect(form1).toMatch(HIDDEN_FINISH);
    expect(form1).not.toMatch(/name="section"/);
  });
});

describe('T-377 S2 W2 - the finish button is absent when it must be', () => {
  it('an unstamped non-empty section; a view-only (voided) day; a finalized pull. Positive control: the same stuck pull shows it first', async () => {
    const f = await fixture('t377w2');
    const { id: dayId } = await importDay(f, D10);
    const pullId = await built(f, dayId);

    // (a) direct still has a line and is unstamped: nothing to finish
    expect(finishForm(await renderPage(f, { store: f.storeId, day: dayId, pull: pullId })), '(a) an unstamped non-empty section').toBeNull();

    // positive control: stuck -> the button shows (W1)
    await stuck(pullId);
    expect(finishForm(await renderPage(f, { store: f.storeId, day: dayId, pull: pullId })), 'control: the stuck pull shows the button').not.toBeNull();

    // (c) the same pull on a voided (view-only) day
    await sql`update sales_days set status = 'voided', voided_by = ${f.adminId}, voided_at = now(), void_reason = 'Entered wrong' where id = ${dayId}`;
    expect(finishForm(await renderPage(f, { store: f.storeId, day: dayId, pull: pullId })), '(c) view only').toBeNull();
    await sql`update sales_days set status = 'open', voided_by = null, voided_at = null, void_reason = null where id = ${dayId}`;

    // (b) a finalized pull (all three stamps, status finalized)
    await sql`update pos_usage_pulls set recipe_finalized_at = now(), orphan_finalized_at = now(), status = 'finalized', finalized_at = now(), finalized_by = ${f.adminId} where id = ${pullId}`;
    expect(finishForm(await renderPage(f, { store: f.storeId, day: dayId, pull: pullId })), '(b) a finalized pull').toBeNull();
  });
});

describe('T-377 S2 W3 - finalizeSectionAction with finish', () => {
  it('finish=1 on the stuck pull -> ok "Pull finished — nothing left to post." and the pull is finalized', async () => {
    const f = await fixture('t377w3a');
    const { id: dayId } = await importDay(f, D10);
    const pullId = await built(f, dayId);
    await stuck(pullId);

    const r = await finalizeVia(f, { storeId: f.storeId, salesDayId: dayId, pullId, finish: '1' });
    expect(r.q.get('error'), 'no error').toBeNull();
    expect(r.q.get('ok')).toBe('Pull finished — nothing left to post.');
    expect((await pullState(pullId)).status).toBe('finalized');
  });

  it('E10 on the button: the map changed to direct after the page rendered -> error "Something new turned up", nothing stamped', async () => {
    const f = await fixture('t377w3b');
    await setItemAMap(f, 'no_stock');
    const { id: dayId } = await importDay(f, D10);
    const pullId = await built(f, dayId); // all three sections empty at build
    await setItemAMap(f, 'direct');

    const r = await finalizeVia(f, { storeId: f.storeId, salesDayId: dayId, pullId, finish: '1' });
    expect(r.q.get('ok')).toBeNull();
    expect(r.q.get('error') ?? '').toMatch(/^Something new turned up/);
    const st = await pullState(pullId);
    expect([st.direct, st.recipe, st.orphan], 'nothing stamped').toEqual([null, null, null]);
    expect(st.status).toBe('planned');
  });

  it('a section outside direct/recipe/orphan, without finish -> refused, nothing stamped', async () => {
    const f = await fixture('t377w3c');
    const { id: dayId } = await importDay(f, D10);
    const pullId = await built(f, dayId);

    const r = await finalizeVia(f, { storeId: f.storeId, salesDayId: dayId, pullId, section: 'bogus', confirmedKeys: 'direct:item-a' });
    expect(r.q.get('ok')).toBeNull();
    expect(r.q.get('error'), 'refused with a sentence').toBeTruthy();
    const st = await pullState(pullId);
    expect([st.direct, st.recipe, st.orphan]).toEqual([null, null, null]);
    expect(st.status).toBe('planned');
  });
});
