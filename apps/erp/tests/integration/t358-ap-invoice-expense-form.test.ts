/**
 * T-358 / DEF-485 — `docs/tasks/358-def-485-ap-invoice-expense-moneylines.md`, legs R1-R3, A1-A5,
 * plus amendment C1's two render legs (credit-default-for-terms / cash-for-COD).
 *
 * ⛔ TESTER, not BUILDER. `apps/erp/src/app/ap/invoices/[id]/page.tsx` still posts the old
 * hand-rolled trio (`method_1`/`amount_1`/`moneyAccountId_1`, no `lineCount`) — every A-leg below is
 * red today for exactly that reason (DEF-485's repro). R1-R3 are red because the page has not been
 * swapped to `<MoneyLines>` yet.
 *
 * ⛔ C4 — MoneyLines is verified by NAMES (`emittedNames()`) and by the "— no terms set" TEXT, never
 * by line numbers — T-353 S3 is committed and MoneyLines.tsx is stable, but this file does not pin
 * its internals by position.
 */
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/components/money/MoneyLines', async () => {
  return await import('../../src/components/money/MoneyLines');
});
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, apRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, verifyInvoice } from '@shareat/domain';
import { MoneyLines } from '../../src/components/money/MoneyLines';
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

// =================================================================================================
// emittedNames() — per spec §"TESTER paths". Renders <form><MoneyLines .../></form> and returns
// every name="…" plus the Count input's rendered value.
// =================================================================================================

function emittedNames(props: {
  sources: Awaited<ReturnType<typeof import('../../src/lib/money-lines/load').loadMoneyLines>>['sources'];
  staff: { id: string; displayName: string }[];
  supplierId: string | null;
  supplierCreditTermsDays: number | null;
}): { names: string[]; countValue: string | null; html: string } {
  const html = renderToStaticMarkup(
    createElement('form', null, createElement(MoneyLines, { direction: 'out', ...props })),
  );
  const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
  const countMatch = html.match(/name="[a-zA-Z]*Count"[^>]*value="([^"]*)"/);
  return { names, countValue: countMatch?.[1] ?? null, html };
}

describe('emittedNames() — non-vacuous (a broken render must not pass every leg below by accident)', () => {
  it('finds ≥1 Method, Amount and Account name for index 0, plus a Count name', () => {
    const { names } = emittedNames({ sources: [], staff: [], supplierId: null, supplierCreditTermsDays: null });
    expect(names.some((n) => /Method_0$/.test(n)), `names: ${JSON.stringify(names)}`).toBe(true);
    expect(names.some((n) => /Amount_0$/.test(n))).toBe(true);
    expect(names.some((n) => /Account_0$/.test(n))).toBe(true);
    expect(names.some((n) => /Count$/.test(n))).toBe(true);
  });
});

// =================================================================================================
// R1-R3 — page render legs, and C1's two new render legs.
// =================================================================================================

let InvoiceDetailPage: typeof import('../../src/app/ap/invoices/[id]/page').default;
let requireSessionMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  InvoiceDetailPage = (await import('../../src/app/ap/invoices/[id]/page')).default;
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
}, 30_000);

async function renderInvoicePage(f: Awaited<ReturnType<typeof fixture>>, invoiceId: string): Promise<string> {
  requireSessionMock.mockResolvedValue({
    actor: f.admin, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  });
  const element = await InvoiceDetailPage({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as never);
}

describe('R1 — the verified invoice\'s expense form is MoneyLines, not the old trio', () => {
  it('markup contains lineCount/lineMethod_0/lineAmount_0/lineAccount_0, and none of the trio\'s names — red today: emits the trio, no lineCount', async () => {
    const f = await fixture('r1');
    const html = await renderInvoicePage(f, f.invoiceTermsId);
    expect(html).toMatch(/name="lineCount"/);
    expect(html).toMatch(/name="lineMethod_0"/);
    expect(html).toMatch(/name="lineAmount_0"/);
    expect(html).toMatch(/name="lineAccount_0"/);
    expect(html, "today's red: the trio is still there").not.toMatch(/name="method_1"/);
    expect(html).not.toMatch(/name="amount_1"/);
    expect(html).not.toMatch(/name="moneyAccountId_1"/);
  });
});

describe('R2 — Credit is disabled ("no terms set") for the cash-on-delivery supplier, enabled for the one WITH terms', () => {
  it('COD invoice: Credit option is disabled and says "no terms set" — red today: MoneyLines is not mounted at all yet, so lineMethod_0 is absent from the render', async () => {
    const f = await fixture('r2-cod');
    const html = await renderInvoicePage(f, f.invoiceCodId);
    const idx = html.indexOf('lineMethod_0');
    expect(idx, `expected to find the method select in: ${html}`).toBeGreaterThanOrEqual(0);
    const window = html.slice(Math.max(0, idx - 100), idx + 600);
    expect(window).toMatch(/<option value="credit" disabled[^>]*>[\s\S]*no terms set/);
  });

  it('WITH-terms invoice: Credit option is enabled (not disabled) — red today: MoneyLines is not mounted at all yet, so lineMethod_0 is absent from the render', async () => {
    const f = await fixture('r2-terms');
    const html = await renderInvoicePage(f, f.invoiceTermsId);
    const idx = html.indexOf('lineMethod_0');
    expect(idx, `expected to find the method select in: ${html}`).toBeGreaterThanOrEqual(0);
    const window = html.slice(Math.max(0, idx - 100), idx + 600);
    expect(window).not.toMatch(/<option value="credit" disabled/);
  });
});

describe('R3 — the page\'s recordExpenseForInvoiceAction form names ⊇ emittedNames() for the same props', () => {
  it('every name MoneyLines emits appears inside the render — red today: the names are absent (the trio is mounted instead)', async () => {
    const f = await fixture('r3');
    // ⛔ Uses the COD invoice, not the WITH-terms one: C1 defaults the WITH-terms page render to a
    // CREDIT line (no lineSource_0 — credit needs no source), while emittedNames() below (called
    // with no initialLines) defaults to CASH (which DOES emit lineSource_0). Comparing those would
    // spuriously fail on lineSource_0 for a reason unrelated to R3's own claim. The COD invoice's
    // page render defaults to Cash too, so both sides compare like with like.
    const html = await renderInvoicePage(f, f.invoiceCodId);
    const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
    const moneyLines = await loadMoneyLines(f.orgId, f.storeId);
    const { names } = emittedNames({
      sources: moneyLines.sources, staff: moneyLines.staff,
      supplierId: f.supplierCodId, supplierCreditTermsDays: null,
    });
    const missing = names.filter((n) => !html.includes(`name="${n}"`));
    expect(missing, `missing from the page render: ${JSON.stringify(missing)}`).toEqual([]);
  });
});

describe('C1 (Ian, bible row 247) — Credit defaults for a supplier WITH terms (remaining pre-filled); Cash for cash-on-delivery', () => {
  it('WITH terms: line 0 is credit, pre-selected, amount pre-filled to the remaining capacity — red today: MoneyLines is not mounted at all yet, so lineMethod_0/lineAmount_0 are absent from the render', async () => {
    const f = await fixture('c1-terms');
    const html = await renderInvoicePage(f, f.invoiceTermsId);
    const capacity = await asOrg(f.orgId, (tx) => apRepo.capacityOf(tx, f.orgId, f.invoiceTermsId));
    const remaining = capacity?.remaining ?? '1000.00';

    const methodIdx = html.indexOf('lineMethod_0');
    expect(methodIdx, `expected to find the method select in: ${html}`).toBeGreaterThanOrEqual(0);
    const methodWindow = html.slice(Math.max(0, methodIdx - 100), methodIdx + 600);
    expect(methodWindow, `today's red — window: ${methodWindow}`).toMatch(/<option value="credit"[^>]*selected/);

    const amountIdx = html.indexOf('lineAmount_0');
    expect(amountIdx, `expected to find the amount input in: ${html}`).toBeGreaterThanOrEqual(0);
    const amountWindow = html.slice(Math.max(0, amountIdx - 50), amountIdx + 300);
    expect(amountWindow, `today's red — window: ${amountWindow}`).toContain(`value="${remaining}"`);
  });

  it('cash-on-delivery: line 0 is cash, amount blank — red today too: MoneyLines is not mounted at all yet, so lineMethod_0/lineAmount_0 are absent from the render (same root cause as R1-R3)', async () => {
    const f = await fixture('c1-cod');
    const html = await renderInvoicePage(f, f.invoiceCodId);

    const methodIdx = html.indexOf('lineMethod_0');
    expect(methodIdx, `expected to find the method select in: ${html}`).toBeGreaterThanOrEqual(0);
    const methodWindow = html.slice(Math.max(0, methodIdx - 100), methodIdx + 600);
    expect(methodWindow).toMatch(/<option value="cash"[^>]*selected/);

    const amountIdx = html.indexOf('lineAmount_0');
    expect(amountIdx, `expected to find the amount input in: ${html}`).toBeGreaterThanOrEqual(0);
    const amountWindow = html.slice(Math.max(0, amountIdx - 50), amountIdx + 300);
    expect(amountWindow).toMatch(/value=""/);
  });
});

// =================================================================================================
// A1-A5 — recordExpenseForInvoiceAction, driven ONLY through emittedNames() (C3).
// =================================================================================================

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

function hiddenInputs(f: Awaited<ReturnType<typeof fixture>>, invoiceId: string) {
  return { returnTo: `/ap/invoices/${invoiceId}`, supplierId: '', supplierInvoiceId: invoiceId, storeId: f.storeId };
}

async function expenseCountForInvoice(invoiceId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceId}`;
  return Number(row!.n);
}

/**
 * ⚠️ MEASURED FINDING, reported to the orchestrator: A1/A2 are GREEN TODAY, not red as the spec's
 * own table states. `emittedNames()` renders MoneyLines directly (its own definition: a STANDALONE
 * `<MoneyLines>`, never the page) and this FormData is posted straight to
 * `recordExpenseForInvoiceAction`, bypassing the page's actual render entirely.
 * `parseExpenseForm`/`validateMoneyLines` were built FOR MoneyLines back in T-266 and have never
 * needed the page to be right — DEF-485 lives ENTIRELY in the page not emitting MoneyLines' names
 * (R1/R3, correctly red), not in the parser. Kept as a real regression guard (it will still be true,
 * and now meaningfully so, once the page is fixed) — not weakened to force a red it cannot honestly
 * have. The genuine "red today" evidence for A1/A2 is the DEF-485-repro leg at the bottom of this
 * file, using the trio's ACTUAL FormData.
 */
describe('A1 — a CASH line from emittedNames() posts, linked to the invoice', () => {
  it('redirects to /expenses/<uuid>; one posted expense, total ₱500, one cash payment line — GREEN today (see the file-level note above); the trio\'s actual red is the DEF-485-repro leg below', async () => {
    const f = await fixture('a1');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');

    const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
    const moneyLines = await loadMoneyLines(f.orgId, f.storeId);
    const { names } = emittedNames({
      sources: moneyLines.sources, staff: moneyLines.staff, supplierId: null, supplierCreditTermsDays: null,
    });
    expect(names.some((n) => /Count$/.test(n)), 'emittedNames() produced no Count name — fixture is broken').toBe(true);

    const fd = new FormData();
    const hidden = hiddenInputs(f, f.invoiceCodId);
    fd.set('returnTo', hidden.returnTo);
    fd.set('supplierInvoiceId', hidden.supplierInvoiceId);
    fd.set('storeId', hidden.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-358 A1 cash line');
    const countName = names.find((n) => /Count$/.test(n))!;
    fd.set(countName, '1');
    fd.set(names.find((n) => /Method_0$/.test(n))!, 'cash');
    fd.set(names.find((n) => /Amount_0$/.test(n))!, '500.00');
    fd.set(names.find((n) => /Account_0$/.test(n))!, f.drawerId);

    const before = await expenseCountForInvoice(f.invoiceCodId);
    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(to, `today's red — got redirect: ${to}`).toMatch(/^\/expenses\/[0-9a-f-]{36}/);

    const after = await expenseCountForInvoice(f.invoiceCodId);
    expect(after, 'expected exactly one new posted expense').toBe(before + 1);
    const [expense] = await sql<{ total_amount: string }[]>`
      select total_amount from expenses where supplier_invoice_id = ${f.invoiceCodId} order by created_at desc limit 1`;
    expect(Number(expense!.total_amount)).toBe(500);
    const [payment] = await sql<{ method: string; money_account_id: string }[]>`
      select method, money_account_id from expense_payments
      where expense_id = (select id from expenses where supplier_invoice_id = ${f.invoiceCodId} order by created_at desc limit 1)`;
    expect(payment!.method).toBe('cash');
    expect(payment!.money_account_id).toBe(f.drawerId);
  });
});

describe('A2 — a CREDIT line from emittedNames(), supplier WITH terms, posts', () => {
  it('redirects to /expenses/<uuid>, posted, with a credit payment line — GREEN today (see A1\'s file-level note above)', async () => {
    const f = await fixture('a2');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');

    const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
    const moneyLines = await loadMoneyLines(f.orgId, f.storeId);
    const { names } = emittedNames({
      sources: moneyLines.sources, staff: moneyLines.staff, supplierId: f.supplierTermsId, supplierCreditTermsDays: 30,
    });

    const fd = new FormData();
    const hidden = hiddenInputs(f, f.invoiceTermsId);
    fd.set('returnTo', hidden.returnTo);
    fd.set('supplierId', f.supplierTermsId);
    fd.set('supplierInvoiceId', hidden.supplierInvoiceId);
    fd.set('storeId', hidden.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-358 A2 credit line');
    fd.set(names.find((n) => /Count$/.test(n))!, '1');
    fd.set(names.find((n) => /Method_0$/.test(n))!, 'credit');
    fd.set(names.find((n) => /Amount_0$/.test(n))!, '500.00');
    fd.set(names.find((n) => /Account_0$/.test(n))!, '');

    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(to, `today's red — got redirect: ${to}`).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    const [payment] = await sql<{ method: string }[]>`
      select method from expense_payments
      where expense_id = (select id from expenses where supplier_invoice_id = ${f.invoiceTermsId} order by created_at desc limit 1)`;
    expect(payment!.method).toBe('credit');
  });
});

describe('A3 — Count = 0 (no lines): the parser\'s refusal is intact', () => {
  it('redirects to returnTo with error= "Add at least one payment line." — no expense row (guard)', async () => {
    const f = await fixture('a3');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');

    const fd = new FormData();
    const hidden = hiddenInputs(f, f.invoiceCodId);
    fd.set('returnTo', hidden.returnTo);
    fd.set('supplierInvoiceId', hidden.supplierInvoiceId);
    fd.set('storeId', hidden.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-358 A3 no lines');
    fd.set('lineCount', '0');

    const before = await expenseCountForInvoice(f.invoiceCodId);
    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(to).toContain(hidden.returnTo);
    expect(decodeURIComponent(to)).toContain('Add at least one payment line.');
    expect(await expenseCountForInvoice(f.invoiceCodId)).toBe(before);
  });
});

describe('A4 — a credit line for the cash-on-delivery supplier: refused', () => {
  it('redirects with error= the "…is cash-on-delivery…" sentence — no expense row (guard)', async () => {
    const f = await fixture('a4');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');

    const fd = new FormData();
    const hidden = hiddenInputs(f, f.invoiceCodId);
    fd.set('returnTo', hidden.returnTo);
    fd.set('supplierInvoiceId', hidden.supplierInvoiceId);
    fd.set('storeId', hidden.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-358 A4 credit on COD');
    fd.set('lineCount', '1');
    fd.set('lineMethod_0', 'credit');
    fd.set('lineAmount_0', '500.00');

    const before = await expenseCountForInvoice(f.invoiceCodId);
    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(decodeURIComponent(to)).toMatch(/is cash-on-delivery/);
    expect(await expenseCountForInvoice(f.invoiceCodId)).toBe(before);
  });
});

describe('A5 — a cash line whose Account is at ANOTHER store of the same org: refused', () => {
  it('refused (server re-fetches sources per store) — no expense row (guard)', async () => {
    const f = await fixture('a5');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');

    const fd = new FormData();
    const hidden = hiddenInputs(f, f.invoiceCodId);
    fd.set('returnTo', hidden.returnTo);
    fd.set('supplierInvoiceId', hidden.supplierInvoiceId);
    fd.set('storeId', hidden.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-358 A5 wrong-store account');
    fd.set('lineCount', '1');
    fd.set('lineMethod_0', 'cash');
    fd.set('lineAmount_0', '500.00');
    fd.set('lineAccount_0', f.otherStoreAccountId);

    const before = await expenseCountForInvoice(f.invoiceCodId);
    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(to).toContain(hidden.returnTo);
    expect(await expenseCountForInvoice(f.invoiceCodId)).toBe(before);
  });
});

// =================================================================================================
// DEF-485 repro — the OLD trio's FormData, recorded once as evidence, kept for A1/A2's red.
// =================================================================================================

describe('DEF-485 repro (evidence) — the old trio\'s exact FormData refuses with no lineCount', () => {
  it('method_1=cash, amount_1=500, moneyAccountId_1=<id>, no lineCount: refused "Add at least one payment line."', async () => {
    const f = await fixture('repro');
    ACTOR_HOLDER.actor = f.admin;
    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');

    const fd = new FormData();
    const hidden = hiddenInputs(f, f.invoiceCodId);
    fd.set('returnTo', hidden.returnTo);
    fd.set('supplierInvoiceId', hidden.supplierInvoiceId);
    fd.set('storeId', hidden.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'DEF-485 repro');
    fd.set('method_1', 'cash');
    fd.set('amount_1', '500');
    fd.set('moneyAccountId_1', f.drawerId);
    // Deliberately NO lineCount — the trio never posted one.

    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(decodeURIComponent(to)).toContain('Add at least one payment line.');
  });
});
