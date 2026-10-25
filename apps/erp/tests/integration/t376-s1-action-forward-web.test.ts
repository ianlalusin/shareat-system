import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-376 S1 audit guards (F2, F3, F4). Real DB and real domain; the domain functions are wrapped by call-through spies so
 * the legs can read exactly what the ACTION handed over (the fifth argument of verifyInvoice, `periodOverride` in
 * recordExpenseForInvoice's input). Written after the builder's code landed, so these are guards (green on the
 * builder's tree); each names the mutant that turns it red.
 *
 *   F2  recordExpenseForInvoiceAction: open-month bill -> no periodOverride; closed-month -> passed.
 *       Mutant: forward unconditionally (drop `asked && inClosedMonth`) -> the open-month leg is red.
 *   F3  forged form field invoiceDate: the action trusts the invoice row. Mutant: read the date from the form -> both legs red.
 *   F4  cross-store: a manager scoped to store B submitting for a store-A bill gets the generic refusal.
 *       Mutant: run the closed-month logic/sentence before authorize, or authorize at the manager's own store -> red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
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
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
const SPY = { verify: [] as unknown[][], record: [] as unknown[][] };
vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/domain')>();
  return {
    ...actual,
    verifyInvoice: (...a: unknown[]) => {
      SPY.verify.push(a);
      return (actual.verifyInvoice as (...x: unknown[]) => unknown)(...a);
    },
    recordExpenseForInvoice: (...a: unknown[]) => {
      SPY.record.push(a);
      return (actual.recordExpenseForInvoice as (...x: unknown[]) => unknown)(...a);
    },
  };
});
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createExpense } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

async function person(orgId: string, name: string, role: 'manager' | 'admin' | 'staff', storeId: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

/** Lipa; admin, manager, staff (logs the bills), staff2 (holds nothing); cash funded; January 2026 closed by `closeJanuary`, February open. */
async function fixture(hint: string) {
  const code = uid(`t376s1w-${hint}`);
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
  const staff2Id = await person(orgId, 'Staff Two', 'staff', storeId);
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

  const bill = async (o: { on: string; drafts: string[]; verified?: boolean }) => {
    const [inv] = o.verified
      ? await sql<{ id: string }[]>`
          insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
                                         attested_supplier, attested_invoice, attested_items, attested_price)
          values (${orgId}, ${storeId}, ${supplier!.id}, ${o.on}, '5000.00', 'verified', ${file!.id}, ${managerId}, now(), ${staffId}, true, true, true, true) returning id`
      : await sql<{ id: string }[]>`
          insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, created_by)
          values (${orgId}, ${storeId}, ${supplier!.id}, ${o.on}, '5000.00', 'pending', ${file!.id}, ${staffId}) returning id`;
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
    orgId, storeId, adminId, managerId, staffId, staff2Id, supplierId: supplier!.id, categoryId: cat!.id, cashId: cash!.id,
    admin, manager: actor(orgId, managerId), staff2: actor(orgId, staff2Id), bill,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const closeJanuary = (f: Fixture) => sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-01-01'`;

const invoiceStatus = async (id: string) => (await sql<{ status: string }[]>`select status from supplier_invoices where id = ${id}`)[0]!.status;
const expenseStatus = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;
const entryCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'expense_payment'`)[0]!.n);
const overrideRows = (orgId: string) =>
  sql<{ actor_person_id: string; reason: string; note: string | null; period_status_at_post: string }[]>`
    select actor_person_id, reason, note, period_status_at_post from period_overrides where org_id = ${orgId}`;

async function expectRedirectTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => paramsOf(to).get(k);

type OverrideFields = { confirm?: boolean; reason?: string; note?: string };
function addOverride(fd: FormData, o: OverrideFields) {
  if (o.confirm) fd.set('periodOverrideConfirm', 'on');
  if (o.reason !== undefined) fd.set('periodOverrideReason', o.reason);
  if (o.note !== undefined) fd.set('periodOverrideNote', o.note);
}
const FULL: OverrideFields = { confirm: true, reason: 'late_supplier_invoice', note: 'Bill arrived in October' };

function verifyForm(invoiceId: string, o: OverrideFields): FormData {
  const fd = new FormData();
  fd.set('invoiceId', invoiceId);
  for (const k of ['attestSupplier', 'attestInvoice', 'attestItems', 'attestPrice']) fd.set(k, 'on');
  addOverride(fd, o);
  return fd;
}
async function submitVerify(who: Actor, invoiceId: string, o: OverrideFields): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { verifyInvoiceAction } = await import('../../src/app/ap/actions');
  return expectRedirectTo(() => verifyInvoiceAction(verifyForm(invoiceId, o)));
}
async function submitRecord(who: Actor, f: Fixture, invoiceId: string, o: OverrideFields): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const fd = new FormData();
  fd.set('returnTo', `/ap/invoices/${invoiceId}`);
  fd.set('supplierId', f.supplierId);
  fd.set('supplierInvoiceId', invoiceId);
  fd.set('storeId', f.storeId);
  fd.set('categoryId', f.categoryId);
  fd.set('particulars', 'Late pork');
  fd.set('lineCount', '1');
  fd.set('lineMethod_0', 'cash');
  fd.set('lineAmount_0', '700.00');
  fd.set('lineAccount_0', f.cashId);
  addOverride(fd, o);
  const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');
  return expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
}
async function renderBill(who: Actor, invoiceId: string): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { default: Page } = await import('../../src/app/ap/invoices/[id]/page');
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve({}) } as never)) as never);
}

const resetSpy = () => {
  SPY.verify.length = 0;
  SPY.record.length = 0;
};
const verifyOptions = () => SPY.verify[0]?.[4] as { periodOverride?: { reason: string; note?: string } } | undefined;
const recordOverride = () => (SPY.record[0]?.[2] as { periodOverride?: unknown } | undefined)?.periodOverride;
const CLOSED_SENTENCE = 'January 2026 is closed. Ask an administrator to post this one entry into it.';

describe('F2 - recordExpenseForInvoiceAction forwards the override only for a closed-month bill', () => {
  it('a FEBRUARY bill with a full override: the domain is called with NO periodOverride and the expense posts - Mutant: forward unconditionally -> red', async () => {
    const f = await fixture('f2o');
    const b = await f.bill({ on: '2026-02-10', drafts: [], verified: true });
    await closeJanuary(f);
    resetSpy();

    const to = await submitRecord(f.admin, f, b.id, FULL);

    expect(to, `refused: ${param(to, 'error')}`).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    expect(SPY.record).toHaveLength(1);
    expect(recordOverride(), 'the open-month bill must not carry the override into the domain').toBeUndefined();
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });

  it('control: the same form on a JANUARY (closed) bill passes the typed reason and note', async () => {
    const f = await fixture('f2c');
    const b = await f.bill({ on: '2026-01-10', drafts: [], verified: true });
    await closeJanuary(f);
    resetSpy();

    const to = await submitRecord(f.admin, f, b.id, FULL);

    expect(to, `refused: ${param(to, 'error')}`).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    expect(recordOverride()).toEqual({ reason: 'late_supplier_invoice', note: 'Bill arrived in October' });
  });
});

describe('F3 - a forged invoiceDate field changes nothing: the action trusts the invoice row', () => {
  it('a FEBRUARY bill, form says invoiceDate=2026-01-10: verifyInvoice gets NO options, verified, zero rows - Mutant: read the date from the form -> red', async () => {
    const f = await fixture('f3a');
    const b = await f.bill({ on: '2026-02-10', drafts: ['1200.00'] });
    await closeJanuary(f);
    resetSpy();
    const fd = verifyForm(b.id, FULL);
    fd.set('invoiceDate', '2026-01-10');
    ACTOR_HOLDER.actor = f.admin;
    const { verifyInvoiceAction } = await import('../../src/app/ap/actions');

    const to = await expectRedirectTo(() => verifyInvoiceAction(fd));

    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(SPY.verify).toHaveLength(1);
    expect(verifyOptions(), 'a forged closed date made the action forward the override').toBeUndefined();
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });

  it('reverse: a JANUARY bill, form says invoiceDate=2026-02-10: without the override the closed-month sentence still refuses; with it, it is passed and posts - Mutant: read the date from the form -> both red', async () => {
    const f = await fixture('f3b');
    const b = await f.bill({ on: '2026-01-10', drafts: ['1200.00'] });
    await closeJanuary(f);
    ACTOR_HOLDER.actor = f.admin;
    const { verifyInvoiceAction } = await import('../../src/app/ap/actions');

    const bare = verifyForm(b.id, {});
    bare.set('invoiceDate', '2026-02-10');
    const refused = await expectRedirectTo(() => verifyInvoiceAction(bare));
    // T-475 S1: the refusal is framed with the draft's name; the closed-month sentence is kept whole inside it.
    expect(param(refused, 'error'), 'a forged open date skipped the closed-month refusal').toContain(CLOSED_SENTENCE);
    expect(await invoiceStatus(b.id)).toBe('pending');

    resetSpy();
    const full = verifyForm(b.id, FULL);
    full.set('invoiceDate', '2026-02-10');
    const to = await expectRedirectTo(() => verifyInvoiceAction(full));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(verifyOptions()?.periodOverride).toMatchObject({ reason: 'late_supplier_invoice' });
    expect(await overrideRows(f.orgId)).toHaveLength(1);
  });
});

describe('F4 - cross-store: the gate is proven at the BILL store before anything is said about its month', () => {
  it('a manager scoped to store B submitting a store-A January bill with the override ticked gets the generic refusal; the domain is never reached, nothing posts - control: the same manager on a store-B bill reaches the normal path', async () => {
    const f = await fixture('f4');
    const a = await f.bill({ on: '2026-01-10', drafts: ['1200.00'] });

    const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('bacoor')}, 'Bacoor') returning id`;
    const managerB = await person(f.orgId, 'Manager B', 'manager', storeB!.id);
    const [fileB] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${storeB!.id}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${storeB!.id}/receipt_photo/${uid('r')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.adminId})
      returning id`;
    const [bB] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, created_by)
      values (${f.orgId}, ${storeB!.id}, ${f.supplierId}, '2026-01-12', '800.00', 'pending', ${fileB!.id}, ${f.staffId}) returning id`;
    await closeJanuary(f);
    resetSpy();

    const to = await submitVerify(actor(f.orgId, managerB), a.id, FULL);
    const error = param(to, 'error');
    expect(error, 'a refusal banner').toBeTruthy();
    expect(error).not.toMatch(UUID);
    expect(error, `the bill's month or the override was spoken to someone outside its store: ${error}`).not.toMatch(/is closed|is locked|Choose a reason|Add a note|override/i);
    expect(SPY.verify, 'the domain must not be reached').toHaveLength(0);
    expect(await invoiceStatus(a.id)).toBe('pending');
    expect(await expenseStatus(a.draftIds[0]!)).toBe('draft');
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    // control: the same manager, a store-B bill with no drafts (nothing to post), reaches the domain carrying the override
    const ok = await submitVerify(actor(f.orgId, managerB), bB!.id, FULL);
    expect(param(ok, 'error'), `the control was refused: ${param(ok, 'error')}`).toBeNull();
    expect(SPY.verify).toHaveLength(1);
    expect(verifyOptions()?.periodOverride).toMatchObject({ reason: 'late_supplier_invoice' });
    expect(await invoiceStatus(bB!.id)).toBe('verified');
  });
});
