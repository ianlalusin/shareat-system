import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-408 S1 (TESTER) - the web leg: `recordInvoiceAction` carries vatType / vatAmount / isOfficialReceipt, the /ap form
 * offers them, the invoice detail header shows them (R5). Invariant 8 plus the form round trip.
 * Spec: docs/tasks/408-supplier-invoice-vat-or.md, R1, R5. Harness copied from t379-s3b-ap-fees-web.test.ts.
 *
 * CONTRACT PINNED HERE (the spec does not name the markup, so these are the minimum a working form needs):
 *  - <select name="vatType"> with option values supplier_default, vatable, zero_rated, exempt, non_vat; the first option
 *    (the default) is supplier_default and reads "Supplier's usual".
 *  - <select name="isOfficialReceipt"> with option values '' (default, "Supplier's usual"), yes, no.
 *  - <input name="vatAmount"> not required; label texts "VAT type", "Official receipt?", "VAT amount (as printed)".
 *  - the detail header shows, as text: "VAT type", "VAT amount" followed by the peso figure, and "Official receipt"
 *    followed by Yes / No. The wording of the type value itself is matched loosely (case-insensitive "vatable").
 * Each test names its killing mutant.
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
  // T-448: FormModal/Dialog read the address.
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
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
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));
vi.mock('@/components/money/MoneyLines', async () => await import('../../src/components/money/MoneyLines'));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
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
  const code = uid(`t408w-${hint}`);
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
  return { orgId, storeId, admin: actor(orgId, adminId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

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
const TEXT = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function supplier(f: Fixture, vatStatus: 'vat_registered' | 'non_vat' | null, issuesOfficialReceipt = true) {
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name: `Sup ${uid('s')}`, vatStatus, issuesOfficialReceipt }));
  return id;
}
function recordForm(f: Fixture, supplierId: string, over: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('supplierId', supplierId);
  fd.set('invoiceDate', '2026-01-10');
  fd.set('totalAmount', '1120.00');
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}
async function logBill(f: Fixture, supplierId: string, over: Record<string, string>): Promise<{ id: string; to: string }> {
  ACTOR_HOLDER.actor = f.admin;
  const { recordInvoiceAction } = await import('../../src/app/ap/actions');
  const to = await expectRedirectTo(() => recordInvoiceAction(recordForm(f, supplierId, over)));
  return { id: /\/ap\/invoices\/([0-9a-f-]{36})/.exec(to)?.[1] ?? '', to };
}
async function stored(id: string) {
  return (await sql<{ vat_type: string | null; vat_amount: string | null; vat_exclusive_amount: string | null; is_official_receipt: boolean }[]>`
    select vat_type, vat_amount::text, vat_exclusive_amount::text, is_official_receipt from supplier_invoices where id = ${id}`)[0]!;
}
const billCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoices where org_id = ${orgId}`)[0]!.n);

let InvoiceDetailPage: typeof import('../../src/app/ap/invoices/[id]/page').default;
let ApPage: typeof import('../../src/app/ap/page').default;
let requireSessionMock: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  InvoiceDetailPage = (await import('../../src/app/ap/invoices/[id]/page')).default;
  ApPage = (await import('../../src/app/ap/page')).default;
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
}, 60_000);
function asSession(f: Fixture) {
  requireSessionMock.mockResolvedValue({ actor: f.admin, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
}
async function renderInvoicePage(f: Fixture, invoiceId: string): Promise<string> {
  asSession(f);
  return renderToStaticMarkup((await InvoiceDetailPage({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve({}) })) as never);
}
async function renderApPage(f: Fixture): Promise<string> {
  asSession(f);
  return renderToStaticMarkup((await ApPage({ searchParams: Promise.resolve({}) })) as never);
}

describe('I8 - the OR select reaches the invoice; blank copies the supplier habit', () => {
  it('supplier habit OR=true: isOfficialReceipt "no" stores false; blank stores true; "yes" stores true. Mutant: the action ignores the field -> "no" stores true -> red', async () => {
    const f = await fixture('i8a');
    const s = await supplier(f, null, true);
    const no = await logBill(f, s, { isOfficialReceipt: 'no' });
    const blank = await logBill(f, s, { isOfficialReceipt: '' });
    const yes = await logBill(f, s, { isOfficialReceipt: 'yes' });
    expect((await stored(no.id)).is_official_receipt, no.to).toBe(false);
    expect((await stored(blank.id)).is_official_receipt, blank.to).toBe(true);
    expect((await stored(yes.id)).is_official_receipt, yes.to).toBe(true);
  });
  it('supplier habit OR=false: "yes" stores true (override upward); blank stays false; field absent stays false. Mutant: blank forced to true, or yes ignored -> red', async () => {
    const f = await fixture('i8b');
    const s = await supplier(f, null, false);
    const yes = await logBill(f, s, { isOfficialReceipt: 'yes' });
    const blank = await logBill(f, s, { isOfficialReceipt: '' });
    const absent = await logBill(f, s, {});
    expect((await stored(yes.id)).is_official_receipt).toBe(true);
    expect((await stored(blank.id)).is_official_receipt).toBe(false);
    expect((await stored(absent.id)).is_official_receipt).toBe(false);
  });
});

describe('Form round trip - vatType / vatAmount travel through recordInvoiceAction', () => {
  it('supplier_default on a VAT-registered supplier + typed 100.00 on 1,120.00 -> vatable, 100.00, exclusive 1020.00. Mutant: the action drops vatType or vatAmount -> null row -> red', async () => {
    const f = await fixture('rt1');
    const s = await supplier(f, 'vat_registered');
    const { id, to } = await logBill(f, s, { vatType: 'supplier_default', vatAmount: '100.00', isOfficialReceipt: '' });
    expect(id, `redirected to ${to}`).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stored(id)).toMatchObject({ vat_type: 'vatable', vat_amount: '100.00', vat_exclusive_amount: '1020.00' });
  });
  it('a blank / absent vatType keeps the old behaviour: vat_type null. Mutant: absent field treated as "supplier_default" -> red', async () => {
    const f = await fixture('rt2');
    const s = await supplier(f, 'vat_registered');
    const absent = await logBill(f, s, {});
    expect(await stored(absent.id)).toMatchObject({ vat_type: null, vat_amount: null });
  });
  it('an explicit exempt with the amount blank stores exempt / null. Mutant: the action sends "" through as an amount the domain stores or refuses -> red', async () => {
    const f = await fixture('rt3');
    const s = await supplier(f, 'vat_registered');
    const { id, to } = await logBill(f, s, { vatType: 'exempt', vatAmount: '' });
    expect(id, `redirected to ${to}`).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stored(id)).toMatchObject({ vat_type: 'exempt', vat_amount: null });
  });
  it('R2 refusals come back as a plain sentence on /ap and write nothing: vatable with no amount; non_vat supplier + vatable', async () => {
    const f = await fixture('rt4');
    const reg = await supplier(f, 'vat_registered');
    const non = await supplier(f, 'non_vat');
    const noAmount = await logBill(f, reg, { vatType: 'vatable', vatAmount: '' });
    expect(noAmount.to).toMatch(/^\/ap(\?|$)/);
    expect(errorOf(noAmount.to) ?? `no error: ${noAmount.to}`).toMatch(/\S/);
    expect(errorOf(noAmount.to)).not.toMatch(/recordInvoice:|undefined|\[object/);
    const wrong = await logBill(f, non, { vatType: 'vatable', vatAmount: '100.00' });
    expect(errorOf(wrong.to) ?? `no error: ${wrong.to}`).toMatch(/\S/);
    expect(errorOf(wrong.to)).not.toMatch(/recordInvoice:|undefined|\[object/);
    expect(await billCount(f.orgId), 'a refused VAT bill wrote an invoice').toBe(0);
  });
});

describe('The /ap form offers the three controls', () => {
  it('<select name="vatType"> with the five options, default "Supplier\'s usual"; <select name="isOfficialReceipt"> with "", yes, no; <input name="vatAmount"> not required. Mutant: a control missing or required -> red', async () => {
    const f = await fixture('form');
    const html = await renderApPage(f);
    const vatSelect = new RegExp('<select[^>]*name="vatType"[^>]*>([\\s\\S]*?)</select>').exec(html);
    expect(vatSelect, 'no <select name="vatType"> on /ap').not.toBeNull();
    const vatValues = [...vatSelect![1]!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(vatValues).toEqual(expect.arrayContaining(['supplier_default', 'vatable', 'zero_rated', 'exempt', 'non_vat']));
    expect(vatValues[0], "the default (first) option must be the supplier's usual").toBe('supplier_default');
    expect(TEXT(vatSelect![1]!)).toContain("Supplier's usual");

    const orSelect = new RegExp('<select[^>]*name="isOfficialReceipt"[^>]*>([\\s\\S]*?)</select>').exec(html);
    expect(orSelect, 'no <select name="isOfficialReceipt"> on /ap').not.toBeNull();
    const orValues = [...orSelect![1]!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(orValues).toEqual(['', 'yes', 'no']);
    expect(TEXT(orSelect![1]!)).toContain("Supplier's usual");

    const amount = /<input[^>]*name="vatAmount"[^>]*>/.exec(html)?.[0];
    expect(amount, 'no <input name="vatAmount"> on /ap').toBeDefined();
    expect(amount).not.toMatch(/\brequired\b/);

    const text = TEXT(html);
    expect(text).toContain('VAT type');
    expect(text).toContain('Official receipt?');
    expect(text).toContain('VAT amount (as printed)');
  });
});

describe('R5 - the invoice detail header shows what was stored', () => {
  it('a vatable bill, typed 107.14, OR "no": the page shows VAT type, VAT amount ₱107.14 and Official receipt No. Mutant: header not added -> red', async () => {
    const f = await fixture('r5a');
    const s = await supplier(f, 'vat_registered', true);
    const { id } = await logBill(f, s, { totalAmount: '1000.00', vatType: 'vatable', vatAmount: '107.14', isOfficialReceipt: 'no' });
    const text = TEXT(await renderInvoicePage(f, id));
    expect(text).toContain('VAT type');
    expect(text).toMatch(/vatable/i);
    expect(text).toMatch(/VAT amount[^₱]*₱107\.14/);
    expect(text).toMatch(/Official receipt[^A-Za-z]*No\b/);
  });
  it('an OR bill shows Official receipt Yes. Mutant: the flag rendered inverted / constant -> red', async () => {
    const f = await fixture('r5b');
    const s = await supplier(f, 'vat_registered', true);
    const { id } = await logBill(f, s, { totalAmount: '1000.00', vatType: 'vatable', vatAmount: '107.14', isOfficialReceipt: 'yes' });
    expect(TEXT(await renderInvoicePage(f, id))).toMatch(/Official receipt[^A-Za-z]*Yes\b/);
  });
  it('a bill with no VAT type shows no invented peso VAT figure. Mutant: the page computes 12/112 for display -> red', async () => {
    const f = await fixture('r5c');
    const s = await supplier(f, 'vat_registered');
    const { id } = await logBill(f, s, { totalAmount: '1120.00' });
    const text = TEXT(await renderInvoicePage(f, id));
    expect(text).not.toMatch(/VAT amount[^₱]*₱120\.00/);
  });
});
