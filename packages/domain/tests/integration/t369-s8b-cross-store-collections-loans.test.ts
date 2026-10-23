import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S8b (DEF-556; Ian ruling (a) for Q5, 2026-10-02) — collections and loans across stores. `docs/tasks/369-unwired-money-screens.md` §S8b.
 * The money-account line goes at the ACCOUNT's store; the 1250/2150 pair runs in the direction of the money: money OUT of a store
 * (loan payment, S8's direction) -> DR 1250 at the paying store / CR 2150 at the owing store; money IN to another store
 * (collection, disbursement; NEW) -> DR 1250 at the OWING store / CR 2150 at the receiving store. A new `transfer_funds` gate at the
 * account's store applies to all three writers. T8 (the helper) is the updated `tests/unit/inter-store-legs.test.ts`.
 *
 * MUTANTS (each turns a NAMED test red; none is planted in the tree):
 *   (i)   keep the money line at the document's store          -> T1, T5, T6 (balanceOf asserts)
 *   (ii)  keep S8's debit refusal in the helper                -> T1, T2, T6 (the call throws)
 *   (iii) do not mirror the direction (DR 1250 at the receiving store) -> T1/T6 party+side asserts and the per-store tie
 *   (iv)  drop the new transfer_funds gate                     -> T4
 *   (v)   build the collection's pair from amount, not cash    -> T2 (4,250 vs 5,000)
 *
 * Fixture: S8's two-store shape (Lipa-only manager, admin at both, Lipa staff); a Lipa customer with charges; a Lipa loan.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { arRepo, closeDb, loansRepo, moneyAccountsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createCustomer,
  createLoan,
  createSupplier,
  disburseLoan,
  listFindings,
  recordCharge,
  recordCollection,
  recordLoanPayment,
  reverseLoanEntry,
  voidCollection,
} from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// -----------------------------------------------------------------------------------------------
// Fixture
// -----------------------------------------------------------------------------------------------

interface Account { id: string; glCode: string; storeId: string }
async function foundation(storeId: string, instrument: string, custodian: string): Promise<Account> {
  const [row] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts
    where store_id = ${storeId} and instrument = ${instrument} and custodian = ${custodian} and is_foundation`;
  if (!row) throw new Error(`fixture: no foundation ${custodian} ${instrument} account at store ${storeId}`);
  return { id: row.id, glCode: row.gl_account_code, storeId };
}

async function fixture(hint: string) {
  const code = uid(`t369s8-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const lipaCode = uid('lipa');
  const malvarCode = uid('malvar');
  const [lipa] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${lipaCode}, 'Lipa') returning id`;
  const [malvar] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${malvarCode}, 'Malvar') returning id`;
  const lipaId = lipa!.id;
  const malvarId = malvar!.id;

  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await mk('Lipa Manager', 'manager', [lipaId]);
  const adminId = await mk('Admin', 'admin', [lipaId, malvarId]);
  const staffId = await mk('Lipa Staff', 'staff', [lipaId]);
  const anaId = await mk('Ana Reyes', 'staff', [lipaId]);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${lipaId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId: lipaId, employmentId: emp!.id, personId: staffId, setBy: managerId });

  const lipaCash = await foundation(lipaId, 'cash', 'cashier');
  const lipaSafe = await foundation(lipaId, 'cash', 'office');
  const malvarSafe = await foundation(malvarId, 'cash', 'office');
  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  for (const [storeId, acct] of [[lipaId, lipaCash], [lipaId, lipaSafe], [malvarId, malvarSafe]] as const) {
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'),
        memo: 'fixture funding', postedBy: adminId,
        lines: [{ accountCode: acct.glCode, storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
      }),
    );
  }
  const manager = actor(orgId, managerId);
  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
  return {
    orgId, lipaId, malvarId, lipaCode, malvarCode, categoryId: category!.id, supplierId: supplier.id,
    manager, admin: actor(orgId, adminId), staff: actor(orgId, staffId),
    managerId, adminId, staffId, anaId, lipaCash, lipaSafe, malvarSafe,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** What the store owes Ana: DR 6200 / CR 2130 (party = employee), exactly what `routeExpense` writes for a reimbursable. */
async function owe(f: Fixture, amount: string): Promise<void> {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-05', sourceType: 'manual_journal', sourceId: uid('owe'), idempotencyKey: uid('owe'),
      memo: 'fixture reimbursable expense', postedBy: f.adminId,
      lines: [
        { accountCode: '6200', storeId: f.lipaId, debit: amount },
        { accountCode: '2130', storeId: f.lipaId, credit: amount, partyType: 'employee', partyId: f.anaId },
      ],
    }),
  );
}

const bal = (f: Fixture, a: Account) => asOrg(f.orgId, (tx) => moneyAccountsRepo.balanceOf(tx, f.orgId, { id: a.id, glAccountCode: a.glCode, storeId: a.storeId }));
const snapshot = async (f: Fixture) => ({ lipaCash: await bal(f, f.lipaCash), lipaSafe: await bal(f, f.lipaSafe), malvarSafe: await bal(f, f.malvarSafe) });

interface Line { code: string; store_id: string | null; debit: string; credit: string; party_type: string | null; party_id: string | null }
async function linesFor(entryId: string): Promise<Line[]> {
  return sql<Line[]>`
    select a.code, jl.store_id, jl.debit::numeric(14,2)::text as debit, jl.credit::numeric(14,2)::text as credit, jl.party_type, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by a.code, jl.line_no`;
}
/** Every store's lines in this entry net to zero (S8's per-store tie; the org total alone ties on HEAD too). */
async function expectEachStoreTies(entryId: string, what: string) {
  const rows = await sql<{ store_id: string | null; net: string }[]>`
    select store_id, (sum(debit) - sum(credit))::numeric(14,2)::text as net from journal_lines where entry_id = ${entryId} group by store_id order by store_id`;
  for (const r of rows) expect(r.net, `${what}: store ${r.store_id} does not net to zero on its own`).toBe('0.00');
}
/** 1250 / 2150 net (debit − credit) at one store, over every non-draft entry of the org. */
async function interStoreNet(orgId: string, storeId: string, code: '1250' | '2150'): Promise<string> {
  const [r] = await sql<{ n: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2)::text as n
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = ${code} and jl.store_id = ${storeId}`;
  return r!.n;
}
const reciprocalFindings = (f: Fixture) =>
  asOrg(f.orgId, async (tx) => (await listFindings(tx, f.orgId, { period: '2026-01' })).findings.filter((x) => x.kind === 'dueFromDueToNotReciprocal'));
const shape = (l: Line[]) => l.map((x) => `${x.code}|${x.store_id}|${x.debit}|${x.credit}|${x.party_type ?? ''}|${x.party_id ?? ''}`).sort();

async function rejection(p: Promise<unknown>, what: string): Promise<{ err: unknown }> {
  try {
    await p;
  } catch (err) {
    return { err };
  }
  throw new Error(`NOT REFUSED — ${what} posted instead`);
}
const entryCount = async (orgId: string, types: string[]) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = any(${types})`)[0]!.n);

// -----------------------------------------------------------------------------------------------
// S8b fixtures: a Lipa customer with open charges, a Lipa loan
// -----------------------------------------------------------------------------------------------

async function customerOf(f: Fixture): Promise<string> {
  return (await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Resto ${uid('c')}` }))).id;
}
const charge = (f: Fixture, customerId: string, amount: string, on = '2026-01-10') =>
  asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.manager, { storeId: f.lipaId, customerId, chargeDate: on, dueDate: null, totalAmount: amount, revenueAccountCode: '4150' }),
  );
const collect = (f: Fixture, who: Actor, customerId: string, into: Account, amount: string, allocations: { chargeId: string; amountApplied: string }[], extra: { platformFee?: string; creditApplied?: string } = {}) =>
  asOrg(f.orgId, (tx) =>
    recordCollection(tx, who, { storeId: f.lipaId, customerId, collectionDate: '2026-01-16', amount, moneyAccountId: into.id, allocations, ...extra }),
  );
const controlBalance = (f: Fixture, customerId: string) =>
  asOrg(f.orgId, async (tx) => (await arRepo.positionOf(tx, f.orgId, customerId)).controlBalance);

async function newLoan(f: Fixture): Promise<string> {
  const loan = await asOrg(f.orgId, (tx) =>
    createLoan(tx, f.admin, {
      storeId: f.lipaId, lenderName: 'Grab', name: `Grab advance ${uid('l')}`, principalAmount: '200000.00', interestRate: '2', ratePeriod: 'month',
      interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: '2026-01-11',
    }),
  );
  return loan.id;
}
const disburse = (f: Fixture, who: Actor, loanId: string, into: Account, amount = '50000.00') =>
  asOrg(f.orgId, (tx) => disburseLoan(tx, who, { loanId, amount, intoMoneyAccountId: into.id, on: '2026-01-11' }));
const loanPay = (f: Fixture, who: Actor, loanId: string, from: Account, amount = '4800.00') =>
  asOrg(f.orgId, (tx) => recordLoanPayment(tx, who, { loanId, amount, fromMoneyAccountId: from.id, on: '2026-01-12' }));
const loanOutstanding = (f: Fixture, loanId: string) => asOrg(f.orgId, async (tx) => (await loansRepo.positionOf(tx, f.orgId, loanId)).outstanding);
const noInterStore = (l: Line[]) => l.filter((x) => x.code === '1250' || x.code === '2150');

// -----------------------------------------------------------------------------------------------
// T1 / T2 — recordCollection into ANOTHER store's safe (money IN: the pair runs the other way)
// -----------------------------------------------------------------------------------------------

describe("T1 — the admin collects Lipa's ₱2,000 charge into MALVAR's safe", () => {
  it("exactly four lines; Malvar's safe +2,000, Lipa's cash and safe unchanged; 1250 at Lipa +2,000 and 2150 at Malvar −2,000; every store nets 0.00; no reciprocal finding; the charge is cleared — red on HEAD: the debit sits at Lipa", async () => {
    const f = await fixture('t1');
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const before = await snapshot(f);

    const r = await collect(f, f.admin, customerId, f.malvarSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]);

    expect(shape(await linesFor(r.entryId))).toEqual(
      shape([
        { code: '1130', store_id: f.malvarId, debit: '2000.00', credit: '0.00', party_type: null, party_id: null },
        { code: '2150', store_id: f.malvarId, debit: '0.00', credit: '2000.00', party_type: 'store', party_id: f.lipaCode },
        { code: '1250', store_id: f.lipaId, debit: '2000.00', credit: '0.00', party_type: 'store', party_id: f.malvarCode },
        { code: '1210', store_id: f.lipaId, debit: '0.00', credit: '2000.00', party_type: 'customer', party_id: customerId },
      ]),
    );
    const after = await snapshot(f);
    expect(Number(after.malvarSafe) - Number(before.malvarSafe), "Malvar's safe did not rise by exactly 2,000.00").toBe(2000);
    expect(after.lipaCash, "Lipa's cash moved").toBe(before.lipaCash);
    expect(after.lipaSafe, "Lipa's safe moved").toBe(before.lipaSafe);
    expect(await interStoreNet(f.orgId, f.lipaId, '1250')).toBe('2000.00');
    expect(await interStoreNet(f.orgId, f.malvarId, '2150')).toBe('-2000.00');
    await expectEachStoreTies(r.entryId, 'collection');
    expect(await reciprocalFindings(f)).toEqual([]);
    expect(await controlBalance(f, customerId), 'the charge is not cleared').toBe('0.00');
  });
});

describe('T2 — every optional leg: ₱5,000 into Malvar\'s safe, ₱250 fee, ₱500 store credit applied, ₱300 surplus', () => {
  it('the pair is for the CASH portion only (₱4,250); 6400 and both 2140 lines stay at Lipa — Mutant (v): a pair built from `amount` -> red', async () => {
    const f = await fixture('t2');
    const customerId = await customerOf(f);
    // ₱500 of store credit first (a same-store overpayment at Lipa).
    const first = await charge(f, customerId, '1000.00', '2026-01-05');
    await collect(f, f.manager, customerId, f.lipaSafe, '1500.00', [{ chargeId: first.chargeId, amountApplied: '1000.00' }]);
    const second = await charge(f, customerId, '4700.00', '2026-01-08');

    const r = await collect(f, f.admin, customerId, f.malvarSafe, '5000.00', [{ chargeId: second.chargeId, amountApplied: '4700.00' }], { platformFee: '250.00', creditApplied: '500.00' });

    const lines = await linesFor(r.entryId);
    expect(shape(lines)).toEqual(
      shape([
        { code: '1130', store_id: f.malvarId, debit: '4250.00', credit: '0.00', party_type: null, party_id: null },
        { code: '2150', store_id: f.malvarId, debit: '0.00', credit: '4250.00', party_type: 'store', party_id: f.lipaCode },
        { code: '1250', store_id: f.lipaId, debit: '4250.00', credit: '0.00', party_type: 'store', party_id: f.malvarCode },
        { code: '2140', store_id: f.lipaId, debit: '500.00', credit: '0.00', party_type: 'customer', party_id: customerId },
        { code: '6400', store_id: f.lipaId, debit: '250.00', credit: '0.00', party_type: null, party_id: null },
        { code: '1210', store_id: f.lipaId, debit: '0.00', credit: '4700.00', party_type: 'customer', party_id: customerId },
        { code: '2140', store_id: f.lipaId, debit: '0.00', credit: '300.00', party_type: 'customer', party_id: customerId },
      ]),
    );
    await expectEachStoreTies(r.entryId, 'the all-legs collection');
  });
});

describe("T3 (positive control, same store) — collection into LIPA's own safe, one loan payment, one disbursement", () => {
  it('no 1250/2150 line anywhere; every line at Lipa; the collection is exactly the pre-S8b two lines — Mutant (iv) appends the pair unconditionally -> red', async () => {
    const f = await fixture('t3');
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const c = await collect(f, f.manager, customerId, f.lipaSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]);
    expect(shape(await linesFor(c.entryId))).toEqual(
      shape([
        { code: '1130', store_id: f.lipaId, debit: '2000.00', credit: '0.00', party_type: null, party_id: null },
        { code: '1210', store_id: f.lipaId, debit: '0.00', credit: '2000.00', party_type: 'customer', party_id: customerId },
      ]),
    );
    const loanId = await newLoan(f);
    const d = await disburse(f, f.admin, loanId, f.lipaSafe);
    const p = await loanPay(f, f.admin, loanId, f.lipaSafe);
    for (const entryId of [d.entryId, p.entryId]) {
      const lines = await linesFor(entryId);
      expect(noInterStore(lines), 'a same-store loan entry grew an inter-store pair').toEqual([]);
      expect(lines.every((l) => l.store_id === f.lipaId)).toBe(true);
    }
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T4 — the new transfer_funds gate, in all three writers
// -----------------------------------------------------------------------------------------------

describe("T4 (✗, new gate) — the Lipa-only manager naming MALVAR's safe is refused by transfer_funds, in each writer on its own", () => {
  const types = ['ar_collection', 'loan_disbursement', 'loan_payment'];
  const collectionRows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from ar_collections where org_id = ${orgId}`)[0]!.n);
  /** The refusal is authorize()'s scope error: the capability is on `err.capability`, not in the message. */
  const expectGate = (err: unknown) => {
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).capability).toBe('transfer_funds');
  };

  it('recordCollection into Malvar\'s safe: AuthorizationError(transfer_funds); no entry, no ar_collections row, Malvar\'s safe unchanged — control: the admin collects the same charge', async () => {
    const f = await fixture('t4c');
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const safe = await bal(f, f.malvarSafe);
    const entries = await entryCount(f.orgId, types);
    const rows = await collectionRows(f.orgId);

    const refused = await rejection(collect(f, f.manager, customerId, f.malvarSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]), "a collection into Malvar's safe by a Lipa-only manager");

    expectGate(refused.err);
    expect(await entryCount(f.orgId, types), 'a refused collection left an entry behind').toBe(entries);
    expect(await collectionRows(f.orgId), 'a refused collection left an ar_collections row').toBe(rows);
    expect(await bal(f, f.malvarSafe), "Malvar's safe moved").toBe(safe);
    expect(await controlBalance(f, customerId), 'the charge was cleared by a refused collection').toBe('2000.00');
    const control = await collect(f, f.admin, customerId, f.malvarSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]);
    expect(control.entryId, 'control: the admin (holds transfer_funds at both stores) collects it').toBeTruthy();
  });

  it('disburseLoan into Malvar\'s safe: AuthorizationError(transfer_funds); no entry, the loan position unchanged, Malvar\'s safe unchanged — control: the admin disburses', async () => {
    const f = await fixture('t4d');
    const loanId = await newLoan(f);
    const outstanding = await loanOutstanding(f, loanId);
    const safe = await bal(f, f.malvarSafe);
    const entries = await entryCount(f.orgId, types);

    const refused = await rejection(disburse(f, f.manager, loanId, f.malvarSafe, '1000.00'), "a loan disbursement into Malvar's safe by a Lipa-only manager");

    expectGate(refused.err);
    expect(await entryCount(f.orgId, types), 'a refused disbursement left an entry behind').toBe(entries);
    expect(await loanOutstanding(f, loanId), 'the loan position moved').toBe(outstanding);
    expect(await bal(f, f.malvarSafe), "Malvar's safe moved").toBe(safe);
    const control = await disburse(f, f.admin, loanId, f.malvarSafe, '1000.00');
    expect(control.entryId, 'control: the admin disburses into the same safe').toBeTruthy();
  });

  it('recordLoanPayment out of Malvar\'s safe: AuthorizationError(transfer_funds); no entry, the loan position unchanged, Malvar\'s safe unchanged — control: the admin pays', async () => {
    const f = await fixture('t4p');
    const loanId = await newLoan(f);
    await disburse(f, f.admin, loanId, f.lipaSafe);
    const outstanding = await loanOutstanding(f, loanId);
    const safe = await bal(f, f.malvarSafe);
    const entries = await entryCount(f.orgId, types);

    const refused = await rejection(loanPay(f, f.manager, loanId, f.malvarSafe), "a loan payment out of Malvar's safe by a Lipa-only manager");

    expectGate(refused.err);
    expect(await entryCount(f.orgId, types), 'a refused payment left an entry behind').toBe(entries);
    expect(await loanOutstanding(f, loanId), 'the loan position moved').toBe(outstanding);
    expect(await bal(f, f.malvarSafe), "Malvar's safe moved").toBe(safe);
    const control = await loanPay(f, f.admin, loanId, f.malvarSafe);
    expect(control.entryId, 'control: the admin pays from the same safe').toBeTruthy();
  });
});

// -----------------------------------------------------------------------------------------------
// T5 / T6 — the loan writers
// -----------------------------------------------------------------------------------------------

describe("T5 — a ₱4,800 Lipa loan payment from MALVAR's safe (money OUT: S8's direction)", () => {
  it("Malvar's safe −4,800; 2400 at Lipa down by the computed principal, 7200 at Lipa the computed interest; DR 1250 Malvar / CR 2150 Lipa for 4,800; every store ties; checkDraw still refuses a payment larger than Malvar's safe holds", async () => {
    const f = await fixture('t5');
    const loanId = await newLoan(f);
    await disburse(f, f.admin, loanId, f.lipaSafe, '200000.00');
    const before = await snapshot(f);

    const r = await loanPay(f, f.admin, loanId, f.malvarSafe);

    expect(shape(await linesFor(r.entryId))).toEqual(
      shape([
        { code: '2400', store_id: f.lipaId, debit: r.split.principal, credit: '0.00', party_type: 'loan', party_id: loanId },
        { code: '7200', store_id: f.lipaId, debit: r.split.interest, credit: '0.00', party_type: null, party_id: null },
        { code: '1130', store_id: f.malvarId, debit: '0.00', credit: '4800.00', party_type: null, party_id: null },
        { code: '1250', store_id: f.malvarId, debit: '4800.00', credit: '0.00', party_type: 'store', party_id: f.lipaCode },
        { code: '2150', store_id: f.lipaId, debit: '0.00', credit: '4800.00', party_type: 'store', party_id: f.malvarCode },
      ]),
    );
    const after = await snapshot(f);
    expect(Number(before.malvarSafe) - Number(after.malvarSafe), "Malvar's safe did not fall by exactly 4,800.00").toBe(4800);
    expect(after.lipaSafe, "Lipa's safe moved").toBe(before.lipaSafe);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('4800.00');
    expect(await interStoreNet(f.orgId, f.lipaId, '2150')).toBe('-4800.00');
    await expectEachStoreTies(r.entryId, 'the loan payment');

    // checkDraw reads the PAYING account: Malvar's safe holds ~95,200 now, so 150,000 out of it is refused.
    const entriesBefore = await entryCount(f.orgId, ['loan_payment']);
    await rejection(loanPay(f, f.admin, loanId, f.malvarSafe, '150000.00'), "a payment larger than Malvar's safe holds");
    expect(await entryCount(f.orgId, ['loan_payment'])).toBe(entriesBefore);
  });
});

describe("T6 — a ₱50,000 Lipa loan drawn INTO Malvar's safe (money IN)", () => {
  it("Malvar's safe +50,000; 2400 at Lipa; DR 1250 Lipa / CR 2150 Malvar for 50,000; every store ties; no reciprocal finding — red on HEAD: the debit sits at Lipa", async () => {
    const f = await fixture('t6');
    const loanId = await newLoan(f);
    const before = await snapshot(f);

    const r = await disburse(f, f.admin, loanId, f.malvarSafe);

    expect(shape(await linesFor(r.entryId))).toEqual(
      shape([
        { code: '1130', store_id: f.malvarId, debit: '50000.00', credit: '0.00', party_type: null, party_id: null },
        { code: '2400', store_id: f.lipaId, debit: '0.00', credit: '50000.00', party_type: 'loan', party_id: loanId },
        { code: '1250', store_id: f.lipaId, debit: '50000.00', credit: '0.00', party_type: 'store', party_id: f.malvarCode },
        { code: '2150', store_id: f.malvarId, debit: '0.00', credit: '50000.00', party_type: 'store', party_id: f.lipaCode },
      ]),
    );
    const after = await snapshot(f);
    expect(Number(after.malvarSafe) - Number(before.malvarSafe), "Malvar's safe did not rise by exactly 50,000.00").toBe(50000);
    expect(after.lipaCash).toBe(before.lipaCash);
    expect(after.lipaSafe).toBe(before.lipaSafe);
    await expectEachStoreTies(r.entryId, 'the loan disbursement');
    expect(await reciprocalFindings(f)).toEqual([]);
    expect(await loanOutstanding(f, loanId)).toBe('50000.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T7 — voids mirror every line, the pair included (no code change: guards reverseEntry)
// -----------------------------------------------------------------------------------------------

describe('T7 — voidCollection and reverseLoanEntry mirror the pair', () => {
  it("voidCollection on T1: the safe returns, 1250/2150 return to 0.00, the reversal carries the same party ids, the charge is open again", async () => {
    const f = await fixture('t7c');
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const before = await snapshot(f);
    const r = await collect(f, f.admin, customerId, f.malvarSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]);
    expect(await interStoreNet(f.orgId, f.lipaId, '1250'), 'fixture: the pair was posted').toBe('2000.00');

    await asOrg(f.orgId, (tx) => voidCollection(tx, f.admin, { collectionId: r.collectionId, reason: 'Bounced' }));

    expect(await snapshot(f)).toEqual(before);
    expect(await interStoreNet(f.orgId, f.lipaId, '1250')).toBe('0.00');
    expect(await interStoreNet(f.orgId, f.malvarId, '2150')).toBe('0.00');
    const [rev] = await sql<{ id: string }[]>`select id from journal_entries where reversal_of_entry_id = ${r.entryId}`;
    const lines = await linesFor(rev!.id);
    expect(lines.find((l) => l.code === '1250')).toMatchObject({ store_id: f.lipaId, credit: '2000.00', party_type: 'store', party_id: f.malvarCode });
    expect(lines.find((l) => l.code === '2150')).toMatchObject({ store_id: f.malvarId, debit: '2000.00', party_type: 'store', party_id: f.lipaCode });
    await expectEachStoreTies(rev!.id, 'the collection reversal');
    expect(await controlBalance(f, customerId), 'the charge did not reopen').toBe('2000.00');
  });

  it("reverseLoanEntry on T5: the safe returns, 1250/2150 return to 0.00, and the loan position is back", async () => {
    const f = await fixture('t7l');
    const loanId = await newLoan(f);
    await disburse(f, f.admin, loanId, f.lipaSafe, '200000.00');
    const outstanding = await loanOutstanding(f, loanId);
    const before = await snapshot(f);
    const r = await loanPay(f, f.admin, loanId, f.malvarSafe);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250'), 'fixture: the pair was posted').toBe('4800.00');

    await asOrg(f.orgId, (tx) => reverseLoanEntry(tx, f.admin, { loanId, entryId: r.entryId, reason: 'Wrong account' }));

    expect(await snapshot(f)).toEqual(before);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('0.00');
    expect(await interStoreNet(f.orgId, f.lipaId, '2150')).toBe('0.00');
    expect(await loanOutstanding(f, loanId)).toBe(outstanding);
    const [rev] = await sql<{ id: string }[]>`select id from journal_entries where reversal_of_entry_id = ${r.entryId}`;
    const lines = await linesFor(rev!.id);
    expect(lines.find((l) => l.code === '1250')).toMatchObject({ store_id: f.malvarId, credit: '4800.00', party_id: f.lipaCode });
    await expectEachStoreTies(rev!.id, 'the loan reversal');
  });
});

// -----------------------------------------------------------------------------------------------
// T9 — a collection settled ENTIRELY by store credit moves no cash, so naming another store's account is not a cross-store draw
// -----------------------------------------------------------------------------------------------

describe("T9 — a zero-cash (credit-only) collection naming MALVAR's safe", () => {
  it("a Lipa-only manager applying ₱500 of store credit (creditApplied = amount) against a Lipa charge, naming Malvar's safe, is NOT refused: no 1250/2150, no line at Malvar, Malvar's safe unchanged, the charge cleared — control: the same call with cash > 0 IS refused (transfer_funds)", async () => {
    const f = await fixture('t9');
    const customerId = await customerOf(f);
    // ₱500 of store credit: a same-store overpayment at Lipa (1,500 against a 1,000 charge)
    const first = await charge(f, customerId, '1000.00', '2026-01-05');
    await collect(f, f.manager, customerId, f.lipaSafe, '1500.00', [{ chargeId: first.chargeId, amountApplied: '1000.00' }]);
    const second = await charge(f, customerId, '500.00', '2026-01-08');
    const safeBefore = await bal(f, f.malvarSafe);

    // control: cash is moving (₱100 of the ₱500), so the gate applies
    const refused = await rejection(
      collect(f, f.manager, customerId, f.malvarSafe, '500.00', [{ chargeId: second.chargeId, amountApplied: '500.00' }], { creditApplied: '400.00' }),
      "a collection with ₱100 of cash into Malvar's safe by a Lipa-only manager",
    );
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect((refused.err as AuthorizationError).capability).toBe('transfer_funds');

    // the target: no cash moves, so nothing is drawn from or credited to Malvar, and no transfer_funds is needed
    const r = await rejectionFree(collect(f, f.manager, customerId, f.malvarSafe, '500.00', [{ chargeId: second.chargeId, amountApplied: '500.00' }], { creditApplied: '500.00' }), 'a fully credit-funded collection naming Malvar\'s safe');
    const lines = await linesFor(r.entryId);
    expect(noInterStore(lines), 'a zero-cash collection grew an inter-store pair').toEqual([]);
    expect(lines.filter((l) => l.store_id === f.malvarId), 'a zero-cash collection put a line at Malvar').toEqual([]);
    expect(await bal(f, f.malvarSafe), "Malvar's safe moved").toBe(safeBefore);
    expect(await controlBalance(f, customerId), 'the charge is not cleared').toBe('0.00');
  });
});

/** The call must SUCCEED; a refusal is reported as the defect (the gate refuses a no-cash collection). */
async function rejectionFree<T>(p: Promise<T>, what: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw new Error(`REFUSED — ${what} was refused (${(err as Error).name}${(err as { capability?: string }).capability ? `, capability ${(err as { capability?: string }).capability}` : ''}) instead of posting`);
  }
}

// -----------------------------------------------------------------------------------------------
// T10 — the OWING store's gate: rights at Malvar alone do not let anyone collect for, or pay, a LIPA document
// -----------------------------------------------------------------------------------------------

describe("T10 — an actor who holds rights at MALVAR only, naming a LIPA document and Malvar's safe", () => {
  const types = ['ar_collection', 'loan_disbursement', 'loan_payment'];
  async function malvarOnly(f: Fixture): Promise<Actor> {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Malvar Manager') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.malvarId})`;
    return actor(f.orgId, p!.id);
  }
  const owingGate = (err: unknown, capability: string) => {
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).capability, "refused at the OWING store's capability").toBe(capability);
  };

  it("recordCollection of a Lipa charge into Malvar's safe: AuthorizationError(record_ar_collection), nothing posted, Malvar's safe unchanged — control: the admin collects it", async () => {
    const f = await fixture('t10c');
    const who = await malvarOnly(f);
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const safe = await bal(f, f.malvarSafe);
    const entries = await entryCount(f.orgId, types);
    const refused = await rejection(collect(f, who, customerId, f.malvarSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]), "a Malvar-only actor collecting a Lipa charge");
    owingGate(refused.err, 'record_ar_collection');
    expect(await entryCount(f.orgId, types)).toBe(entries);
    expect(await bal(f, f.malvarSafe)).toBe(safe);
    expect(await controlBalance(f, customerId), 'the charge was cleared by a refused collection').toBe('2000.00');
    expect((await collect(f, f.admin, customerId, f.malvarSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }])).entryId, 'control: the admin').toBeTruthy();
  });

  it("disburseLoan on a Lipa loan into Malvar's safe: AuthorizationError(record_ap_payment), nothing posted, loan position unchanged — control: the admin disburses", async () => {
    const f = await fixture('t10d');
    const who = await malvarOnly(f);
    const loanId = await newLoan(f);
    const outstanding = await loanOutstanding(f, loanId);
    const safe = await bal(f, f.malvarSafe);
    const entries = await entryCount(f.orgId, types);
    const refused = await rejection(disburse(f, who, loanId, f.malvarSafe, '1000.00'), 'a Malvar-only actor disbursing a Lipa loan');
    owingGate(refused.err, 'record_ap_payment');
    expect(await entryCount(f.orgId, types)).toBe(entries);
    expect(await loanOutstanding(f, loanId)).toBe(outstanding);
    expect(await bal(f, f.malvarSafe)).toBe(safe);
    expect((await disburse(f, f.admin, loanId, f.malvarSafe, '1000.00')).entryId, 'control: the admin').toBeTruthy();
  });

  it("recordLoanPayment on a Lipa loan out of Malvar's safe: AuthorizationError(record_ap_payment), nothing posted, loan position unchanged — control: the admin pays", async () => {
    const f = await fixture('t10p');
    const who = await malvarOnly(f);
    const loanId = await newLoan(f);
    await disburse(f, f.admin, loanId, f.lipaSafe);
    const outstanding = await loanOutstanding(f, loanId);
    const safe = await bal(f, f.malvarSafe);
    const entries = await entryCount(f.orgId, types);
    const refused = await rejection(loanPay(f, who, loanId, f.malvarSafe), 'a Malvar-only actor paying a Lipa loan');
    owingGate(refused.err, 'record_ap_payment');
    expect(await entryCount(f.orgId, types)).toBe(entries);
    expect(await loanOutstanding(f, loanId)).toBe(outstanding);
    expect(await bal(f, f.malvarSafe)).toBe(safe);
    expect((await loanPay(f, f.admin, loanId, f.malvarSafe)).entryId, 'control: the admin').toBeTruthy();
  });
});

// -----------------------------------------------------------------------------------------------
// T11 — a WALLET (1140) on the RECEIVING side: the debit and its party sit at Malvar, the pair is mirrored
// -----------------------------------------------------------------------------------------------

describe("T11 — a Lipa collection paid INTO a Malvar e-wallet (1140)", () => {
  async function walletAt(storeId: string): Promise<Account> {
    const [w] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'ewallet' and custodian = 'office' and is_foundation`;
    return { id: w!.id, glCode: '1140', storeId };
  }
  async function collectInto(f: Fixture, wallet: Account) {
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.lipaId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('rf')}.jpg`}, 'image/jpeg', 10, ${uid('sum')}, ${f.staffId}) returning id`;
    const before = await bal(f, wallet);
    const r = await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.admin, {
        storeId: f.lipaId, customerId, collectionDate: '2026-01-16', amount: '2000.00', moneyAccountId: wallet.id,
        allocations: [{ chargeId: ch.chargeId, amountApplied: '2000.00' }], receiptFileId: file!.id,
      } as never),
    );
    return { r, customerId, before };
  }

  it("the 1140 debit is at MALVAR with the wallet as its party; 2150 at Malvar (party Lipa's code) / 1250 at Lipa (party Malvar's code), each 2,000; each store nets 0.00; Malvar's wallet rises by 2,000", async () => {
    const f = await fixture('t11');
    const wallet = await walletAt(f.malvarId);
    const { r, before } = await collectInto(f, wallet);
    const lines = await linesFor(r.entryId);
    expect(lines.find((l) => l.code === '1140')).toMatchObject({ store_id: f.malvarId, debit: '2000.00', party_type: 'money_account', party_id: wallet.id });
    expect(lines.find((l) => l.code === '2150')).toMatchObject({ store_id: f.malvarId, credit: '2000.00', party_type: 'store', party_id: f.lipaCode });
    expect(lines.find((l) => l.code === '1250')).toMatchObject({ store_id: f.lipaId, debit: '2000.00', party_type: 'store', party_id: f.malvarCode });
    await expectEachStoreTies(r.entryId, 'wallet collection');
    expect(Number(await bal(f, wallet)) - Number(before), "Malvar's wallet balance").toBe(2000);
  });

  it("positive control: the same collection into LIPA's own wallet -> every line at Lipa, no pair", async () => {
    const f = await fixture('t11pc');
    const wallet = await walletAt(f.lipaId);
    const { r } = await collectInto(f, wallet);
    const lines = await linesFor(r.entryId);
    expect(noInterStore(lines), 'a same-store wallet collection grew a pair').toEqual([]);
    for (const l of lines) expect(l.store_id).toBe(f.lipaId);
  });
});

// -----------------------------------------------------------------------------------------------
// A1 (DEF-573) — voiding a cross-store posting needs transfer_funds at every OTHER store the original's lines touch
// -----------------------------------------------------------------------------------------------

describe("A1 — the Lipa-only manager cannot void what the admin posted against MALVAR's safe", () => {
  const entryStatus = async (entryId: string) => (await sql<{ status: string }[]>`select status from journal_entries where id = ${entryId}`)[0]!.status;
  const reversals = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and reversal_of_entry_id is not null`)[0]!.n);
  const expectGate = (err: unknown) => {
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).capability, 'the refusal must keep authorize()\'s own capability').toBe('transfer_funds');
  };

  it("A1-T1 voidCollection of a collection into Malvar's safe: AuthorizationError(transfer_funds); nothing reversed, the safe and the pair unchanged — A1-T3 control: the admin voids it and everything returns", async () => {
    const f = await fixture('a1c');
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const before = await snapshot(f);
    const r = await collect(f, f.admin, customerId, f.malvarSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]);
    const posted = await snapshot(f);
    const reversalsBefore = await reversals(f.orgId);

    const refused = await rejection(asOrg(f.orgId, (tx) => voidCollection(tx, f.manager, { collectionId: r.collectionId, reason: 'Bounced' })), "a Lipa-only manager voiding a collection into Malvar's safe");

    expectGate(refused.err);
    expect(await reversals(f.orgId), 'a refused void wrote a reversal').toBe(reversalsBefore);
    expect(await entryStatus(r.entryId), 'a refused void changed the original').toBe('posted');
    expect(await snapshot(f)).toEqual(posted);
    expect(await interStoreNet(f.orgId, f.lipaId, '1250')).toBe('2000.00');
    expect(await interStoreNet(f.orgId, f.malvarId, '2150')).toBe('-2000.00');
    expect(await controlBalance(f, customerId), 'the charge reopened on a refused void').toBe('0.00');

    await asOrg(f.orgId, (tx) => voidCollection(tx, f.admin, { collectionId: r.collectionId, reason: 'Bounced' }));
    expect(await snapshot(f), 'control: the admin void restores every balance').toEqual(before);
    expect(await interStoreNet(f.orgId, f.lipaId, '1250')).toBe('0.00');
    expect(await interStoreNet(f.orgId, f.malvarId, '2150')).toBe('0.00');
  });

  it("A1-T1 reverseLoanEntry of a disbursement into Malvar's safe: AuthorizationError(transfer_funds); nothing reversed, the loan position unchanged — control: the admin reverses it", async () => {
    const f = await fixture('a1d');
    const loanId = await newLoan(f);
    const before = await snapshot(f);
    const d = await disburse(f, f.admin, loanId, f.malvarSafe);
    const posted = await snapshot(f);
    const outstanding = await loanOutstanding(f, loanId);
    const reversalsBefore = await reversals(f.orgId);

    const refused = await rejection(asOrg(f.orgId, (tx) => reverseLoanEntry(tx, f.manager, { loanId, entryId: d.entryId, reason: 'Wrong account' })), "a Lipa-only manager reversing a disbursement into Malvar's safe");

    expectGate(refused.err);
    expect(await reversals(f.orgId)).toBe(reversalsBefore);
    expect(await entryStatus(d.entryId)).toBe('posted');
    expect(await snapshot(f)).toEqual(posted);
    expect(await loanOutstanding(f, loanId)).toBe(outstanding);
    expect(await interStoreNet(f.orgId, f.lipaId, '1250')).toBe('50000.00');

    await asOrg(f.orgId, (tx) => reverseLoanEntry(tx, f.admin, { loanId, entryId: d.entryId, reason: 'Wrong account' }));
    expect(await snapshot(f), 'control: the admin reversal restores every balance').toEqual(before);
    expect(await interStoreNet(f.orgId, f.lipaId, '1250')).toBe('0.00');
    expect(await interStoreNet(f.orgId, f.malvarId, '2150')).toBe('0.00');
  });

  it("A1-T1 reverseLoanEntry of a payment out of Malvar's safe: AuthorizationError(transfer_funds); nothing reversed, the loan position unchanged — control: the admin reverses it", async () => {
    const f = await fixture('a1p');
    const loanId = await newLoan(f);
    await disburse(f, f.admin, loanId, f.lipaSafe, '200000.00');
    const before = await snapshot(f);
    const outstandingBefore = await loanOutstanding(f, loanId);
    const p = await loanPay(f, f.admin, loanId, f.malvarSafe);
    const posted = await snapshot(f);
    const outstanding = await loanOutstanding(f, loanId);
    const reversalsBefore = await reversals(f.orgId);

    const refused = await rejection(asOrg(f.orgId, (tx) => reverseLoanEntry(tx, f.manager, { loanId, entryId: p.entryId, reason: 'Wrong account' })), "a Lipa-only manager reversing a payment out of Malvar's safe");

    expectGate(refused.err);
    expect(await reversals(f.orgId)).toBe(reversalsBefore);
    expect(await entryStatus(p.entryId)).toBe('posted');
    expect(await snapshot(f)).toEqual(posted);
    expect(await loanOutstanding(f, loanId)).toBe(outstanding);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('4800.00');

    await asOrg(f.orgId, (tx) => reverseLoanEntry(tx, f.admin, { loanId, entryId: p.entryId, reason: 'Wrong account' }));
    expect(await snapshot(f), 'control: the admin reversal restores every balance').toEqual(before);
    expect(await loanOutstanding(f, loanId)).toBe(outstandingBefore);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('0.00');
    expect(await interStoreNet(f.orgId, f.lipaId, '2150')).toBe('0.00');
  });

  it("A1-T4 (positive control, no extra right): the Lipa-only manager voids a SAME-store collection and reverses a SAME-store loan payment — both succeed", async () => {
    const f = await fixture('a1s');
    const customerId = await customerOf(f);
    const ch = await charge(f, customerId, '2000.00');
    const c = await collect(f, f.admin, customerId, f.lipaSafe, '2000.00', [{ chargeId: ch.chargeId, amountApplied: '2000.00' }]);
    await asOrg(f.orgId, (tx) => voidCollection(tx, f.manager, { collectionId: c.collectionId, reason: 'Wrong day' }));
    expect(await entryStatus(c.entryId)).toBe('reversed');
    expect(await controlBalance(f, customerId), 'the charge reopened').toBe('2000.00');

    const loanId = await newLoan(f);
    await disburse(f, f.admin, loanId, f.lipaSafe, '200000.00');
    const p = await loanPay(f, f.admin, loanId, f.lipaSafe);
    await asOrg(f.orgId, (tx) => reverseLoanEntry(tx, f.manager, { loanId, entryId: p.entryId, reason: 'Wrong day' }));
    expect(await entryStatus(p.entryId)).toBe('reversed');
  });
});
