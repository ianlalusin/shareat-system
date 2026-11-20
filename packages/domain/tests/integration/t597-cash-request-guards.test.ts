import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { cashRequestsRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
  settleCashRequest,
  cancelCashRequest,
  createSupplier,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { heldRace } from './_fixtures/held-race';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actorOf = (orgId: string, personId: string): Actor => ({ orgId, personId });

async function fundAccount(orgId: string, storeId: string, code: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
    const [target] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 1, ${target!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${equity!.id}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staffId: string;
  managerId: string;
  staffFloatId: string;
  officeSafeId: string;
  otherOfficeSafeId: string;
  drawerId: string;
  categoryId: string;
  supplierId: string;
  supplier2Id: string;
  fileId: string;
  holder: string;
  manager: Actor;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t415-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${`${name} ${hint}`}) returning id`)[0]!.id;
  const storeId = await mkStore('A');
  const otherStoreId = await mkStore('B');

  const person = async (name: string, role: 'staff' | 'manager') => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const staffId = await person(`${hint} Ana`, 'staff');
  const managerId = await person(`${hint} Manager`, 'manager');
  const grant = async (sid: string) => {
    const [employment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${sid}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId, storeId: sid, employmentId: employment!.id, personId: staffId, setBy: managerId });
  };
  await grant(storeId);
  await grant(otherStoreId);

  const account = async (sid: string, custodian: 'staff' | 'office' | 'cashier') => {
    const [row] = await sql<{ id: string }[]>`
      select id from money_accounts where org_id = ${orgId} and store_id = ${sid} and custodian = ${custodian} and instrument = 'cash' order by created_at limit 1`;
    return row!.id;
  };
  await fundAccount(orgId, storeId, '1130', '500000.00');
  await fundAccount(orgId, otherStoreId, '1130', '500000.00');

  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const manager = actorOf(orgId, managerId);
  const supplier = await asPerson(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
  const supplier2 = await asPerson(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier Two`, creditTermsDays: 30 }));
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/${hint}.jpg`}, 'image/jpeg', 1024, ${`sum-${code}`}, ${staffId}) returning id`;
  return {
    orgId, storeId, otherStoreId, staffId, managerId,
    staffFloatId: await account(storeId, 'staff'),
    officeSafeId: await account(storeId, 'office'),
    otherOfficeSafeId: await account(otherStoreId, 'office'),
    drawerId: await account(storeId, 'cashier'),
    categoryId: category!.id, supplierId: supplier.id, supplier2Id: supplier2.id, fileId: file!.id,
    holder: `${hint} Ana`, manager,
  };
}

/** Request -> approve -> release (from a safe) through the real domain functions. */
async function releasedFloat(f: Fixture, amount: string, storeId = f.storeId, fromSafe = f.officeSafeId, holderId = f.staffId): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createCashRequest(tx, f.manager, { storeId, requestedFor: holderId, purpose: 'Market run', amount, on: '2026-01-05' }),
  );
  await asPerson(f.orgId, (tx) => decideCashRequest(tx, f.manager, { requestId: id, decision: 'approve', amount, on: '2026-01-05' }));
  await asPerson(f.orgId, (tx) => releaseCashRequest(tx, f.manager, { requestId: id, amount, fromMoneyAccountId: fromSafe, on: '2026-01-05' }));
  return id;
}


// ---- helpers for T-597 ----
const requestStatus = async (id: string) => (await sql<{ status: string }[]>`select status from cash_requests where id = ${id}`)[0]!.status;
const outstandingOf = async (f: Fixture, id: string) =>
  (await asPerson(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, id))).outstanding;
const entriesOf = async (id: string, type: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where source_id = ${id} and source_type = ${type}`)[0]!.n);

/** The refusal's `userMessage`; falls back to the raw message; a marker when the call SUCCEEDED. */
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? (err as Error).message;
  }
  return '<<NO REFUSAL - THE CALL SUCCEEDED>>';
}

async function approvedRequest(f: Fixture, amount: string): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createCashRequest(tx, f.manager, { storeId: f.storeId, requestedFor: f.staffId, purpose: 'Market run', amount, on: '2026-01-05' }),
  );
  await asPerson(f.orgId, (tx) => decideCashRequest(tx, f.manager, { requestId: id, decision: 'approve', amount, on: '2026-01-05' }));
  return id;
}

type SettleArgs = { returnedAmount?: string; shortAmount?: string; shortReason?: string; toMoneyAccountId?: string; on?: string; settleId?: string };
const settleOp = (f: Fixture, requestId: string, a: SettleArgs) => (tx: Tx) =>
  settleCashRequest(tx, f.manager, { requestId, settleId: crypto.randomUUID(), on: '2026-01-08', ...a });
const settleWith = (f: Fixture, requestId: string, a: SettleArgs) => asPerson(f.orgId, settleOp(f, requestId, a));

const STALE_FORM = 'This form is out of date. Reload the page and try again.';
const DIFFERENT_FIGURES = /already recorded with different figures/;

// ---------------------------------------------------------------------------------------------------------------------
// DEF-885: a settle is keyed on the form's settleId, not on (date, amount)
// ---------------------------------------------------------------------------------------------------------------------
describe('DEF-885 - two settles, two settle ids', () => {
  it('two 500 returns on one day post TWO entries and the float drops by 1,000', async () => {
    const f = await setup('d885a');
    const req = await releasedFloat(f, '2000.00');
    const one = await settleWith(f, req, { returnedAmount: '500.00', toMoneyAccountId: f.officeSafeId });
    const two = await settleWith(f, req, { returnedAmount: '500.00', toMoneyAccountId: f.officeSafeId });
    expect(two.entryIds[0]).not.toBe(one.entryIds[0]);
    expect(await entriesOf(req, 'cash_request_return')).toBe(2);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });
});

describe('DEF-885 - the same settle id is a replay', () => {
  it('twice in a row: one entry, the second call hands back the same entry and does not refuse', async () => {
    const f = await setup('d885b');
    const req = await releasedFloat(f, '2000.00');
    const settleId = crypto.randomUUID();
    const first = await settleWith(f, req, { settleId, returnedAmount: '500.00', toMoneyAccountId: f.officeSafeId });
    const second = await settleWith(f, req, { settleId, returnedAmount: '500.00', toMoneyAccountId: f.officeSafeId });
    expect(second.entryIds).toEqual(first.entryIds);
    expect(await entriesOf(req, 'cash_request_return')).toBe(1);
    expect(await outstandingOf(f, req)).toBe('1500.00');
  });

  it('a replay of the call that CLOSED the request answers the same way instead of "already liquidated"', async () => {
    const f = await setup('d885c');
    const req = await releasedFloat(f, '1000.00');
    const settleId = crypto.randomUUID();
    const first = await settleWith(f, req, { settleId, returnedAmount: '1000.00', toMoneyAccountId: f.officeSafeId });
    expect(first.liquidated).toBe(true);
    const second = await settleWith(f, req, { settleId, returnedAmount: '1000.00', toMoneyAccountId: f.officeSafeId });
    expect(second.entryIds).toEqual(first.entryIds);
    expect(second.liquidated).toBe(true);
    expect(await requestStatus(req)).toBe('liquidated');
  });

  it('the same id with a different amount is refused as "different figures"; nothing new is written', async () => {
    const f = await setup('d885d');
    const req = await releasedFloat(f, '2000.00');
    const settleId = crypto.randomUUID();
    await settleWith(f, req, { settleId, returnedAmount: '500.00', toMoneyAccountId: f.officeSafeId });
    expect(await messageOf(settleWith(f, req, { settleId, returnedAmount: '600.00', toMoneyAccountId: f.officeSafeId }))).toMatch(DIFFERENT_FIGURES);
    expect(await entriesOf(req, 'cash_request_return')).toBe(1);
  });

  it('C1: the same id that ADDS a shortage the first call did not post is not a replay - the status check runs', async () => {
    const f = await setup('d885e');
    const req = await releasedFloat(f, '1000.00');
    const settleId = crypto.randomUUID();
    await settleWith(f, req, { settleId, returnedAmount: '1000.00', toMoneyAccountId: f.officeSafeId }); // liquidates
    expect(await requestStatus(req)).toBe('liquidated');
    const msg = await messageOf(
      settleWith(f, req, { settleId, returnedAmount: '1000.00', shortAmount: '100.00', shortReason: 'Lost change', toMoneyAccountId: f.officeSafeId }),
    );
    expect(msg).toBe("d885e Ana's cash request is already liquidated, so there is nothing left to settle.");
    expect(await entriesOf(req, 'cash_request_shortage')).toBe(0);
  });

  it.each([['missing', undefined], ['garbage', 'not-a-uuid']])('a %s settle id is refused with the out-of-date sentence; nothing written', async (_n, bad) => {
    const f = await setup(`d885f${_n}`);
    const req = await releasedFloat(f, '1000.00');
    const msg = await messageOf(
      asPerson(f.orgId, (tx) =>
        settleCashRequest(tx, f.manager, { requestId: req, settleId: bad as unknown as string, returnedAmount: '100.00', toMoneyAccountId: f.officeSafeId, on: '2026-01-08' }),
      ),
    );
    expect(msg).toBe(STALE_FORM);
    expect(await entriesOf(req, 'cash_request_return')).toBe(0);
  });
});

describe('DEF-885 - concurrent: the same settle id from two tabs', () => {
  it('the second waits on the request row, replays, and posts nothing more', async () => {
    const f = await setup('d885g');
    const req = await releasedFloat(f, '2000.00');
    const settleId = crypto.randomUUID();
    const op = (tx: Tx) => settleCashRequest(tx, f.manager, { requestId: req, settleId, returnedAmount: '500.00', toMoneyAccountId: f.officeSafeId, on: '2026-01-08' });
    const [a, b] = await heldRace(asPerson, f.orgId, op, op, 700, { sql });
    expect(b.entryIds).toEqual(a.entryIds);
    expect(await entriesOf(req, 'cash_request_return')).toBe(1);
    expect(await outstandingOf(f, req)).toBe('1500.00');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// DEF-887: cancel racing release
// ---------------------------------------------------------------------------------------------------------------------
describe('DEF-887 - release held open vs cancel', () => {
  it('the cancel waits, then is refused "already released"; the request stays released and 1120 holds the amount', async () => {
    const f = await setup('d887a');
    const req = await approvedRequest(f, '1000.00');
    const release = (tx: Tx) => releaseCashRequest(tx, f.manager, { requestId: req, amount: '1000.00', fromMoneyAccountId: f.officeSafeId, on: '2026-01-05' });
    const cancel = (tx: Tx) => messageOf(cancelCashRequest(tx, f.manager, { requestId: req }));
    const [, msg] = await heldRace(asPerson, f.orgId, release, cancel, 700, { sql });
    expect(msg).toBe('This cash request has already been released, so it cannot be withdrawn. Record what comes back instead.');
    expect(await requestStatus(req)).toBe('released');
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });

  it('reverse: cancel held open vs a release - the release is refused, no entry, status cancelled', async () => {
    const f = await setup('d887b');
    const req = await approvedRequest(f, '1000.00');
    const cancel = (tx: Tx) => cancelCashRequest(tx, f.manager, { requestId: req });
    const release = (tx: Tx) =>
      messageOf(releaseCashRequest(tx, f.manager, { requestId: req, amount: '1000.00', fromMoneyAccountId: f.officeSafeId, on: '2026-01-05' }));
    const [, msg] = await heldRace(asPerson, f.orgId, cancel, release, 700, { sql });
    expect(msg).toMatch(/is cancelled — only an approved one can be released/);
    expect(await requestStatus(req)).toBe('cancelled');
    expect(await entriesOf(req, 'cash_request_release')).toBe(0);
  });
});

describe('DEF-887 - the repo update refuses a row that moved on', () => {
  it('a stale expected status -> "changed by someone else"; an unknown id -> gone', async () => {
    const f = await setup('d887c');
    const req = await approvedRequest(f, '1000.00');
    const stale = asPerson(f.orgId, (tx) => cashRequestsRepo.update(tx, f.orgId, req, { status: 'cancelled' }, 'requested'));
    expect(await messageOf(stale)).toBe('This cash request was changed by someone else a moment ago. Reload the page and look again.');
    expect(await requestStatus(req)).toBe('approved');
    const unknown = asPerson(f.orgId, (tx) => cashRequestsRepo.update(tx, f.orgId, crypto.randomUUID(), { status: 'cancelled' }, 'requested'));
    expect(await messageOf(unknown)).toMatch(/does not exist|cash request/i);
    // positive: a matching expected status updates
    await asPerson(f.orgId, (tx) => cashRequestsRepo.update(tx, f.orgId, req, { status: 'cancelled' }, ['requested', 'approved']));
    expect(await requestStatus(req)).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// DEF-886: settle and release only use this store's live accounts
// ---------------------------------------------------------------------------------------------------------------------
const retire = (id: string) => sql`update money_accounts set is_active = false where id = ${id}`;

describe('DEF-886 - the returned cash goes into this store account, and a live one', () => {
  it("another store's account is refused; no entry; the float is unchanged", async () => {
    const f = await setup('d886a');
    const req = await releasedFloat(f, '1000.00');
    const msg = await messageOf(settleWith(f, req, { returnedAmount: '400.00', toMoneyAccountId: f.otherOfficeSafeId }));
    expect(msg).toBe("That money account belongs to another store. Choose one of this store's accounts for the returned cash.");
    expect(await entriesOf(req, 'cash_request_return')).toBe(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });

  it('a retired account is refused; the same account live takes the cash', async () => {
    const f = await setup('d886b');
    const req = await releasedFloat(f, '1000.00');
    await retire(f.drawerId);
    const msg = await messageOf(settleWith(f, req, { returnedAmount: '400.00', toMoneyAccountId: f.drawerId }));
    expect(msg).toMatch(/^".+" is retired and cannot take the returned cash\. Choose another account\.$/);
    expect(await entriesOf(req, 'cash_request_return')).toBe(0);
    // positive: an active same-store account posts
    const ok = await settleWith(f, req, { returnedAmount: '400.00', toMoneyAccountId: f.officeSafeId });
    expect(ok.entryIds).toHaveLength(1);
    expect(await outstandingOf(f, req)).toBe('600.00');
  });

  it('a replay still succeeds after the account was retired (the first call passed the check)', async () => {
    const f = await setup('d886c');
    const req = await releasedFloat(f, '1000.00');
    const settleId = crypto.randomUUID();
    const first = await settleWith(f, req, { settleId, returnedAmount: '400.00', toMoneyAccountId: f.drawerId });
    await retire(f.drawerId);
    const again = await settleWith(f, req, { settleId, returnedAmount: '400.00', toMoneyAccountId: f.drawerId });
    expect(again.entryIds).toEqual(first.entryIds);
  });

  it('a release from a retired account is refused; no entry; still approved', async () => {
    const f = await setup('d886d');
    const req = await approvedRequest(f, '1000.00');
    await retire(f.drawerId);
    const msg = await messageOf(
      asPerson(f.orgId, (tx) => releaseCashRequest(tx, f.manager, { requestId: req, amount: '1000.00', fromMoneyAccountId: f.drawerId, on: '2026-01-05' })),
    );
    expect(msg).toMatch(/^".+" is retired\. Choose another account to release from\.$/);
    expect(await requestStatus(req)).toBe('approved');
    expect(await entriesOf(req, 'cash_request_release')).toBe(0);
  });
});
