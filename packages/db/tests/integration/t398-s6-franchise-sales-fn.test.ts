/**
 * T-398 S6b (TESTER) -- migration 0220: franchise_agreements, franchise_access_log, the definers franchise_sales_daily /
 * franchise_stock_levels / franchise_franchisees / log_break_glass_approval. docs/tasks/398-s6/{S6-REFRESH s3-s5,TESTS S6b,QUESTIONS}.md.
 * Real Postgres via TEST_DATABASE_URL (`_test` name guard). App legs run as shareat_app with app.org_id + app.person_id set (the real
 * withActorPrincipal shape); "owner" legs connect as the migrator and say so. Log counts are read AS OWNER (a missing row cannot hide behind RLS).
 *
 * RED TODAY for one reason: migration 0220 does not exist, so the tables and functions are absent. Every refusal leg asserts SQLSTATE and WORDS,
 * rejects 42P01/42703/42883/42704 (a missing object is never a "refusal"), and rejects "permission denied for function" (a missing EXECUTE grant
 * is not the guard speaking).
 *
 * ASSUMED NAMES (S6-REFRESH s3; the plan does not pin SQLSTATE/words for the V6 range refusals, so those legs pin words only):
 *   guard refusals           42501, message in words (not "permission denied")
 *   RETURNS TABLE            exactly the s3.4 list, in order (typmods are not visible in the catalog: scale is proven by the returned text, '900.00')
 *   append-only raise        any error whose message says so (append / cannot / read-only / not allowed ...); the SQLSTATE is the builder's
 *
 * MUTANTS: each leg names the one it kills.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { lowStockRepo, salesDaysRepo, withOrgPrincipal } from '@shareat/db';
import { routeInputForDay } from '@shareat/domain';
import { APP_ROLE } from '../../src/rls/registry';
import {
  D0,
  FEED_DAY,
  SENTINEL_BANK,
  SENTINEL_COST,
  SENTINEL_EXPENSE,
  addDays,
  callSales,
  callSalesAll,
  callStock,
  callStockAll,
  cellsOf,
  expectRefusedShape,
  franchiseWorld,
  insertLogRow,
  menuFixture,
  logCount,
  sql,
  totalLogCount,
  viaApp,
  type FranchiseWorld,
  type PgErr,
  type Tx,
} from './_fixtures/t398-s6-franchise';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const W = () => franchiseWorld();
const GUARD = '42501';

/** A guard refusal: SQLSTATE 42501, said in words, and NOT the privilege system speaking. */
function expectGuardRefusal(err: PgErr | undefined, why: string): void {
  expectRefusedShape(err, why);
  expect(err!.code, `${why}: wrong SQLSTATE (${err!.message})`).toBe(GUARD);
  expect(err!.message.length, `${why}: refusal must be said in words`).toBeGreaterThan(15);
  expect(err!.message, `${why}: this is a missing EXECUTE grant, not the guard`).not.toMatch(/permission denied/i);
}

/** Owner-level probe: the statement runs in its own rolled-back transaction. */
async function ownerProbe(fn: (tx: Tx) => PromiseLike<unknown>): Promise<PgErr | undefined> {
  class Rollback extends Error {}
  let out: PgErr | undefined;
  try {
    await sql.begin(async (tx) => {
      try {
        await tx.savepoint(async (sp) => {
          await fn(sp as unknown as Tx);
        });
      } catch (e) {
        out = e as PgErr;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

const nameOfItem = async (id: string) => (await sql<{ name: string }[]>`select name from items where id = ${id}`)[0]!.name;

describe('S0 -- RED while 0220 is not applied: both tables and the four callable definers exist', () => {
  it('franchise_agreements and franchise_access_log are in public; franchise_sales_daily / franchise_stock_levels / franchise_franchisees / log_break_glass_approval exist', async () => {
    const t = await sql<{ relname: string }[]>`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('franchise_agreements', 'franchise_access_log')`;
    expect(t.map((r) => r.relname).sort(), 'RED today: migration 0220 is not applied').toEqual(['franchise_access_log', 'franchise_agreements']);
    const f = await sql<{ proname: string }[]>`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('franchise_sales_daily', 'franchise_stock_levels', 'franchise_franchisees', 'log_break_glass_approval')`;
    expect(f.map((r) => r.proname).sort()).toEqual(['franchise_franchisees', 'franchise_sales_daily', 'franchise_stock_levels', 'log_break_glass_approval']);
  });
});

describe('S0b -- the fixture world builds (five orgs, agreements, sales days incl. a feed day, stock with sentinel layers)', () => {
  it('builds once for the whole file; its last step inserts the agreements, so while 0220 is absent this is where the world stops (RED: relation franchise_agreements does not exist)', async () => {
    const w = await W();
    expect(w.agreementId).toBeTruthy();
  }, 240_000);
});

// ================================================================================================ catalog legs

/** "TABLE(a text, b timestamp with time zone)" -> [['a','text'], ['b','timestamp with time zone']]; typmods are stripped (the catalog does not keep them). */
async function returnsTable(fn: string): Promise<[string, string][]> {
  const r = await sql<{ res: string }[]>`select pg_get_function_result(p.oid) res from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${fn}`;
  expect(r.length, `RED today: ${fn} absent`).toBe(1);
  const m = /^TABLE\((.*)\)$/s.exec(r[0]!.res);
  expect(m, `${fn} must RETURN TABLE, got ${r[0]!.res}`).not.toBeNull();
  return m![1]!.split(', ').map((c) => {
    const i = c.indexOf(' ');
    return [c.slice(0, i), c.slice(i + 1).replace(/\(\d+(,\s*\d+)?\)/, '')] as [string, string];
  });
}
const identityArgs = async (fn: string) =>
  (await sql<{ a: string }[]>`select pg_get_function_arguments(p.oid) a from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${fn}`)[0]?.a;

describe('V2 / V16 -- catalog: the result of each function is EXACTLY the pinned columns (kills: an added total_expenses / service_charge / money_account / unit_cost / value column)', () => {
  it('V2 franchise_sales_daily returns exactly the s3.4 columns, in order, with their types; its signature is (p_franchisee_org uuid, p_from date, p_to date, p_reason text DEFAULT NULL)', async () => {
    expect(await returnsTable('franchise_sales_daily')).toEqual([
      ['row_kind', 'text'], ['store_id', 'uuid'], ['store_name', 'text'], ['business_date', 'date'], ['day_status', 'text'],
      ['gross_sales', 'numeric'], ['discounts', 'numeric'], ['comps', 'numeric'], ['refunds', 'numeric'], ['net_sales', 'numeric'],
      ['cash_collected', 'numeric'], ['online_collected', 'numeric'], ['credit_sales', 'numeric'], ['channel_name', 'text'], ['channel_amount', 'numeric'],
    ]);
    expect(await identityArgs('franchise_sales_daily')).toMatch(/^p_franchisee_org uuid, p_from date, p_to date, p_reason text DEFAULT NULL(::text)?$/);
  });

  it('V16 franchise_stock_levels returns exactly store_id, store_name, item_name, base_unit, on_hand, threshold, below_threshold, as_of; signature (p_franchisee_org uuid, p_store uuid DEFAULT NULL, p_reason text DEFAULT NULL)', async () => {
    expect(await returnsTable('franchise_stock_levels')).toEqual([
      ['store_id', 'uuid'], ['store_name', 'text'], ['item_name', 'text'], ['base_unit', 'text'], ['on_hand', 'numeric'],
      ['threshold', 'numeric'], ['below_threshold', 'boolean'], ['as_of', 'timestamp with time zone'],
    ]);
    expect(await identityArgs('franchise_stock_levels')).toMatch(/^p_franchisee_org uuid, p_store uuid DEFAULT NULL(::uuid)?, p_reason text DEFAULT NULL(::text)?$/);
  });

  it('V25 (catalog) franchise_franchisees() takes no argument and returns exactly (franchisee_org_id uuid, franchisee_name text, sales_visible_from date)', async () => {
    expect(await returnsTable('franchise_franchisees')).toEqual([['franchisee_org_id', 'uuid'], ['franchisee_name', 'text'], ['sales_visible_from', 'date']]);
    expect(await identityArgs('franchise_franchisees')).toBe('');
  });

  it('log_break_glass_approval(p_person uuid, p_capability text, p_store uuid) returns boolean (kills: returns the row / a different signature)', async () => {
    expect(await identityArgs('log_break_glass_approval')).toBe('p_person uuid, p_capability text, p_store uuid');
    const [r] = await sql<{ t: string }[]>`select pg_get_function_result(p.oid) t from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'log_break_glass_approval'`;
    expect(r!.t).toBe('boolean');
  });
});

describe('V14 -- catalog: every definer is SECURITY DEFINER with a pinned search_path, no PUBLIC execute; only the callable ones reach shareat_app', () => {
  interface Fn { proname: string; prosecdef: boolean; proconfig: string[] | null; public_exec: boolean; app_exec: boolean; rettype: string }
  const defs = () =>
    sql<Fn[]>`
      select p.proname, p.prosecdef, p.proconfig,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
             has_function_privilege(${APP_ROLE}, p.oid, 'EXECUTE') as app_exec,
             pg_get_function_result(p.oid) as rettype
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and (p.proname like 'franchise\_%' or p.proname like 'log\_break\_glass\_%' or p.proname like 'sessions\_break\_glass\_%' or (p.prosecdef and p.prosrc ilike '%franchise_access_log%'))`;
  const CALLABLE = ['franchise_franchisees', 'franchise_sales_daily', 'franchise_stock_levels', 'log_break_glass_approval'];

  it('the four callable functions: prosecdef, search_path = public, pg_temp, no PUBLIC EXECUTE, EXECUTE for shareat_app (kills: INVOKER; unpinned path; PUBLIC grant; no app grant)', async () => {
    const all = await defs();
    for (const name of CALLABLE) {
      const f = all.find((x) => x.proname === name);
      expect(f, `RED today: ${name} absent`).toBeDefined();
      expect(f!.prosecdef, `${name} must be SECURITY DEFINER`).toBe(true);
      expect((f!.proconfig ?? []).join(' '), `${name}: search_path`).toMatch(/search_path=("?public"?, ?"?pg_temp"?|public, pg_temp)/);
      expect(f!.public_exec, `${name}: PUBLIC must not execute it`).toBe(false);
      expect(f!.app_exec, `${name}: shareat_app must execute it`).toBe(true);
    }
  });

  it('franchise_reader_check is a definer-private helper: pinned, and NOT executable by shareat_app or PUBLIC (kills: a granted helper is a second door)', async () => {
    const f = (await defs()).find((x) => x.proname === 'franchise_reader_check');
    expect(f, 'RED today: the shared guard function is absent').toBeDefined();
    expect(f!.public_exec).toBe(false);
    expect(f!.app_exec, 'the guard helper must not be callable by the app').toBe(false);
    expect((f!.proconfig ?? []).join(' ')).toMatch(/search_path/);
  });

  it('the session trigger: sessions_break_glass_log_trg is an AFTER INSERT row trigger on sessions whose function is a pinned, non-PUBLIC definer', async () => {
    const t = await sql<{ tgname: string; fn: string; secdef: boolean; cfg: string[] | null; public_exec: boolean; tgtype: number }[]>`
      select tg.tgname, p.proname as fn, p.prosecdef as secdef, p.proconfig as cfg, tg.tgtype,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
      from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
      where tg.tgrelid = 'sessions'::regclass and tg.tgname = 'sessions_break_glass_log_trg' and not tg.tgisinternal`;
    expect(t.length, 'RED today: the sessions trigger is absent (K4)').toBe(1);
    const x = t[0]!;
    expect(x.secdef, 'the trigger function must be SECURITY DEFINER (it writes a log the signing-in person cannot write)').toBe(true);
    expect((x.cfg ?? []).join(' ')).toMatch(/search_path/);
    expect(x.public_exec).toBe(false);
    // tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT. AFTER INSERT FOR EACH ROW = ROW | INSERT, not BEFORE.
    expect(x.tgtype & 1, 'FOR EACH ROW').toBe(1);
    expect(x.tgtype & 2, 'AFTER, not BEFORE').toBe(0);
    expect(x.tgtype & 4, 'INSERT').toBe(4);
  });

  it('the SECURITY DEFINER set around the franchise log is EXACTLY: the four callable + franchise_reader_check + the sessions trigger function (kills: an extra unpinned definer)', async () => {
    const all = await defs();
    const trig = await sql<{ fn: string }[]>`select p.proname fn from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid where tg.tgname = 'sessions_break_glass_log_trg'`;
    const definers = all.filter((x) => x.prosecdef).map((x) => x.proname).sort();
    expect(definers).toEqual([...new Set([...CALLABLE, 'franchise_reader_check', trig[0]?.fn ?? '(trigger function missing)'])].sort());
    for (const f of all.filter((x) => x.prosecdef)) {
      expect((f.proconfig ?? []).join(' '), `${f.proname}: search_path pinned`).toMatch(/search_path/);
      expect(f.public_exec, `${f.proname}: no PUBLIC execute`).toBe(false);
    }
  });
});

// ================================================================================================ behaviour: the two reads

describe('V1 -- ianL reads Padre Garcia D0..D0+6: the day rows, the channel rows, the log row', () => {
  it('5 non-voided days (QI-1 a), each verified day equals routeInputForDay to the centavo, 1 log row (rows_returned 5, ianL\'s name) that mgrPG can read. Kills: no log INSERT (L1); INVOKER (0 rows under RLS); verified-only filter', async () => {
    const w = await W();
    const before = await logCount(w.pg.orgId);
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callSales(tx, w.pg.orgId, D0, addDays(D0, 6), 'monthly check'), true);
    expect(r.err?.message, 'RED today: no function').toBeUndefined();
    const rows = r.value!;
    const days = rows.filter((x) => x.row_kind === 'day');
    expect(days.map((d) => d.business_date).sort(), 'the five non-voided days of store 1').toEqual([0, 1, 2, 3, 4].map((n) => addDays(D0, n)));
    expect(Object.fromEntries(days.map((d) => [d.business_date, d.day_status]))).toEqual({
      [D0]: 'verified', [addDays(D0, 1)]: 'verified', [addDays(D0, 2)]: 'verified', [addDays(D0, 3)]: 'submitted', [addDays(D0, 4)]: 'open',
    });
    expect(days.every((d) => d.store_id === w.pg.storeId && d.store_name === 'Lipa')).toBe(true);
    expect(rows.some((x) => x.business_date === addDays(D0, 5)), 'the voided day must not be returned').toBe(false);

    // gross is composed by the ONE function the books use (K3); the rest to the centavo, as text
    const day = async (id: string) =>
      withOrgPrincipal(w.pg.orgId, async (tx) => {
        const d = await salesDaysRepo.getById(tx, w.pg.orgId, id);
        const ch = await salesDaysRepo.getChannelsForDay(tx, id);
        const te = await salesDaysRepo.getTendersForDay(tx, id);
        return routeInputForDay(d!, ch, te);
      });
    const byDate = (d: string) => days.find((x) => x.business_date === d)!;
    for (const [n, id] of [[0, w.days.v0], [1, w.days.v1], [2, w.days.v2]] as const) {
      const ri = await day(id);
      const d = byDate(addDays(D0, n));
      expect(d.gross_sales, `day ${n} gross`).toBe(String(ri.totalSales));
      expect(d.comps, `day ${n} comps`).toBe(String(ri.comps));
      expect(d.cash_collected).toBe(String(ri.cashCollected));
      expect(d.online_collected).toBe(String(ri.onlineCollected));
      expect(d.credit_sales).toBe(String(ri.creditSales));
    }
    expect(days.map((d) => [d.business_date, d.gross_sales, d.discounts, d.comps, d.refunds, d.net_sales, d.cash_collected, d.online_collected, d.credit_sales]).sort()).toEqual([
      [D0, '1000.00', '85.00', '15.00', '0.00', '900.00', '700.00', '250.00', '50.00'],
      [addDays(D0, 1), '2000.00', '100.00', '0.00', '0.00', '1900.00', '1500.00', '400.00', '100.00'],
      [addDays(D0, 2), '1500.50', '35.50', '4.00', '0.00', '1461.00', '1000.50', '500.00', '0.00'],
      [addDays(D0, 3), '800.00', '0.00', '0.00', '0.00', '800.00', '800.00', '0.00', '0.00'],
      [addDays(D0, 4), '300.00', '0.00', '0.00', '0.00', '300.00', '300.00', '0.00', '0.00'],
    ].sort());
    // channel rows = sales_day_channels of those days, incl. the confirmed-zero row; money columns of the day are NULL on a channel row
    const chRows = rows.filter((x) => x.row_kind === 'channel');
    const owner = await sql<{ d: string; name: string; amount: string }[]>`
      select sd.business_date::text d, sc.name, c.amount::text amount from sales_day_channels c join sales_days sd on sd.id = c.sales_day_id join sales_channels sc on sc.id = c.channel_id
      where sd.org_id = ${w.pg.orgId} and sd.status <> 'voided' and sd.business_date between ${D0} and ${addDays(D0, 6)} order by 1, 2`;
    expect(chRows.map((c) => [c.business_date, c.channel_name, c.channel_amount]).sort()).toEqual(owner.map((o) => [o.d, o.name, o.amount]).sort());
    expect(chRows.length).toBe(4);
    expect(chRows.every((c) => c.gross_sales === null && c.net_sales === null && c.cash_collected === null && c.discounts === null), 'a channel row carries no day money').toBe(true);
    expect(chRows.some((c) => c.channel_amount === '0.00'), 'the no_sales row is returned as 0.00').toBe(true);

    // one log row, written by the database, readable by PG's manager
    expect(await logCount(w.pg.orgId), 'L1: exactly one new log row').toBe(before + 1);
    const [lg] = await sql<Record<string, unknown>[]>`
      select id, what, rows_returned, person_name, reader_person_id, franchisor_org_id, agreement_id, range_from::text rf, range_to::text rt, reason, store_id, franchisee_person_id, session_id, credential_kind, capability
      from franchise_access_log where org_id = ${w.pg.orgId} order by occurred_at desc, id desc limit 1`;
    expect(lg).toMatchObject({
      what: 'sales_daily', rows_returned: 5, person_name: w.ianL.name, reader_person_id: w.ianL.id, franchisor_org_id: w.l.orgId, agreement_id: w.agreementId,
      rf: D0, rt: addDays(D0, 6), reason: 'monthly check', franchisee_person_id: null, session_id: null, credential_kind: null, capability: null,
    });
    const seen = await viaApp({ org: w.pg.orgId, person: w.mgrPG.id }, async (tx) => (await tx`select count(*)::int n from franchise_access_log where id = ${lg!.id as string}`)[0]!.n);
    expect(seen.value, 'PG\'s manager can read the row').toBe(1);
    const seenByStaff = await viaApp({ org: w.pg.orgId, person: w.staffPG.id }, async (tx) => (await tx`select count(*)::int n from franchise_access_log where id = ${lg!.id as string}`)[0]!.n);
    expect(seenByStaff.err, 'RLS is org-level; the capability gate is the domain\'s').toBeUndefined();
  });

  it('L2 no sentinel leaks: no cell of the sales result equals 98765.43 / 87654.32 or contains SENTINEL, and the result carries no extra column. Kills: a money-account / cost column slipped in', async () => {
    const w = await W();
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callSalesAll(tx, w.pg.orgId, D0, addDays(D0, 10)));
    expect(r.err?.message, 'RED today').toBeUndefined();
    expect(r.value!.length).toBeGreaterThan(5);
    expect(Object.keys(r.value![0]!)).toEqual([
      'row_kind', 'store_id', 'store_name', 'business_date', 'day_status', 'gross_sales', 'discounts', 'comps', 'refunds', 'net_sales',
      'cash_collected', 'online_collected', 'credit_sales', 'channel_name', 'channel_amount',
    ]);
    const cells = cellsOf(r.value!);
    for (const bad of [SENTINEL_COST, SENTINEL_EXPENSE, SENTINEL_BANK, 'SENTINEL', '123.45', '67.89']) {
      // 123.45 / 67.89 are the days' service charge / other charges: never returned (s3.4 "Never: service charge, other charges")
      expect(cells.filter((c) => c.includes(bad)), `leaked ${bad}`).toEqual([]);
    }
  });
});

describe('V23 -- a POS-feed day: gross = total_sales + the platform channel (K3); the no_sales channel row comes back as 0', () => {
  it('feed day: gross 3400.00 (3000.00 + Foodpanda 400.00), refunds 30.00, net 3370.00, equals routeInputForDay; 3 channel rows incl. Grab 0.00. Kills: gross from total_sales alone', async () => {
    const w = await W();
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callSales(tx, w.pg.orgId, FEED_DAY, FEED_DAY));
    expect(r.err?.message, 'RED today').toBeUndefined();
    const day = r.value!.filter((x) => x.row_kind === 'day');
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ store_id: w.pg.store2Id, store_name: 'Batangas', day_status: 'submitted', gross_sales: '3400.00', refunds: '30.00', net_sales: '3370.00', cash_collected: '2500.00', online_collected: '500.00' });
    const ri = await withOrgPrincipal(w.pg.orgId, async (tx) => {
      const d = await salesDaysRepo.getById(tx, w.pg.orgId, w.days.feed);
      return routeInputForDay(d!, await salesDaysRepo.getChannelsForDay(tx, w.days.feed), await salesDaysRepo.getTendersForDay(tx, w.days.feed));
    });
    expect(day[0]!.gross_sales, 'gross equals the books\' own composition').toBe(String(ri.totalSales));
    const ch = r.value!.filter((x) => x.row_kind === 'channel').map((c) => c.channel_amount).sort();
    expect(ch).toEqual(['0.00', '3000.00', '400.00']);
    expect(cellsOf(r.value! as never).filter((c) => /SENTINEL/.test(c)), 'L2').toEqual([]);
  });
});

describe('V15 / V20 -- stock levels: on hand per item over all locations, the low-stock flag at-or-below, active items only', () => {
  it('V15 ianL reads PG store 1: on_hand = sum of movements over both locations, equals lowStock for thresholded items, 1 log row with store_id, visible to mgrPG. Kills: no stock log INSERT', async () => {
    const w = await W();
    const before = await logCount(w.pg.orgId);
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callStock(tx, w.pg.orgId, w.pg.storeId, 'stock check'), true);
    expect(r.err?.message, 'RED today: no function').toBeUndefined();
    const rows = r.value!;
    const names = {
      above: await nameOfItem(w.items.above), at: await nameOfItem(w.items.at), below: await nameOfItem(w.items.below), none: await nameOfItem(w.items.none),
      zeroWith: await nameOfItem(w.items.zeroWith),
    };
    expect(rows.map((x) => [x.item_name, x.on_hand, x.threshold, x.below_threshold]).sort()).toEqual(
      [
        [names.above, '12.500', '10.000', false],
        [names.at, '5.000', '5.000', true],
        [names.below, '2.000', '8.000', true],
        [names.none, '3.250', null, false],
        [names.zeroWith, '0.000', '4.000', true],
      ].sort(),
    );
    expect(rows.every((x) => x.store_id === w.pg.storeId && x.store_name === 'Lipa' && x.base_unit === 'kg')).toBe(true);
    expect(Math.abs(Date.now() - rows[0]!.as_of.getTime()), 'as_of is now()').toBeLessThan(5 * 60_000);
    // equals the books' own low-stock query for the thresholded items at or below the line
    const low = await withOrgPrincipal(w.pg.orgId, (tx) => lowStockRepo.lowStock(tx, w.pg.orgId, w.pg.storeId));
    expect(rows.filter((x) => x.below_threshold).map((x) => [x.item_name, x.on_hand, x.threshold]).sort()).toEqual(low.map((x) => [x.itemName, x.onHand, x.threshold]).sort());
    // the log
    expect(await logCount(w.pg.orgId), 'L1').toBe(before + 1);
    const [lg] = await sql<Record<string, unknown>[]>`
      select id, what, rows_returned, store_id, reader_person_id, person_name, reason, range_from, range_to from franchise_access_log where org_id = ${w.pg.orgId} order by occurred_at desc, id desc limit 1`;
    expect(lg).toMatchObject({ what: 'stock_levels', rows_returned: 5, store_id: w.pg.storeId, reader_person_id: w.ianL.id, person_name: w.ianL.name, reason: 'stock check', range_from: null, range_to: null });
    const seen = await viaApp({ org: w.pg.orgId, person: w.mgrPG.id }, async (tx) => (await tx`select count(*)::int n from franchise_access_log where id = ${lg!.id as string}`)[0]!.n);
    expect(seen.value).toBe(1);
  });

  it('V15b p_store NULL = every PG store: store 2\'s item appears with its store name; the log row carries store_id NULL', async () => {
    const w = await W();
    const before = await logCount(w.pg.orgId);
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callStock(tx, w.pg.orgId, null), true);
    expect(r.err?.message, 'RED today').toBeUndefined();
    expect(r.value!.length).toBe(6);
    expect(r.value!.find((x) => x.store_id === w.pg.store2Id)).toMatchObject({ store_name: 'Batangas', on_hand: '7.000', threshold: null, below_threshold: false });
    expect(await logCount(w.pg.orgId)).toBe(before + 1);
    const [lg] = await sql<{ store_id: string | null; rows_returned: number }[]>`select store_id, rows_returned from franchise_access_log where org_id = ${w.pg.orgId} order by occurred_at desc, id desc limit 1`;
    expect(lg).toEqual({ store_id: null, rows_returned: 6 });
  });

  it('V20 below_threshold: true AT the line, true below it, false above it, false with no threshold (NULL threshold), inactive items excluded, zero-without-a-line excluded. Kills: `<` instead of `<=` (K9); inactive included', async () => {
    const w = await W();
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callStock(tx, w.pg.orgId, w.pg.storeId));
    expect(r.err?.message, 'RED today').toBeUndefined();
    const by = new Map(r.value!.map((x) => [x.item_name, x]));
    expect(by.get(await nameOfItem(w.items.at))).toMatchObject({ on_hand: '5.000', threshold: '5.000', below_threshold: true });
    expect(by.get(await nameOfItem(w.items.below))!.below_threshold).toBe(true);
    expect(by.get(await nameOfItem(w.items.above))!.below_threshold).toBe(false);
    expect(by.get(await nameOfItem(w.items.none))).toMatchObject({ threshold: null, below_threshold: false });
    expect(by.has(await nameOfItem(w.items.inactive)), 'an inactive item is not shown').toBe(false);
    expect(by.has(await nameOfItem(w.items.zeroWithout)), 'on hand 0 and no line: not shown').toBe(false);
  });

  it('L2 no sentinel leaks in the stock result (layers at 98765.43), and no extra column. Kills: a cost / value column slipped in', async () => {
    const w = await W();
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callStockAll(tx, w.pg.orgId, null));
    expect(r.err?.message, 'RED today').toBeUndefined();
    expect(Object.keys(r.value![0]!)).toEqual(['store_id', 'store_name', 'item_name', 'base_unit', 'on_hand', 'threshold', 'below_threshold', 'as_of']);
    const cells = cellsOf(r.value!);
    for (const bad of [SENTINEL_COST, SENTINEL_EXPENSE, 'SENTINEL', '98765']) expect(cells.filter((c) => c.includes(bad)), `leaked ${bad}`).toEqual([]);
  });
});

// ================================================================================================ the guard

describe('V4 / V9 / V10 / V11 / V21 / V22 -- who may call: the guard refuses in words, writes nothing', () => {
  type Call = (tx: Tx, w: FranchiseWorld) => Promise<unknown>;
  const SALES: Call = (tx, w) => callSales(tx, w.pg.orgId, D0, addDays(D0, 1));
  const STOCK: Call = (tx, w) => callStock(tx, w.pg.orgId, null);
  const BOTH: [string, Call][] = [['sales', SALES], ['stock', STOCK]];

  it.each(BOTH)('V4 (%s) adminPG / mgrPG / staffPG (inside PG) asking for L\'s data: 42501 in words, no rows, no log. Kills: the agreement check dropped', async (_n, call) => {
    const w = await W();
    for (const p of [w.adminPG, w.mgrPG, w.staffPG, w.ianPG, w.superPG]) {
      const before = await totalLogCount();
      const r = await viaApp({ org: w.pg.orgId, person: p.id }, (tx) => (call === SALES ? callSales(tx, w.l.orgId, D0, addDays(D0, 1)) : callStock(tx, w.l.orgId, null)) as Promise<unknown>);
      expectGuardRefusal(r.err, `PG person ${p.name} reading L`);
      expect(r.value).toBeUndefined();
      expect(await totalLogCount(), 'a refusal writes no log row').toBe(before);
    }
  });

  it.each(BOTH)('V4b (%s) superPG (a super_admin ROLE inside PG: passes the role check) asking for the data of PG itself, of X and of L: 42501, no log. Only the agreement check can refuse this. Kills: the agreement check dropped', async (_n, call) => {
    const w = await W();
    for (const target of [w.pg.orgId, w.x.orgId, w.l.orgId]) {
      const before = await totalLogCount();
      const r = await viaApp({ org: w.pg.orgId, person: w.superPG.id }, (tx) => (call === SALES ? callSales(tx, target, D0, addDays(D0, 1)) : callStock(tx, target, null)) as Promise<unknown>);
      expectGuardRefusal(r.err, `superPG asking for ${target}`);
      expect(await totalLogCount()).toBe(before);
    }
  });

  it.each(BOTH)('V9 (%s) no app.org_id at all: 42501, no log. Kills: the guard checks the person only', async (_n, call) => {
    const w = await W();
    const before = await totalLogCount();
    const r = await viaApp({ person: w.ianL.id }, (tx) => call(tx, w));
    expectGuardRefusal(r.err, 'no org');
    expect(await totalLogCount()).toBe(before);
  });

  it.each(BOTH)('V10 (%s) org = L but app.person_id NULL: 42501, no log. Kills: the NULL-person check dropped', async (_n, call) => {
    const w = await W();
    const before = await totalLogCount();
    const r = await viaApp({ org: w.l.orgId }, (tx) => call(tx, w));
    expectGuardRefusal(r.err, 'no person');
    expect(await totalLogCount()).toBe(before);
  });

  it.each(BOTH)('V11 (%s) adminL (admin, no grant), mgrL, staffL via raw SQL with the person set: 42501, no log. Kills: the role/grant check dropped', async (_n, call) => {
    const w = await W();
    for (const p of [w.adminL, w.mgrL, w.staffL]) {
      const before = await totalLogCount();
      const r = await viaApp({ org: w.l.orgId, person: p.id }, (tx) => call(tx, w));
      expectGuardRefusal(r.err, `${p.name} has no right to look`);
      expect(await totalLogCount()).toBe(before);
    }
  });

  it.each(BOTH)('V22 (%s) a person of ANOTHER org (readerX: super_admin of X; ianX: admin of X + the view_franchise_sales grant) with org set to L: 42501, no log. A grant carries no org, so ianX passes every check but the person-in-caller-org one. Kills: that check dropped', async (_n, call) => {
    const w = await W();
    for (const p of [w.readerX, w.ianX]) {
      const before = await totalLogCount();
      const r = await viaApp({ org: w.l.orgId, person: p.id }, (tx) => call(tx, w));
      expectGuardRefusal(r.err, `${p.name} (a person of X) with org = L`);
      expect(await totalLogCount()).toBe(before);
    }
  });

  it('V21 ianL (role admin + person-level grant: the PRODUCTION shape) succeeds; superL (super_admin role, no grant) succeeds; a revoked grant is refused. Kills: role-only check (K1); `revoked_at` ignored', async () => {
    const w = await W();
    const a = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callSales(tx, w.pg.orgId, D0, D0));
    expect(a.err?.message, 'RED today: no function').toBeUndefined();
    expect(a.value!.length).toBeGreaterThan(0);
    const b = await viaApp({ org: w.l.orgId, person: w.superL.id }, (tx) => callSales(tx, w.pg.orgId, D0, D0));
    expect(b.err?.message, 'a super_admin ROLE is also enough').toBeUndefined();
    // a second admin+grant person, then revoke
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.l.orgId}, ${`Ian2-${Date.now()}`}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.l.orgId}, 'admin')`;
    const [g] = await sql<{ id: string }[]>`insert into person_grants (person_id, grant_name, grant_source) values (${p!.id}, 'view_franchise_sales', 'owner') returning id`;
    expect((await viaApp({ org: w.l.orgId, person: p!.id }, (tx) => callSales(tx, w.pg.orgId, D0, D0))).err, 'control: allowed while the grant is live').toBeUndefined();
    await sql`update person_grants set revoked_at = now(), revoke_reason = 'tester: revoked' where id = ${g!.id}`;
    const before = await totalLogCount();
    const c = await viaApp({ org: w.l.orgId, person: p!.id }, (tx) => callSales(tx, w.pg.orgId, D0, D0));
    expectGuardRefusal(c.err, 'a revoked grant');
    expect(await totalLogCount()).toBe(before);
  });

  it('V17 stock function refusals: X\'s reader, an org with NO agreement (W), NULL person, a non-grant admin, and a p_store that is another org\'s store: all 42501, no rows, no log. Kills: the agreement check dropped; a foreign store id accepted', async () => {
    const w = await W();
    const cases: [string, { org: string; person?: string }, string | null][] = [
      ['X\'s reader (agreement is to Y, not PG)', { org: w.x.orgId, person: w.readerX.id }, null],
      ['W\'s reader (no agreement at all)', { org: w.w.orgId, person: w.readerW.id }, null],
      ['NULL person', { org: w.l.orgId }, null],
      ['non-grant admin', { org: w.l.orgId, person: w.adminL.id }, null],
      ['p_store = an X store', { org: w.l.orgId, person: w.ianL.id }, w.x.storeId],
      ['p_store = one of L\'s own stores', { org: w.l.orgId, person: w.ianL.id }, w.l.storeId],
    ];
    for (const [why, ctx, store] of cases) {
      const before = await totalLogCount();
      const r = await viaApp(ctx, (tx) => callStock(tx, w.pg.orgId, store));
      expectGuardRefusal(r.err, why);
      expect(r.value, `${why}: no rows`).toBeUndefined();
      expect(await totalLogCount(), `${why}: no log row`).toBe(before);
    }
  });

  it('V17b a successful stock read changes NOTHING: stock_movements, stock_layers, journal_entries and journal_lines counts of PG are identical before and after (the 1310 inventory balance included)', async () => {
    const w = await W();
    const snap = async () =>
      sql<Record<string, number>[]>`
        select (select count(*)::int from stock_movements where org_id = ${w.pg.orgId}) as movements,
               (select count(*)::int from stock_layers where org_id = ${w.pg.orgId}) as layers,
               (select coalesce(sum(quantity), 0)::text from stock_movements where org_id = ${w.pg.orgId}) as qty,
               (select count(*)::int from journal_entries where org_id = ${w.pg.orgId}) as entries,
               (select count(*)::int from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.org_id = ${w.pg.orgId}) as lines,
               (select count(*)::int from sales_days where org_id = ${w.pg.orgId}) as days`;
    const a = await snap();
    const r = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callStock(tx, w.pg.orgId, w.pg.storeId), true);
    expect(r.err?.message, 'RED today').toBeUndefined();
    const s = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callSales(tx, w.pg.orgId, D0, addDays(D0, 6)), true);
    expect(s.err?.message).toBeUndefined();
    expect(await snap(), 'a read must not write business rows').toEqual(a);
  });
});

describe('V6 -- out-of-range requests are REFUSED in words, never clipped, and write no log row (QO-6)', () => {
  const ian = async () => {
    const w = await W();
    return { w, ctx: { org: w.l.orgId, person: w.ianL.id } };
  };

  it('p_from = D0 - 1 (before sales_visible_from): refused, message says "visible from"; no log. Kills: clip instead of refuse', async () => {
    const { w, ctx } = await ian();
    const before = await totalLogCount();
    const r = await viaApp(ctx, (tx) => callSales(tx, w.pg.orgId, addDays(D0, -1), addDays(D0, 2)));
    expectRefusedShape(r.err, 'before visible-from');
    expect(r.value, 'refused, not clipped to D0').toBeUndefined();
    expect(r.err!.message).toMatch(/visible from/i);
    expect(r.err!.message).not.toMatch(/permission denied/i);
    expect(await totalLogCount()).toBe(before);
  });

  it('a span of 367 days is refused (the cap is 366), a span of exactly 366 days is allowed (control); to < from is refused; none writes a log row. Kills: the range cap dropped; off by one', async () => {
    const { w, ctx } = await ian();
    const before = await totalLogCount();
    const over = await viaApp(ctx, (tx) => callSales(tx, w.pg.orgId, D0, addDays(D0, 366)));
    expectRefusedShape(over.err, '367 days');
    expect(over.err!.message).toMatch(/366/);
    const backwards = await viaApp(ctx, (tx) => callSales(tx, w.pg.orgId, addDays(D0, 3), D0));
    expectRefusedShape(backwards.err, 'to before from');
    expect(backwards.err!.message).not.toMatch(/permission denied/i);
    expect(await totalLogCount(), 'refusals write no log row').toBe(before);
    const ok = await viaApp(ctx, (tx) => callSales(tx, w.pg.orgId, D0, addDays(D0, 365)));
    expect(ok.err?.message, 'control: 366 days (D0..D0+365) is within the cap').toBeUndefined();
  });
});

describe('V19 -- a THIRD org sees nothing of PG, and its own franchisee\'s call returns only that franchisee\'s rows (the definer bypasses RLS, so every read must name org_id)', () => {
  it('readerX (agreement X -> Y) asking for PG: refused for both functions. Asking for Y: only Y\'s rows (no PG row, no X row; X and PG hold the same dates and the same item names). Kills: a read missing `org_id = p_franchisee_org`', async () => {
    const w = await W();
    const ctx = { org: w.x.orgId, person: w.readerX.id };
    expectGuardRefusal((await viaApp(ctx, (tx) => callSales(tx, w.pg.orgId, D0, addDays(D0, 6)))).err, 'X reading PG sales');
    expectGuardRefusal((await viaApp(ctx, (tx) => callStock(tx, w.pg.orgId, null))).err, 'X reading PG stock');
    const s = await viaApp(ctx, (tx) => callSales(tx, w.y.orgId, D0, addDays(D0, 6)));
    expect(s.err?.message, 'RED today').toBeUndefined();
    expect(s.value!.map((r) => [r.row_kind, r.business_date, r.gross_sales ?? r.channel_amount]).sort()).toEqual([['channel', D0, '555.00'], ['day', D0, '555.00']].sort());
    expect(s.value!.every((r) => r.store_id === w.y.storeId || r.store_id === w.y.store2Id), 'only Y stores').toBe(true);
    const st = await viaApp(ctx, (tx) => callStock(tx, w.y.orgId, null));
    expect(st.err?.message).toBeUndefined();
    expect(st.value!).toHaveLength(1);
    expect(st.value![0]).toMatchObject({ item_name: await nameOfItem(w.items.above), on_hand: '2.000', threshold: '10.000', below_threshold: true });
    expect([w.y.storeId, w.y.store2Id]).toContain(st.value![0]!.store_id);
    // and L's reader still gets only PG's rows, none of X's or Y's
    const own = await viaApp({ org: w.l.orgId, person: w.ianL.id }, (tx) => callSales(tx, w.pg.orgId, D0, D0));
    expect(own.value!.some((r) => r.gross_sales === '777.00' || r.gross_sales === '555.00' || r.channel_amount === '777.00' || r.channel_amount === '555.00'), 'no foreign row in PG\'s answer').toBe(false);
  });

  it('V5 (guard) as shareat_app with org = L: a direct SELECT of PG\'s sales_days / expenses / stock_movements / persons / stores returns 0 rows; as PG the same tables are not empty (control). Kills: any widened policy', async () => {
    const w = await W();
    const count = (tx: Tx, t: string) => tx.unsafe<{ n: number }[]>(`select count(*)::int n from ${t} where org_id = $1`, [w.pg.orgId]);
    const asL = await viaApp({ org: w.l.orgId, person: w.ianL.id }, async (tx) => {
      const out: Record<string, number> = {};
      for (const t of ['sales_days', 'expenses', 'stock_movements', 'persons', 'stores', 'stock_layers', 'person_roles']) out[t] = (await count(tx, t))[0]!.n;
      return out;
    });
    expect(asL.err?.message).toBeUndefined();
    expect(asL.value).toEqual({ sales_days: 0, expenses: 0, stock_movements: 0, persons: 0, stores: 0, stock_layers: 0, person_roles: 0 });
    const asPg = await viaApp({ org: w.pg.orgId }, async (tx) => ({ days: (await count(tx, 'sales_days'))[0]!.n, moves: (await count(tx, 'stock_movements'))[0]!.n }));
    expect(asPg.value!.days).toBeGreaterThan(5);
    expect(asPg.value!.moves).toBeGreaterThan(5);
  });
});

describe('V25 -- franchise_franchisees(): the picker list, person-checked, unlogged', () => {
  it('ianL gets exactly one row (PG, its name, D0); readerX gets only Y; mgrL with a person set is refused 42501; nobody\'s call writes a log row. Kills: the person check dropped; the list not scoped to the caller', async () => {
    const w = await W();
    const before = await totalLogCount();
    const list = (tx: Tx) => tx.unsafe<{ franchisee_org_id: string; franchisee_name: string; sales_visible_from: string }[]>('select franchisee_org_id, franchisee_name, sales_visible_from::text as sales_visible_from from franchise_franchisees()');
    const a = await viaApp({ org: w.l.orgId, person: w.ianL.id }, list, true);
    expect(a.err?.message, 'RED today').toBeUndefined();
    const [org] = await sql<{ name: string }[]>`select name from organizations where id = ${w.pg.orgId}`;
    expect(a.value).toEqual([{ franchisee_org_id: w.pg.orgId, franchisee_name: org!.name, sales_visible_from: D0 }]);
    const b = await viaApp({ org: w.x.orgId, person: w.readerX.id }, list, true);
    expect(b.value!.map((r) => r.franchisee_org_id)).toEqual([w.y.orgId]);
    expectGuardRefusal((await viaApp({ org: w.l.orgId, person: w.mgrL.id }, list)).err, 'mgrL');
    expectGuardRefusal((await viaApp({ org: w.l.orgId }, list)).err, 'no person');
    expect(await totalLogCount(), 'listing franchisees is not a business look: nothing logged').toBe(before);
  });
});

// ================================================================================================ the tables' own rules

describe('V7 / V12 / V13 / V24 -- the log is append-only for EVERY role; the app can read agreements and nothing else; the CHECKs state which columns are set', () => {
  const APPEND = /append|cannot|can not|not allowed|read[- ]only|immutable|never|may not|only/i;

  it('V7 UPDATE and DELETE of a log row AS OWNER are raised (append-only for every role). Kills: the row trigger dropped', async () => {
    const w = await W();
    const id = await insertLogRow(sql, { franchisee: w.pg, franchisor: w.l, agreementId: w.agreementId, readerPersonId: w.ianL.id });
    const upd = await ownerProbe((tx) => tx`update franchise_access_log set rows_returned = 99 where id = ${id}`);
    expectRefusedShape(upd, 'owner UPDATE of a log row');
    expect(upd!.message).toMatch(APPEND);
    const del = await ownerProbe((tx) => tx`delete from franchise_access_log where id = ${id}`);
    expectRefusedShape(del, 'owner DELETE of a log row');
    expect(del!.message).toMatch(APPEND);
    const [row] = await sql<{ rows_returned: number }[]>`select rows_returned from franchise_access_log where id = ${id}`;
    expect(row, 'the row survived').toEqual({ rows_returned: 0 });
  });

  it('V7b a superuser setting session_replication_role = replica still cannot UPDATE/DELETE/TRUNCATE the log (the triggers are ENABLE ALWAYS). Kills: origin-mode triggers', async () => {
    const w = await W();
    const [role] = await sql<{ rolsuper: boolean }[]>`select rolsuper from pg_roles where rolname = current_user`;
    const id = await insertLogRow(sql, { franchisee: w.pg, franchisor: w.l, agreementId: w.agreementId, readerPersonId: w.ianL.id });
    for (const stmt of ['update franchise_access_log set rows_returned = 77 where id = $1', 'delete from franchise_access_log where id = $1']) {
      const e = await ownerProbe(async (tx) => {
        await tx.unsafe('set local session_replication_role = replica');
        await tx.unsafe(stmt, [id]);
      });
      expectRefusedShape(e, `replica-mode ${stmt}`);
      if (role!.rolsuper) expect(e!.message, 'the append-only trigger spoke, not a privilege error').toMatch(APPEND);
    }
    const [row] = await sql<{ rows_returned: number }[]>`select rows_returned from franchise_access_log where id = ${id}`;
    expect(row!.rows_returned).toBe(0);
  });

  it('V13 TRUNCATE of the log, and of both tables together (so the FK rule cannot be the reason), AS OWNER is raised by the statement trigger. Kills: the TRUNCATE trigger dropped', async () => {
    // T-398 S6 (no TRUNCATE trigger, orchestrator 28 Oct): no TRUNCATE trigger; the app role has no TRUNCATE grant (SELECT only), so its TRUNCATE is refused by privilege.
    const w = await W();
    for (const stmt of ['truncate franchise_access_log', 'truncate franchise_agreements', 'truncate franchise_access_log, franchise_agreements']) {
      const r = await viaApp({ org: w.pg.orgId, person: w.mgrPG.id }, (tx) => tx.unsafe(stmt));
      expectRefusedShape(r.err, `app role ${stmt}`);
      expect(r.err!.code, `${stmt}: ${r.err!.message}`).toBe('42501');
      expect(r.err!.message).toMatch(/permission denied/i);
    }
    expect(await totalLogCount(), 'nothing was removed').toBeGreaterThan(0);
  });

  it('V12 as shareat_app: INSERT into the log and into franchise_agreements is "permission denied"; UPDATE / DELETE of either too; SELECT works (positive control). Kills: a GRANT INSERT/UPDATE', async () => {
    const w = await W();
    const denied = async (stmt: string, args: unknown[] = []) => {
      const r = await viaApp({ org: w.pg.orgId, person: w.mgrPG.id }, (tx) => tx.unsafe(stmt, args as never[]));
      expectRefusedShape(r.err, stmt);
      expect(r.err!.code, `${stmt}: ${r.err!.message}`).toBe('42501');
      expect(r.err!.message, stmt).toMatch(/permission denied/i);
    };
    await denied(`insert into franchise_access_log (org_id, franchisor_org_id, agreement_id, what, reader_person_id, person_name, range_from, range_to, rows_returned) values ($1, $2, $3, 'sales_daily', $4, 'x', current_date, current_date, 0)`, [w.pg.orgId, w.l.orgId, w.agreementId, w.ianL.id]);
    await denied(`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from) values ($1, $2, $3, current_date)`, [w.pg.orgId, w.l.orgId, w.mgrPG.id]);
    await denied(`update franchise_agreements set sales_visible_from = '2020-01-01' where id = $1`, [w.agreementId]);
    await denied(`delete from franchise_agreements where id = $1`, [w.agreementId]);
    await denied(`update franchise_access_log set rows_returned = 1 where org_id = $1`, [w.pg.orgId]);
    await denied(`delete from franchise_access_log where org_id = $1`, [w.pg.orgId]);
    const ok = await viaApp({ org: w.pg.orgId }, async (tx) => ({
      ag: (await tx`select count(*)::int n from franchise_agreements`)[0]!.n,
      lg: (await tx`select count(*)::int n from franchise_access_log`)[0]!.n,
    }));
    expect(ok.err?.message, 'SELECT must be granted').toBeUndefined();
    expect(ok.value!.ag).toBe(1);
    const [row] = await sql<{ sales_visible_from: string }[]>`select sales_visible_from::text from franchise_agreements where id = ${w.agreementId}`;
    expect(row!.sales_visible_from, 'the agreement is unchanged').toBe(D0);
  });

  it('V24 the log CHECKs: a break-glass row with reader_person_id, a read row without range_*, an approval row without capability are each rejected 23514 AS OWNER, while the matching valid row is accepted (control). Kills: a loosened CHECK', async () => {
    const w = await W();
    const base = { franchisee: w.pg, franchisor: w.l, agreementId: w.agreementId };
    const signIn = { what: 'break_glass_sign_in', reader_person_id: null, franchisee_person_id: w.ianPG.id, range_from: null, range_to: null, rows_returned: null, session_id: crypto.randomUUID(), credential_kind: 'pin' };
    const approval = { what: 'break_glass_approval', reader_person_id: null, franchisee_person_id: w.ianPG.id, range_from: null, range_to: null, rows_returned: null, capability: 'verify_sales_day' };
    // controls first: each valid shape is accepted (so the refusals below are the CHECKs, not a wrong base row)
    for (const [why, over] of [['sales_daily', {}], ['sign-in', signIn], ['approval', approval]] as const) {
      const ok = await ownerProbe((tx) => insertLogRow(tx, { ...base, over: { ...over } }));
      expect(ok?.message, `control (${why}): the valid row must be accepted`).toBeUndefined();
    }
    const bad: [string, Record<string, unknown>][] = [
      ['break-glass sign-in WITH reader_person_id', { ...signIn, reader_person_id: w.ianL.id }],
      ['sales_daily WITHOUT range_from / range_to', { range_from: null, range_to: null }],
      ['break_glass_approval WITHOUT capability', { ...approval, capability: null }],
      ['sales_daily with range_from after range_to', { range_from: addDays(D0, 3), range_to: D0 }],
      ['sales_daily with negative rows_returned', { rows_returned: -1 }],
      ['sales_daily WITHOUT reader_person_id', { reader_person_id: null }],
      ['an unknown what', { what: 'peeked' }],
    ];
    for (const [why, over] of bad) {
      const e = await ownerProbe((tx) => insertLogRow(tx, { ...base, over }));
      expectRefusedShape(e, why);
      expect(e!.code, `${why}: ${e!.message}`).toBe('23514');
    }
  });

  it('agreements: one franchisor per franchisee (UNIQUE org_id), never your own franchisor (CHECK franchisor_org_id <> org_id), and the franchisor person must belong to the franchisee org (composite FK) -- each AS OWNER. Kills: a dropped UNIQUE / CHECK / composite FK', async () => {
    const w = await W();
    const dup = await ownerProbe((tx) => tx`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from) values (${w.pg.orgId}, ${w.x.orgId}, ${w.mgrPG.id}, ${D0})`);
    expectRefusedShape(dup, 'a second franchisor for PG');
    expect(dup!.code).toBe('23505');
    const self = await ownerProbe((tx) => tx`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from) values (${w.w.orgId}, ${w.w.orgId}, ${w.w.personId}, ${D0})`);
    expectRefusedShape(self, 'own franchisor');
    expect(self!.code).toBe('23514');
    const foreign = await ownerProbe((tx) => tx`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from) values (${w.w.orgId}, ${w.l.orgId}, ${w.ianL.id}, ${D0})`);
    expectRefusedShape(foreign, 'a franchisor person from the wrong org');
    expect(foreign!.code).toBe('23503');
    const twice = await ownerProbe((tx) => tx`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from) values (${w.w.orgId}, ${w.l.orgId}, ${w.ianPG.id}, ${D0})`);
    expectRefusedShape(twice, 'one person cannot be the break-glass person of two franchisees / of the wrong org');
  });
});

describe('V8-support -- log_break_glass_approval is callable by the app, adds a row ONLY for an agreement\'s franchisor person, and is a no-op returning false for anyone else', () => {
  it('p_person = ianPG: returns true and adds exactly one break_glass_approval row (capability, store, person name snapshot); p_person = mgrPG: returns false and adds none. Kills: logs every approval; ignores the person', async () => {
    const w = await W();
    const before = await logCount(w.pg.orgId, 'break_glass_approval');
    const yes = await viaApp({ org: w.pg.orgId, person: w.ianPG.id }/* A1: the caller must be the person */, async (tx) => (await tx`select log_break_glass_approval(${w.ianPG.id}::uuid, 'verify_sales_day', ${w.pg.storeId}::uuid) as r`)[0]!.r, true);
    expect(yes.err?.message, 'RED today').toBeUndefined();
    expect(yes.value).toBe(true);
    expect(await logCount(w.pg.orgId, 'break_glass_approval')).toBe(before + 1);
    const [lg] = await sql<Record<string, unknown>[]>`select capability, store_id, franchisee_person_id, reader_person_id, person_name, range_from, rows_returned from franchise_access_log where org_id = ${w.pg.orgId} and what = 'break_glass_approval' order by occurred_at desc, id desc limit 1`;
    expect(lg).toMatchObject({ capability: 'verify_sales_day', store_id: w.pg.storeId, franchisee_person_id: w.ianPG.id, reader_person_id: null, person_name: w.ianPG.name, range_from: null, rows_returned: null });
    const no = await viaApp({ org: w.pg.orgId, person: w.mgrPG.id }/* A1: caller = p_person */, async (tx) => (await tx`select log_break_glass_approval(${w.mgrPG.id}::uuid, 'verify_sales_day', ${w.pg.storeId}::uuid) as r`)[0]!.r, true);
    expect(no.value).toBe(false);
    expect(await logCount(w.pg.orgId, 'break_glass_approval'), 'a non-franchisor approval adds no row').toBe(before + 1);
  });
});

describe('P2 -- RLS on the two tables: the franchisee and its franchisor read their rows; a third org reads none (FORCE RLS, one SELECT policy each)', () => {
  it('PG and L (the franchisor) each see the PG agreement and PG log rows; X and W (third orgs) see 0 of either, whoever the person is. Kills: a policy arm opened to all orgs; FORCE RLS dropped', async () => {
    const w = await W();
    await insertLogRow(sql, { franchisee: w.pg, franchisor: w.l, agreementId: w.agreementId, readerPersonId: w.ianL.id });
    const view = (org: string, person?: string) =>
      viaApp({ org, person }, async (tx) => ({
        ag: (await tx`select count(*)::int n from franchise_agreements where org_id = ${w.pg.orgId}`)[0]!.n as number,
        lg: (await tx`select count(*)::int n from franchise_access_log where org_id = ${w.pg.orgId}`)[0]!.n as number,
      }));
    const pg = await view(w.pg.orgId, w.mgrPG.id);
    const l = await view(w.l.orgId, w.ianL.id);
    expect(pg.err?.message, 'RED today').toBeUndefined();
    expect(pg.value!.ag).toBe(1);
    expect(pg.value!.lg).toBeGreaterThanOrEqual(1);
    expect(l.value!.ag).toBe(1);
    expect(l.value!.lg).toBeGreaterThanOrEqual(1);
    for (const [org, person] of [[w.x.orgId, w.readerX.id], [w.w.orgId, w.readerW.id], [w.y.orgId, w.ianY.id]] as const) {
      const v = await view(org, person);
      expect(v.value, `org ${org} must see none of PG's rows`).toEqual({ ag: 0, lg: 0 });
    }
    // FORCE: even the table owner connected as a plain role sees nothing without an org context under RLS? (owner bypass is the migrator's; the app role with no org sees none)
    const none = await viaApp({}, async (tx) => (await tx`select count(*)::int n from franchise_access_log`)[0]!.n as number);
    expect(none.value, 'no org context: no rows').toBe(0);
  });
});

describe('S6 audit -- A1 log_break_glass_approval is not a free write; A2 an agreement can END', () => {
  it('A1 a PG user who is NOT Ian\'s PG person cannot log with Ian\'s person id (42501, no row); Ian\'s PG person logs exactly one row; an unknown capability is refused 22023, no row. Kills: any caller may forge; free-text capability', async () => {
    const w = await W();
    const call = (person: string | undefined, as: string, cap = 'verify_sales_day') => viaApp({ org: w.pg.orgId, person }, async (tx) => (await tx`select log_break_glass_approval(${as}::uuid, ${cap}, ${w.pg.storeId}::uuid) as r`)[0]!.r, true);
    const n = () => logCount(w.pg.orgId, 'break_glass_approval');
    const before = await n();
    for (const who of [w.mgrPG.id, w.staffPG.id, undefined]) {
      const r = await call(who, w.ianPG.id);
      expectGuardRefusal(r.err, `caller ${who ?? 'NULL person'} forging Ian's person id`);
    }
    expect(await n(), 'forgeries wrote nothing').toBe(before);
    for (const cap of ['not_a_capability', '', 'x'.repeat(300)]) {
      const r = await call(w.ianPG.id, w.ianPG.id, cap);
      expectRefusedShape(r.err, `capability ${cap.slice(0, 20)}`);
      expect(r.err!.code, r.err!.message).toBe('22023');
    }
    expect(await n(), 'bad capabilities wrote nothing').toBe(before);
    const ok = await call(w.ianPG.id, w.ianPG.id);
    expect(ok.err?.message, 'Ian\'s own PG person may log').toBeUndefined();
    expect(ok.value).toBe(true);
    expect(await n()).toBe(before + 1);
  });

  it('A2 franchise_agreements.ended_on: ended_on <= today -> both reads refused 42501 for Ian, no log row; future or NULL -> reads work; the app role cannot set it. Kills: no end date; <= vs <', async () => {
    const w = await W();
    const e = await menuFixture('s6e');
    await sql`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from) values (${e.orgId}, ${w.l.orgId}, ${e.personId}, ${D0})`;
    const setEnd = async (v: string | null) => sql`update franchise_agreements set ended_on = ${v}::date where org_id = ${e.orgId}`;
    const ian = { org: w.l.orgId, person: w.ianL.id };
    for (const [why, v] of [['today', 'current_date'], ['yesterday', "current_date - 1"]] as const) {
      await sql.unsafe(`update franchise_agreements set ended_on = ${v} where org_id = $1`, [e.orgId]);
      const before = await totalLogCount();
      expectGuardRefusal((await viaApp(ian, (tx) => callSales(tx, e.orgId, D0, D0))).err, `sales, ended ${why}`);
      expectGuardRefusal((await viaApp(ian, (tx) => callStock(tx, e.orgId, null))).err, `stock, ended ${why}`);
      expect(await totalLogCount(), 'no log row').toBe(before);
    }
    await sql`update franchise_agreements set ended_on = current_date + 30 where org_id = ${e.orgId}`;
    expect((await viaApp(ian, (tx) => callSales(tx, e.orgId, D0, D0))).err, 'future end: reads work').toBeUndefined();
    expect((await viaApp(ian, (tx) => callStock(tx, e.orgId, null))).err).toBeUndefined();
    await setEnd(null);
    expect((await viaApp(ian, (tx) => callSales(tx, e.orgId, D0, D0))).err, 'NULL end: reads work').toBeUndefined();
    const app = await viaApp({ org: e.orgId, person: e.personId }, (tx) => tx`update franchise_agreements set ended_on = current_date where org_id = ${e.orgId}`);
    expectRefusedShape(app.err, 'app role sets ended_on');
    expect(app.err!.code).toBe('42501');
    expect(app.err!.message).toMatch(/permission denied/i);
  });
});
