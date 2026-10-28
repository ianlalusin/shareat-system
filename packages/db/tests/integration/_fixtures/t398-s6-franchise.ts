/**
 * T-398 S6 shared fixture (TESTER). Raw SQL as the connection owner, so the DATABASE is what is proven (migration 0220).
 * docs/tasks/398-s6/{S6-REFRESH s3,TESTS "Fixture (S6b)"}.md. Reuses the S5 two-org helper (menuFixture / asApp from t401-menu).
 *
 * ASSUMED NAMES the builder must match (S6-REFRESH s3, also listed in the hand-back):
 *   franchise_agreements  (id, org_id, franchisor_org_id, franchisor_person_id, sales_visible_from, created_at)
 *   franchise_access_log  (id, org_id, franchisor_org_id, agreement_id, what, reader_person_id, franchisee_person_id, person_name,
 *                          range_from, range_to, store_id, session_id, credential_kind, capability, rows_returned, reason, occurred_at)
 *   franchise_sales_daily(p_franchisee_org, p_from, p_to, p_reason) / franchise_stock_levels(p_franchisee_org, p_store, p_reason) /
 *   franchise_franchisees() / log_break_glass_approval(p_person, p_capability, p_store)
 *
 * The world (one per test file; every org is new, so a re-run on the same DB never collides):
 *   L   Ian's company. ianL = role admin + person-level grant view_franchise_sales (the PRODUCTION shape, K1); superL = role super_admin
 *       (no grant); adminL / mgrL / staffL = no grant.
 *   PG  the franchisee. ianPG = the agreement's franchisor_person_id (a person INSIDE PG); mgrPG / adminPG / staffPG. Two stores; store 1 has
 *       two locations. Sales days D0..D0+5 on store 1 (3 verified, 1 submitted, 1 open, 1 voided), a FEED day with a platform channel on
 *       store 2 at D0+10 (K3). Stock with layers whose unit_cost is the SENTINEL, a money account named SENTINEL-BANK with a tender.
 *   X   a third org with its own agreement X -> Y; readerX = role super_admin in X. X and Y hold sales days on the same dates and stock items
 *       with the SAME NAMES as PG, with different figures, so a read missing `org_id = p_franchisee_org` shows up as foreign rows.
 *   W   an org with a super_admin reader and NO agreement at all.
 * Agreement L -> PG has sales_visible_from = D0.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import { APP_ROLE } from '../../../src/rls/registry';
import { menuFixture, newLocation, sql, uid, type MenuFx, type PgErr } from './t401-menu';

export { sql, uid, menuFixture, type MenuFx, type PgErr };

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export const SENTINEL_COST = '98765.43';
export const SENTINEL_EXPENSE = '87654.32';
export const SENTINEL_BANK = 'SENTINEL-BANK';

/** ISO date + n days (UTC arithmetic on a date string; no timezone involved). */
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const D0 = '2026-11-02';
export const FEED_DAY = addDays(D0, 10);

/** Items need a code of the items_code_shape_check form. */
const itemCode = () => `${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'A')}-${String(1 + Math.floor(Math.random() * 998)).padStart(3, '0')}`;

export interface Person {
  id: string;
  name: string;
}
export interface FranchiseWorld {
  l: MenuFx;
  pg: MenuFx;
  x: MenuFx;
  y: MenuFx;
  w: MenuFx;
  ianL: Person;
  superL: Person;
  adminL: Person;
  mgrL: Person;
  staffL: Person;
  ianPG: Person;
  mgrPG: Person;
  adminPG: Person;
  staffPG: Person;
  /** A super_admin ROLE inside PG: passes the role check, so only the agreement check can stop PG from reading L (or itself). */
  superPG: Person;
  readerX: Person;
  /** A person of X holding the SAME shape as Ian (admin role + person-level view_franchise_sales grant). Grants carry no org, so only the person-in-caller-org check stops this person using org = L. */
  ianX: Person;
  ianY: Person;
  readerW: Person;
  agreementId: string;
  agreementXId: string;
  /** PG stock items (store 1): above / at / below the line, no threshold, inactive, zero-with-threshold, zero-without. */
  items: { above: string; at: string; below: string; none: string; inactive: string; zeroWith: string; zeroWithout: string; store2: string };
  /** PG sales days by label. */
  days: { v0: string; v1: string; v2: string; submitted: string; open: string; voided: string; feed: string };
  channels: { walkIn: string; foodpanda: string; feedPos: string; feedPlatform: string; feedNoSales: string };
  pgLocations: [string, string];
}

async function person(orgId: string, name: string, role: 'super_admin' | 'admin' | 'manager' | 'staff' | null, grants: string[] = []): Promise<Person> {
  const dn = uid(name);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${dn}) returning id`;
  if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const g of grants) await sql`insert into person_grants (person_id, grant_name, grant_source) values (${p!.id}, ${g}, 'owner')`;
  return { id: p!.id, name: dn };
}

async function newItem(orgId: string, personId: string, name: string, status: 'active' | 'inactive' = 'active'): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, status, created_by) values (${orgId}, ${itemCode()}, ${name}, 'raw_material', 'kg', ${status}, ${personId}) returning id`;
  return r!.id;
}

/** A receipt (qty > 0) or a usage (qty < 0) movement; a receipt also gets a layer at `unitCost`. */
async function move(orgId: string, storeId: string, locationId: string, itemId: string, qty: string, personId: string, unitCost?: string): Promise<void> {
  const positive = !qty.startsWith('-');
  const [m] = await sql<{ id: string }[]>`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${orgId}, ${storeId}, ${locationId}, ${itemId}, now(), ${qty}, ${positive ? 'receipt' : 'usage'}, 't398-s6-test', ${randomUUID()}, ${personId}) returning id`;
  if (positive && unitCost) {
    await sql`
      insert into stock_layers (org_id, store_id, item_id, received_at, quantity, unit_cost, remaining_quantity, source, source_id, movement_id)
      values (${orgId}, ${storeId}, ${itemId}, now(), ${qty}, ${unitCost}, ${qty}, 'opening', ${randomUUID()}, ${m!.id})`;
  }
}

async function threshold(orgId: string, storeId: string, itemId: string, value: string, personId: string): Promise<void> {
  await sql`insert into store_item_thresholds (org_id, store_id, item_id, low_stock_threshold, set_by) values (${orgId}, ${storeId}, ${itemId}, ${value}, ${personId})`;
}

interface DayFigures {
  total: string;
  unli: string;
  ala: string;
  senior?: string;
  pwd?: string;
  other?: string;
  comps?: string;
  refunds?: string;
  cash: string;
  online: string;
  credit?: string;
}
async function salesChannel(orgId: string, storeId: string, name: string, remitted: boolean): Promise<string> {
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
    values (${orgId}, ${storeId}, ${uid(name)}, ${remitted}, ${remitted ? null : '1220'}) returning id`;
  return c!.id;
}
async function typedDay(orgId: string, storeId: string, date: string, status: 'open' | 'submitted' | 'verified' | 'voided', f: DayFigures, by: string): Promise<string> {
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, senior_discount, pwd_discount, other_discount, comps,
                            service_charge, other_charges, cash_collected, online_collected, credit_sales, created_by,
                            submitted_by, submitted_at, verified_by, verified_at, voided_by, voided_at, void_reason)
    values (${orgId}, ${storeId}, ${date}, ${status}, ${f.total}, ${f.unli}, ${f.ala}, ${f.senior ?? '0'}, ${f.pwd ?? '0'}, ${f.other ?? '0'}, ${f.comps ?? '0'},
            '123.45', '67.89', ${f.cash}, ${f.online}, ${f.credit ?? '0'}, ${by},
            ${status === 'open' ? null : by}, ${status === 'open' ? null : sql`now()`},
            ${status === 'verified' ? by : null}, ${status === 'verified' ? sql`now()` : null},
            ${status === 'voided' ? by : null}, ${status === 'voided' ? sql`now()` : null}, ${status === 'voided' ? 'entered twice' : null})
    returning id`;
  return d!.id;
}
const chanRow = (dayId: string, channelId: string, amount: string, noSales = false) =>
  sql`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${dayId}, ${channelId}, ${amount}, ${noSales})`;

let worldP: Promise<FranchiseWorld> | undefined;
export const franchiseWorld = (): Promise<FranchiseWorld> => (worldP ??= build());

async function build(): Promise<FranchiseWorld> {
  const l = await menuFixture('s6l');
  const pg = await menuFixture('s6pg');
  const x = await menuFixture('s6x');
  const y = await menuFixture('s6y');
  const w = await menuFixture('s6w');

  const ianL = await person(l.orgId, 'IanL', 'admin', ['view_franchise_sales']);
  const superL = await person(l.orgId, 'SuperL', 'super_admin');
  const adminL = await person(l.orgId, 'AdminL', 'admin');
  const mgrL = await person(l.orgId, 'MgrL', 'manager');
  const staffL = await person(l.orgId, 'StaffL', 'staff');
  const ianPG = await person(pg.orgId, 'IanInPG', 'admin');
  const mgrPG = await person(pg.orgId, 'MgrPG', 'manager');
  const adminPG = await person(pg.orgId, 'AdminPG', 'admin');
  const staffPG = await person(pg.orgId, 'StaffPG', 'staff');
  const superPG = await person(pg.orgId, 'SuperPG', 'super_admin');
  const readerX = await person(x.orgId, 'ReaderX', 'super_admin');
  const ianX = await person(x.orgId, 'IanInX', 'admin', ['view_franchise_sales']);
  const ianY = await person(y.orgId, 'IanInY', 'admin');
  const readerW = await person(w.orgId, 'ReaderW', 'super_admin');

  // --- PG sales: typed days on store 1 (unlinked), three channels ---
  const walkIn = await salesChannel(pg.orgId, pg.storeId, 'Walk-in', true);
  const foodpanda = await salesChannel(pg.orgId, pg.storeId, 'Foodpanda', false);
  const by = mgrPG.id;
  const v0 = await typedDay(pg.orgId, pg.storeId, D0, 'verified', { total: '1000.00', unli: '600.00', ala: '400.00', senior: '50.00', pwd: '25.00', other: '10.00', comps: '15.00', cash: '700.00', online: '250.00', credit: '50.00' }, by);
  const v1 = await typedDay(pg.orgId, pg.storeId, addDays(D0, 1), 'verified', { total: '2000.00', unli: '1200.00', ala: '800.00', other: '100.00', cash: '1500.00', online: '400.00', credit: '100.00' }, by);
  const v2 = await typedDay(pg.orgId, pg.storeId, addDays(D0, 2), 'verified', { total: '1500.50', unli: '900.25', ala: '600.25', senior: '20.05', pwd: '10.00', other: '5.45', comps: '4.00', cash: '1000.50', online: '500.00' }, by);
  const submitted = await typedDay(pg.orgId, pg.storeId, addDays(D0, 3), 'submitted', { total: '800.00', unli: '500.00', ala: '300.00', cash: '800.00', online: '0' }, by);
  const open = await typedDay(pg.orgId, pg.storeId, addDays(D0, 4), 'open', { total: '300.00', unli: '200.00', ala: '100.00', cash: '300.00', online: '0' }, by);
  const voided = await typedDay(pg.orgId, pg.storeId, addDays(D0, 5), 'voided', { total: '9999.00', unli: '9999.00', ala: '0', cash: '9999.00', online: '0' }, by);
  await chanRow(v0, walkIn, '800.00');
  await chanRow(v0, foodpanda, '200.00');
  await chanRow(v1, walkIn, '2000.00');
  await chanRow(v1, foodpanda, '0.00', true); // a confirmed-zero channel row
  // the money-account name is PG's banking: a tender on d0 must never surface (QO-2)
  const [ma] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${pg.orgId}, ${pg.storeId}, ${SENTINEL_BANK}, 'bank', '1120', 'office') returning id`;
  await sql`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${v0}, ${ma!.id}, '250.00')`;

  // --- PG store 2: a FEED day (K3) with a platform channel, linked store so the derivation flag is honoured ---
  const feedPos = await salesChannel(pg.orgId, pg.store2Id, 'POS walk-in', true);
  const feedPlatform = await salesChannel(pg.orgId, pg.store2Id, 'Foodpanda', false);
  const feedNoSales = await salesChannel(pg.orgId, pg.store2Id, 'Grab', false);
  await sql`
    insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${pg.orgId}, ${pg.store2Id}, ${uid('pos-s6')}, 'Batangas POS', ${feedPos}, 'vat_inclusive', ${mgrPG.id})`;
  const [feedRow] = await sql<{ id: string }[]>`
    insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_by)
    values (${pg.orgId}, ${pg.store2Id}, ${FEED_DAY}, 'sales', 'import', ${randomUUID()}, 'pos-x', '{}', '{}'::jsonb, ${'a'.repeat(64)}, ${mgrPG.id}) returning id`;
  const feed = await sql.begin(async (tx) => {
    await tx`select set_config('app.principal_kind', 'staff', true)`;
    await tx`select set_config('app.org_id', ${pg.orgId}, true)`;
    await tx`select set_config('app.sales_day_derivation', 'on', true)`;
    const [d] = await tx<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, status, source, pos_v1_day_feed_id, pos_sourced, pos_sourced_at, refunds, total_sales, unli_sales, ala_carte_sales,
                              cash_collected, online_collected, created_by, submitted_by, submitted_at)
      values (${pg.orgId}, ${pg.store2Id}, ${FEED_DAY}, 'submitted', 'pos_v1_day_feed', ${feedRow!.id}, true, now(), '30.00', '3000.00', '1800.00', '1200.00', '2500.00', '500.00',
              ${mgrPG.id}, ${mgrPG.id}, now()) returning id`;
    await tx`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${d!.id}, ${feedPos}, '3000.00', false)`;
    await tx`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${d!.id}, ${feedPlatform}, '400.00', false)`;
    await tx`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${d!.id}, ${feedNoSales}, '0.00', true)`;
    return d!.id;
  });

  // --- PG stock, store 1 (two locations) and store 2 ---
  await sql`update stores set stock_model = 'multi_room' where id = ${pg.storeId}`; // store 1 holds two locations
  const loc1 = await newLocation({ orgId: pg.orgId, personId: pg.personId }, pg.storeId);
  const loc2 = await newLocation({ orgId: pg.orgId, personId: pg.personId }, pg.storeId);
  const locS2 = await newLocation({ orgId: pg.orgId, personId: pg.personId }, pg.store2Id);
  const nameOf = async (id: string) => (await sql<{ name: string }[]>`select name from items where id = ${id}`)[0]!.name;
  const above = pg.stockItemId; // menuFixture's Pork
  const at = await newItem(pg.orgId, pg.personId, uid('AtLine'));
  const below = await newItem(pg.orgId, pg.personId, uid('BelowLine'));
  const none = await newItem(pg.orgId, pg.personId, uid('NoLine'));
  const inactive = await newItem(pg.orgId, pg.personId, uid('Retired'), 'inactive');
  const zeroWith = await newItem(pg.orgId, pg.personId, uid('ZeroWith'));
  const zeroWithout = await newItem(pg.orgId, pg.personId, uid('ZeroWithout'));
  const store2 = await newItem(pg.orgId, pg.personId, uid('OtherStore'));
  const p = pg.personId;
  await move(pg.orgId, pg.storeId, loc1, above, '10.000', p, SENTINEL_COST);
  await move(pg.orgId, pg.storeId, loc2, above, '4.500', p, SENTINEL_COST);
  await move(pg.orgId, pg.storeId, loc1, above, '-2.000', p); // on hand 12.500, line 10.000
  await move(pg.orgId, pg.storeId, loc1, at, '5.000', p, SENTINEL_COST); // on hand 5.000, line 5.000
  await move(pg.orgId, pg.storeId, loc1, below, '2.000', p, SENTINEL_COST); // on hand 2.000, line 8.000
  await move(pg.orgId, pg.storeId, loc1, none, '3.250', p, SENTINEL_COST); // no line
  await move(pg.orgId, pg.storeId, loc1, inactive, '1.000', p, SENTINEL_COST);
  await move(pg.orgId, pg.storeId, loc1, zeroWith, '3.000', p, SENTINEL_COST);
  await move(pg.orgId, pg.storeId, loc1, zeroWith, '-3.000', p); // 0, line 4.000
  await move(pg.orgId, pg.storeId, loc1, zeroWithout, '1.000', p, SENTINEL_COST);
  await move(pg.orgId, pg.storeId, loc1, zeroWithout, '-1.000', p); // 0, no line
  await move(pg.orgId, pg.store2Id, locS2, store2, '7.000', p, SENTINEL_COST);
  await threshold(pg.orgId, pg.storeId, above, '10.000', p);
  await threshold(pg.orgId, pg.storeId, at, '5.000', p);
  await threshold(pg.orgId, pg.storeId, below, '8.000', p);
  await threshold(pg.orgId, pg.storeId, inactive, '5.000', p);
  await threshold(pg.orgId, pg.storeId, zeroWith, '4.000', p);

  // --- X and Y: SAME dates and item NAMES as PG, different figures ---
  for (const [org, tag, total, qty] of [[x, 'X', '777.00', '1.000'], [y, 'Y', '555.00', '2.000']] as const) {
    const ch = await salesChannel(org.orgId, org.storeId, 'Walk-in', true);
    const d = await typedDay(org.orgId, org.storeId, D0, 'verified', { total, unli: total, ala: '0', cash: total, online: '0' }, org.personId);
    await chanRow(d, ch, total);
    const loc = await newLocation({ orgId: org.orgId, personId: org.personId }, org.storeId);
    const twin = await newItem(org.orgId, org.personId, await nameOf(above)); // identical name to PG's Pork
    await move(org.orgId, org.storeId, loc, twin, qty, org.personId, SENTINEL_COST);
    await threshold(org.orgId, org.storeId, twin, '10.000', org.personId);
    void tag;
  }

  // --- the agreements (the app has SELECT only; S7 writes them as the owner). LAST, so the data above is exercised even while 0220 is absent ---
  const [ag] = await sql<{ id: string }[]>`
    insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from)
    values (${pg.orgId}, ${l.orgId}, ${ianPG.id}, ${D0}) returning id`;
  const [agx] = await sql<{ id: string }[]>`
    insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from)
    values (${y.orgId}, ${x.orgId}, ${ianY.id}, ${D0}) returning id`;

  return {
    l, pg, x, y, w, ianL, superL, adminL, mgrL, staffL, ianPG, mgrPG, adminPG, staffPG, superPG, readerX, ianX, ianY, readerW,
    agreementId: ag!.id, agreementXId: agx!.id,
    items: { above, at, below, none, inactive, zeroWith, zeroWithout, store2 },
    days: { v0, v1, v2, submitted, open, voided, feed },
    channels: { walkIn, foodpanda, feedPos, feedPlatform, feedNoSales },
    pgLocations: [loc1, loc2],
  };
}

// ------------------------------------------------------------------------------------------------ running as the app

export interface AppCtx {
  /** app.org_id; omit for "no org". */
  org?: string;
  /** app.person_id; omit for "no person". */
  person?: string;
}
class Rollback extends Error {}

/**
 * Run fn as shareat_app. `commit: false` (default) always rolls back; `commit: true` commits on success (a refusal aborts the transaction, so nothing
 * of a refused call can persist either way). Resolves with the value or the error the statement raised.
 */
export async function viaApp<T>(ctx: AppCtx, fn: (tx: Tx) => Promise<T>, commit = false): Promise<{ value?: T; err?: PgErr }> {
  const out: { value?: T; err?: PgErr } = {};
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${APP_ROLE}`);
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      if (ctx.org) await tx`select set_config('app.org_id', ${ctx.org}, true)`;
      if (ctx.person) await tx`select set_config('app.person_id', ${ctx.person}, true)`;
      try {
        out.value = (await tx.savepoint(async (sp) => fn(sp as unknown as Tx))) as T;
      } catch (e) {
        out.err = e as PgErr;
        throw new Rollback();
      }
      if (!commit) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

/** The rows a franchise_sales_daily call returns, columns spelled out (dates as text). */
export const SALES_COLS = 'row_kind, store_id, store_name, business_date::text as business_date, day_status, gross_sales, discounts, comps, refunds, net_sales, cash_collected, online_collected, credit_sales, channel_name, channel_amount';
export type SalesRow = {
  row_kind: string; store_id: string; store_name: string; business_date: string; day_status: string;
  gross_sales: string | null; discounts: string | null; comps: string | null; refunds: string | null; net_sales: string | null;
  cash_collected: string | null; online_collected: string | null; credit_sales: string | null; channel_name: string | null; channel_amount: string | null;
};
export const STOCK_COLS = 'store_id, store_name, item_name, base_unit, on_hand, threshold, below_threshold, as_of';
export type StockRow = { store_id: string; store_name: string; item_name: string; base_unit: string; on_hand: string; threshold: string | null; below_threshold: boolean; as_of: Date };

export const callSales = (tx: Tx, org: string, from: string, to: string, reason: string | null = null) =>
  tx.unsafe<SalesRow[]>(`select ${SALES_COLS} from franchise_sales_daily($1::uuid, $2::date, $3::date, $4::text)`, [org, from, to, reason]);
/** `select *`: exposes every column the function returns (the sentinel scans use this, so an extra column cannot hide). */
export const callSalesAll = (tx: Tx, org: string, from: string, to: string) =>
  tx.unsafe<Record<string, unknown>[]>(`select * from franchise_sales_daily($1::uuid, $2::date, $3::date, null)`, [org, from, to]);
export const callStock = (tx: Tx, org: string, store: string | null = null, reason: string | null = null) =>
  tx.unsafe<StockRow[]>(`select ${STOCK_COLS} from franchise_stock_levels($1::uuid, $2::uuid, $3::text)`, [org, store, reason]);
export const callStockAll = (tx: Tx, org: string, store: string | null = null) =>
  tx.unsafe<Record<string, unknown>[]>(`select * from franchise_stock_levels($1::uuid, $2::uuid, null)`, [org, store]);

// ------------------------------------------------------------------------------------------------ owner-side reads

/** Count log rows as OWNER (a missing row cannot hide behind RLS). */
export const logCount = async (org: string, what?: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int n from franchise_access_log where org_id = ${org} and (${what ?? null}::text is null or what = ${what ?? null})`)[0]!.n;
export const logRowsSince = (org: string, afterCount: number) =>
  sql<Record<string, unknown>[]>`select * from franchise_access_log where org_id = ${org} order by occurred_at, id offset ${afterCount}`;
export const totalLogCount = async (): Promise<number> => (await sql<{ n: number }[]>`select count(*)::int n from franchise_access_log`)[0]!.n;

/** Every cell of every row, flattened to text, for the sentinel scan (L2). */
export function cellsOf(rows: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const r of rows) for (const [k, v] of Object.entries(r)) out.push(`${k}=${v instanceof Date ? v.toISOString() : String(v)}`);
  return out;
}

/** SQLSTATE codes that mean "the object does not exist" - never accepted as a refusal. */
export const BROKEN = ['42P01', '42703', '42883', '42704'];
export function expectRefusedShape(err: PgErr | undefined, why: string): void {
  if (!err) throw new Error(`${why}: the call was ACCEPTED`);
  if (BROKEN.includes(err.code ?? '')) throw new Error(`${why}: raised ${err.code} ${err.message} - the object is missing, that is not a refusal`);
}

/** One valid log row, inserted as OWNER (so tests of the log's own rules do not depend on the definers). */
export async function insertLogRow(q: Sql | Tx, f: { franchisee: MenuFx; franchisor: MenuFx; agreementId?: string; readerPersonId?: string; what?: string; over?: Record<string, unknown> }): Promise<string> {
  const s = q as unknown as Sql;
  const agreementId =
    f.agreementId ?? (await s<{ id: string }[]>`select id from franchise_agreements where org_id = ${f.franchisee.orgId} and franchisor_org_id = ${f.franchisor.orgId}`)[0]!.id;
  const row: Record<string, unknown> = {
    org_id: f.franchisee.orgId,
    franchisor_org_id: f.franchisor.orgId,
    agreement_id: agreementId,
    what: f.what ?? 'sales_daily',
    reader_person_id: f.readerPersonId ?? f.franchisor.personId,
    person_name: 'Test Reader',
    range_from: D0,
    range_to: D0,
    rows_returned: 0,
    ...(f.over ?? {}),
  };
  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const [r] = await s.unsafe<{ id: string }[]>(`insert into franchise_access_log (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals as never[]);
  return r!.id;
}

/**
 * S5 X1 widening: an agreement franchisor -> franchisee (the franchisee's own person is the in-PG "Ian") and one sales_daily log row, as owner.
 * Idempotent per pair.
 */
export async function seedFranchiseAgreementAndLog(q: Sql, f: { franchisee: MenuFx; franchisor: MenuFx }): Promise<void> {
  const have = await q<{ id: string }[]>`select id from franchise_agreements where org_id = ${f.franchisee.orgId}`;
  const agreementId =
    have[0]?.id ??
    (
      await q<{ id: string }[]>`
        insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from)
        values (${f.franchisee.orgId}, ${f.franchisor.orgId}, ${f.franchisee.personId}, ${D0}) returning id`
    )[0]!.id;
  await insertLogRow(q, { franchisee: f.franchisee, franchisor: f.franchisor, agreementId });
}
