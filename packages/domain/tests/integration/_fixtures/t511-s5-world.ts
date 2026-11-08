/**
 * T-511 S5b - the world the review-stage integration tests run in (NOT a test file). Builds on the S4 world: one org per call, so nothing here truncates.
 *
 * Adds: a third store (Banay-banay) with its own Grab channel (code read from the Banay fixture), an admin scoped to all three stores, loans created
 * through the real domain (createLoan, updateLoanRepaymentAmount, disburseLoan so the ledger holds the outstanding), a destination money account for a
 * channel, and read-backs of the staged tables on the raw connection. Real Postgres through the caller's `postgres(TEST_DATABASE_URL)`.
 */
import { eq, sql as dsql } from 'drizzle-orm';
import type postgres from 'postgres';
import { APP_ROLE, schema, transaction, type SettlementDayLineRow, type Tx } from '@shareat/db';
import { createLoan, disburseLoan, updateLoanRepaymentAmount } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { world, grabStoreIdOf, salesDay, upload, type World } from './t511-s4-world';

export * from './t511-s4-world';
export const BANAY_GRAB_ID = grabStoreIdOf('grab-banay-oct-transfers.csv');

let seq = 0;
const uid = (p: string): string => `${p}-${Date.now()}-${++seq}`;

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export interface World3 extends World {
  storeC: string;
  grabC: string;
  managerC: Actor;
}

/** The S4 world plus Banay-banay (C) and open fiscal periods for the loan disbursals (Sep 2026 and May 2026) unless `periods: false`. */
export async function world3(sql: postgres.Sql, hint: string, opts: { periods?: boolean } = {}): Promise<World3> {
  const w = await world(sql, hint);
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${w.orgId}, ${uid('Banay')}, 'Banay-banay') returning id`;
  const storeC = s!.id;
  await sql`insert into person_store_scope (person_id, store_id) values (${w.admin.personId}, ${storeC})`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Manager C') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeC})`;
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code)
    values (${w.orgId}, ${storeC}, 'Grab', false, '1220', 'grab', ${BANAY_GRAB_ID}) returning id`;
  // open periods for the loan disbursals and the raw posted settlement. `periods: false` leaves the books without any, so a test can CLOSE October (an open
  // period may not start before a closed one).
  if (opts.periods !== false) {
    for (const [from, to] of [['2026-05-01', '2026-05-31'], ['2026-09-01', '2026-09-30']] as const) {
      await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${w.orgId}, ${from}, ${to}, 'open')`;
    }
  }
  return { ...w, storeC, grabC: c!.id, managerC: { personId: p!.id, orgId: w.orgId } };
}

/**
 * A Grab loan through the real domain: created, its expected daily repayment recorded (null = none entered), and `principal` drawn into a bank account so the
 * ledger shows it outstanding. Returns the loan id.
 */
export async function mkLoan(
  sql: postgres.Sql,
  w: World,
  o: { storeId: string; name: string; startDate: string; principal: string; repayment: string | null },
): Promise<string> {
  const loan = await asOrg(w.orgId, (tx) =>
    createLoan(tx, w.admin, {
      storeId: o.storeId, lenderName: 'Grab', name: o.name, principalAmount: o.principal, interestRate: '2', ratePeriod: 'month',
      interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: o.startDate,
    }),
  );
  if (o.repayment !== null) await asOrg(w.orgId, (tx) => updateLoanRepaymentAmount(tx, w.admin, { loanId: loan.id, repaymentAmount: o.repayment }));
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${w.orgId}, ${o.storeId}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  await asOrg(w.orgId, (tx) =>
    disburseLoan(tx, w.admin, { requestId: crypto.randomUUID(), loanId: loan.id, amount: o.principal, intoMoneyAccountId: acct!.id, on: '2026-09-30' }),
  );
  return loan.id;
}

/** Sets a channel's payout destination account (raw), so the "no destination account" blocker clears. */
export async function setDestination(sql: postgres.Sql, w: World, channelId: string): Promise<void> {
  const [row] = await sql<{ store_id: string }[]>`select store_id from sales_channels where id = ${channelId}`;
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${w.orgId}, ${row!.store_id}, ${uid('Dest')}, 'bank', '1140', 'office', true) returning id`;
  await sql`update sales_channels set destination_money_account_id = ${acct!.id} where id = ${channelId}`;
}

/** Ingests the two Grab October files of a store (Transactions first), as the upload screen would, by the store's manager. */
export interface IngestFn {
  (w: World, actor: Actor, f: { bytes: Buffer; contentType: string }): Promise<unknown>;
}
export async function stageGrabOctober(ingest: IngestFn, w: World, actor: Actor, store: 'lipa' | 'malvar' | 'banay'): Promise<void> {
  await ingest(w, actor, upload(`grab-${store}-oct-transactions.csv`));
  await ingest(w, actor, upload(`grab-${store}-oct-transfers.csv`));
}

/* ------------------------------------------------------------------ read-backs (raw connection, no RLS) */

export interface LineRow {
  id: string; channel_id: string; store_id: string; platform: string; sales_date: string; version: number; is_current: boolean; review_state: string;
  decision_reason: string | null; decided_by: string | null; decided_at: Date | null; settlement_id: string | null; order_value: string; net_payout: string;
  recorded_figure: string | null; difference: string | null; paid_state: string; unexplained: string; payout_reference: string | null; loan_deduction: string;
}
export const lineRows = (sql: postgres.Sql, orgId: string, channelId: string): Promise<LineRow[]> => sql<LineRow[]>`
  select id::text, channel_id::text, store_id::text, platform, sales_date::text, version, is_current, review_state, decision_reason, decided_by::text, decided_at,
         settlement_id::text, order_value::text, net_payout::text, recorded_figure::text, difference::text, paid_state, unexplained::text, payout_reference,
         loan_deduction::text
    from settlement_day_lines where org_id = ${orgId} and channel_id = ${channelId} order by sales_date, version`;
export const lineOn = async (sql: postgres.Sql, orgId: string, channelId: string, date: string): Promise<LineRow> =>
  (await lineRows(sql, orgId, channelId)).find((l) => l.sales_date === date && l.is_current)!;

export const auditRows = (sql: postgres.Sql, orgId: string, action: string) => sql<{ action: string; entity_id: string; store_id: string | null; actor_person_id: string | null; source: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]>`
  select action, entity_id::text, store_id::text, actor_person_id::text, source, before, after from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at`;

export const ledgerCount = async (sql: postgres.Sql, orgId: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId}`;
  return r!.n;
};
export const settlementCount = async (sql: postgres.Sql, orgId: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from channel_settlements where org_id = ${orgId}`;
  return r!.n;
};

export const loanLineRows = (sql: postgres.Sql, dayLineId: string) => sql<{ id: string; kind: string; amount: string; row_ordinal: number; loan_id: string | null; allocation_source: string; is_active: boolean }[]>`
  select id::text, kind, amount::text, row_ordinal, loan_id::text, allocation_source, is_active from settlement_loan_lines where day_line_id = ${dayLineId} order by row_ordinal, id`;

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Runs `fn` and returns { ok: true, value } or { ok: false, error } (never throws). */
export async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error & { userMessage?: string; code?: string } }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

/** One day line by id, as the app reads it (camelCase `DayLineRow`), whether or not it is the current version. */
export async function lineById(tx: Tx, id: string): Promise<SettlementDayLineRow> {
  const [row] = await tx.select().from(schema.settlementDayLines).where(eq(schema.settlementDayLines.id, id)).limit(1);
  return row!;
}

/**
 * A POSTED channel settlement for a channel and business date, written raw (a posted row needs a journal entry to point at; the entry is an empty draft: the
 * only thing the day checks look at is that a posted settlement exists). Returns its id.
 */
export async function postedSettlementRaw(sql: postgres.Sql, w: World, o: { channelId: string; storeId: string; salesDayId: string; date: string }): Promise<string> {
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${w.orgId}, ${o.storeId}, ${uid('Posted')}, 'bank', '1140', 'office', true) returning id`;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${w.orgId} and starts_on = '2026-09-01'`;
  const [bank] = await sql<{ id: string }[]>`select id from accounts where org_id = ${w.orgId} and code = '6400'`;
  const [other] = await sql<{ id: string }[]>`select id from accounts where org_id = ${w.orgId} and code = '4150'`;
  const entry = await sql.begin(async (trx) => {
    const [e] = await trx<{ id: string }[]>`
      insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, memo, status)
      values (${w.orgId}, ${period!.id}, '2026-09-30', 'manual_journal', ${uid('src')}, ${uid('idem')}, 'posted-settlement probe', 'draft') returning id`;
    await trx`insert into journal_lines (entry_id, account_id, line_no, debit, credit) values (${e!.id}, ${bank!.id}, 1, 1, 0), (${e!.id}, ${other!.id}, 2, 0, 1)`;
    return e!;
  });
  const [set] = await sql<{ id: string }[]>`
    insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id,
                                     settled_on, created_by, status, posted_by, posted_at, journal_entry_id)
    values (${w.orgId}, ${o.storeId}, ${o.channelId}, ${o.salesDayId}, ${o.date}, '0', '0', '0', ${acct!.id}, ${o.date}, ${w.admin.personId}, 'posted', ${w.admin.personId}, now(), ${entry.id})
    returning id`;
  return set!.id;
}

/** Closes the fiscal month that holds `startsOn`..`endsOn` (inserts the period as closed). */
export async function closedPeriod(sql: postgres.Sql, w: World, startsOn: string, endsOn: string, status: 'closed' | 'locked' = 'closed'): Promise<void> {
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${w.orgId}, ${startsOn}, ${endsOn}, ${status})`;
}

/**
 * `salesDay`, but a verified day with sales also carries a journal entry, as a day verified through the domain does (T-511 S7a: `dayBlockers` now holds a verified day with no entry
 * as `sales_day_not_posted`, because a platform correction has nothing to replace). The entry is an empty draft in an open period of the world (or a marker month of 1990 closed at once); nothing reads it but the
 * day's `journal_entry_id`. An open or no-sales day is left as `salesDay` leaves it.
 */
export async function postedSalesDay(
  sql: postgres.Sql,
  w: World,
  storeId: string,
  channelId: string,
  date: string,
  amount: string,
  o: { verified?: boolean; noSales?: boolean } = {},
): Promise<string> {
  const dayId = await salesDay(sql, w, storeId, channelId, date, amount, o);
  if (o.verified === false || o.noSales === true) return dayId;
  // any open period of the org will do; a world with none gets a marker month of 1990 (opened, used, closed at once: an open period may not start before a closed one)
  const [existing] = await sql<{ id: string; starts_on: string }[]>`select id, starts_on::text as starts_on from fiscal_periods where org_id = ${w.orgId} and status = 'open' order by starts_on limit 1`;
  let periodId = existing?.id;
  let from = existing?.starts_on ?? '';
  let markerMade = false;
  if (!periodId) {
    const month = new Date(Date.UTC(1990, 0, 1)); // a fixed anchor, not a clock
    month.setUTCMonth(month.getUTCMonth() + (seq % 600));
    from = month.toISOString().slice(0, 10);
    const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    periodId = (await sql<{ id: string }[]>`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${w.orgId}, ${from}, ${to}, 'open') returning id`)[0]!.id;
    markerMade = true;
  }
  const [bank] = await sql<{ id: string }[]>`select id from accounts where org_id = ${w.orgId} and code = '6400'`;
  const [other] = await sql<{ id: string }[]>`select id from accounts where org_id = ${w.orgId} and code = '4150'`;
  const entryId = await sql.begin(async (trx) => {
    const [e] = await trx<{ id: string }[]>`
      insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, memo, status)
      values (${w.orgId}, ${periodId}, ${from}, 'manual_journal', ${uid('src')}, ${uid('idem')}, 'posted sales day marker', 'draft') returning id`;
    await trx`insert into journal_lines (entry_id, account_id, line_no, debit, credit) values (${e!.id}, ${bank!.id}, 1, 1, 0), (${e!.id}, ${other!.id}, 2, 0, 1)`;
    return e!.id;
  });
  await sql`update sales_days set journal_entry_id = ${entryId} where id = ${dayId}`;
  if (markerMade) await sql`update fiscal_periods set status = 'closed' where id = ${periodId}`;
  return dayId;
}
