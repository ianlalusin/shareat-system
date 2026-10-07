import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-376 S1 (DEF-581) - the closed-month override on the bills screen. `docs/tasks/376-ap-closed-month-and-screen-nits.md`
 * S1, web legs W1-W7. (W3b, the mocked-domain drop leg, is `apps/erp/tests/t376-s1-verify-action-drop.test.ts`.)
 *
 * TESTER, not BUILDER. Harness from `t369-s5-override-web.test.ts` (session mock, `Page` stub, real actions, real
 * domain, real Postgres; `submit`, `param`, the render legs). Same field names as T-369 S5a:
 * `periodOverrideConfirm` / `periodOverrideReason` / `periodOverrideNote`, marker `data-closed-month-override`.
 *
 *   verify form : `verifyInvoiceAction` (fields invoiceId, attestSupplier/Invoice/Items/Price, + the override fields)
 *   record form : `recordExpenseForInvoiceAction` (returnTo, supplierId, supplierInvoiceId, storeId, categoryId,
 *                 particulars, lineCount, lineMethod_0, lineAmount_0, lineAccount_0, + the override fields)
 *   The bill's date is read on the server; the form never carries it.
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

const OK_BANNER = 'Verified. Expenses can now be recorded against it.';

// -----------------------------------------------------------------------------------------------

describe('W1 - the admin verifies a January bill with the override fields', () => {
  it('ok banner; both drafts posted; two override rows for the admin - red on HEAD: the fields are ignored and the bill sentence refuses', async () => {
    const f = await fixture('w1');
    const b = await f.bill({ on: '2026-01-10', drafts: ['1200.00', '800.00'] });
    await closeJanuary(f);

    const to = await submitVerify(f.admin, b.id, FULL);

    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toBe(OK_BANNER);
    expect(await invoiceStatus(b.id)).toBe('verified');
    for (const d of b.draftIds) expect(await expenseStatus(d)).toBe('posted');
    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ actor_person_id: f.adminId, reason: 'late_supplier_invoice', note: 'Bill arrived in October', period_status_at_post: 'closed' });
    }
  });
});

describe('W2 - the manager submits the override fields anyway', () => {
  it('an error banner with no uuid and not the closed-month sentence; pending, zero rows - control: the admin then posts the same bill (W1)', async () => {
    const f = await fixture('w2');
    const b = await f.bill({ on: '2026-01-10', drafts: ['1200.00', '800.00'] });
    await closeJanuary(f);

    const to = await submitVerify(f.manager, b.id, FULL);
    const error = param(to, 'error');
    expect(error, 'a refusal banner').toBeTruthy();
    expect(param(to, 'ok')).toBeNull();
    expect(error).not.toMatch(UUID);
    expect(error, `the override was ignored (HEAD's bill sentence) instead of refused for the missing capability: ${error}`).not.toMatch(/is closed/);
    expect(await invoiceStatus(b.id)).toBe('pending');
    expect(await entryCount(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    const control = await submitVerify(f.admin, b.id, FULL);
    expect(param(control, 'ok')).toBe(OK_BANNER);
  });
});

describe('W3 - a February (open) bill with the override fields', () => {
  it('verified, drafts posted, ZERO override rows (the outcome; the action\'s own drop is pinned by W3b)', async () => {
    const f = await fixture('w3');
    const b = await f.bill({ on: '2026-02-10', drafts: ['1200.00'] });
    await closeJanuary(f);

    const to = await submitVerify(f.admin, b.id, FULL);

    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toBe(OK_BANNER);
    expect(await expenseStatus(b.draftIds[0]!)).toBe('posted');
    expect(await overrideRows(f.orgId), 'an override audit row was written for an OPEN month').toHaveLength(0);
  });
});

describe('W4 - an incomplete override form is refused with a sentence naming what is missing', () => {
  it('ticked with no reason -> the reason sentence; "Other" with no note -> the note sentence; neither is the closed-month refusal; nothing posts - control: the complete form (W1)', async () => {
    const f = await fixture('w4');
    const b = await f.bill({ on: '2026-01-10', drafts: ['1200.00'] });
    await closeJanuary(f);

    const noReason = param(await submitVerify(f.admin, b.id, { confirm: true, reason: '', note: 'x' }), 'error');
    expect(noReason).toBe('Choose a reason for posting into the closed month, or untick the confirmation.');

    const noNote = param(await submitVerify(f.admin, b.id, { confirm: true, reason: 'other', note: '   ' }), 'error');
    expect(noNote, 'a refusal banner').toBeTruthy();
    expect(noNote).toMatch(/note/i);
    expect(noNote, `silently dropped into the closed-month refusal: ${noNote}`).not.toMatch(/is closed/);

    expect(await invoiceStatus(b.id)).toBe('pending');
    expect(await entryCount(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    const control = await submitVerify(f.admin, b.id, { confirm: true, reason: 'other', note: 'BIR asked for it' });
    expect(param(control, 'error'), `the complete form was refused: ${param(control, 'error')}`).toBeNull();
  });
});

describe('W5 (T-364) - the gate is proven before anything is said about the bill\'s month', () => {
  it('a staff member without verify_supplier_invoice, ticked but half-filled, gets the generic authorization refusal - not a closed-month or override sentence; nothing posts', async () => {
    const f = await fixture('w5');
    const b = await f.bill({ on: '2026-01-10', drafts: ['1200.00'] });
    await closeJanuary(f);

    const to = await submitVerify(f.staff2, b.id, { confirm: true, reason: '', note: '' });
    const error = param(to, 'error');
    expect(error, 'a refusal banner').toBeTruthy();
    expect(error).not.toMatch(UUID);
    expect(error, `the bill's month was spoken to someone who may not verify it: ${error}`).not.toMatch(/is closed|is locked|Choose a reason|Add a note/);
    expect(await invoiceStatus(b.id)).toBe('pending');
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});

describe('W6 (render) - the override control on the verify form', () => {
  it('the admin\'s HTML for a pending January bill with two drafts carries the marker, the three fields, the four reason labels and the plural copy; the manager\'s carries none; both carry the Verify form', async () => {
    const f = await fixture('w6');
    const b = await f.bill({ on: '2026-01-10', drafts: ['1200.00', '800.00'] });
    await closeJanuary(f);

    const admin = await renderBill(f.admin, b.id);
    expect(admin, 'positive control: the admin\'s page renders the Verify form').toContain('Verify this invoice');
    expect(admin, 'no data-closed-month-override marker for the admin').toContain('data-closed-month-override');
    for (const name of ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote']) expect(admin, `missing ${name}`).toContain(`name="${name}"`);
    for (const label of ['Late supplier bill', 'Correction required by BIR/regulator', 'Fixing a mistake', 'Other']) expect(admin, `missing label ${label}`).toContain(label);
    expect(admin, 'the plural copy').toContain('post these 2 expenses anyway');
    expect(admin, 'no browser dialogs').not.toMatch(/\b(alert|confirm)\(/);

    const manager = await renderBill(f.manager, b.id);
    expect(manager, 'positive control: the manager\'s page renders the Verify form').toContain('Verify this invoice');
    expect(manager, 'a manager must not be handed the override control').not.toContain('data-closed-month-override');
    for (const name of ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote']) expect(manager).not.toContain(name);
  });

  it('a January bill with NO drafts has no marker in the verify form, even for the admin - control: the same admin sees it on a bill with drafts', async () => {
    const f = await fixture('w6b');
    const empty = await f.bill({ on: '2026-01-10', drafts: [] });
    const full = await f.bill({ on: '2026-01-11', drafts: ['1200.00'] });
    await closeJanuary(f);

    const html = await renderBill(f.admin, empty.id);
    expect(html, 'positive control: the Verify form is there').toContain('Verify this invoice');
    expect(html, 'verifying posts nothing, so it needs no override').not.toContain('data-closed-month-override');
    expect(await renderBill(f.admin, full.id)).toContain('data-closed-month-override');
  });

  it('a February (open) pending bill carries no marker for the admin - control: January does', async () => {
    const f = await fixture('w6c');
    const feb = await f.bill({ on: '2026-02-10', drafts: ['1200.00'] });
    const jan = await f.bill({ on: '2026-01-10', drafts: ['1200.00'] });
    await closeJanuary(f);

    expect(await renderBill(f.admin, jan.id)).toContain('data-closed-month-override');
    expect(await renderBill(f.admin, feb.id)).not.toContain('data-closed-month-override');
  });
});

describe('W7 (record form) - a VERIFIED January bill', () => {
  it('the admin\'s HTML carries the marker with the singular copy; the manager\'s carries none - control: both render the record form', async () => {
    const f = await fixture('w7r');
    const b = await f.bill({ on: '2026-01-10', drafts: [], verified: true });
    await closeJanuary(f);

    const admin = await renderBill(f.admin, b.id);
    expect(admin, 'positive control: the record form renders').toContain('Record an expense against this invoice');
    expect(admin).toContain('data-closed-month-override');
    expect(admin, 'the singular copy').toContain('post this one entry anyway');
    expect(admin).not.toContain('post these');
    for (const name of ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote']) expect(admin, `missing ${name}`).toContain(`name="${name}"`);

    const manager = await renderBill(f.manager, b.id);
    expect(manager, 'positive control: the manager\'s record form renders').toContain('Record an expense against this invoice');
    expect(manager).not.toContain('data-closed-month-override');
  });

  it('submitting with the override posts and redirects to the new expense; one override row - red on HEAD: the fields are ignored and the bill sentence refuses', async () => {
    const f = await fixture('w7s');
    const b = await f.bill({ on: '2026-01-10', drafts: [], verified: true });
    await closeJanuary(f);

    const to = await submitRecord(f.admin, f, b.id, FULL);

    expect(to, `refused: ${param(to, 'error')}`).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    expect(await entryCount(f.orgId)).toBe(1);
    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_person_id: f.adminId, reason: 'late_supplier_invoice', note: 'Bill arrived in October', period_status_at_post: 'closed' });
  });

  it('submitting WITHOUT the override: the ordinary closed-month sentence, nothing posts - control: the override submission above', async () => {
    const f = await fixture('w7n');
    const b = await f.bill({ on: '2026-01-10', drafts: [], verified: true });
    await closeJanuary(f);

    const to = await submitRecord(f.admin, f, b.id, {});
    expect(param(to, 'error')).toBe('January 2026 is closed. Ask an administrator to post this one entry into it.');
    expect(await entryCount(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    const control = await submitRecord(f.admin, f, b.id, FULL);
    expect(control).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
  });
});
