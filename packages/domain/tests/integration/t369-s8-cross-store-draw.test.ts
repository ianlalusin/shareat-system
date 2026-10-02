import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S8 (DEF-551; Ian ruling (a), 2026-10-01) — a cross-store draw credits the safe that PAID, at ITS store, and records
 * what one store owes the other as a 1250/2150 pair in the SAME entry. `docs/tasks/369-unwired-money-screens.md` §S8, T1-T6.
 *
 * The three writers: `payReimbursement` (T1, T2), `approveExpense` (T3), `recordPayment` AP (T4); `voidPayment` mirrors (T6);
 * the Lipa-only manager is still refused in all three (T5). T7 (the pure helper) is `tests/unit/inter-store-legs.test.ts`.
 * The S1 T3 positive control carries the T1 store/balance asserts too.
 *
 * Every red leg asserts the TARGET. On HEAD the credit sits at the OWING store: Malvar's safe does not move, Lipa's cash goes
 * negative, and no 1250/2150 line exists. The Lipa-owed liability is the only thing the entry gets right.
 *
 * MUTANTS (each turns a NAMED test red; none is planted in the tree):
 *   (i)   keep the money credit at the owing store           -> T1 (Malvar's safe unchanged), T3, T4 (balanceOf asserts)
 *   (ii)  drop the pair, keep the credit at the account's store -> the per-store tie in T1/T3/T4 (Malvar nets -650, Lipa +650)
 *   (iii) swap the parties (each line names its OWN store)    -> T1's and T4's party_id asserts
 *   (iv)  append the pair unconditionally                     -> T2 (exactly two lines) and T3's same-store control
 *   (v)   approve builds the pair from the expense total      -> T3 (the pair is 400, not 1,000)
 *
 * Fixture: S1's two-store shape (`t369-s1-reimbursement-payout.test.ts`) plus the supplier/invoice/expense scaffolding of
 * `t369-s0-void-supplier-payment.test.ts`. manager = Lipa only; admin = both stores; staff = Lipa (creates the expense).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { apRepo, closeDb, moneyAccountsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  approveExpense,
  createExpense,
  createSupplier,
  listFindings,
  payReimbursement,
  recordExpenseForInvoice,
  recordInvoice,
  recordPayment,
  verifyInvoice,
  voidPayment,
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
    values (${orgId}, ${lipaId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
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
// T1 / T2 — payReimbursement (the ₱650 case)
// -----------------------------------------------------------------------------------------------

const payout = (f: Fixture, who: Actor, from: Account, amount = '650.00') =>
  asOrg(f.orgId, (tx) => payReimbursement(tx, who, { storeId: f.lipaId, employeeId: f.anaId, amount, fromMoneyAccountId: from.id, on: '2026-01-16', payoutId: crypto.randomUUID() }));

describe('T1 — the admin pays Ana ₱650 (owed at Lipa) from MALVAR\'s safe', () => {
  it('four lines exactly; Malvar\'s safe falls by 650, Lipa\'s cash and safe do not move; 1250 at Malvar = +650 and 2150 at Lipa = −650; every store nets 0.00; no reciprocal finding — red on HEAD: the credit is at Lipa', async () => {
    const f = await fixture('t1');
    await owe(f, '650.00');
    const before = await snapshot(f);

    const r = await payout(f, f.admin, f.malvarSafe);

    expect(shape(await linesFor(r.entryId))).toEqual(
      shape([
        { code: '2130', store_id: f.lipaId, debit: '650.00', credit: '0.00', party_type: 'employee', party_id: f.anaId },
        { code: '2150', store_id: f.lipaId, debit: '0.00', credit: '650.00', party_type: 'store', party_id: f.malvarCode },
        { code: '1250', store_id: f.malvarId, debit: '650.00', credit: '0.00', party_type: 'store', party_id: f.lipaCode },
        { code: '1130', store_id: f.malvarId, debit: '0.00', credit: '650.00', party_type: null, party_id: null },
      ]),
    );
    const after = await snapshot(f);
    expect(Number(before.malvarSafe) - Number(after.malvarSafe), "Malvar's safe did not fall by exactly 650.00").toBe(650);
    expect(after.lipaCash, "Lipa's cash moved").toBe(before.lipaCash);
    expect(after.lipaSafe, "Lipa's safe moved").toBe(before.lipaSafe);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('650.00');
    expect(await interStoreNet(f.orgId, f.lipaId, '2150')).toBe('-650.00');
    await expectEachStoreTies(r.entryId, 'reimbursement payout');
    expect(await reciprocalFindings(f)).toEqual([]);
  });
});

describe('T2 (positive control, unchanged) — the Lipa manager pays Ana ₱650 from LIPA\'s own safe', () => {
  it('exactly two lines (DR 2130 / CR 1130, both at Lipa), no 1250/2150 — Mutant (iv) appends the pair unconditionally -> red', async () => {
    const f = await fixture('t2');
    await owe(f, '650.00');
    const r = await payout(f, f.manager, f.lipaSafe);
    expect(shape(await linesFor(r.entryId))).toEqual(
      shape([
        { code: '2130', store_id: f.lipaId, debit: '650.00', credit: '0.00', party_type: 'employee', party_id: f.anaId },
        { code: '1130', store_id: f.lipaId, debit: '0.00', credit: '650.00', party_type: null, party_id: null },
      ]),
    );
    expect(await interStoreNet(f.orgId, f.lipaId, '2150')).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T3 — approveExpense: ₱1,000 at Lipa, ₱600 from Lipa's cashier cash + ₱400 from Malvar's safe
// -----------------------------------------------------------------------------------------------

async function splitExpense(f: Fixture, second: Account): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.lipaId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('rf')}.jpg`}, 'image/jpeg', 10, ${uid('sum')}, ${f.staffId}) returning id`;
  const inv = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, { storeId: f.lipaId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: '1000.00', receiptFileId: file!.id }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, inv.id, { supplier: true, invoice: true, items: true, price: true }));
  const created = await asOrg(f.orgId, (tx) =>
    createExpense(tx, f.staff, {
      storeId: f.lipaId, supplierId: f.supplierId, supplierInvoiceId: inv.id, businessDate: '2026-01-10', categoryId: f.categoryId,
      particulars: 'Split-funded purchase',
      payments: [
        { method: 'cash', amount: '600.00', moneyAccountId: f.lipaCash.id },
        { method: 'cash', amount: '400.00', moneyAccountId: second.id },
      ] as never,
    }),
  );
  return created.id;
}

describe('T3 — approving a Lipa expense funded ₱600 by Lipa cash and ₱400 by Malvar\'s safe', () => {
  it('Lipa cash −600, Malvar safe −400; exactly one 1250/2150 pair, for 400 (not 1,000); each store nets 0.00 — Mutant (v): the pair built from the expense total -> red', async () => {
    const f = await fixture('t3');
    const expenseId = await splitExpense(f, f.malvarSafe);
    const before = await snapshot(f);

    const r = await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, expenseId));

    const after = await snapshot(f);
    expect(Number(before.lipaCash) - Number(after.lipaCash), 'Lipa cash').toBe(600);
    expect(Number(before.malvarSafe) - Number(after.malvarSafe), "Malvar's safe did not fall by 400 (the credit was posted at Lipa)").toBe(400);
    const lines = await linesFor(r.journalEntryId);
    const pair = lines.filter((l) => l.code === '1250' || l.code === '2150');
    expect(pair, 'exactly one 1250/2150 pair').toHaveLength(2);
    expect(pair.find((l) => l.code === '1250')).toMatchObject({ store_id: f.malvarId, debit: '400.00', party_type: 'store', party_id: f.lipaCode });
    expect(pair.find((l) => l.code === '2150')).toMatchObject({ store_id: f.lipaId, credit: '400.00', party_type: 'store', party_id: f.malvarCode });
    await expectEachStoreTies(r.journalEntryId, 'expense approval');
  });

  it('positive control: the same split with both legs from LIPA (cashier cash + safe) -> no pair, every line at Lipa', async () => {
    const f = await fixture('t3pc');
    const expenseId = await splitExpense(f, f.lipaSafe);
    const r = await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, expenseId));
    const lines = await linesFor(r.journalEntryId);
    expect(lines.filter((l) => l.code === '1250' || l.code === '2150'), 'a same-store split grew an inter-store pair').toEqual([]);
    for (const l of lines) expect(l.store_id).toBe(f.lipaId);
  });
});

// -----------------------------------------------------------------------------------------------
// T4 — recordPayment (AP)
// -----------------------------------------------------------------------------------------------

async function bill(f: Fixture, amount: string): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.lipaId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('rf')}.jpg`}, 'image/jpeg', 10, ${uid('sum')}, ${f.staffId}) returning id`;
  const inv = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, { storeId: f.lipaId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: file!.id }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, inv.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId: f.lipaId, supplierId: f.supplierId, supplierInvoiceId: inv.id, categoryId: f.categoryId,
      particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return exp.expenseId;
}
const apPay = (f: Fixture, who: Actor, expenseId: string, from: Account, o: { amount: string; creditApplied?: string }) =>
  asOrg(f.orgId, (tx) =>
    recordPayment(tx, who, {
      storeId: f.lipaId, supplierId: f.supplierId, businessDate: '2026-01-15', amount: o.amount, moneyAccountId: from.id,
      ...(o.creditApplied ? { creditApplied: o.creditApplied } : {}),
      allocations: [{ expenseId, amountApplied: o.amount }],
    }),
  );
const openItemIds = (f: Fixture) => asOrg(f.orgId, async (tx) => (await apRepo.openItems(tx, f.orgId, f.supplierId, f.lipaId)).map((o) => o.expenseId));
const apStoreOf = async (paymentId: string) => (await sql<{ store_id: string }[]>`select store_id from ap_payments where id = ${paymentId}`)[0]!.store_id;

describe('T4 — the admin pays a ₱12,000 Lipa bill from MALVAR\'s safe', () => {
  it('Malvar safe −12,000; DR 2110 at Lipa; the 1250/2150 pair for 12,000; ap_payments.store_id = Lipa; the open item is cleared; each store nets 0.00', async () => {
    const f = await fixture('t4');
    const expenseId = await bill(f, '12000.00');
    const before = await snapshot(f);

    const r = await apPay(f, f.admin, expenseId, f.malvarSafe, { amount: '12000.00' });

    const after = await snapshot(f);
    expect(Number(before.malvarSafe) - Number(after.malvarSafe), "Malvar's safe did not fall by 12,000.00").toBe(12000);
    expect(after.lipaCash).toBe(before.lipaCash);
    const lines = await linesFor(r.entryId);
    expect(lines.find((l) => l.code === '2110')).toMatchObject({ store_id: f.lipaId, debit: '12000.00' });
    expect(lines.find((l) => l.code === '1250')).toMatchObject({ store_id: f.malvarId, debit: '12000.00', party_type: 'store', party_id: f.lipaCode });
    expect(lines.find((l) => l.code === '2150')).toMatchObject({ store_id: f.lipaId, credit: '12000.00', party_type: 'store', party_id: f.malvarCode });
    expect(lines.find((l) => l.code === '1130')).toMatchObject({ store_id: f.malvarId, credit: '12000.00' });
    expect(await apStoreOf(r.paymentId), 'the payment belongs to the OWING store\'s AP').toBe(f.lipaId);
    expect(await openItemIds(f), "Lipa's open item is not cleared").not.toContain(expenseId);
    await expectEachStoreTies(r.entryId, 'AP payment');
  });

  it('with creditApplied ₱2,000 (a prior overpayment credit): the pair, and the safe, move by the ₱10,000 CASH portion only', async () => {
    const f = await fixture('t4credit');
    const first = await bill(f, '1000.00');
    // an OVERPAYMENT: hand over 3,000 against a 1,000 bill -> 2,000 of supplier credit (1240) at Lipa
    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { storeId: f.lipaId, supplierId: f.supplierId, businessDate: '2026-01-12', amount: '3000.00', moneyAccountId: f.lipaSafe.id, allocations: [{ expenseId: first, amountApplied: '1000.00' }] }),
    );
    const expenseId = await bill(f, '12000.00');
    const before = await snapshot(f);

    const r = await apPay(f, f.admin, expenseId, f.malvarSafe, { amount: '12000.00', creditApplied: '2000.00' });

    const after = await snapshot(f);
    expect(Number(before.malvarSafe) - Number(after.malvarSafe), 'only the cash portion leaves the safe').toBe(10000);
    const lines = await linesFor(r.entryId);
    expect(lines.find((l) => l.code === '1250')).toMatchObject({ store_id: f.malvarId, debit: '10000.00' });
    expect(lines.find((l) => l.code === '2150')).toMatchObject({ store_id: f.lipaId, credit: '10000.00' });
    await expectEachStoreTies(r.entryId, 'AP payment with credit applied');
  });
});

// -----------------------------------------------------------------------------------------------
// T5 (✗ unchanged) — the Lipa-only manager is still refused in all three writers
// -----------------------------------------------------------------------------------------------

describe("T5 (✗ unchanged) — a Lipa-only manager drawing on Malvar's safe is AuthorizationError, nothing posted", () => {
  it('payReimbursement, approveExpense and recordPayment: each refused; no entry of its type written — positive control: T1 / T3 / T4 (the admin posts the same)', async () => {
    const f = await fixture('t5');
    await owe(f, '650.00');
    const expenseId = await splitExpense(f, f.malvarSafe);
    const billId = await bill(f, '12000.00');
    const types = ['reimbursement_payout', 'expense_payment', 'ap_payment'];
    const before = await entryCount(f.orgId, types);

    expect((await rejection(payout(f, f.manager, f.malvarSafe), "₱650 out of Malvar's safe by a Lipa-only manager")).err).toBeInstanceOf(AuthorizationError);
    expect((await rejection(asOrg(f.orgId, (tx) => approveExpense(tx, f.manager, expenseId)), "an expense funded from Malvar's safe approved by a Lipa-only manager")).err).toBeInstanceOf(AuthorizationError);
    expect((await rejection(apPay(f, f.manager, billId, f.malvarSafe, { amount: '12000.00' }), "an AP payment from Malvar's safe by a Lipa-only manager")).err).toBeInstanceOf(AuthorizationError);

    expect(await entryCount(f.orgId, types), 'a refused draw left an entry behind').toBe(before);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('0.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T6 — voidPayment mirrors every line, the pair included (no code change: guards reverseEntry)
// -----------------------------------------------------------------------------------------------

describe("T6 — voiding T4's payment", () => {
  it("Malvar's safe returns to its prior balance; 1250 at Malvar and 2150 at Lipa return to 0.00; the reversal carries the same party ids", async () => {
    const f = await fixture('t6');
    const expenseId = await bill(f, '12000.00');
    const before = await snapshot(f);
    const r = await apPay(f, f.admin, expenseId, f.malvarSafe, { amount: '12000.00' });
    expect(await interStoreNet(f.orgId, f.malvarId, '1250'), 'fixture: the pair was posted').toBe('12000.00');

    await asOrg(f.orgId, (tx) => voidPayment(tx, f.admin, { paymentId: r.paymentId, reason: 'Bounced cheque' } as never));

    expect(await snapshot(f)).toEqual(before);
    expect(await interStoreNet(f.orgId, f.malvarId, '1250')).toBe('0.00');
    expect(await interStoreNet(f.orgId, f.lipaId, '2150')).toBe('0.00');
    const reversal = await sql<{ id: string }[]>`select id from journal_entries where reversal_of_entry_id = ${r.entryId}`;
    expect(reversal).toHaveLength(1);
    const rev = await linesFor(reversal[0]!.id);
    expect(rev.find((l) => l.code === '1250')).toMatchObject({ store_id: f.malvarId, credit: '12000.00', party_type: 'store', party_id: f.lipaCode });
    expect(rev.find((l) => l.code === '2150')).toMatchObject({ store_id: f.lipaId, debit: '12000.00', party_type: 'store', party_id: f.malvarCode });
    await expectEachStoreTies(reversal[0]!.id, 'the reversal');
  });
});

// -----------------------------------------------------------------------------------------------
// T8 — replay of a cross-store payout (audit MED): the same payoutId is a no-op for the REAL shape and a refusal for the OLD shape
// -----------------------------------------------------------------------------------------------

describe('T8 — replaying a cross-store reimbursement payout', () => {
  const payWith = (f: Fixture, who: Actor, from: Account, payoutId: string) =>
    asOrg(f.orgId, (tx) =>
      payReimbursement(tx, who, { storeId: f.lipaId, employeeId: f.anaId, amount: '650.00', fromMoneyAccountId: from.id, on: '2026-01-16', payoutId }),
    );

  it("(a) the admin pays Lipa's debt from Malvar's safe, then replays the same payoutId: the SAME entry, created:false, still 4 lines, no second entry, the safe moved once — Mutant: the replay check reads `credit.storeId === input.storeId` -> the real entry (credit at Malvar) is refused and this leg is red", async () => {
    const f = await fixture('t8a');
    await owe(f, '650.00');
    const payoutId = crypto.randomUUID();
    const before = await snapshot(f);

    const first = await payWith(f, f.admin, f.malvarSafe, payoutId);
    expect(first.created).toBe(true);
    const replay = await payWith(f, f.admin, f.malvarSafe, payoutId);

    expect(replay.entryId, 'the replay wrote or returned a different entry').toBe(first.entryId);
    expect(replay.created).toBe(false);
    expect(await linesFor(first.entryId)).toHaveLength(4);
    expect(await entryCount(f.orgId, ['reimbursement_payout']), 'a replay posted a second entry').toBe(1);
    const after = await snapshot(f);
    expect(Number(before.malvarSafe) - Number(after.malvarSafe), 'the safe moved more than once').toBe(650);
  });

  it("(b) a hand-inserted PRE-S8 entry (credit at LIPA) under that key: replayed from MALVAR's safe it is refused as a different store/account and nothing is posted; replayed from LIPA's own safe (the shape it matches) it is accepted as the same entry", async () => {
    const f = await fixture('t8b');
    await owe(f, '650.00');
    const payoutId = crypto.randomUUID();
    const oldShape = await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-16', sourceType: 'reimbursement_payout', sourceId: uid('old'),
        idempotencyKey: `reimbursement:${f.anaId}:payout:${payoutId}`, memo: 'pre-S8 shape: the credit at the OWING store', postedBy: f.adminId,
        lines: [
          { accountCode: '2130', storeId: f.lipaId, debit: '650.00', partyType: 'employee', partyId: f.anaId },
          { accountCode: '1130', storeId: f.lipaId, credit: '650.00' },
        ],
      }),
    );
    const before = await entryCount(f.orgId, ['reimbursement_payout']);

    const refused = await rejection(payWith(f, f.admin, f.malvarSafe, payoutId), "a replay of a pre-S8 entry against Malvar's safe");
    expect(refused.err).not.toBeInstanceOf(AuthorizationError);
    expect((refused.err as { userMessage?: string }).userMessage, 'the refusal must be the written different-figures sentence').toBe(
      'This payment was already recorded with different figures. Reload the page and try again.',
    );
    expect(await entryCount(f.orgId, ['reimbursement_payout']), 'a refused replay wrote an entry').toBe(before);

    const control = await payWith(f, f.admin, f.lipaSafe, payoutId);
    expect(control.entryId, 'control: the same key from the account the old shape matches').toBe(oldShape.entryId);
    expect(control.created).toBe(false);
  });
});

// -----------------------------------------------------------------------------------------------
// T9 — the OWING store's authorisation: rights at Malvar alone are not enough to settle a Lipa debt
// -----------------------------------------------------------------------------------------------

describe("T9 — an actor with rights at MALVAR only drawing Malvar's safe for a LIPA debt is refused in all three writers", () => {
  it("payReimbursement, approveExpense and recordPayment: AuthorizationError, nothing posted — control: the SAME person pays a MALVAR-owed debt from Malvar's safe, and the admin (both stores) posts the Lipa one", async () => {
    const f = await fixture('t9');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Malvar Manager') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.malvarId})`;
    const malvarMgr = actor(f.orgId, p!.id);

    await owe(f, '650.00');
    const expenseId = await splitExpense(f, f.malvarSafe);
    const billId = await bill(f, '12000.00');
    const types = ['reimbursement_payout', 'expense_payment', 'ap_payment'];
    const before = await entryCount(f.orgId, types);
    const safeBefore = await bal(f, f.malvarSafe);

    expect((await rejection(payout(f, malvarMgr, f.malvarSafe), "a Malvar-only manager paying Lipa's reimbursement")).err).toBeInstanceOf(AuthorizationError);
    expect((await rejection(asOrg(f.orgId, (tx) => approveExpense(tx, malvarMgr, expenseId)), 'a Malvar-only manager approving a Lipa expense')).err).toBeInstanceOf(AuthorizationError);
    expect((await rejection(apPay(f, malvarMgr, billId, f.malvarSafe, { amount: '12000.00' }), 'a Malvar-only manager paying a Lipa bill')).err).toBeInstanceOf(AuthorizationError);
    expect(await entryCount(f.orgId, types), 'a refused draw left an entry behind').toBe(before);
    expect(await bal(f, f.malvarSafe), "Malvar's safe moved on a refused draw").toBe(safeBefore);

    // control 1: the same person, at the store they DO hold, from that store's own safe
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-05', sourceType: 'manual_journal', sourceId: uid('owe'), idempotencyKey: uid('owe'), memo: 'fixture reimbursable at Malvar', postedBy: f.adminId,
        lines: [
          { accountCode: '6200', storeId: f.malvarId, debit: '300.00' },
          { accountCode: '2130', storeId: f.malvarId, credit: '300.00', partyType: 'employee', partyId: f.anaId },
        ],
      }),
    );
    const own = await asOrg(f.orgId, (tx) =>
      payReimbursement(tx, malvarMgr, { storeId: f.malvarId, employeeId: f.anaId, amount: '300.00', fromMoneyAccountId: f.malvarSafe.id, on: '2026-01-16', payoutId: crypto.randomUUID() }),
    );
    expect(own.created, "control: a Malvar-only manager paying a Malvar debt from Malvar's safe posts").toBe(true);
    // control 2: the admin posts the Lipa debt from Malvar's safe
    expect((await payout(f, f.admin, f.malvarSafe)).created).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// T10 — a WALLET (1140) leg: the account belongs to Malvar, so the credit and the party sit at Malvar
// -----------------------------------------------------------------------------------------------

describe("T10 — a Lipa expense paid from MALVAR's e-wallet (1140)", () => {
  async function walletOf(f: Fixture, storeId: string): Promise<Account> {
    const [w] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'ewallet' and custodian = 'office' and is_foundation`;
    // 1140 carries one line per WALLET: the party is the wallet, so fund it as the routing writes it
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('wf'), idempotencyKey: uid('wf'), memo: 'fixture wallet funding', postedBy: f.adminId,
        lines: [
          { accountCode: '1140', storeId, debit: '100000.00', partyType: 'money_account', partyId: w!.id },
          { accountCode: '3900', storeId, credit: '100000.00' },
        ],
      }),
    );
    return { id: w!.id, glCode: '1140', storeId };
  }
  async function walletExpense(f: Fixture, wallet: Account): Promise<string> {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.lipaId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('rf')}.jpg`}, 'image/jpeg', 10, ${uid('sum')}, ${f.staffId}) returning id`;
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, { storeId: f.lipaId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: '1000.00', receiptFileId: file!.id }),
    );
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, inv.id, { supplier: true, invoice: true, items: true, price: true }));
    const created = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.staff, {
        storeId: f.lipaId, supplierId: f.supplierId, supplierInvoiceId: inv.id, businessDate: '2026-01-10', categoryId: f.categoryId,
        particulars: 'Wallet-funded purchase', payments: [{ method: 'online', amount: '1000.00', moneyAccountId: wallet.id }] as never,
      }),
    );
    return created.id;
  }

  it("the 1140 credit is at MALVAR with the wallet as its party; the 1250/2150 pair is for 1,000; each store nets 0.00; Malvar's wallet falls by 1,000", async () => {
    const f = await fixture('t10');
    const wallet = await walletOf(f, f.malvarId);
    const expenseId = await walletExpense(f, wallet);
    const before = await bal(f, wallet);

    const r = await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, expenseId));

    const lines = await linesFor(r.journalEntryId);
    expect(lines.find((l) => l.code === '1140')).toMatchObject({ store_id: f.malvarId, credit: '1000.00', party_type: 'money_account', party_id: wallet.id });
    expect(lines.find((l) => l.code === '1250')).toMatchObject({ store_id: f.malvarId, debit: '1000.00', party_type: 'store', party_id: f.lipaCode });
    expect(lines.find((l) => l.code === '2150')).toMatchObject({ store_id: f.lipaId, credit: '1000.00', party_type: 'store', party_id: f.malvarCode });
    await expectEachStoreTies(r.journalEntryId, 'wallet-funded expense');
    expect(Number(before) - Number(await bal(f, wallet)), "Malvar's wallet balance").toBe(1000);
  });

  it("positive control: the same expense paid from LIPA's own wallet -> every line at Lipa, no pair", async () => {
    const f = await fixture('t10pc');
    const wallet = await walletOf(f, f.lipaId);
    const expenseId = await walletExpense(f, wallet);
    const r = await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, expenseId));
    const lines = await linesFor(r.journalEntryId);
    expect(lines.filter((l) => l.code === '1250' || l.code === '2150'), 'a same-store wallet payment grew a pair').toEqual([]);
    for (const l of lines) expect(l.store_id).toBe(f.lipaId);
  });
});
