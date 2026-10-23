import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-390 S3 - shared fixture for the tie-out and opening-asset tests.
 * `docs/tasks/390-opening-stock-and-subledger-tieout.md` s5.3, s8. TESTER-owned.
 *
 * ⛔ C2 DEVIATION (spec defect, reported): s8 says C2 is reached by running the real `applyPurge` with `performedBy`. S2 has not
 * built that (today `applyPurge` records no step), and a real purge truncates every purge-class table of the WHOLE test database,
 * which would delete every other fixture. So `reachC2` inserts the one `cutover_steps` row by hand, with a comment. When S2 lands
 * the purge path gets its own test (9a); S3 only needs R8's C2 gate to be satisfiable.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { APP_ROLE, cutoverRepo, journalRepo, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { seedChartOfAccounts } from '../../packages/db/seed/chart-of-accounts';

export const sql = postgres(url, { max: 5 });
export const CONVERSION = '2027-01-01';
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** The error a call rejects with, or null when it resolves. */
export const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

/**
 * A S3 function that does not exist yet fails HERE, by name, so a red run says "missing export" and not a bare TypeError.
 * (Vitest does not typecheck; an unexported name would otherwise be `undefined`.)
 */
export function need<T = (...a: never[]) => unknown>(name: string): T {
  const fn = (domain as Record<string, unknown>)[name];
  if (typeof fn !== 'function') {
    throw new Error(`MISSING EXPORT: @shareat/domain does not export ${name} (T-390 S3 has not been built).`);
  }
  return fn as T;
}

export interface TieLine {
  register: string;
  storeId: string | null;
  account: string | null;
  registerFigure: string;
  ledgerFigure: string;
  difference: string;
  sentence: string;
}
export interface TieOut {
  holds: boolean;
  lines: TieLine[];
  notChecked?: { account: string; amount: string; reason: string }[];
}

export interface Fixture {
  orgId: string;
  storeA: string;
  storeB: string;
  nameA: string;
  nameB: string;
  roomA: string;
  roomB: string;
  admin: Actor;
  adminId: string;
  manager: Actor;
  staff: Actor;
}

export async function fixture(hint: string): Promise<Fixture> {
  const code = uid(`t390s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  // One window covers the opening (2027-01), the pre-cutover docs (2026-12) and "today" (a supplier return stamps now).
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

  const mkPerson = async (name: string, role: string | null, scoped = true) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    if (scoped) {
      for (const s of [storeA, storeB]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    }
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staff', 'staff');

  const [lt] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, roomCode: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, status, created_by)
      values (${orgId}, ${storeId}, ${roomCode}, ${roomCode}, ${lt!.id}, 'operating', true, 'active', ${adminId}) returning id`;
    return r!.id;
  };
  const roomA = await mkRoom(storeA, 'KIT');
  const roomB = await mkRoom(storeB, 'BAR');

  const f: Fixture = {
    orgId, storeA, storeB, nameA, nameB, roomA, roomB,
    admin: { personId: adminId, orgId }, adminId,
    manager: { personId: managerId, orgId }, staff: { personId: staffId, orgId },
  };
  await reachC2(f);
  return f;
}

/** See the C2 DEVIATION note at the top of this file. Not a purge; the one row R8 looks for. */
export async function reachC2(f: Fixture): Promise<void> {
  await sql`
    insert into cutover_steps (org_id, store_id, step_code, completion, note, completed_by)
    values (${f.orgId}, null, 'C2', 'performed', 'T-390 S3 test fixture: C2 inserted by hand (S2 purge row not built)', ${f.adminId})`;
}

/** C3 recorded as done (the C3 -> C4 gate). */
export const reachC3 = (f: Fixture) =>
  asOrg(f.orgId, (tx) =>
    cutoverRepo.recordStep(tx, {
      orgId: f.orgId, storeId: null, stepCode: 'C3', completion: 'performed', note: 'test', completedBy: f.adminId,
    }),
  );

/**
 * C3P attested. Written through the repo (what `attestStep` writes) so a C5 test fails on ITS OWN rule while the step is still
 * undeclared; the real `attestStep('C3P')` path has its own test in the tie-out file.
 */
export const attestC3P = (f: Fixture) =>
  asOrg(f.orgId, (tx) =>
    cutoverRepo.recordStep(tx, {
      orgId: f.orgId, storeId: null, stepCode: 'C3P', completion: 'attested', note: 'agreed with v1 aged lists', completedBy: f.adminId,
    }),
  );

// ---------------------------------------------------------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------------------------------------------------------

export interface FigureArgs {
  accountCode: string;
  storeId: string;
  direction: 'debit' | 'credit';
  amount: string;
  partyType?: string;
  partyId?: string;
  entryDate?: string;
  memo?: string;
}
export const figure = (f: Fixture, a: FigureArgs) =>
  asOrg(f.orgId, (tx) =>
    domain.addOpeningFigure(tx, f.admin, { entryDate: CONVERSION, ...a } as Parameters<typeof domain.addOpeningFigure>[2]),
  );

/**
 * A draft written straight through the journal repo, bypassing `addOpeningFigure`'s refusals (R6 refuses 1590 and 1310-1330 once
 * S2 lands). Used ONLY where a test needs a line the domain will not let a person type.
 */
export async function rawOpeningDraft(
  f: Fixture,
  a: { accountCode: string; storeId: string | null; direction: 'debit' | 'credit'; amount: string; key: string },
): Promise<void> {
  await asOrg(f.orgId, async (tx) => {
    const period = await journalRepo.findPeriodForDate(tx, f.orgId, CONVERSION);
    const { id, created } = await journalRepo.insertDraftEntry(tx, {
      orgId: f.orgId, entryDate: CONVERSION, periodId: period!.id, memo: `raw ${a.accountCode}`,
      sourceType: 'opening_balance', sourceId: `raw:${a.key}`, idempotencyKey: `raw:${f.orgId}:${a.key}`,
    });
    if (!created) return;
    const dr = a.direction === 'debit';
    await journalRepo.insertLines(tx, id, [
      {
        accountId: await journalRepo.resolveAccountId(tx, f.orgId, a.accountCode), lineNo: 1, storeId: a.storeId,
        debit: (dr ? a.amount : '0') as never, credit: (dr ? '0' : a.amount) as never,
        partyType: null, partyId: null, lineMemo: 'raw', channelId: null,
      },
      {
        accountId: await journalRepo.resolveAccountId(tx, f.orgId, '3900'), lineNo: 2, storeId: a.storeId,
        debit: (dr ? '0' : a.amount) as never, credit: (dr ? a.amount : '0') as never,
        partyType: null, partyId: null, lineMemo: 'raw', channelId: null,
      },
    ]);
  });
}

/** Every store's 3900 net (credit minus debit) over opening drafts and posted opening entries, in centavos as a string. */
export async function net3900(f: Fixture): Promise<Map<string, number>> {
  const rows = await sql<{ store_id: string; net: string }[]>`
    select jl.store_id, sum((jl.credit - jl.debit) * 100)::text as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${f.orgId} and je.source_type = 'opening_balance' and a.code = '3900'
    group by jl.store_id`;
  return new Map(rows.map((r) => [r.store_id, Number(r.net)]));
}

/**
 * Clears each store's 3900 to zero with the existing C3 reconcile figure (3900 -> 3300, bible row 109), so a test whose subject is
 * ANOTHER register is not also tripping T10. Replaces any earlier reconcile draft, so it can be called again after more figures.
 */
export async function settle3900(f: Fixture): Promise<void> {
  const drafts = await asOrg(f.orgId, (tx) => cutoverRepo.openingDrafts(tx, f.orgId));
  for (const id of new Set(drafts.filter((d) => d.accountCode === '3300').map((d) => d.id))) {
    await asOrg(f.orgId, (tx) => domain.removeOpeningFigure(tx, f.admin, { entryId: id }));
  }
  for (const [storeId, centavos] of await net3900(f)) {
    if (centavos === 0) continue;
    const amount = (Math.abs(centavos) / 100).toFixed(2);
    // Store 3900 is net CREDIT: clear it with Dr 3900 / Cr 3300, which is `addOpeningFigure(3300, credit)`.
    await figure(f, { accountCode: '3300', storeId, direction: centavos > 0 ? 'credit' : 'debit', amount });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Registers' own rows
// ---------------------------------------------------------------------------------------------------------------------------

export async function mkSupplier(f: Fixture, name: string): Promise<{ id: string; name: string }> {
  const nm = `${name} ${uid('sup')}`;
  const [r] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${nm}, ${f.adminId}) returning id`;
  return { id: r!.id, name: nm };
}
export async function mkCustomer(f: Fixture, name: string): Promise<{ id: string; name: string }> {
  const nm = `${name} ${uid('cus')}`;
  const [r] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, created_by) values (${f.orgId}, ${nm}, ${f.adminId}) returning id`;
  return { id: r!.id, name: nm };
}
export async function mkPerson(f: Fixture, name: string, employedAt: string | null): Promise<{ id: string; name: string }> {
  const nm = `${name} ${uid('per')}`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${f.orgId}, ${nm}) returning id`;
  if (employedAt) {
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${f.orgId}, ${employedAt}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')`;
  }
  return { id: p!.id, name: nm };
}
export async function mkLoan(
  f: Fixture, storeId: string, name: string, status: 'active' | 'paid_off' = 'active',
): Promise<{ id: string; name: string }> {
  const nm = `${name} ${uid('loan')}`;
  const [r] = await sql<{ id: string }[]>`
    insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method,
                       payment_frequency, term_periods, start_date, status, created_by)
    values (${f.orgId}, ${storeId}, 'Grab', ${nm}, 50000, 0, 'month', 'straight', 'monthly', 6, '2026-06-01', ${status}, ${f.adminId})
    returning id`;
  return { id: r!.id, name: nm };
}
export async function mkPrepaid(f: Fixture, storeId: string, totalCost: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into prepaid_items (org_id, store_id, name, category, coverage_start_date, coverage_months, total_cost, status, created_by)
    values (${f.orgId}, ${storeId}, ${uid('Insurance')}, 'insurance', ${CONVERSION}, 12, ${totalCost}, 'active', ${f.adminId})
    returning id`;
  return r!.id;
}
/** An ACTIVE asset, valued at `cost`, acquired on `acquiredOn` (the conversion date by default). */
export async function mkAsset(f: Fixture, storeId: string, cost: string, acquiredOn = CONVERSION): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost, salvage_value, useful_life_months, interval,
                              status, in_service_on, in_service_source, created_by)
    values (${f.orgId}, ${storeId}, ${uid('Chiller')}, 'equipment', ${acquiredOn}, ${cost}, '0', 24, 'monthly', 'active',
            ${acquiredOn}, 'acquired', ${f.adminId})
    returning id`;
  return r!.id;
}
/** The cutover SHELL: pending valuation, no cost, no date. Returns its id and its (unique) name. */
export async function mkShell(f: Fixture, storeId: string, name = 'Walk-in Chiller'): Promise<{ id: string; name: string }> {
  const nm = `${name} ${uid('shell')}`;
  const [r] = await sql<{ id: string }[]>`
    insert into fixed_assets (org_id, store_id, name, category, status, created_by)
    values (${f.orgId}, ${storeId}, ${nm}, 'equipment', 'pending_valuation', ${f.adminId}) returning id`;
  return { id: r!.id, name: nm };
}
/** An active money account of the store with this GL code, creating one if the store has none. */
export async function moneyAccountOf(f: Fixture, storeId: string, gl: string, active = true): Promise<string> {
  const found = await sql<{ id: string }[]>`
    select id from money_accounts where org_id = ${f.orgId} and store_id = ${storeId} and gl_account_code = ${gl}
      and is_active = ${active} order by created_at limit 1`;
  if (found[0]) return found[0].id;
  const [r] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${f.orgId}, ${storeId}, ${uid('Wallet')}, 'bank', ${gl}, 'office', ${active}) returning id`;
  return r!.id;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reading the tie-out
// ---------------------------------------------------------------------------------------------------------------------------

export const tieOut = (f: Fixture): Promise<TieOut> =>
  asOrg(f.orgId, (tx) => need<(tx: Tx, orgId: string) => Promise<TieOut>>('openingTieOut')(tx, f.orgId));

/** A peso figure as the sentence may print it: with or without thousands commas, e.g. 12400.00 -> /12,?400\.00/. */
export const peso = (amount: string): RegExp => {
  const [whole, cents] = amount.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',?');
  return new RegExp(`${grouped}\\.${cents ?? '00'}`);
};

/** The first sentence that matches EVERY predicate (a string is "contains", a RegExp is "matches"); undefined if none. */
export function sentenceWith(t: TieOut, ...parts: (string | RegExp)[]): string | undefined {
  return t.lines
    .map((l) => l.sentence)
    .find((s) => parts.every((p) => (typeof p === 'string' ? s.includes(p) : p.test(s))));
}

export const sentences = (t: TieOut): string => t.lines.map((l) => `- ${l.sentence}`).join('\n');

export { domain, cutoverRepo };
