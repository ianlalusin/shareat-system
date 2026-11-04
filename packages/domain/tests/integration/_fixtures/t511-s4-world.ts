/**
 * T-511 S4 - the world the ingest integration tests run in (NOT a test file). Real Postgres through the caller's `postgres(TEST_DATABASE_URL)` connection.
 *
 * One org per `world()` call, so tests never share rows and nothing here truncates. Two stores (Lipa = A, Malvar = B), each with a Grab channel and a Foodpanda
 * channel whose platform codes are the REAL codes printed in the redacted fixtures (the Grab Store IDs are read from the fixture CSVs themselves; the Foodpanda
 * vendor codes are O6JZ for Lipa and A08X for Malvar). People: an admin scoped to BOTH stores with store A first (so a "first scope store" bug shows), a
 * manager of A only, a manager of B only, and a staff member.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { forceVerifiedSql, mkSubmitter } from './sales-day-flow';
import { fixture, fp34Order, fpChargeRow, fpWorkbook, parseGrab, zipBytes, day as isoDay } from '../../unit/t511-s3-helpers';

export { fixture, parseGrab };
export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The Store ID column of a Grab fixture (one per file; the readers refuse a mixed file). */
export function grabStoreIdOf(name: string): string {
  const g = parseGrab(fixture(name));
  return (g.rows[0] as string[])[g.headers.indexOf('Store ID')] as string;
}
export const LIPA_GRAB_ID = grabStoreIdOf('grab-lipa-oct-transfers.csv');
export const MALVAR_GRAB_ID = grabStoreIdOf('grab-malvar-oct-transfers.csv');
export const LIPA_FP = 'O6JZ';
export const MALVAR_FP = 'A08X';

let seq = 0;
const uid = (p: string): string => `${p}-${Date.now()}-${++seq}`;

export interface World {
  orgId: string;
  storeA: string;
  storeB: string;
  grabA: string;
  fpA: string;
  grabB: string;
  fpB: string;
  admin: Actor;
  managerA: Actor;
  managerB: Actor;
  staff: Actor;
}

export async function world(sql: postgres.Sql, hint: string, opts: { channels?: boolean } = {}): Promise<World> {
  const code = uid(`t511s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const store = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await store('Lipa');
  const storeB = await store('Malvar');
  const person = async (name: string, role: string, stores: string[]): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const admin = await person('Admin', 'admin', [storeA, storeB]);
  const managerA = await person('Manager A', 'manager', [storeA]);
  const managerB = await person('Manager B', 'manager', [storeB]);
  const staff = await person('Staff', 'staff', [storeA]);
  const channel = async (storeId: string, name: string, platform: 'grab' | 'foodpanda', platformCode: string | null) => {
    const [c] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code)
      values (${orgId}, ${storeId}, ${name}, false, '1220', ${platformCode ? platform : null}, ${platformCode}) returning id`;
    return c!.id;
  };
  const withCodes = opts.channels !== false;
  const grabA = await channel(storeA, 'Grab', 'grab', withCodes ? LIPA_GRAB_ID : null);
  const fpA = await channel(storeA, 'Foodpanda', 'foodpanda', withCodes ? LIPA_FP : null);
  const grabB = await channel(storeB, 'Grab', 'grab', withCodes ? MALVAR_GRAB_ID : null);
  const fpB = await channel(storeB, 'Foodpanda', 'foodpanda', withCodes ? MALVAR_FP : null);
  return { orgId, storeA, storeB, grabA, fpA, grabB, fpB, admin, managerA, managerB, staff };
}

/**
 * A sales day for one channel. `verified` runs the two legal status steps (open -> submitted -> verified) on the raw connection; otherwise the day is left
 * `open`. `noSales` writes the confirmed-zero row. Returns the day id.
 */
export async function salesDay(
  sql: postgres.Sql,
  w: World,
  storeId: string,
  channelId: string,
  date: string,
  amount: string,
  o: { verified?: boolean; noSales?: boolean } = {},
): Promise<string> {
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${w.orgId}, ${storeId}, ${date}, ${amount}, 0, ${amount}, ${w.managerA.personId}) returning id`;
  await sql`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${d!.id}, ${channelId}, ${amount}, ${o.noSales === true})`;
  if (o.verified !== false) {
    const submitter = await mkSubmitter(sql, w.orgId, [storeId], 'Submitter');
    await forceVerifiedSql(sql, d!.id, w.admin.personId, submitter.personId);
  }
  return d!.id;
}

/** Marks a current day line booked the way slice 7 will: a channel_settlements row to point at, then the allowed column update. Raw connection. */
export async function bookLine(sql: postgres.Sql, w: World, lineId: string): Promise<{ settlementId: string }> {
  const [line] = await sql<{ store_id: string; channel_id: string; sales_date: string }[]>`select store_id, channel_id, sales_date::text from settlement_day_lines where id = ${lineId}`;
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${w.orgId}, ${line!.store_id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${w.orgId}, ${line!.store_id}, '2026-01-10', '0', '0', '0', ${w.admin.personId}) returning id`;
  const [set] = await sql<{ id: string }[]>`
    insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by)
    values (${w.orgId}, ${line!.store_id}, ${line!.channel_id}, ${day!.id}, '2026-01-10', '0', '0', '0', ${acct!.id}, '2026-01-10', ${w.admin.personId}) returning id`;
  await sql`
    update settlement_day_lines
       set review_state = 'booked', decided_by = ${w.admin.personId}, decided_at = now(), settlement_id = ${set!.id}
     where id = ${lineId}`;
  return { settlementId: set!.id };
}

/* ------------------------------------------------------------------ synthetic Foodpanda zips (a real code, controllable figures) */

export interface SynthOrder {
  /** the order date, YYYY-MM-DD */
  date: string;
  /** column R (and K): the revenue after discounts */
  revenue: number;
}

/**
 * A Foodpanda settlement zip (workbook + a stub PDF) whose vendor code is `vendor`, with one order row per entry (identities hold: commission 22.32,
 * withholding tax 0.50, tax on charges 2.68, balance = revenue - 25.50) and no Appendix B charges. `tag` makes the bytes (and so the fingerprint) unique.
 */
export function synthFoodpanda(orders: SynthOrder[], vendor: string, tag: string): Buffer {
  const rows = orders.map((o, i) =>
    fp34Order(`${vendor.toLowerCase()}-${String(i).padStart(4, '0')}-${tag}`, { 7: isoDay(o.date), 10: o.revenue, 17: o.revenue, 33: Number((o.revenue - 25.5).toFixed(2)) }, '200999999999', vendor),
  );
  const book = fpWorkbook({ orderRows: rows, chargeRows: [] });
  return zipBytes([
    { name: '20261015_200999999999.xls', data: book },
    { name: '20261015_200999999999.pdf', data: Buffer.from(`%PDF-1.4 stub ${tag}`) },
  ]);
}

export { fpChargeRow };

/** The raw bytes of a fixture re-read from disk (a fresh copy) plus the content type the upload action would declare for it. */
export function upload(name: string): { bytes: Buffer; contentType: string } {
  return { bytes: Buffer.from(readFileSync(join(__dirname, '..', '..', 'fixtures', 'settlement-intake', name))), contentType: name.endsWith('.zip') ? 'application/zip' : 'text/csv' };
}
