import { testItemCode } from '../../packages/domain/tests/integration/_fixtures/item-code';
import { sql as dsql } from 'drizzle-orm';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../packages/db/seed/chart-of-accounts';
import { asOrg, attestC3P as attestC3Ps3, domain, errorOf, need, settle3900 as settle3900s3, sql, uid } from './t390-s3-common';
import { realPurge } from './t390-real-purge';

/**
 * T-390 S2 - shared fixture for the opening-stock tests. `docs/tasks/390-opening-stock-and-subledger-tieout.md` s8 fixtures.
 * TESTER-owned. Builds on the S3 helpers (`t390-s3-common.ts`) but reaches C2 through the REAL `applyPurge` (R8), not a hand-inserted
 * row, which is exactly the deviation the S3 fixture documents and S2 closes.
 */
export { asOrg, errorOf, sql, uid, domain, need };

type S3Fixture = Parameters<typeof settle3900s3>[0];
/** The S3 helpers read only `orgId` and `admin`, which this fixture has. */
export const settle3900 = (f: S2Fixture) => settle3900s3(f as unknown as S3Fixture);
export const attestC3P = (f: S2Fixture) => attestC3Ps3(f as unknown as S3Fixture);

export type C2Mode = 'real' | 'none' | 'attested';

export interface S2Fixture {
  orgId: string;
  storeA: string;
  storeB: string;
  nameA: string;
  nameB: string;
  /** Store A: Kitchen (default), Freezer, Dry. Store B: Bar (default, its only room). */
  kitA: string;
  frzA: string;
  dryA: string;
  barB: string;
  admin: Actor;
  adminId: string;
  staff: Actor;
  /** raw_material, supply, retail, raw_material (the 0.005 item). */
  raw: string;
  sup: string;
  ret: string;
  pinch: string;
  names: Record<string, string>;
}

/**
 * One org, two stores, rooms, four items. `c2`: 'real' runs the real purge AFTER the org exists (so the org gets its C2 row), 'none'
 * leaves it un-purged, 'attested' inserts an `attested` C2 row by hand (which R8 must NOT accept).
 */
export async function s2fixture(hint: string, c2: C2Mode = 'real'): Promise<S2Fixture> {
  // A real purge costs seconds (it truncates ~100 tables), so 'real' fixtures come from a pool built BEFORE one purge (primePool).
  if (c2 === 'real') {
    const pooled = pool.shift();
    if (pooled) return pooled;
  }
  const code = uid(`t390s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('S')}, ${name}, 'multi_room') returning id`;
    return s!.id;
  };
  const nameA = `Lipa ${uid('a')}`;
  const nameB = `Malvar ${uid('b')}`;
  const storeA = await mkStore(nameA);
  const storeB = await mkStore(nameB);

  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [storeA, storeB]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const staffId = await mkPerson('Staff', 'staff');

  const [lt] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, roomCode: string, isDefault: boolean) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, status, created_by)
      values (${orgId}, ${storeId}, ${roomCode}, ${roomCode}, ${lt!.id}, 'operating', ${isDefault}, 'active', ${adminId}) returning id`;
    return r!.id;
  };
  const kitA = await mkRoom(storeA, 'KIT', true);
  const frzA = await mkRoom(storeA, 'FRZ', false);
  const dryA = await mkRoom(storeA, 'DRY', false);
  const barB = await mkRoom(storeB, 'BAR', true);

  const names: Record<string, string> = {};
  const mkItem = async (key: string, label: string, kind: string, unit: string) => {
    const nm = `${label} ${uid('n')}`;
    const [i] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${testItemCode()}, ${nm}, ${kind}, ${unit}, ${adminId}) returning id`;
    names[key] = nm;
    return i!.id;
  };
  const raw = await mkItem('raw', 'Pork belly', 'raw_material', 'kg');
  const sup = await mkItem('sup', 'Gloves', 'supply', 'pcs');
  const ret = await mkItem('ret', 'Soda', 'retail', 'pcs');
  const pinch = await mkItem('pinch', 'Pinch of salt', 'raw_material', 'kg');

  if (c2 === 'attested') {
    // ⛔ By hand ON PURPOSE: `attestStep('C2')` is refused (R8), and this row is the one R8 must not accept.
    await sql`
      insert into cutover_steps (org_id, store_id, step_code, completion, note, completed_by)
      values (${orgId}, null, 'C2', 'attested', 'T-390 S2 test: an attested C2 is not a performed purge', ${adminId})`;
  }
  if (c2 === 'real') await realPurge(sql, adminId);

  return {
    orgId, storeA, storeB, nameA, nameB, kitA, frzA, dryA, barB,
    admin: { personId: adminId, orgId }, adminId, staff: { personId: staffId, orgId },
    raw, sup, ret, pinch, names,
  };
}

const pool: S2Fixture[] = [];

/**
 * Build `n` un-purged fixtures, then run ONE real purge, which writes C2 for every one of them. `s2fixture(hint)` (mode 'real') then
 * hands them out. Call it from a file-level `beforeAll`. Each pooled org is untouched until a test pops it, so the purge loses nothing.
 */
export async function primePool(n: number): Promise<void> {
  const made: S2Fixture[] = [];
  for (let i = 0; i < n; i++) made.push(await s2fixture(`pool${i}`, 'none'));
  await realPurge(sql, made[0]!.adminId);
  pool.push(...made);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------------------------------------------------------

export interface CountArgs {
  store: string;
  room: string;
  item: string;
  qty: string;
  cost?: string;
  source?: string;
}
export const count = (f: S2Fixture, a: CountArgs) =>
  asOrg(f.orgId, (tx) =>
    domain.recordOpeningCount(tx, f.admin, {
      storeId: a.store, locationId: a.room, itemId: a.item, quantity: a.qty,
      ...(a.cost !== undefined ? { unitCost: a.cost, costSource: a.source ?? 'v1_last_delivery' } : {}),
    } as Parameters<typeof domain.recordOpeningCount>[2]),
  );

/**
 * The standard scenario (all costed, so every count is valuable):
 *   Lipa (A):   Pork   Kitchen 5 + Freezer 3 @ 100.0000   -> 800.00  (1310)
 *               Soda   Kitchen 4 @ 12.3333                -> 49.33   (1310)  [49.3332 rounded]
 *               Pinch  Kitchen 1 + Freezer 1 + Dry 1 @ 0.0050 -> 0.02 (1310)  [0.015 rounded ONCE, not 3 x 0.01]
 *               Gloves Kitchen 10 @ 2.5000, Freezer 0     -> 25.00   (1320)
 *   Malvar (B): Pork   Bar 2 @ 50.0000                    -> 100.00  (1310)
 * so A: 1310 = 849.35, 1320 = 25.00; B: 1310 = 100.00. Quantity > 0 rows: 7 at A, 1 at B = 8 movements.
 */
export const EXPECT = {
  A: { '1310': '849.35', '1320': '25.00' },
  B: { '1310': '100.00' },
  qtyRows: 8,
} as const;

export async function standardCounts(f: S2Fixture): Promise<void> {
  const c = (store: string, room: string, item: string, qty: string, cost?: string) => count(f, { store, room, item, qty, cost });
  await c(f.storeA, f.kitA, f.raw, '5', '100.0000');
  await c(f.storeA, f.frzA, f.raw, '3', '100.0000');
  await c(f.storeA, f.kitA, f.ret, '4', '12.3333');
  await c(f.storeA, f.kitA, f.pinch, '1', '0.0050');
  await c(f.storeA, f.frzA, f.pinch, '1', '0.0050');
  await c(f.storeA, f.dryA, f.pinch, '1', '0.0050');
  await c(f.storeA, f.kitA, f.sup, '10', '2.5000');
  await c(f.storeA, f.frzA, f.sup, '0');
  await c(f.storeB, f.barB, f.raw, '2', '50.0000');
}

/** A S2 function that does not exist yet fails HERE, by name. */
export function needS2<T>(name: string): T {
  const fn = (domain as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: @shareat/domain does not export ${name} (T-390 S2 has not been built).`);
  return fn as T;
}
export interface ValueResult {
  entryId: string;
  byAccount: { code: string; amount: string }[];
}
export const value = (f: S2Fixture, storeId: string, actor: Actor = f.admin): Promise<ValueResult | null> =>
  asOrg(f.orgId, (tx) => needS2<(tx: unknown, a: Actor, i: { storeId: string }) => Promise<ValueResult | null>>('valueOpeningStock')(tx, actor, { storeId }));

export const post = (f: S2Fixture, actor: Actor = f.admin) => asOrg(f.orgId, (tx) => domain.postOpeningBalances(tx, actor));

/** Counts, value both stores, clear each store's 3900 with the reconcile figure, attest C3P: C5 is ready to press. */
export async function readyToPost(f: S2Fixture): Promise<{ entryA: string; entryB: string }> {
  await standardCounts(f);
  const a = await value(f, f.storeA);
  const b = await value(f, f.storeB);
  await settle3900(f);
  await attestC3P(f);
  return { entryA: a!.entryId, entryB: b!.entryId };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reading what C5 wrote
// ---------------------------------------------------------------------------------------------------------------------------

export interface MovementRow {
  id: string;
  store_id: string;
  location_id: string;
  item_id: string;
  quantity: string;
  kind: string;
  source_type: string;
  source_id: string;
  moved_at: string;
  journal_entry_id: string | null;
}
export const openingMovements = (orgId: string) =>
  sql<MovementRow[]>`
    select id, store_id, location_id, item_id, quantity::text, kind, source_type, source_id,
           to_char(moved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as moved_at, journal_entry_id
    from stock_movements where org_id = ${orgId} and kind = 'opening' order by store_id, location_id, item_id`;

export interface LayerRow {
  id: string;
  store_id: string;
  item_id: string;
  quantity: string;
  remaining_quantity: string;
  unit_cost: string;
  source: string;
  source_id: string;
  movement_id: string;
  received_at: string;
}
export const openingLayers = (orgId: string) =>
  sql<LayerRow[]>`
    select id, store_id, item_id, quantity::text, remaining_quantity::text, unit_cost::text, source, source_id, movement_id,
           to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as received_at
    from stock_layers where org_id = ${orgId} and source = 'opening' order by store_id, item_id, id`;

/** Every `opening_balance` entry's status for the org: 'draft' | 'posted'. */
export const openingEntryStatuses = async (orgId: string): Promise<string[]> =>
  (await sql<{ status: string }[]>`select status from journal_entries where org_id = ${orgId} and source_type = 'opening_balance'`).map((r) => r.status);

/** Posted opening lines on one inventory account for one store, debit minus credit, as pesos text. */
export async function postedOpeningLine(orgId: string, storeId: string, accountCode: string): Promise<string> {
  const [r] = await sql<{ net: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2)::text as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_type = 'opening_balance' and je.status = 'posted'
      and a.code = ${accountCode} and jl.store_id = ${storeId}`;
  return r!.net;
}

/** onHand = Σ signed movements, as the ledger defines it. */
export async function onHand(orgId: string, itemId: string, locationId: string): Promise<number> {
  const [r] = await sql<{ q: string }[]>`
    select coalesce(sum(quantity), 0)::text as q from stock_movements where org_id = ${orgId} and item_id = ${itemId} and location_id = ${locationId}`;
  return Number(r!.q);
}

/** The refusal's sentence: the user-facing message when there is one, the raw message otherwise. */
export function sentenceOf(e: unknown): string {
  const u = (e as { userMessage?: string } | null)?.userMessage;
  return u ?? (e as Error | null)?.message ?? '';
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function defer<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

export { dsql };
