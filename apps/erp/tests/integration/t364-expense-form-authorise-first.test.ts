import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-364 S1 (DEF-496) — the expenses form authorises BEFORE it judges or reads anything.
 * `docs/tasks/364-def-496-497-authorise-first.md` §Slice S1, legs E1-E15. Today
 * `parseExpenseForm` (apps/erp/src/app/expenses/actions.ts) runs the invoice lookup,
 * `loadMoneyLines`, the supplier read and `validateMoneyLines` first, so a caller who holds no
 * capability is told float holder names / balances, supplier names and whether an invoice exists.
 * Target: one uniform refusal (the SAME person's refusal for a VALID form) and nothing read.
 *
 * Harness copied from `t361-cod-credit-web-parity.test.ts:16-170`. No existing test is edited.
 * Baselines are computed (BASE), never hard-coded; every non-holder leg first asserts BASE is
 * non-null (T-352 audit F7).
 *
 * Mutants (per the spec):
 *   M1 gate moved below validateMoneyLines ......... EXECUTED by the auditor 2026-09-30:
 *                                                    E1-E9 red, E10-E14 green.
 *   M2 approve_expense dropped from record list .... predicted, not executed: E9 red
 *   M3 approve_expense added to create list ........ predicted, not executed: E10 red
 *   M4 gate given `{}` instead of `{ storeId }` ..... predicted, not executed: E11-E12 red.
 *                                                    Only for E11/E12 (an admin who holds the role
 *                                                    and capability) does authorize() reach
 *                                                    storeRequired; for others it raises
 *                                                    noActiveRole/roleMayNot first
 *                                                    (packages/auth/src/authorize.ts :145, :178, :188).
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

import { randomUUID } from 'node:crypto';
import { transaction, APP_ROLE, goneSentence, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createSupplier,
  recordInvoice,
  verifyInvoice,
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
} from '@shareat/domain';
import { MoneyLines } from '../../src/components/money/MoneyLines';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

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

/** An opening balance into a GL code so a money account has something to spend FROM. */
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

async function moneyAccountId(orgId: string, storeId: string, custodian: 'staff' | 'office'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from money_accounts where org_id = ${orgId} and store_id = ${storeId}
      and custodian = ${custodian} and instrument = 'cash'`;
  if (!row) throw new Error(`fixture: no ${custodian} cash account seeded for the store`);
  return row.id;
}

async function person(orgId: string, name: string, role: 'staff' | 'manager' | 'admin', storeId: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

async function fixture(hint: string) {
  const code = uid(`t364e-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [store2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}2`)}, ${`Store2 ${hint}`}) returning id`;
  const otherStoreId = store2!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;

  const adminId = await person(orgId, 'Admin', 'admin', storeId);
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${adminId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: adminId, setBy: adminId });
  const admin_ = actor(orgId, adminId);

  const verifierId = await person(orgId, 'Verifier', 'admin', storeId);
  const verifier_ = actor(orgId, verifierId);

  // staff: role staff + store scope, NO position or person grant (CAPABILITY-MATRIX: not create_expense).
  const staffId = await person(orgId, 'Plain Staff', 'staff', storeId);
  // otherManager: role manager, scoped to the SECOND store only.
  const otherManagerId = await person(orgId, 'Other Manager', 'manager', otherStoreId);
  // creator: role staff at the store + one person grant create_expense (holds create, not approve).
  const creatorId = await person(orgId, 'Creator', 'staff', storeId);
  await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${creatorId}, 'create_expense', null, null)`;

  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  const codName = `COD ${uid(hint)}`;
  const termsName = `Terms ${uid(hint)}`;
  const codSupplier = await asOrg(orgId, (tx) => createSupplier(tx, admin_, { name: codName }));
  const termsSupplier = await asOrg(orgId, (tx) => createSupplier(tx, admin_, { name: termsName, creditTermsDays: 30 }));

  // Money: an office safe with cash to spend, and an open float held by "Float Holder <uid>", ₱100.00.
  await fundAccount(orgId, storeId, '1130', '500000.00');
  await fundAccount(orgId, otherStoreId, '1130', '500000.00');
  const officeSafeId = await moneyAccountId(orgId, storeId, 'office');
  const staffFloatId = await moneyAccountId(orgId, storeId, 'staff');
  const otherOfficeSafeId = await moneyAccountId(orgId, otherStoreId, 'office');
  const holderName = `Float Holder ${uid('h')}`;
  const holderId = await person(orgId, holderName, 'staff', storeId);
  const { id: floatRequestId } = await asOrg(orgId, (tx) =>
    createCashRequest(tx, admin_, { storeId, requestedFor: holderId, purpose: 'Market run', amount: '100.00', on: '2026-01-05' }),
  );
  await asOrg(orgId, (tx) => decideCashRequest(tx, verifier_, { requestId: floatRequestId, decision: 'approve', amount: '100.00', on: '2026-01-05' }));
  await asOrg(orgId, (tx) =>
    releaseCashRequest(tx, verifier_, { requestId: floatRequestId, amount: '100.00', fromMoneyAccountId: officeSafeId, on: '2026-01-05' }),
  );

  return {
    orgId, storeId, otherStoreId, admin: admin_, verifier: verifier_, categoryId: category!.id,
    staff: actor(orgId, staffId), otherManager: actor(orgId, otherManagerId), creator: actor(orgId, creatorId),
    codSupplierId: codSupplier.id, codSupplierName: codName,
    termsSupplierId: termsSupplier.id, termsSupplierName: termsName,
    officeSafeId, staffFloatId, otherOfficeSafeId, floatRequestId, holderName,
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
const errorOf = (to: string) => new URL(to, 'http://localhost').searchParams.get('error');

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

// ---------------------------------------------------------------------------------------------
// T-364 harness proper
// ---------------------------------------------------------------------------------------------

type ActionName = 'create' | 'record';
interface Line { method: string; amount: string; account: string; request: string }

/** Form data built from the names the real component emits (P1's shape), never hard-coded. */
async function buildForm(
  f: Fixture,
  o: { storeId?: string; supplierId: string; invoiceId: string; lines: Line[]; namesStoreId?: string },
): Promise<FormData> {
  const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
  const moneyLines = await loadMoneyLines(f.orgId, o.namesStoreId ?? f.storeId);
  const { names } = emittedNames({ sources: moneyLines.sources, staff: moneyLines.staff, supplierId: f.termsSupplierId, supplierCreditTermsDays: null });
  const fd = new FormData();
  fd.set('returnTo', '/expenses/new');
  fd.set('storeId', o.storeId ?? f.storeId);
  fd.set('supplierId', o.supplierId);
  fd.set('supplierInvoiceId', o.invoiceId);
  fd.set('categoryId', f.categoryId);
  fd.set('particulars', 'T-364 S1');
  fd.set(names.find((n) => /Count$/.test(n))!, String(o.lines.length));
  o.lines.forEach((l, i) => {
    fd.set(names.find((n) => new RegExp(`Method_${i}$`).test(n))!, l.method);
    fd.set(names.find((n) => new RegExp(`Amount_${i}$`).test(n))!, l.amount);
    fd.set(names.find((n) => new RegExp(`Account_${i}$`).test(n))!, l.account);
    fd.set(names.find((n) => new RegExp(`Request_${i}$`).test(n))!, l.request);
  });
  return fd;
}

/** Run an action as `who`; returns the redirect target and its `error` param (null on success). */
async function run(action: ActionName, who: Actor, fd: FormData): Promise<{ to: string; error: string | null }> {
  ACTOR_HOLDER.actor = who;
  const mod = await import('../../src/app/expenses/actions');
  const fn = action === 'create' ? mod.createExpenseAction : mod.recordExpenseForInvoiceAction;
  const to = await expectRedirectTo(() => fn(fd));
  return { to, error: errorOf(to) };
}

const cashLine = (f: Fixture, amount = '50.00'): Line => ({ method: 'cash', amount, account: f.officeSafeId, request: '' });
const floatLine = (f: Fixture): Line => ({ method: 'cash', amount: '500.00', account: f.staffFloatId, request: f.floatRequestId });
const codCreditLine = (): Line => ({ method: 'credit', amount: '500.00', account: '', request: '' });
const amountLine = (f: Fixture): Line => ({ ...cashLine(f), amount: '1,5' });

const FLOAT_SENTENCE = /Float Holder .*float holds 100\.00.*asks for more/;

/** One shared fixture: three VERIFIED invoices (terms supplier, COD supplier, spare). Refused
 *  submissions write nothing, so the same invoices serve every non-holder leg. */
let shared: Promise<{ f: Fixture; termsInv: string; codInv: string }> | null = null;
function world() {
  shared ??= (async () => {
    const f = await fixture('e');
    return { f, termsInv: await verifiedInvoice(f, f.termsSupplierId, '5000.00'), codInv: await verifiedInvoice(f, f.codSupplierId, '5000.00') };
  })();
  return shared;
}

/** BASE(p, action): person p's `error` for the SAME action and a VALID form (T-351 W1, T-352 F7). */
async function base(who: Actor, action: ActionName, storeId?: string): Promise<string> {
  const { f, termsInv } = await world();
  const fd = await buildForm(f, { storeId, supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [cashLine(f)] });
  const { error, to } = await run(action, who, fd);
  expect(error, `BASE must be a refusal, redirect was: ${to}`).not.toBeNull();
  return error!;
}

/** The "learned nothing" assertions shared by the non-holder legs. */
function expectNothingLearned(error: string | null, baseline: string, extraForbidden: (string | RegExp)[] = []) {
  expect(error, 'non-holder must be refused').not.toBeNull();
  expect(error).toBe(baseline);
  for (const bad of ['Float Holder', '100.00', ...extraForbidden]) {
    if (typeof bad === 'string') expect(error, `leaked ${bad}`).not.toContain(bad);
    else expect(error, `leaked ${bad}`).not.toMatch(bad);
  }
}

async function countsFor(...ids: string[]): Promise<number[]> {
  return Promise.all(ids.map(expenseCountForInvoice));
}

describe('T-364 S1 — non-holders get one uniform refusal and nothing is read (E1-E9)', () => {
  it('E1 staff · create · float line over the outstanding: BASE, no float holder / balance. Kills M1', async () => {
    const { f, termsInv, codInv } = await world();
    const baseline = await base(f.staff, 'create');
    const before = await countsFor(termsInv, codInv);
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [floatLine(f)] });
    const { error } = await run('create', f.staff, fd);
    expectNothingLearned(error, baseline);
    expect(await countsFor(termsInv, codInv), 'nothing written').toEqual(before);
  });

  it('E2 staff · create · credit line against the COD supplier: BASE, no supplier name. Kills M1', async () => {
    const { f, codInv } = await world();
    const baseline = await base(f.staff, 'create');
    const before = await expenseCountForInvoice(codInv);
    const fd = await buildForm(f, { supplierId: f.codSupplierId, invoiceId: codInv, lines: [codCreditLine()] });
    const { error } = await run('create', f.staff, fd);
    expectNothingLearned(error, baseline, [f.codSupplierName, 'cash-on-delivery']);
    expect(await expenseCountForInvoice(codInv), 'nothing written').toBe(before);
  });

  it('E3 staff · create · amount "1,5": BASE, no "not a valid amount". Kills M1', async () => {
    const { f, termsInv } = await world();
    const baseline = await base(f.staff, 'create');
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [amountLine(f)] });
    const { error } = await run('create', f.staff, fd);
    expectNothingLearned(error, baseline, ['not a valid amount']);
  });

  it('E4 staff · create · supplier blank + a random invoice uuid: BASE (nothing says the invoice is missing). Kills M1', async () => {
    const { f } = await world();
    const baseline = await base(f.staff, 'create');
    const fd = await buildForm(f, { supplierId: '', invoiceId: randomUUID(), lines: [cashLine(f)] });
    const { error } = await run('create', f.staff, fd);
    expectNothingLearned(error, baseline, ['does not exist']);
  });

  it('E5 staff · create · ORACLE PAIR: real invoice id vs random uuid, supplier blank → identical, both BASE. Kills M1', async () => {
    const { f, termsInv } = await world();
    const baseline = await base(f.staff, 'create');
    const real = await run('create', f.staff, await buildForm(f, { supplierId: '', invoiceId: termsInv, lines: [cashLine(f)] }));
    const fake = await run('create', f.staff, await buildForm(f, { supplierId: '', invoiceId: randomUUID(), lines: [cashLine(f)] }));
    expect(real.error, 'error for a REAL invoice (actual) must equal error for a RANDOM uuid (expected)').toBe(fake.error);
    expect(real.error, 'real-invoice error vs BASE').toBe(baseline);
    expect(fake.error, 'random-uuid error vs BASE').toBe(baseline);
  });

  it('E6 otherManager (store B only) · create at the fixture store · float line: BASE(otherManager), no float holder. Kills M1', async () => {
    const { f, termsInv } = await world();
    const baseline = await base(f.otherManager, 'create');
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [floatLine(f)] });
    const { error } = await run('create', f.otherManager, fd);
    expectNothingLearned(error, baseline);
  });

  it('E7 staff · record · float line on a verified invoice: BASE(staff, record), no float holder. Kills M1', async () => {
    const { f, termsInv } = await world();
    const baseline = await base(f.staff, 'record');
    const before = await expenseCountForInvoice(termsInv);
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [floatLine(f)] });
    const { error } = await run('record', f.staff, fd);
    expectNothingLearned(error, baseline);
    expect(await expenseCountForInvoice(termsInv), 'nothing written').toBe(before);
  });

  it('E8 staff · record · COD credit line: as E7, no supplier name. Kills M1', async () => {
    const { f, codInv } = await world();
    const baseline = await base(f.staff, 'record');
    const fd = await buildForm(f, { supplierId: f.codSupplierId, invoiceId: codInv, lines: [codCreditLine()] });
    const { error } = await run('record', f.staff, fd);
    expectNothingLearned(error, baseline, [f.codSupplierName, 'cash-on-delivery']);
  });

  it('E9 creator (create, not approve) · record · float line: BASE(creator, record) is the approve_expense refusal; no float holder. Kills M1, M2', async () => {
    const { f, termsInv } = await world();
    const baseline = await base(f.creator, 'record');
    console.log(`[T-364 E9] BASE(creator, record) = ${JSON.stringify(baseline)}`);
    expect(baseline, 'BASE is the approve_expense refusal').toMatch(/approve an expense/);
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [floatLine(f)] });
    const { error } = await run('record', f.creator, fd);
    expectNothingLearned(error, baseline);
  });
});

describe('T-364 S1 — positive controls and order guards (green before and after)', () => {
  it('E10 creator · create · float line: the FLOAT sentence byte for byte (the gate did not over-refuse a holder). Kills M3', async () => {
    const { f, termsInv } = await world();
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [floatLine(f)] });
    const { error } = await run('create', f.creator, fd);
    expect(error).toMatch(FLOAT_SENTENCE);
    expect(error).toContain(f.holderName);
  });

  it('E11 admin · create · E1..E4 forms in turn: float, COD, amount, invoice-missing sentences. Kills M4', async () => {
    const { f, termsInv, codInv } = await world();
    const e1 = await run('create', f.admin, await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [floatLine(f)] }));
    expect(e1.error).toMatch(FLOAT_SENTENCE);
    const e2 = await run('create', f.admin, await buildForm(f, { supplierId: f.codSupplierId, invoiceId: codInv, lines: [codCreditLine()] }));
    expect(e2.error).toBe(S(f.codSupplierName));
    const e3 = await run('create', f.admin, await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [amountLine(f)] }));
    expect(e3.error).toMatch(/"1,5" is not a valid amount/);
    const e4 = await run('create', f.admin, await buildForm(f, { supplierId: '', invoiceId: randomUUID(), lines: [cashLine(f)] }));
    // R7 (DEF-508) retired the old `/does not exist/` text — the blank-supplier pre-lookup in
    // actions.ts:168 now throws the same uniform goneSentence as the domain gate, id-free.
    expect(e4.error).toBe(goneSentence('supplier invoice'));
  });

  it('E12 admin · record · float sentence, then a valid form posts and redirects to /expenses/<uuid>. Kills M4', async () => {
    const { f, termsInv } = await world();
    const bad = await run('record', f.admin, await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [floatLine(f)] }));
    expect(bad.error).toMatch(FLOAT_SENTENCE);
    const freshInv = await verifiedInvoice(f, f.termsSupplierId, '5000.00');
    const ok = await run('record', f.admin, await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: freshInv, lines: [cashLine(f)] }));
    expect(ok.error, `redirect was: ${ok.to}`).toBeNull();
    expect(ok.to).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    expect(await expenseCountForInvoice(freshInv), 'expense posted').toBe(1);
  });

  it('E13 staff · create · storeId blank: "Choose a store." (the one pre-gate check)', async () => {
    const { f, termsInv } = await world();
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [cashLine(f)] });
    fd.set('storeId', '');
    const { error } = await run('create', f.staff, fd);
    expect(error).toBe('Choose a store.');
  });

  it('E14 admin · create · storeId blank + a malformed amount: "Choose a store." still wins', async () => {
    const { f, termsInv } = await world();
    const fd = await buildForm(f, { supplierId: f.termsSupplierId, invoiceId: termsInv, lines: [amountLine(f)] });
    fd.set('storeId', '');
    const { error } = await run('create', f.admin, fd);
    expect(error).toBe('Choose a store.');
  });

  // E15 — oracle pair for a holder at ANOTHER store. otherManager legitimately holds create_expense
  // at their own store, so the gate passes, and the invoice lookup (actions.ts) is org-scoped, not
  // store-scoped: store B's invoice is reachable from store A. T-364 S1's gate does not close this;
  // the fix is T-367 S2's R7 (DEF-508), which does not exist yet — this asserts the TARGET (the
  // oracle pair agrees) so the red names exactly what is still open, rather than a permanent todo.
  it('E15 otherManager · create at OWN store, supplier blank: real store-B invoice vs random uuid must be identical — Mutant: no store check exists at all (HEAD), (a) actually saves against store B\'s invoice, red — DEF-508 (T-367)', async () => {
    const { f, termsInv } = await world();
    const before = await expenseCountForInvoice(termsInv);

    const fdReal = await buildForm(f, { storeId: f.otherStoreId, namesStoreId: f.otherStoreId, supplierId: '', invoiceId: termsInv, lines: [{ method: 'cash', amount: '50.00', account: f.otherOfficeSafeId, request: '' }] });
    const { error: errorReal } = await run('create', f.otherManager, fdReal);

    const fdFake = await buildForm(f, { storeId: f.otherStoreId, namesStoreId: f.otherStoreId, supplierId: '', invoiceId: randomUUID(), lines: [{ method: 'cash', amount: '50.00', account: f.otherOfficeSafeId, request: '' }] });
    const { error: errorFake } = await run('create', f.otherManager, fdFake);

    expect(errorFake, 'the fake id must be refused as not-found').not.toBeNull();
    expect(
      errorReal,
      `today: no store check exists (DEF-508) — the real store-B invoice id was NOT refused the same way as the fake one (got: ${errorReal ?? '(no error — it saved)'}, vs fake: ${errorFake})`,
    ).toBe(errorFake);
    expect(errorReal, 'must not name store B\'s terms supplier').not.toContain(f.termsSupplierName);

    const after = await expenseCountForInvoice(termsInv);
    expect(after, 'today: this DEF-508 gap actually writes an expense at store A against store B\'s invoice').toBe(before);
  });
});
