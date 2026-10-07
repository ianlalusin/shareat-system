import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S0 (DEF-550) — the web legs: T9 (render) and T10 (action).
 * `docs/tasks/369-unwired-money-screens.md` §S0, "BUILDER" bullets for `ap/invoices/[id]/page.tsx`
 * and `voidPaymentAction`.
 *
 * ⛔ TESTER, not BUILDER. Harness copied from `t362-supplier-terms-web.test.ts` (`RedirectSignal`,
 * the session mock, the `Page` stub, the two forwarded money-lines modules, `renderInvoicePage`).
 * The REAL domain, REAL action and REAL page run over a REAL Postgres; only the session and
 * `next/navigation` are doubled.
 *
 * ## What the spec leaves open, pinned here so the builder has one reading
 * The void panel is a native `<details>` whose `<summary>` reads "Void this payment" and which
 * holds a form posting `voidPaymentAction` with fields: `paymentId` (hidden) · `supplierId` (hidden)
 * · `invoiceId` (hidden) · `reason` (required) · and, ONLY for a payment in a closed month,
 * `voidOn` (`type="date"`, required, defaulting to today). The section heading is exactly
 * "Payments against this bill". A voided payment row reads "Voided — {reason}". A payment that also
 * pays another bill says "Also pays {invoiceNo}" in its row and "This also re-opens {invoiceNo}." in
 * its panel. If the builder reads different names, that is a QUESTION to the tester, not a test edit.
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
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));
vi.mock('@/components/money/MoneyLines', async () => await import('../../src/components/money/MoneyLines'));

import { apRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, verifyInvoice, recordExpenseForInvoice, recordPayment, voidPayment } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

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

async function fund(orgId: string, storeId: string, code: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in (${code}, '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy})
    returning id`;
  return row!.id;
}

/** Lipa (the bill's store), Malvar (another store); manager (Lipa), otherManager (Malvar only), staff (Lipa). */
async function fixture(hint: string) {
  const code = uid(`t369s0w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [lipa] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'Lipa') returning id`;
  const [malvar] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}m`)}, 'Malvar') returning id`;
  const storeId = lipa!.id;
  const malvarId = malvar!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager', [storeId]);
  const otherManagerId = await mk('Malvar Manager', 'manager', [malvarId]);
  const staffId = await mk('Staff', 'staff', [storeId]);
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: managerId });
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  await fund(orgId, storeId, '1110', '500000.00');
  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const manager = actor(orgId, managerId);
  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
  return {
    orgId, storeId, malvarId, supplierId: supplier.id, drawerId: drawer!.id, categoryId: category!.id,
    manager, staff: actor(orgId, staffId), otherManager: actor(orgId, otherManagerId), managerId, staffId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function bill(f: Fixture, amount: string, invoiceNo: string): Promise<{ invoiceId: string; expenseId: string }> {
  const fileId = await receiptFile(f.orgId, f.storeId, f.staffId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, { storeId: f.storeId, supplierId: f.supplierId, invoiceNo, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: fileId }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: created.id, categoryId: f.categoryId,
      particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return { invoiceId: created.id, expenseId: exp.expenseId };
}
const payBills = (f: Fixture, amount: string, allocations: { expenseId: string; amountApplied: string }[], on = '2026-01-15', creditApplied?: string) =>
  asOrg(f.orgId, (tx) =>
    recordPayment(tx, f.manager, {
      storeId: f.storeId, supplierId: f.supplierId, businessDate: on, amount, moneyAccountId: f.drawerId,
      ...(creditApplied ? { creditApplied } : {}), referenceNo: 'CHQ-0042', allocations,
    }),
  );
const closeJanuary = (orgId: string) => sql`update fiscal_periods set status = 'closed' where org_id = ${orgId} and starts_on = '2026-01-01'`;
const paymentStatus = async (id: string) => (await sql<{ status: string }[]>`select status from ap_payments where id = ${id}`)[0]!.status;
const reversalCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and reversal_of_entry_id is not null`)[0]!.n);

let InvoiceDetailPage: typeof import('../../src/app/ap/invoices/[id]/page').default;
beforeAll(async () => {
  InvoiceDetailPage = (await import('../../src/app/ap/invoices/[id]/page')).default;
}, 30_000);

async function renderBill(who: Actor, invoiceId: string, search: Record<string, string> = {}): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const element = await InvoiceDetailPage({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve(await seedSearch(search)) });
  return renderToStaticMarkup(element as never);
}
/** Every `<details>…</details>` block whose summary is "Void this payment". */
const voidPanels = (html: string) => (html.match(/<details[\s\S]*?<\/details>/g) ?? []).filter((d) => d.includes('Void this payment'));

async function expectRedirectTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const pathOf = (to: string) => new URL(to, 'http://localhost').pathname;
const param = (to: string, k: string) => paramsOf(to).get(k);

// -----------------------------------------------------------------------------------------------
// T9 — the bill page lists its payments and offers the void only where it can be used
// -----------------------------------------------------------------------------------------------

describe('T9 — "Payments against this bill"', () => {
  it('a manager at the bill\'s store sees the section, one row, and a "Void this payment" <details> with reason + hidden ids (no date field: the month is open)', async () => {
    const f = await fixture('t9a');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);

    const html = await renderBill(f.manager, a.invoiceId);
    expect(html).toMatch(/Payments against this bill/);
    expect(html).toMatch(/3,000\.00/);
    expect(html).toMatch(/CHQ-0042/);
    const panels = voidPanels(html);
    expect(panels, 'exactly one void panel for one posted payment').toHaveLength(1);
    const panel = panels[0]!;
    expect(panel).toMatch(/name="reason"[^>]*required|required[^>]*name="reason"/);
    for (const name of ['paymentId', 'supplierId', 'invoiceId']) {
      expect(panel, `hidden ${name}`).toMatch(new RegExp(`<input[^>]*type="hidden"[^>]*name="${name}"|<input[^>]*name="${name}"[^>]*type="hidden"`));
    }
    expect(panel).toContain(paid.paymentId);
    expect(panel).toContain(a.invoiceId);
    expect(panel, 'an open month needs no reversal date').not.toMatch(/name="voidOn"/);
    expect(panel).toMatch(/Void payment/);
    expect(html, 'no browser dialogs').not.toMatch(/\b(alert|confirm)\(/);
  });

  it("a staff member and a manager of ANOTHER store see the row and NO void control (money controls render only where usable)", async () => {
    const f = await fixture('t9b');
    const a = await bill(f, '3000.00', 'INV-A');
    await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);

    for (const who of [f.staff, f.otherManager]) {
      const html = await renderBill(who, a.invoiceId);
      expect(html, 'the row is visible').toMatch(/Payments against this bill/);
      expect(html).toMatch(/3,000\.00/);
      expect(voidPanels(html), 'no void panel for a non-holder').toHaveLength(0);
      expect(html).not.toMatch(/Void this payment/);
    }
  });

  it('a voided payment shows "Voided — {reason}" and no control; the bill\'s other forms are unchanged', async () => {
    const f = await fixture('t9c');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);
    await asOrg(f.orgId, (tx) => voidPayment(tx, f.manager, { paymentId: paid.paymentId, reason: 'Bounced cheque' }));

    const html = await renderBill(f.manager, a.invoiceId);
    expect(html).toMatch(/Payments against this bill/);
    expect(html).toMatch(/Voided — Bounced cheque/);
    expect(voidPanels(html)).toHaveLength(0);
    expect(html).not.toMatch(/Void this payment/);
  });

  it('a payment that also pays bill C says "Also pays INV-C" in its row and "This also re-opens INV-C." in its panel', async () => {
    const f = await fixture('t9d');
    const a = await bill(f, '1000.00', 'INV-A');
    const c = await bill(f, '500.00', 'INV-C');
    await payBills(f, '1500.00', [
      { expenseId: a.expenseId, amountApplied: '1000.00' },
      { expenseId: c.expenseId, amountApplied: '500.00' },
    ]);

    const html = await renderBill(f.manager, a.invoiceId);
    expect(html).toMatch(/Also pays[\s\S]{0,800}INV-C/);
    const panels = voidPanels(html);
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatch(/This also re-opens[\s\S]{0,800}INV-C/);
    // Positive control: a payment that touches ONLY this bill carries neither sentence.
    const f2 = await fixture('t9d2');
    const solo = await bill(f2, '1000.00', 'INV-S');
    await payBills(f2, '1000.00', [{ expenseId: solo.expenseId, amountApplied: '1000.00' }]);
    const soloHtml = await renderBill(f2.manager, solo.invoiceId);
    expect(soloHtml).not.toMatch(/Also pays/);
    expect(soloHtml).not.toMatch(/This also re-opens/);
  });

  it('a closed-month payment\'s panel has a REQUIRED reversal date (type=date, name=voidOn) and the closed-month hint', async () => {
    const f = await fixture('t9e');
    const a = await bill(f, '3000.00', 'INV-A');
    await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }], '2026-01-15');
    await closeJanuary(f.orgId);

    const html = await renderBill(f.manager, a.invoiceId);
    const panels = voidPanels(html);
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;
    const input = panel.match(/<input[^>]*name="voidOn"[^>]*>/);
    expect(input, `no voidOn input in: ${panel}`).not.toBeNull();
    expect(input![0]).toMatch(/type="date"/);
    expect(input![0]).toMatch(/required/);
    expect(panel).toMatch(/This payment is in a closed month\. The reversal is dated in an open month\./);
  });
});

// -----------------------------------------------------------------------------------------------
// T10 — voidPaymentAction
// -----------------------------------------------------------------------------------------------

function voidForm(o: { paymentId: string; supplierId: string; invoiceId?: string; reason?: string; voidOn?: string }): FormData {
  const fd = new FormData();
  fd.set('paymentId', o.paymentId);
  fd.set('supplierId', o.supplierId);
  if (o.invoiceId !== undefined) fd.set('invoiceId', o.invoiceId);
  fd.set('reason', o.reason ?? 'Bounced cheque');
  if (o.voidOn) fd.set('voidOn', o.voidOn);
  return fd;
}

describe('T10 — voidPaymentAction', () => {
  it('submitting from the bill returns to /ap/invoices/{id} with the ok banner (amount via formatMoney); the payment is voided and the bill is owed again', async () => {
    const f = await fixture('t10a');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);
    ACTOR_HOLDER.actor = f.manager;
    const { voidPaymentAction } = await import('../../src/app/ap/actions');

    const to = await expectRedirectTo(() => voidPaymentAction(voidForm({ paymentId: paid.paymentId, supplierId: f.supplierId, invoiceId: a.invoiceId })));
    expect(pathOf(to)).toBe(`/ap/invoices/${a.invoiceId}`);
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toBe('Payment of ₱3,000.00 voided — reversed, not deleted. The bills it paid are owed again.');
    expect(await paymentStatus(paid.paymentId)).toBe('voided');
    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open.map((o) => o.outstanding)).toEqual(['3000.00']);
  });

  it('a refusal (T6\'s case: the overpayment credit is spent) returns to the bill with the sentence — no id in the banner; nothing voided', async () => {
    const f = await fixture('t10b');
    const a = await bill(f, '1000.00', 'INV-A');
    const payA = await payBills(f, '1500.00', [{ expenseId: a.expenseId, amountApplied: '1000.00' }]);
    const b = await bill(f, '500.00', 'INV-B');
    await payBills(f, '500.00', [{ expenseId: b.expenseId, amountApplied: '500.00' }], '2026-01-16', '500.00');
    ACTOR_HOLDER.actor = f.manager;
    const { voidPaymentAction } = await import('../../src/app/ap/actions');

    const to = await expectRedirectTo(() => voidPaymentAction(voidForm({ paymentId: payA.paymentId, supplierId: f.supplierId, invoiceId: a.invoiceId })));
    expect(pathOf(to)).toBe(`/ap/invoices/${a.invoiceId}`);
    expect(param(to, 'ok')).toBeNull();
    expect(param(to, 'error')).toMatch(/₱500\.00 of this payment's overpayment has already been used/);
    expect(param(to, 'error')).not.toMatch(UUID);
    expect(await paymentStatus(payA.paymentId)).toBe('posted');
    expect(await reversalCount(f.orgId)).toBe(0);
  });

  it('a blank reason is refused with the DOMAIN\'s sentence, back on the bill', async () => {
    const f = await fixture('t10c');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);
    ACTOR_HOLDER.actor = f.manager;
    const { voidPaymentAction } = await import('../../src/app/ap/actions');

    const to = await expectRedirectTo(() => voidPaymentAction(voidForm({ paymentId: paid.paymentId, supplierId: f.supplierId, invoiceId: a.invoiceId, reason: '   ' })));
    expect(pathOf(to)).toBe(`/ap/invoices/${a.invoiceId}`);
    expect(param(to, 'error')).toBe('Say why this payment is being voided.');
    expect(await paymentStatus(paid.paymentId)).toBe('posted');
  });

  it('a closed-month payment with voidOn in an open month: ok banner, one reversal dated voidOn (the action forwards the field)', async () => {
    const f = await fixture('t10d');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }], '2026-01-15');
    await closeJanuary(f.orgId);
    ACTOR_HOLDER.actor = f.manager;
    const { voidPaymentAction } = await import('../../src/app/ap/actions');

    const to = await expectRedirectTo(() => voidPaymentAction(voidForm({ paymentId: paid.paymentId, supplierId: f.supplierId, invoiceId: a.invoiceId, voidOn: '2026-02-10' })));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toMatch(/voided/);
    const [rev] = await sql<{ entry_date: string; memo: string }[]>`
      select entry_date::text, memo from journal_entries where org_id = ${f.orgId} and reversal_of_entry_id is not null`;
    expect(rev).toMatchObject({ entry_date: '2026-02-10' });
    expect(rev!.memo.startsWith('[prior period] ')).toBe(true);
  });

  it('a non-UUID invoiceId (or none) returns to /ap/suppliers/{supplierId}, never to a URL from the form — a hostile value included', async () => {
    const f = await fixture('t10e');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);
    ACTOR_HOLDER.actor = f.manager;
    const { voidPaymentAction } = await import('../../src/app/ap/actions');

    // A refusal each time (blank reason) so the same payment can be submitted repeatedly.
    for (const invoiceId of ['not-a-uuid', '//evil.example/x', 'https://evil.example', undefined]) {
      const to = await expectRedirectTo(() =>
        voidPaymentAction(voidForm({ paymentId: paid.paymentId, supplierId: f.supplierId, ...(invoiceId !== undefined ? { invoiceId } : {}), reason: '' })),
      );
      expect(to, `invoiceId=${String(invoiceId)}`).toMatch(new RegExp(`^/ap/suppliers/${f.supplierId}\\?`));
    }
  });

  it('a staff member\'s forged POST is refused by the domain — banner back on the bill, nothing voided (positive control: T10a)', async () => {
    const f = await fixture('t10f');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);
    ACTOR_HOLDER.actor = f.staff;
    const { voidPaymentAction } = await import('../../src/app/ap/actions');

    const to = await expectRedirectTo(() => voidPaymentAction(voidForm({ paymentId: paid.paymentId, supplierId: f.supplierId, invoiceId: a.invoiceId })));
    expect(pathOf(to)).toBe(`/ap/invoices/${a.invoiceId}`);
    expect(param(to, 'error'), 'a refusal banner').toBeTruthy();
    expect(param(to, 'error')).not.toMatch(UUID);
    expect(await paymentStatus(paid.paymentId)).toBe('posted');
  });

  it('the touched app files contain no alert( / confirm( (comments stripped)', () => {
    const root = path.resolve(__dirname, '../../src/app/ap');
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => { const i = l.indexOf('//'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    for (const rel of ['actions.ts', 'invoices/[id]/page.tsx']) {
      const code = strip(readFileSync(path.join(root, rel), 'utf8'));
      expect(code, `${rel} must not use browser dialogs`).not.toMatch(/(^|[^.\w])(alert|confirm)\s*\(/);
    }
  });
});

// -----------------------------------------------------------------------------------------------
// S0 AUDIT legs (D, E) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

import { ACTION_LINK } from '../../src/components/action-link';
import { paramsOf, seedSearch } from '../helpers/flash-jar';

/** Adds an admin (both stores) and Malvar's funded office safe to a fixture, for a payment drawn on ANOTHER store's money. */
async function withMalvarSafe(f: Fixture) {
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${f.orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${f.storeId}), (${admin!.id}, ${f.malvarId})`;
  const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.malvarId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await fund(f.orgId, f.malvarId, '1130', '500000.00');
  return { admin: actor(f.orgId, admin!.id), malvarSafeId: safe!.id };
}

describe('AUDIT D — the "Also pays" link is anchored on the link itself and uses the shared ACTION_LINK class', () => {
  it('<a href="/ap/invoices/{C}"> reads INV-C and carries every ACTION_LINK class token (a test must not force a smaller tap target)', async () => {
    const f = await fixture('auditD');
    const a = await bill(f, '1000.00', 'INV-A');
    const c = await bill(f, '500.00', 'INV-C');
    await payBills(f, '1500.00', [
      { expenseId: a.expenseId, amountApplied: '1000.00' },
      { expenseId: c.expenseId, amountApplied: '500.00' },
    ]);

    const html = await renderBill(f.manager, a.invoiceId);
    const anchor = html.match(new RegExp(`<a[^>]*href="/ap/invoices/${c.invoiceId}"[^>]*>[\\s\\S]*?</a>`));
    expect(anchor, 'no link to the other bill').not.toBeNull();
    expect(anchor![0]).toMatch(/>\s*INV-C\s*</);
    const cls = anchor![0].match(/class="([^"]*)"/)?.[1] ?? '';
    for (const token of ACTION_LINK.split(/\s+/)) expect(cls.split(/\s+/), `the link lacks ACTION_LINK's "${token}"`).toContain(token);
  });
});

describe("AUDIT E — the void control is offered only where the actor can use it", () => {
  it("a Lipa-only manager viewing a bill paid from MALVAR's safe sees the row and NO void <details>; the admin (both stores) sees it", async () => {
    const f = await fixture('auditE');
    const { admin, malvarSafeId } = await withMalvarSafe(f);
    const a = await bill(f, '3000.00', 'INV-A');
    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, admin, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15', amount: '3000.00', moneyAccountId: malvarSafeId,
        referenceNo: 'CHQ-0042', allocations: [{ expenseId: a.expenseId, amountApplied: '3000.00' }],
      }),
    );

    const mgr = await renderBill(f.manager, a.invoiceId);
    expect(mgr, 'the row is visible').toMatch(/CHQ-0042/);
    expect(voidPanels(mgr), 'a manager without transfer_funds at Malvar must not be offered the void').toHaveLength(0);
    expect(mgr).not.toMatch(/Void this payment/);

    const adm = await renderBill(admin, a.invoiceId);
    expect(voidPanels(adm), 'positive control: the admin holds both capabilities').toHaveLength(1);
  });

  it('a hostile supplierId (not a uuid) with no invoiceId falls back to /ap — never a URL from the form', async () => {
    const f = await fixture('auditE2');
    const a = await bill(f, '3000.00', 'INV-A');
    const paid = await payBills(f, '3000.00', [{ expenseId: a.expenseId, amountApplied: '3000.00' }]);
    ACTOR_HOLDER.actor = f.manager;
    const { voidPaymentAction } = await import('../../src/app/ap/actions');

    for (const supplierId of ['//evil.example/x', 'https://evil.example', 'not-a-uuid', '']) {
      const fd = new FormData();
      fd.set('paymentId', paid.paymentId);
      fd.set('supplierId', supplierId);
      fd.set('reason', ''); // refused each time, so the payment can be re-submitted
      const to = await expectRedirectTo(() => voidPaymentAction(fd));
      expect(to, `supplierId=${JSON.stringify(supplierId)}`).toMatch(/^\/ap\?/);
    }
  });
});
