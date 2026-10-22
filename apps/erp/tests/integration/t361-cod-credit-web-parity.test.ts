import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-361 (DEF-492) — web-parity legs P1-P3. `docs/tasks/361-def-492-cod-credit-rule-in-domain.md`
 * §Legs, "Web". R1: the web action's own `validateMoneyLines` call already refuses a credit line
 * for a cash-on-delivery supplier (pre-existing, T-266) — these legs are GUARDS proving that stays
 * true, byte-identical, once the domain gains its OWN copy of the rule (this task never touches
 * `apps/erp/**`). Harness/fixture from `t358-ap-invoice-expense-form.test.ts:14-192`. Amendment A1:
 * no `@/lib/constraint-messages` mock-forward — T-348's `@` alias resolves it directly.
 */
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
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/lib/money-lines/load', async () => {
  return await import('../../src/lib/money-lines/load');
});
vi.mock('@/components/money/MoneyLines', async () => {
  return await import('../../src/components/money/MoneyLines');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, verifyInvoice } from '@shareat/domain';
import { MoneyLines } from '../../src/components/money/MoneyLines';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
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

async function fixture(hint: string) {
  const code = uid(`t361p-${hint}`);
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
    values (${orgId}, ${storeId}, ${adminId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: adminId, setBy: adminId });
  const admin_ = actor(orgId, adminId);

  const [verifier] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${verifier!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${verifier!.id}, ${storeId})`;
  const verifier_ = actor(orgId, verifier!.id);

  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  const codName = `COD ${uid(hint)}`;
  const termsName = `Terms ${uid(hint)}`;
  const codSupplier = await asOrg(orgId, (tx) => createSupplier(tx, admin_, { name: codName }));
  const termsSupplier = await asOrg(orgId, (tx) => createSupplier(tx, admin_, { name: termsName, creditTermsDays: 30 }));

  return {
    orgId, storeId, admin: admin_, verifier: verifier_, categoryId: category!.id,
    codSupplierId: codSupplier.id, codSupplierName: codName,
    termsSupplierId: termsSupplier.id, termsSupplierName: termsName,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function receiptFile(f: Fixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.admin.personId}) returning id`;
  return row!.id;
}
async function pendingInvoice(f: Fixture, supplierId: string, totalAmount: string): Promise<string> {
  const fileId = await receiptFile(f);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId, invoiceDate: '2026-01-10', totalAmount, receiptFileId: fileId }),
  );
  return created.id;
}
async function verifiedInvoice(f: Fixture, supplierId: string, totalAmount: string): Promise<string> {
  const invoiceId = await pendingInvoice(f, supplierId, totalAmount);
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.verifier, invoiceId, { supplier: true, invoice: true, items: true, price: true }));
  return invoiceId;
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
const errorOf = (to: string) => paramsOf(to).get('error');

function emittedNames(props: {
  sources: Awaited<ReturnType<typeof import('../../src/lib/money-lines/load').loadMoneyLines>>['sources'];
  staff: { id: string; displayName: string }[];
  supplierId: string | null;
  supplierCreditTermsDays: number | null;
}): { names: string[] } {
  const html = renderToStaticMarkup(createElement('form', null, createElement(MoneyLines, { direction: 'out', ...props })));
  const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
  return { names };
}

const S = (name: string) => `${name} is cash-on-delivery. Set payment terms on the supplier to pay on credit.`;

async function expenseCountForInvoice(invoiceId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceId}`;
  return Number(row!.n);
}

describe('P1 (green, guard: R1 parity) — createExpenseAction, COD invoice, a credit line', () => {
  it(`the redirect error === S(name), byte-identical, via the action's own validateMoneyLines; no row`, async () => {
    const f = await fixture('p1');
    const invoiceId = await pendingInvoice(f, f.codSupplierId, '1000.00');
    ACTOR_HOLDER.actor = f.admin;
    const { createExpenseAction } = await import('../../src/app/expenses/actions');
    const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
    const moneyLines = await loadMoneyLines(f.orgId, f.storeId);
    const { names } = emittedNames({ sources: moneyLines.sources, staff: moneyLines.staff, supplierId: f.codSupplierId, supplierCreditTermsDays: null });

    const fd = new FormData();
    fd.set('returnTo', '/expenses/new');
    fd.set('storeId', f.storeId);
    fd.set('supplierId', f.codSupplierId);
    fd.set('supplierInvoiceId', invoiceId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-361 P1');
    fd.set(names.find((n) => /Count$/.test(n))!, '1');
    fd.set(names.find((n) => /Method_0$/.test(n))!, 'credit');
    fd.set(names.find((n) => /Amount_0$/.test(n))!, '500.00');
    fd.set(names.find((n) => /Account_0$/.test(n))!, '');

    const before = await expenseCountForInvoice(invoiceId);
    const to = await expectRedirectTo(() => createExpenseAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(S(f.codSupplierName));
    expect(await expenseCountForInvoice(invoiceId), 'nothing written').toBe(before);
  });
});

describe('P2 (green, guard: R1 parity) — recordExpenseForInvoiceAction, COD, a credit line', () => {
  it('as P1', async () => {
    const f = await fixture('p2');
    const invoiceId = await verifiedInvoice(f, f.codSupplierId, '1000.00');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');
    const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
    const moneyLines = await loadMoneyLines(f.orgId, f.storeId);
    const { names } = emittedNames({ sources: moneyLines.sources, staff: moneyLines.staff, supplierId: f.codSupplierId, supplierCreditTermsDays: null });

    const fd = new FormData();
    fd.set('returnTo', `/ap/invoices/${invoiceId}`);
    fd.set('supplierId', f.codSupplierId);
    fd.set('supplierInvoiceId', invoiceId);
    fd.set('storeId', f.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-361 P2');
    fd.set(names.find((n) => /Count$/.test(n))!, '1');
    fd.set(names.find((n) => /Method_0$/.test(n))!, 'credit');
    fd.set(names.find((n) => /Amount_0$/.test(n))!, '500.00');
    fd.set(names.find((n) => /Account_0$/.test(n))!, '');

    const before = await expenseCountForInvoice(invoiceId);
    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(S(f.codSupplierName));
    expect(await expenseCountForInvoice(invoiceId), 'nothing written').toBe(before);
  });
});

describe('P3 (green, guard) — recordExpenseForInvoiceAction, TERMS, a credit line', () => {
  it('redirects to /expenses/<uuid>, posted', async () => {
    const f = await fixture('p3');
    const invoiceId = await verifiedInvoice(f, f.termsSupplierId, '1000.00');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');
    const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
    const moneyLines = await loadMoneyLines(f.orgId, f.storeId);
    const { names } = emittedNames({ sources: moneyLines.sources, staff: moneyLines.staff, supplierId: f.termsSupplierId, supplierCreditTermsDays: 30 });

    const fd = new FormData();
    fd.set('returnTo', `/ap/invoices/${invoiceId}`);
    fd.set('supplierId', f.termsSupplierId);
    fd.set('supplierInvoiceId', invoiceId);
    fd.set('storeId', f.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-361 P3');
    fd.set(names.find((n) => /Count$/.test(n))!, '1');
    fd.set(names.find((n) => /Method_0$/.test(n))!, 'credit');
    fd.set(names.find((n) => /Amount_0$/.test(n))!, '500.00');
    fd.set(names.find((n) => /Account_0$/.test(n))!, '');

    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(to, `redirect URL was: ${to}`).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    const [payment] = await sql<{ method: string }[]>`
      select method from expense_payments
      where expense_id = (select id from expenses where supplier_invoice_id = ${invoiceId} order by created_at desc limit 1)`;
    expect(payment!.method).toBe('credit');
  });
});
