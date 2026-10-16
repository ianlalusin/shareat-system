import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-432 cases 18-21 - the "Pay this bill" link on the bill page and the supplier page's `bill` pre-fill.
 * `docs/tasks/432-ap-payment-float-picker.md` ruling 7.
 *
 *   18  link shown only for a verified bill with open items; none for a fully paid, a pending or a voided bill.  M18: drop the open-items condition.
 *   19  link gated by can(record_ap_payment, bill's store): a staff session and a manager of another store see none.  M19: drop the `can` probe.
 *   20  ?store=A&bill=X pre-fills X's open items at their outstanding; the supplier's other items start blank.  M20: pre-fill every item.
 *   21  a `bill` that is another supplier's pre-fills nothing foreign (its row never renders); posting that bill's expense id
 *       with this supplier is refused by the domain, nothing posted.  M21: pre-fill by `bill` without restricting to this supplier's open items.
 *
 * Ambiguity reported to the caller: "a bill matching none of them is ignored" is read as "falls back to today's default", so the
 * supplier's OWN items are not asserted either way in case 21, only that no foreign row appears.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const H = vi.hoisted(() => ({ actor: null as null | { orgId: string; personId: string } }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => H.actor!),
  requireSession: vi.fn(async () => ({
    actor: H.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, verifyInvoice, voidInvoice, recordExpenseForInvoice, recordPayment } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

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
const actorOf = (orgId: string, personId: string): Actor => ({ orgId, personId });

async function fixture() {
  const code = uid('t432bl');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`)[0]!.id;
  const storeA = await mkStore('Alpha');
  const storeB = await mkStore('Bravo');
  const person = async (name: string, role: 'staff' | 'manager' | 'admin', stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await person('Admin', 'admin', [storeA, storeB]);
  const managerAId = await person('Manager Alpha', 'manager', [storeA]);
  const managerBId = await person('Manager Bravo', 'manager', [storeB]);
  const staffId = await person('Staffer', 'staff', [storeA]);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeA}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId: storeA, employmentId: emp!.id, personId: staffId, setBy: adminId });

  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
    const [t] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1130'`;
    const [q] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${t!.id}, ${storeA}, '500000.00', '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${q!.id}, ${storeA}, '0', '500000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const [safe] = await sql<{ id: string }[]>`select id from money_accounts where org_id = ${orgId} and store_id = ${storeA} and custodian = 'office' and instrument = 'cash' limit 1`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeA}, 'receipt_photo', ${`orgs/${orgId}/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${staffId}) returning id`;
  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const admin = actorOf(orgId, adminId);
  const staff = actorOf(orgId, staffId);
  const mkSupplier = async (name: string) => (await asOrg(orgId, (tx) => createSupplier(tx, admin, { name, creditTermsDays: 30 }))).id;
  return {
    orgId, storeA, storeB, admin, staff, managerA: actorOf(orgId, managerAId), managerB: actorOf(orgId, managerBId),
    safeA: safe!.id, fileId: file!.id, categoryId: category!.id, mkSupplier,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;
let shared: Promise<F> | null = null;
const world = () => (shared ??= fixture());

const recordBill = (f: F, supplierId: string, amount: string) =>
  asOrg(f.orgId, (tx) => recordInvoice(tx, f.staff, { storeId: f.storeA, supplierId, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: f.fileId }));
/** Recorded by staff, verified and booked on credit by the admin. */
async function verifiedBill(f: F, supplierId: string, amount: string): Promise<{ invoiceId: string; expenseId: string }> {
  const created = await recordBill(f, supplierId, amount);
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.admin, created.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.admin, {
      storeId: f.storeA, supplierId, supplierInvoiceId: created.id, categoryId: f.categoryId, particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return { invoiceId: created.id, expenseId: exp.expenseId };
}

let InvoicePage: typeof import('../../src/app/ap/invoices/[id]/page').default;
let SupplierPage: typeof import('../../src/app/ap/suppliers/[id]/page').default;
beforeAll(async () => {
  InvoicePage = (await import('../../src/app/ap/invoices/[id]/page')).default;
  SupplierPage = (await import('../../src/app/ap/suppliers/[id]/page')).default;
}, 30_000);

async function renderInvoice(as: Actor, invoiceId: string): Promise<string> {
  H.actor = as;
  resetJar();
  return renderToStaticMarkup((await InvoicePage({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve({}) })) as never);
}
async function renderSupplier(as: Actor, supplierId: string, sp: Record<string, string>): Promise<string> {
  H.actor = as;
  resetJar();
  return renderToStaticMarkup((await SupplierPage({ params: Promise.resolve({ id: supplierId }), searchParams: Promise.resolve(sp) })) as never);
}
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
/** Every href whose link text says "Pay this bill". */
function payLinks(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .filter((m) => m[2]!.replace(/<[^>]*>/g, '').includes('Pay this bill'))
    .map((m) => decode(m[1]!));
}

describe('case 18 - the link is shown only when the bill is payable (M18)', () => {
  it('a verified bill with open items: one link to the supplier page at the bill\'s store, with the bill id', async () => {
    const f = await world();
    const sup = await f.mkSupplier(uid('S18a'));
    const b = await verifiedBill(f, sup, '2000.00');
    expect(payLinks(await renderInvoice(f.admin, b.invoiceId))).toEqual([`/ap/suppliers/${sup}?store=${f.storeA}&bill=${b.invoiceId}`]);
  });

  it('a fully paid bill shows none', async () => {
    const f = await world();
    const sup = await f.mkSupplier(uid('S18b'));
    const b = await verifiedBill(f, sup, '1000.00');
    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.admin, {
        storeId: f.storeA, supplierId: sup, businessDate: '2026-01-15', amount: '1000.00', moneyAccountId: f.safeA,
        allocations: [{ expenseId: b.expenseId, amountApplied: '1000.00' }],
      }),
    );
    expect(payLinks(await renderInvoice(f.admin, b.invoiceId))).toEqual([]);
  });

  it('a pending bill shows none', async () => {
    const f = await world();
    const sup = await f.mkSupplier(uid('S18c'));
    const created = await recordBill(f, sup, '1000.00');
    expect(payLinks(await renderInvoice(f.admin, created.id))).toEqual([]);
  });

  it('a voided bill shows none', async () => {
    const f = await world();
    const sup = await f.mkSupplier(uid('S18d'));
    const created = await recordBill(f, sup, '1000.00');
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.admin, { invoiceId: created.id, reason: 'T-432 fixture' }));
    expect(payLinks(await renderInvoice(f.admin, created.id))).toEqual([]);
  });
});

describe('case 19 - the link is gated by record_ap_payment at the bill\'s store (M19)', () => {
  it('positive control: a manager of the bill\'s store sees it', async () => {
    const f = await world();
    const sup = await f.mkSupplier(uid('S19a'));
    const b = await verifiedBill(f, sup, '2000.00');
    expect(payLinks(await renderInvoice(f.managerA, b.invoiceId))).toHaveLength(1);
  });

  it('a staff session sees none, and neither does a manager of another store', async () => {
    const f = await world();
    const sup = await f.mkSupplier(uid('S19b'));
    const b = await verifiedBill(f, sup, '2000.00');
    expect(payLinks(await renderInvoice(f.staff, b.invoiceId))).toEqual([]);
    expect(payLinks(await renderInvoice(f.managerB, b.invoiceId))).toEqual([]);
  });
});

/** The <input ...> tag of the allocation amount box for one expense. */
function amountBox(html: string, expenseId: string): { value: string | null; tag: string } {
  const tag = html.match(new RegExp(`<input\\b[^>]*name="allocateAmount_${expenseId}"[^>]*>`))?.[0];
  expect(tag, `an amount box for ${expenseId} must render`).toBeDefined();
  return { value: tag!.match(/\bvalue="([^"]*)"/)?.[1] ?? null, tag: tag! };
}

describe('case 20 - ?bill= pre-fills only that bill\'s open items (M20)', () => {
  it('X is pre-filled at its outstanding; the supplier\'s other items are blank', async () => {
    const f = await world();
    const sup = await f.mkSupplier(uid('S20'));
    const x = await verifiedBill(f, sup, '2000.00');
    const y = await verifiedBill(f, sup, '3000.00');
    const html = await renderSupplier(f.admin, sup, { store: f.storeA, bill: x.invoiceId });
    expect(amountBox(html, x.expenseId).value).toBe('2000.00');
    expect(amountBox(html, y.expenseId).value ?? '').toBe('');
    const html2 = await renderSupplier(f.admin, sup, { store: f.storeA, bill: y.invoiceId });
    expect(amountBox(html2, y.expenseId).value).toBe('3000.00');
    expect(amountBox(html2, x.expenseId).value ?? '').toBe('');
  });
});

describe('case 21 - a forged ?bill= pre-selects nothing foreign, and posting the foreign expense is refused (M21)', () => {
  const NOT_OPEN =
    'This expense is not an open item for this supplier at this store — it may belong to another supplier or another store, not be a credit expense, already be fully paid, or not be posted.';

  it("bill=<another supplier's bill>: the foreign row never renders", async () => {
    const f = await world();
    const mine = await f.mkSupplier(uid('S21a'));
    const theirs = await f.mkSupplier(uid('S21b'));
    const own = await verifiedBill(f, mine, '2000.00');
    const foreign = await verifiedBill(f, theirs, '4000.00');
    const html = await renderSupplier(f.admin, mine, { store: f.storeA, bill: foreign.invoiceId });
    expect(html).not.toContain(foreign.expenseId);
    expect(html).not.toContain(foreign.invoiceId);
    // A forged bill is ignored: the supplier's OWN items are pre-filled exactly as with no bill param, not blanked.
    expect(amountBox(html, own.expenseId).value).toBe('2000.00');
    expect(amountBox(await renderSupplier(f.admin, mine, { store: f.storeA }), own.expenseId).value).toBe('2000.00');
  });

  it("posting the other supplier's expense id with this supplier -> the domain's sentence, nothing posted", async () => {
    const f = await world();
    const mine = await f.mkSupplier(uid('S21c'));
    const theirs = await f.mkSupplier(uid('S21d'));
    await verifiedBill(f, mine, '2000.00');
    const foreign = await verifiedBill(f, theirs, '4000.00');
    H.actor = f.admin;
    resetJar();
    const fd = new FormData();
    fd.set('supplierId', mine);
    fd.set('storeId', f.storeA);
    fd.set('businessDate', '2026-01-15');
    fd.set('amount', '500.00');
    fd.set('source', f.safeA);
    fd.append('allocateExpenseId', foreign.expenseId);
    fd.set(`allocateAmount_${foreign.expenseId}`, '500.00');
    const { recordPaymentAction } = await import('../../src/app/ap/actions');
    const signal = await captureRedirect(() => recordPaymentAction(fd));
    expect((outcomeOf(signal).flash as Record<string, string | undefined>).error).toBe(NOT_OPEN);
    const n = await sql<{ n: string }[]>`select count(*)::text n from ap_payments where org_id = ${f.orgId} and supplier_id in (${mine}, ${theirs})`;
    expect(n[0]!.n).toBe('0');
  });
});
