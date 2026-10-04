/**
 * T-374 S5 (DEF-579) — the expense form's `lineCount` is judged, not clamped. T8, T9 of
 * `docs/tasks/374-money-push-follow-ups.md` S5.
 *
 *   T8 (red on HEAD): `lineCount = '51'` with 51 rows -> the 50-line sentence, nothing posted (HEAD: `Math.min(…, 50)` posts 50).
 *                     `lineCount = 'x'` -> the incomplete-form sentence (HEAD: `|| 0` -> "Add at least one payment line.").
 *   T9 (control):     `lineCount = '2'` with two rows posts both. Extra boundary control: `'50'` with 50 rows posts all 50.
 *
 * ⛔ TESTER. Harness and fixture are `t358-ap-invoice-expense-form.test.ts`'s (one RedirectSignal, the real domain, a real Postgres),
 * driven through `recordExpenseForInvoiceAction` with a COD invoice of ₱1,000.00 and ₱10.00 cash lines.
 * Every "nothing posted" assertion is paired with the control legs that post through the same door.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called — fixture is broken');
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
const SESSION_HOLDER: { session: unknown } = { session: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => SESSION_HOLDER.session),
}));

// ⛔ NOT a stub — forwards to the real module (the bare `@/...` specifier the root
// `vitest.config.mts` never resolves; S5.5m/S7/S2-R2 precedent).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});
vi.mock('@/lib/money-lines/load', async () => {
  return await import('../../src/lib/money-lines/load');
});
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, apRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, verifyInvoice } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDbSafe();
  await sql.end({ timeout: 5 });
});
async function closeDbSafe() {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy})
    returning id`;
  return row!.id;
}

/**
 * Full fixture: one org/store, a foundation cash drawer funded ₱500,000, an expense category with
 * an account code, an admin holding `create_expense` + `approve_expense`, a supplier WITH terms and
 * one WITHOUT (cash-on-delivery), and one VERIFIED invoice per supplier with remaining capacity
 * ≥ ₱500. Seeded through the real AP/domain entry points (`createSupplier`, `recordInvoice`,
 * `verifyInvoice`), not raw status writes.
 */
async function fixture(hint: string) {
  const code = uid(`t358-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${adminId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId: adminId, setBy: adminId,
  });

  const admin_ = actor(orgId, adminId);

  // ⛔ Segregation of duties: `verifyInvoice` refuses "you logged this invoice, so you cannot also
  // verify it" — recording and verifying must be two different people. This admin does both roles
  // in the fixture (logs AND, via a second person, verifies), but the ACTUAL A1-A5/R1-R3 legs all
  // act as `admin_` alone, matching a real single-admin org.
  const [verifier] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  const verifierId = verifier!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${verifierId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${verifierId}, ${storeId})`;
  const [verifierEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${verifierId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: verifierEmployment!.id, personId: verifierId, setBy: adminId,
  });
  const verifier_ = actor(orgId, verifierId);

  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const drawerId = drawer!.id;
  await fund(orgId, storeId, '1110', '500000.00');

  const [otherStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('other')}, 'Other Store') returning id`;
  const [otherAccount] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${otherStore!.id} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;

  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  const supplierTerms = await asOrg(orgId, (tx) => createSupplier(tx, admin_, { name: `Terms ${uid('s')}` }));
  const supplierCod = await asOrg(orgId, (tx) => createSupplier(tx, admin_, { name: `COD ${uid('s')}` }));
  // ⛔ No domain entry point sets credit_terms_days (createSupplier/editSupplier's input never
  // includes it — checked in `packages/domain/src/ap/index.ts`). This is supplier METADATA the
  // domain simply has no write path for yet, not the invoice/expense STATUS the "no raw status
  // writes" instruction is about — a direct SQL UPDATE is the only option.
  await sql`update suppliers set credit_terms_days = 30 where id = ${supplierTerms.id}`;

  async function verifiedInvoice(supplierId: string, totalAmount: string): Promise<string> {
    const fileId = await receiptFile(orgId, storeId, adminId);
    const created = await asOrg(orgId, (tx) =>
      recordInvoice(tx, admin_, { storeId, supplierId, invoiceDate: '2026-01-10', totalAmount, receiptFileId: fileId }),
    );
    await asOrg(orgId, (tx) =>
      verifyInvoice(tx, verifier_, created.id, { supplier: true, invoice: true, items: true, price: true }),
    );
    return created.id;
  }

  const invoiceTermsId = await verifiedInvoice(supplierTerms.id, '1000.00');
  const invoiceCodId = await verifiedInvoice(supplierCod.id, '1000.00');

  return {
    orgId, storeId, adminId, admin: admin_, drawerId, otherStoreAccountId: otherAccount!.id,
    categoryId: category!.id,
    supplierTermsId: supplierTerms.id, supplierCodId: supplierCod.id,
    invoiceTermsId, invoiceCodId,
  };
}

async function fund(orgId: string, storeId: string, code: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in (${code}, '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0', null, null)`;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount}, null, null)`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => new URL(to, 'http://localhost').searchParams.get(k);

const PER_LINE = '10.00';
const INCOMPLETE = "The payment lines didn't arrive complete — reload the page and try again.";
const TOO_MANY = 'An expense can carry at most 50 payment lines.';

/** A COD-invoice expense form: `rows` cash lines of ₱10.00 against the drawer, with `lineCount` posted as typed. */
function form(f: Awaited<ReturnType<typeof fixture>>, lineCount: string, rows: number): FormData {
  const fd = new FormData();
  fd.set('returnTo', `/ap/invoices/${f.invoiceCodId}`);
  fd.set('supplierInvoiceId', f.invoiceCodId);
  fd.set('storeId', f.storeId);
  fd.set('categoryId', f.categoryId);
  fd.set('particulars', 'T-374 S5 line count');
  fd.set('lineCount', lineCount);
  for (let i = 0; i < rows; i++) {
    fd.set(`lineMethod_${i}`, 'cash');
    fd.set(`lineAmount_${i}`, PER_LINE);
    fd.set(`lineAccount_${i}`, f.drawerId);
  }
  return fd;
}
async function submit(f: Awaited<ReturnType<typeof fixture>>, fd: FormData): Promise<string> {
  ACTOR_HOLDER.actor = f.admin;
  const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');
  return expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
}
const expenseCount = async (invoiceId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceId}`)[0]!.n);
const paymentLines = async (invoiceId: string) =>
  Number(
    (await sql<{ n: string }[]>`
      select count(*)::text as n from expense_payments
      where expense_id in (select id from expenses where supplier_invoice_id = ${invoiceId})`)[0]!.n,
  );

describe('T8 — lineCount past 50, or unreadable, is refused in words; nothing is posted', () => {
  it("lineCount '51' with 51 rows -> the 50-line sentence; no expense — red today: Math.min(…, 50) posts 50 lines and drops the 51st", async () => {
    const f = await fixture('t8a');
    const to = await submit(f, form(f, '51', 51));
    expect(param(to, 'error') ?? `NO error — redirected to ${to} (HEAD posts 50 of 51 lines and says nothing)`).toBe(TOO_MANY);
    expect(await expenseCount(f.invoiceCodId), 'a refused form posted an expense').toBe(0);
  });

  it("lineCount 'x' (unreadable) with a valid row -> the incomplete-form sentence; no expense — red today: `|| 0` reads it as no lines", async () => {
    const f = await fixture('t8b');
    const to = await submit(f, form(f, 'x', 1));
    expect(param(to, 'error') ?? `NO error — redirected to ${to}`).toBe(INCOMPLETE);
    expect(await expenseCount(f.invoiceCodId)).toBe(0);
  });

  it("lineCount '' / '2.5' / '0x2' / '-1' are not whole counts either; same sentence, no expense", async () => {
    const f = await fixture('t8c');
    for (const typed of ['', '2.5', '0x2', '-1']) {
      const to = await submit(f, form(f, typed, 2));
      expect(param(to, 'error') ?? `NO error — redirected to ${to}`, `lineCount=${JSON.stringify(typed)}`).toBe(INCOMPLETE);
    }
    expect(await expenseCount(f.invoiceCodId)).toBe(0);
  });
});

describe("T8d — lineCount '0' is a valid count of zero lines: the old zero-lines sentence, nothing posted", () => {
  it("lineCount '0' (no rows) -> 'Add at least one payment line.'; no expense", async () => {
    const f = await fixture('t8d');
    const to = await submit(f, form(f, '0', 0));
    expect(param(to, 'error') ?? `NO error — redirected to ${to}`).toBe('Add at least one payment line.');
    expect(await expenseCount(f.invoiceCodId)).toBe(0);
  });
});

describe('T9 (controls) — the same door posts when the count is honest, so the zero counts above are not an inert path', () => {
  it("lineCount '2' with two rows -> both lines post (one expense, two payment lines, ₱20.00)", async () => {
    const f = await fixture('t9');
    const to = await submit(f, form(f, '2', 2));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(to).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    expect(await expenseCount(f.invoiceCodId)).toBe(1);
    expect(await paymentLines(f.invoiceCodId)).toBe(2);
    const [e] = await sql<{ total_amount: string }[]>`select total_amount from expenses where supplier_invoice_id = ${f.invoiceCodId}`;
    expect(Number(e!.total_amount)).toBe(20);
  });

  it("boundary: lineCount '50' with 50 rows -> all 50 post (the cap is 'more than 50', not '50 or more')", async () => {
    const f = await fixture('t9b');
    const to = await submit(f, form(f, '50', 50));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(await paymentLines(f.invoiceCodId)).toBe(50);
  });
});
