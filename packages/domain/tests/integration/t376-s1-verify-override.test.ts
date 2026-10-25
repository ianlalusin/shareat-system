import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-376 S1 (DEF-581) - the closed-month override reaches the two AP posting paths.
 * `docs/tasks/376-ap-closed-month-and-screen-nits.md` S1, domain tests T1-T9.
 *
 *   verifyInvoice(tx, actor, invoiceId, attestation, { periodOverride? })
 *   recordExpenseForInvoice(tx, actor, { ..., periodOverride? })
 *
 * TESTER, not BUILDER. Fixture is `t369-s5-closed-month-override.test.ts`'s (Lipa; admin + manager = an org WITH
 * an admin), plus a STAFF person who LOGS each bill so the admin may verify it. January 2026 is closed, February open.
 * Every draft is dated by its bill (createExpense forces the invoice's date).
 *
 * No cast survives (X-6): on HEAD the fifth argument does not typecheck, and the red is vitest's (HEAD ignores it and
 * refuses with the bill sentence). Once S1 is built the calls typecheck as written.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createExpense, recordExpenseForInvoice, verifyInvoice } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

async function person(orgId: string, name: string, role: 'manager' | 'admin' | 'staff', storeId: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

const ATTEST = { supplier: true, invoice: true, items: true, price: true };
const OVERRIDE = { reason: 'late_supplier_invoice' as const, note: 'Bill arrived in October' };
const CLOSED_SENTENCE = 'January 2026 is closed. Ask an administrator to post this one entry into it.';
const LOCKED_SENTENCE = 'January 2026 is locked. Nothing can be posted into it, not even with the closed-month override.';

/** Lipa; admin, manager, staff; cash drawer funded; January 2026 is closed by `closeJanuary` once the bills exist, February stays open. */
async function fixture(hint: string) {
  const code = uid(`t376s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', storeId);
  const managerId = await person(orgId, 'Manager', 'manager', storeId);
  const staffId = await person(orgId, 'Staff', 'staff', storeId);
  const [cash] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
      lines: [{ accountCode: cash!.gl_account_code, storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
    }),
  );
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Pork Co', ${adminId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('r')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${adminId})
    returning id`;
  const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const admin = actor(orgId, adminId);

  /** A bill dated `on`, logged by `loggedBy`, with a cash draft per amount in `drafts` (made while the month is still open). */
  const bill = async (o: { on: string; loggedBy: string; drafts: string[]; verified?: boolean }) => {
    const [inv] = o.verified
      ? await sql<{ id: string }[]>`
          insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
                                         attested_supplier, attested_invoice, attested_items, attested_price)
          values (${orgId}, ${storeId}, ${supplier!.id}, ${o.on}, '5000.00', 'verified', ${file!.id}, ${managerId}, now(), ${o.loggedBy}, true, true, true, true) returning id`
      : await sql<{ id: string }[]>`
          insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, created_by)
          values (${orgId}, ${storeId}, ${supplier!.id}, ${o.on}, '5000.00', 'pending', ${file!.id}, ${o.loggedBy}) returning id`;
    const draftIds: string[] = [];
    for (const amount of o.drafts) {
      const made = await asOrg(orgId, (tx) =>
        createExpense(tx, admin, {
          storeId, supplierId: supplier!.id, supplierInvoiceId: inv!.id, businessDate: o.on, categoryId: cat!.id,
          particulars: `Pork ${amount}`, payments: [{ method: 'cash', amount, moneyAccountId: cash!.id }],
        }),
      );
      draftIds.push(made.id);
    }
    return { id: inv!.id, draftIds };
  };
  return {
    orgId, storeId, adminId, managerId, staffId, supplierId: supplier!.id, categoryId: cat!.id, cashId: cash!.id,
    admin, manager: actor(orgId, managerId), bill,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const closeJanuary = (f: Fixture) => sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-01-01'`;

const verify = (f: Fixture, who: Actor, invoiceId: string, periodOverride?: { reason: 'late_supplier_invoice'; note?: string }) =>
  asOrg(f.orgId, (tx) => verifyInvoice(tx, who, invoiceId, ATTEST, periodOverride ? { periodOverride } : undefined));

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED - ${what} went through instead (the defect this leg targets)`);
}

const invoiceStatus = async (id: string) => (await sql<{ status: string }[]>`select status from supplier_invoices where id = ${id}`)[0]!.status;
const expenseStatus = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;
const entryCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'expense_payment'`)[0]!.n);
const overrideRows = (orgId: string) =>
  sql<{ entry_id: string; actor_person_id: string; reason: string; note: string | null; period_status_at_post: string }[]>`
    select entry_id, actor_person_id, reason, note, period_status_at_post from period_overrides where org_id = ${orgId}`;
const expensesFor = async (invoiceId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceId}`)[0]!.n);

/** Nothing happened: bill pending, every draft still a draft, no entry, no override row. */
async function expectNothingPosted(f: Fixture, b: { id: string; draftIds: string[] }) {
  expect(await invoiceStatus(b.id)).toBe('pending');
  for (const d of b.draftIds) expect(await expenseStatus(d)).toBe('draft');
  expect(await entryCount(f.orgId)).toBe(0);
  expect(await overrideRows(f.orgId)).toHaveLength(0);
}

// -----------------------------------------------------------------------------------------------

describe('T1 - the admin verifies a January bill with two drafts, with a typed reason', () => {
  it('verified; both drafts posted into 2026-01-10; TWO period_overrides rows (admin, reason, note, closed) - red on HEAD: the fifth argument is ignored and the bill sentence refuses', async () => {
    const f = await fixture('t1');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: ['1200.00', '800.00'] });
    await closeJanuary(f);

    await verify(f, f.admin, b.id, OVERRIDE);

    expect(await invoiceStatus(b.id)).toBe('verified');
    for (const d of b.draftIds) expect(await expenseStatus(d)).toBe('posted');
    expect(await entryCount(f.orgId)).toBe(2);
    const dates = await sql<{ entry_date: string }[]>`select entry_date::text from journal_entries where org_id = ${f.orgId} and source_type = 'expense_payment'`;
    expect(dates.map((d) => d.entry_date)).toEqual(['2026-01-10', '2026-01-10']);
    const rows = await overrideRows(f.orgId);
    expect(rows, 'one row per entry: two drafts, two rows').toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ actor_person_id: f.adminId, reason: 'late_supplier_invoice', note: 'Bill arrived in October', period_status_at_post: 'closed' });
    }
    expect(new Set(rows.map((r) => r.entry_id)).size, 'two distinct entries').toBe(2);
  });
});

describe('T2 (refusal) - the manager (org WITH an admin) cannot use the override', () => {
  it('the refusal reaches the caller through the rewrap: a sentence with no uuid and NOT the closed-month sentence; pending, drafts draft, zero entries, zero rows - control: T1', async () => {
    const f = await fixture('t2');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: ['1200.00', '800.00'] });
    await closeJanuary(f);

    const refused = await rejection(verify(f, f.manager, b.id, OVERRIDE), 'a manager verifying a closed-month bill with an override');
    expect(refused.userMessage, 'the refusal must carry a presentable sentence').toBeTruthy();
    expect(refused.userMessage).not.toMatch(UUID);
    expect(refused.userMessage, `the override was ignored (HEAD's bill sentence) instead of refused for the missing capability: ${refused.userMessage}`).not.toMatch(/is closed/);
    await expectNothingPosted(f, b);

    // positive control: the same bill, the same override, the admin - posts
    await verify(f, f.admin, b.id, OVERRIDE);
    expect(await invoiceStatus(b.id)).toBe('verified');
    expect(await overrideRows(f.orgId)).toHaveLength(2);
  });
});

describe('T3 - no override and January closed: the ordinary sentence', () => {
  it('the admin AND the manager each get the exact "Ask an administrator" sentence; nothing posts - control: T1', async () => {
    const f = await fixture('t3');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: ['1200.00', '800.00'] });
    await closeJanuary(f);

    for (const who of [f.admin, f.manager]) {
      const refused = await rejection(verify(f, who, b.id), 'verifying a closed-month bill with no override');
      // T-475 S1: the refusal names the draft ("This invoice can't be verified yet: ... - <sentence>"); the sentence is kept whole.
      expect(refused.userMessage).toContain(CLOSED_SENTENCE);
      expect(refused.userMessage).not.toMatch(UUID);
      await expectNothingPosted(f, b);
    }

    await verify(f, f.admin, b.id, OVERRIDE); // control
    expect(await invoiceStatus(b.id)).toBe('verified');
  });
});

describe('T4 - a LOCKED month cannot be overridden', () => {
  it('admin + override -> the locked sentence; pending, zero rows', async () => {
    const f = await fixture('t4');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: ['1200.00'] });
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    await sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId}`;

    const refused = await rejection(verify(f, f.admin, b.id, OVERRIDE), 'verifying a bill dated in a locked month');
    expect(refused.userMessage).toContain(LOCKED_SENTENCE);
    await expectNothingPosted(f, b);
  });
});

describe('T5 - an override sent for an OPEN month is simply ignored', () => {
  it('the MANAGER verifies a February bill with an override: verified, posted, zero rows, no AuthorizationError - Mutant: authorize override_period_lock whenever an override is present -> refused, red', async () => {
    const f = await fixture('t5');
    const b = await f.bill({ on: '2026-02-10', loggedBy: f.staffId, drafts: ['1200.00'] });
    await closeJanuary(f);

    await verify(f, f.manager, b.id, OVERRIDE);

    expect(await invoiceStatus(b.id)).toBe('verified');
    expect(await expenseStatus(b.draftIds[0]!)).toBe('posted');
    expect(await overrideRows(f.orgId), 'an override audit row was written for an OPEN month').toHaveLength(0);
  });
});

describe('T6 - a January bill with NO drafts', () => {
  it('admin + override: verified, zero entries, zero rows (nothing to post, nothing to audit)', async () => {
    const f = await fixture('t6');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: [] });
    await closeJanuary(f);

    await verify(f, f.admin, b.id, OVERRIDE);

    expect(await invoiceStatus(b.id)).toBe('verified');
    expect(await entryCount(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});

// T-475 S3 (Ian Q2=B, Q3=A): an ADMIN may now verify a bill they logged (flagged self_verified, audited); every other role still may not.
describe('T7 (R4, segregation) - the MANAGER who LOGGED the bill cannot verify it, override or not; an admin logger now can', () => {
  it('the segregation sentence; zero rows - control: the same override on a bill the manager did not log (T1)', async () => {
    const f = await fixture('t7');
    const mine = await f.bill({ on: '2026-01-10', loggedBy: f.managerId, drafts: ['1200.00'] });
    const staffs = await f.bill({ on: '2026-01-11', loggedBy: f.staffId, drafts: ['800.00'] });
    await closeJanuary(f);

    const refused = await rejection(verify(f, f.manager, mine.id, OVERRIDE), 'the manager logger verifying their own bill');
    expect(refused.userMessage).toMatch(/^You logged this invoice, so you cannot also verify it/);
    await expectNothingPosted(f, mine);
    expect(await invoiceStatus(staffs.id)).toBe('pending');

    await verify(f, f.admin, staffs.id, OVERRIDE); // control
    expect(await invoiceStatus(staffs.id)).toBe('verified');
    expect(await overrideRows(f.orgId)).toHaveLength(1);
  });

  it('positive control: an ADMIN logger verifies their own bill and it is flagged self_verified (details: t475-s3-self-verify.test.ts)', async () => {
    const f = await fixture('t7a');
    const mine = await f.bill({ on: '2026-02-10', loggedBy: f.adminId, drafts: ['1200.00'] });
    await verify(f, f.admin, mine.id);
    expect(await invoiceStatus(mine.id)).toBe('verified');
    const [row] = await sql<{ self_verified: boolean }[]>`select self_verified from supplier_invoices where id = ${mine.id}`;
    expect(row!.self_verified).toBe(true);
  });
});

describe('T8 (I4) - an actor smuggled inside periodOverride changes nothing', () => {
  it('the audit row actor is the caller (the admin), not the smuggled manager - control: the reason and note are the admin\'s own', async () => {
    const f = await fixture('t8');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: ['1200.00'] });
    await closeJanuary(f);
    const smuggled = { ...OVERRIDE, actor: f.manager };

    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.admin, b.id, ATTEST, { periodOverride: smuggled }));

    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(f.adminId);
    expect(rows[0]!.actor_person_id).not.toBe(f.managerId);
    expect(rows[0]).toMatchObject({ reason: 'late_supplier_invoice', note: 'Bill arrived in October' });
  });

  it('a MANAGER naming the admin as the override actor is still refused', async () => {
    const f = await fixture('t8m');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: ['1200.00'] });
    await closeJanuary(f);
    const smuggled = { ...OVERRIDE, actor: f.admin };

    const refused = await rejection(
      asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, b.id, ATTEST, { periodOverride: smuggled })),
      'a manager naming the admin as the override actor',
    );
    expect(refused.userMessage).not.toMatch(/is closed/);
    await expectNothingPosted(f, b);
  });
});

describe('T9 - recordExpenseForInvoice on a VERIFIED January bill', () => {
  const record = (f: Fixture, who: Actor, invoiceId: string, periodOverride?: { reason: 'late_supplier_invoice'; note?: string }) =>
    asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, who, {
        storeId: f.storeId, supplierInvoiceId: invoiceId, supplierId: f.supplierId, categoryId: f.categoryId, particulars: 'Late pork',
        payments: [{ method: 'cash', amount: '700.00', moneyAccountId: f.cashId }],
        ...(periodOverride ? { periodOverride } : {}),
      }),
    );

  it('admin + override posts, one row - Mutant: drop the forward in recordExpenseForInvoice -> red', async () => {
    const f = await fixture('t9a');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: [], verified: true });
    await closeJanuary(f);

    const result = await record(f, f.admin, b.id, OVERRIDE);

    expect(await expenseStatus(result.expenseId)).toBe('posted');
    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_person_id: f.adminId, reason: 'late_supplier_invoice', note: 'Bill arrived in October', period_status_at_post: 'closed' });
  });

  it('admin with NO override: the ordinary sentence, and no expense row survives - control: the override posts', async () => {
    const f = await fixture('t9b');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: [], verified: true });
    await closeJanuary(f);

    const refused = await rejection(record(f, f.admin, b.id), 'recording a closed-month expense with no override');
    expect(refused.userMessage).toBe(CLOSED_SENTENCE);
    expect(await expensesFor(b.id), 'createExpense must unwind with the refusal').toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    await record(f, f.admin, b.id, OVERRIDE); // control
    expect(await expensesFor(b.id)).toBe(1);
  });

  it('manager + override: AuthorizationError, no expense row, no override row - control: the admin posts', async () => {
    const f = await fixture('t9c');
    const b = await f.bill({ on: '2026-01-10', loggedBy: f.staffId, drafts: [], verified: true });
    await closeJanuary(f);

    const refused = await rejection(record(f, f.manager, b.id, OVERRIDE), 'a manager recording a closed-month expense with an override');
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect(await expensesFor(b.id)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    await record(f, f.admin, b.id, OVERRIDE); // control
    expect(await expensesFor(b.id)).toBe(1);
  });
});
