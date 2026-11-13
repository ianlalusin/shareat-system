import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-516 (audit follow-up to T-515): retiring an asset from a voided expense, changing an asset's in-service
 * date, and the store opening-date cascade all take the asset row's lock (FOR UPDATE) before they judge
 * anything, so each serialises with a depreciation run on the same asset. Real PostgreSQL, TWO SEPARATE
 * transactions on two pooled connections; the first is held open by a deferred promise. Fixture and race()
 * helper copied from t515-dispose-asset-lock.test.ts; the expense-linked asset comes from the same
 * createExpense -> approveExpense path fixed-assets.test.ts uses for DEF-160.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  approveExpense,
  createAsset,
  createExpense,
  depreciateAsset,
  retireAssetFromVoidedExpense,
  setAssetInService,
  setStoreOpeningDate,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

vi.setConfig({ testTimeout: 45000 });
const PAUSE_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = postgres(url, { max: 5 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

interface Fixture {
  orgId: string;
  storeId: string;
  adminId: string;
  managerId: string;
  staffId: string;
}

/** `openingDate` is the store's opening date; a date AFTER an asset's acquisition makes it a `store_opening` follower. */
async function setup(hint: string, openingDate = '2020-01-01'): Promise<Fixture> {
  const code = uid(`t516-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')
    `;
  }
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, ${openingDate}) returning id
  `;
  const storeId = store!.id;
  const mkPerson = async (name: string, role: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
    `;
    await sql`insert into person_roles (person_id, org_id, role) values (${r!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${r!.id}, ${storeId})`;
    return r!.id;
  };
  const staffId = await mkPerson(`${hint} Staff`, 'staff');
  const managerId = await mkPerson(`${hint} Manager`, 'manager');
  const adminId = await mkPerson(`${hint} Admin`, 'admin');
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: adminId });
  return { orgId, storeId, adminId, managerId, staffId };
}

/** A lock_timeout makes a hang fail loudly instead of freezing the run. */
async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(dsql`set local lock_timeout = '15s'`);
    return fn(tx);
  });
}

const admin = (f: Fixture): Actor => ({ personId: f.adminId, orgId: f.orgId });
const manager = (f: Fixture): Actor => ({ personId: f.managerId, orgId: f.orgId });

/** Org-wide balance (credit - debit) of one account, over non-draft entries. */
async function balance(orgId: string, code: string): Promise<string> {
  const rows = await sql<{ total: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and a.code = ${code} and je.status <> 'draft'
  `;
  return rows[0]?.total ?? '0';
}

/** Depreciation entries of the asset that are still LIVE (posted, not reversed). */
async function liveDepreciation(orgId: string, assetId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries
    where org_id = ${orgId} and source_id = ${assetId} and source_type = 'depreciation' and status = 'posted'
      and reversal_of_entry_id is null
  `;
  return rows[0]?.n ?? 0;
}

async function statusOf(assetId: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`select status from fixed_assets where id = ${assetId}`;
  return rows[0]!.status;
}

async function inServiceOf(assetId: string): Promise<{ source: string | null; on: string | null }> {
  const [row] = await sql<{ in_service_source: string | null; in_service_on: string | null }[]>`
    select in_service_source, in_service_on::text as in_service_on from fixed_assets where id = ${assetId}`;
  return { source: row?.in_service_source ?? null, on: row?.in_service_on ?? null };
}

async function storeOpeningDate(storeId: string): Promise<string | null> {
  const [row] = await sql<{ d: string | null }[]>`select opening_date::text as d from stores where id = ${storeId}`;
  return row?.d ?? null;
}

/** 120,000 over 24 months, no salvage: 5,000 a month. Acquired 15 Jan 2026. Jan and Feb depreciation committed. */
async function janFebAsset(f: Fixture): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createAsset(tx, admin(f), {
      storeId: f.storeId,
      name: 'Chest freezer',
      category: 'appliances',
      acquiredOn: '2026-01-15',
      cost: '120000.00',
      usefulLifeMonths: 24,
    } as Parameters<typeof createAsset>[2]),
  );
  await asPerson(f.orgId, (tx) => depreciateAsset(tx, admin(f), { assetId: id, through: '2026-02' }));
  return id;
}

/** A CAPEX expense (120,000) that auto-capitalised an asset (same path as fixed-assets.test.ts DEF-160); Jan and Feb committed. */
async function expenseAsset(f: Fixture): Promise<{ expenseId: string; assetId: string }> {
  const [cat] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${f.orgId} and category = 'Capital Expenditure'
  `;
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, 'CAPEX Supplier', ${f.staffId})
    returning id
  `;
  const [capexFile] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo',
            ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/capex-${Date.now()}.jpg`},
            'image/jpeg', 1024, ${`sum-capex-${Date.now()}`}, ${f.staffId})
    returning id
  `;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (
      org_id, store_id, supplier_id, invoice_date, total_amount, status,
      receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price
    ) values (
      ${f.orgId}, ${f.storeId}, ${supplier!.id}, '2026-01-20', '99999999.00', 'verified',
      ${capexFile!.id}, ${f.managerId}, now(), ${f.staffId}, true, true, true, true
    )
    returning id
  `;
  const [drawer] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${f.orgId}, ${f.storeId}, 'Cashier drawer', 'cash', '1110', 'cashier')
    returning id
  `;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-19', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft')
      returning id
    `;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, '500000.00', '0')
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', '500000.00')
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const created = await asPerson(f.orgId, (tx) =>
    createExpense(tx, manager(f), {
      requireItemised: false /* legacy fixture: lineless invoice */,
      storeId: f.storeId,
      supplierId: supplier!.id,
      supplierInvoiceId: invoice!.id,
      businessDate: '2026-01-20',
      categoryId: cat!.id,
      particulars: 'Commercial deep fryer',
      payments: [{ method: 'cash', amount: '120000.00', moneyAccountId: drawer!.id }],
    } as Parameters<typeof createExpense>[2]),
  );
  const approved = await asPerson(f.orgId, (tx) => approveExpense(tx, manager(f), created.id));
  expect(approved.assetId, 'the approval did not capitalise the expense').toBeTruthy();
  await asPerson(f.orgId, (tx) => depreciateAsset(tx, admin(f), { assetId: approved.assetId!, through: '2026-02' }));
  return { expenseId: created.id, assetId: approved.assetId! };
}

const march = (f: Fixture, assetId: string) => (tx: Tx) =>
  depreciateAsset(tx, admin(f), { assetId, through: '2026-03' });
const retire = (f: Fixture, expenseId: string) => (tx: Tx) =>
  retireAssetFromVoidedExpense(tx, admin(f), { expenseId, expenseBusinessDate: '2026-01-20', reason: 'T-516 test' });

/**
 * A runs `first`, then holds its transaction open. B starts only after A has done its work, and runs
 * `second`. B must still be pending after PAUSE_MS (that is the proof it is blocked on A's lock); then A
 * commits and B finishes (or is refused). Resolves with B's outcome and whether B waited.
 */
async function race<TB>(
  f: Fixture,
  first: (tx: Tx) => Promise<unknown>,
  second: (tx: Tx) => Promise<TB>,
): Promise<{ waited: boolean; value?: TB; error?: string }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let didWork!: () => void;
  const worked = new Promise<void>((r) => (didWork = r));
  const a = asPerson(f.orgId, async (tx) => {
    await first(tx);
    didWork();
    await gate;
  });
  await Promise.race([worked, a]); // if A itself throws, fail here instead of hanging on the gate

  let done = false;
  const b = asPerson(f.orgId, second).then(
    (value) => ({ value }) as { value?: TB; error?: string },
    // a refusal carries the person's sentence in userMessage ("What this would reverse has changed..."); message is the raw one
    (e: Error & { userMessage?: string }) => ({ error: e.userMessage ?? e.message }) as { value?: TB; error?: string },
  );
  void b.then(() => (done = true));
  await sleep(PAUSE_MS);
  const waited = !done;
  release();
  await a;
  return { waited, ...(await b) };
}

/** The planToken of the REAL unconfirmed refusal, taken in its own (rolled back) transaction before the race. */
async function refusalToken(f: Fixture, run: (tx: Tx) => Promise<unknown>): Promise<string> {
  const err = await asPerson(f.orgId, run).then(
    () => undefined,
    (e: Error & { planToken?: string }) => e,
  );
  expect(err?.planToken, 'the unconfirmed call did not refuse with a planToken').toMatch(/^[0-9a-f]{16}$/);
  return err!.planToken!;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-516 - retire, in-service change and the store-opening cascade serialise with depreciation on the asset row', () => {
  it('(a) retire from a voided expense: March run posted but uncommitted; the retire waits, then reverses Jan+Feb+Mar; asset disposed, no live depreciation, 1590 net zero', async () => {
    const f = await setup('a');
    const { expenseId, assetId } = await expenseAsset(f);
    expect(await liveDepreciation(f.orgId, assetId)).toBe(2);

    const out = await race(f, march(f, assetId), retire(f, expenseId));

    expect(out.waited, 'the retire did not wait for the depreciation run (no asset row lock)').toBe(true);
    expect(out.error).toBeUndefined();
    expect(await statusOf(assetId)).toBe('disposed');
    expect(await liveDepreciation(f.orgId, assetId), 'a retired asset still has live depreciation (March left standing)').toBe(0);
    expect(await balance(f.orgId, '1590')).toBe('0.00');
    expect(out.value).toEqual({ assetId, depreciationEntriesReversed: 3 });
  });

  it('(b) in-service change with a token confirmed on Jan+Feb: a March run commits first; the change waits, then is refused as stale; nothing reversed, date unchanged', async () => {
    const f = await setup('b');
    const assetId = await janFebAsset(f);
    const before = await inServiceOf(assetId);
    const change = (confirmedPlan?: string) => (tx: Tx) =>
      setAssetInService(tx, admin(f), assetId, {
        mode: 'set',
        inServiceOn: '2026-12-01',
        reason: 'T-516 test',
        ...(confirmedPlan ? { confirmedPlan } : {}),
      });
    const staleToken = await refusalToken(f, change());

    const out = await race(f, march(f, assetId), change(staleToken));

    expect(out.waited, 'the in-service change did not wait for the depreciation run (no asset row lock)').toBe(true);
    expect(out.error).toMatch(/What this would reverse has changed since you confirmed/);
    expect(await inServiceOf(assetId)).toEqual(before);
    expect(await liveDepreciation(f.orgId, assetId)).toBe(3);
    expect(await balance(f.orgId, '1590')).toBe('15000.00');
  });

  it('(c) opposite order: the retire holds open; the March run waits, then posts nothing; asset disposed, no live depreciation, 1590 net zero', async () => {
    const f = await setup('c');
    const { expenseId, assetId } = await expenseAsset(f);

    const out = await race(f, retire(f, expenseId), march(f, assetId));

    expect(out.waited, 'the depreciation run did not wait for the retire (no asset row lock)').toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual([]);
    expect(await statusOf(assetId)).toBe('disposed');
    expect(await liveDepreciation(f.orgId, assetId)).toBe(0);
    expect(await balance(f.orgId, '1590')).toBe('0.00');
  });

  it('(e) store opening-date cascade with a token confirmed on Jan+Feb: a March run on the follower commits first; the change waits, then is refused as stale; nothing reversed, date unchanged', async () => {
    // Store opens 2026-01-20, after the 2026-01-15 acquisition: the asset follows the store (store_opening).
    const f = await setup('e', '2026-01-20');
    const assetId = await janFebAsset(f);
    const before = await inServiceOf(assetId);
    expect(before.source).toBe('store_opening');
    const change = (confirmedPlan?: string) => (tx: Tx) =>
      setStoreOpeningDate(tx, admin(f), f.storeId, {
        openingDate: '2026-12-01',
        ...(confirmedPlan ? { confirmedPlan } : {}),
      });
    const staleToken = await refusalToken(f, change());

    const out = await race(f, march(f, assetId), change(staleToken));

    expect(out.waited, 'the opening-date change did not wait for the depreciation run (no follower lock)').toBe(true);
    expect(out.error).toMatch(/has changed since you confirmed/);
    expect(await storeOpeningDate(f.storeId)).toBe('2026-01-20');
    expect(await inServiceOf(assetId)).toEqual(before);
    expect(await liveDepreciation(f.orgId, assetId)).toBe(3);
    expect(await balance(f.orgId, '1590')).toBe('15000.00');
  });
});
