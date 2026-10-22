import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-379 S3b (DEF-568 / DEF-569) - web legs W1-W6. docs/tasks/379-erp-small-follow-ups.md S3b, with REV-3/5/6/7.
 *
 * TESTER only. Harness, fixture and render helpers copied from t362-supplier-terms-web.test.ts.
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
// Only W10/W11 render the invoice detail page, which mounts <MoneyLines> — forwarded to the real
// modules for the same reason `@/lib/constraint-messages` no longer needs forwarding at all: these
// two ARE still real, un-aliased `@/...` specifiers used only by that one page (not covered by
// t358's own precedent for THIS reason — `@/components/money/MoneyLines` and
// `@/lib/money-lines/load` are genuinely mounted, not test doubles).
vi.mock('@/lib/money-lines/load', async () => {
  return await import('../../src/lib/money-lines/load');
});
vi.mock('@/components/money/MoneyLines', async () => {
  return await import('../../src/components/money/MoneyLines');
});

import { transaction, apRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, verifyInvoice } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { SUPPLIER_INVOICE_LOG_RULES } from '@shareat/domain/field-rules';
import { expectRuleSentence } from '../helpers/rule-sentence';
import { paramsOf } from '../helpers/flash-jar';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

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

/** Org + store + admin + staff (non-holder), chart of accounts seeded. Shape from
 * `t358-ap-invoice-expense-form.test.ts:113-192`, trimmed to what W1-W13 need. */
async function fixture(hint: string) {
  const code = uid(`t362w-${hint}`);
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

  // ⛔ Segregation of duties: `verifyInvoice` refuses "you logged this invoice, so you cannot also
  // verify it" (t358-ap-invoice-expense-form.test.ts:136-139) — a second admin verifies.
  const [verifier] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  const verifierId = verifier!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${verifierId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${verifierId}, ${storeId})`;
  const [verifierEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${verifierId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: verifierEmployment!.id, personId: verifierId, setBy: adminId });
  const verifier_ = actor(orgId, verifierId);

  // The non-holder — CAPABILITY-MATRIX.md:99, `approve_supplier` is ✗ for staff.
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Floor Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${storeId}, 'manual')`;
  const staff_ = actor(orgId, staff!.id);

  const [category] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;

  return { orgId, storeId, admin: admin_, verifier: verifier_, staff: staff_, categoryId: category!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy})
    returning id`;
  return row!.id;
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
const okOf = (to: string) => paramsOf(to).get('ok');


const TEXT = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function supplier(f: Fixture, hint: string) {
  const name = `Sup ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name }));
  return id;
}
async function item(f: Fixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${f.admin.personId}) returning id`;
  return row!.id;
}
function recordForm(f: Fixture, supplierId: string, over: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('supplierId', supplierId);
  fd.set('invoiceDate', '2026-01-10');
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}
/** Logs a bill THROUGH THE ACTION; returns its id and where it redirected. */
async function logBill(f: Fixture, supplierId: string, over: Record<string, string>): Promise<{ id: string; to: string }> {
  ACTOR_HOLDER.actor = f.admin;
  const { recordInvoiceAction } = await import('../../src/app/ap/actions');
  const to = await expectRedirectTo(() => recordInvoiceAction(recordForm(f, supplierId, over)));
  const id = /\/ap\/invoices\/([0-9a-f-]{36})/.exec(to)?.[1] ?? '';
  return { id, to };
}
async function feesOf(id: string) {
  return (await sql<{ delivery_fee: string; other_fees: string; total_amount: string }[]>`
    select delivery_fee::text, other_fees::text, total_amount::text from supplier_invoices where id = ${id}`)[0];
}
async function itemise(f: Fixture, invoiceId: string, itemId: string, unitPrice: string): Promise<string> {
  ACTOR_HOLDER.actor = f.admin;
  const { setInvoiceLinesAction } = await import('../../src/app/ap/actions');
  const fd = new FormData();
  fd.set('invoiceId', invoiceId);
  fd.set('line1_itemId', itemId);
  fd.set('line1_quantity', '10');
  fd.set('line1_purchaseUnit', 'kg');
  fd.set('line1_conversionFactor', '1');
  fd.set('line1_unitPrice', unitPrice);
  return expectRedirectTo(() => setInvoiceLinesAction(fd));
}
async function lineCount(id: string): Promise<number> {
  return Number((await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoice_lines where supplier_invoice_id = ${id}`)[0]!.n);
}
async function billCount(orgId: string): Promise<number> {
  return Number((await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoices where org_id = ${orgId}`)[0]!.n);
}

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
async function verified(f: Fixture, supplierId: string, over: { deliveryFee?: string; otherFees?: string; totalAmount: string }): Promise<string> {
  const fileId = await receiptFile(f.orgId, f.storeId, f.admin.personId);
  const created = await asOrg(f.orgId, (tx) => recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId, invoiceDate: '2026-01-10', receiptFileId: fileId, ...over }));
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.verifier, created.id, { supplier: true, invoice: true, items: true, price: true }));
  return created.id;
}

describe('W1 — recordInvoiceAction carries both fees; the bill is itemised against the GOODS (DEF-569)', () => {
  it('total 10500 + deliveryFee 500 (otherFees blank): delivery_fee 500.00, other_fees 0.00; lines of 10000 saved, 10500 refused. Mutant: the action drops deliveryFee -> red', async () => {
    const f = await fixture('w1');
    const s = await supplier(f, 'w1');
    const x = await item(f);
    const { id, to } = await logBill(f, s, { totalAmount: '10500.00', deliveryFee: '500.00', otherFees: '' });
    expect(id, `redirected to ${to}`).toMatch(/^[0-9a-f-]{36}$/);
    expect(await feesOf(id)).toMatchObject({ delivery_fee: '500.00', other_fees: '0.00', total_amount: '10500.00' });

    const refused = await itemise(f, id, x, '1050');
    expect(errorOf(refused) ?? `no error: ${refused}`).toContain('the goods on this bill come to ₱10,000.00');
    expect(await lineCount(id)).toBe(0);
    const ok = await itemise(f, id, x, '1000');
    expect(errorOf(ok), ok).toBeNull();
    expect(await lineCount(id)).toBe(1);
  });

  it('variant: otherFees 200.00 -> other_fees 200.00 (delivery blank = 0.00); goods = total - 200. Mutant: the action drops otherFees -> red', async () => {
    const f = await fixture('w1b');
    const s = await supplier(f, 'w1b');
    const x = await item(f);
    const { id } = await logBill(f, s, { totalAmount: '10500.00', deliveryFee: '', otherFees: '200.00' });
    expect(await feesOf(id)).toMatchObject({ delivery_fee: '0.00', other_fees: '200.00' });
    expect(errorOf(await itemise(f, id, x, '1000')), 'goods are 10300; 10000 must be refused').toContain('the goods on this bill come to ₱10,300.00');
    expect(errorOf(await itemise(f, id, x, '1030')), 'lines of 10300 are accepted').toBeNull();
    expect(await lineCount(id)).toBe(1);
  });
});

describe('W2 (control) — a blank fee changes nothing', () => {
  it('delivery_fee 0.00; the lines must sum to the total', async () => {
    const f = await fixture('w2');
    const s = await supplier(f, 'w2');
    const x = await item(f);
    const { id } = await logBill(f, s, { totalAmount: '10000.00', deliveryFee: '', otherFees: '' });
    expect(await feesOf(id)).toMatchObject({ delivery_fee: '0.00', other_fees: '0.00' });
    expect(errorOf(await itemise(f, id, x, '1001')) ?? 'not refused').toMatch(/^The lines total ₱10,?010\.00, but the /);
    expect(errorOf(await itemise(f, id, x, '1000'))).toBeNull();
  });
});

describe('W3 — fee refusals come back in words', () => {
  it("deliveryFee -5 -> the rule's sentence; fees above the total -> the feesTooBig sentence; neither writes a bill", async () => {
    const f = await fixture('w3');
    const s = await supplier(f, 'w3');
    const neg = await logBill(f, s, { totalAmount: '1000.00', deliveryFee: '-5' });
    expectRuleSentence(errorOf(neg.to) ?? `no error: ${neg.to}`, SUPPLIER_INVOICE_LOG_RULES.deliveryFee, '-5');
    const big = await logBill(f, s, { totalAmount: '1000.00', deliveryFee: '800.00', otherFees: '300.00' });
    expect(errorOf(big.to) ?? `no error: ${big.to}`).toBe("The delivery and other fees can't be more than the invoice total.");
    expect(await billCount(f.orgId), 'a refused fee wrote a bill').toBe(0);
  });
});

describe('W4 — the itemise note names the GOODS and the fee (render + source, REV-3)', () => {
  it('render: the fee bill says "Lines must add up to ₱10,000.00" and names the ₱500.00 delivery fee; the no-fee bill keeps "₱1,000.00" and names no fee. Mutant: the note uses totalAmount -> red', async () => {
    const f = await fixture('w4');
    const s = await supplier(f, 'w4');
    const feeBill = (await logBill(f, s, { totalAmount: '10500.00', deliveryFee: '500.00' })).id;
    const plain = (await logBill(f, s, { totalAmount: '1000.00' })).id;
    const fee = TEXT(await renderInvoicePage(f, feeBill));
    expect(fee).toContain('Lines must add up to ₱10,000.00');
    expect(fee).not.toContain('Lines must add up to ₱10,500.00');
    expect(fee).toMatch(/Delivery fee[^₱]*₱500\.00/);
    const no = TEXT(await renderInvoicePage(f, plain));
    expect(no).toContain('Lines must add up to ₱1,000.00');
    expect(no).not.toMatch(/Delivery fee|Other fees/);
  });

  it('source: [id]/page.tsx imports `subtract` from @shareat/core/money and puts no Number( on a fee. Mutant: goods via Number -> red', () => {
    const src = readFileSync(resolve(__dirname, '../../src/app/ap/invoices/[id]/page.tsx'), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\bsubtract\b[^}]*\}\s*from\s*'@shareat\/core\/money'/);
    expect(src).not.toMatch(/Number\([^)]*(deliveryFee|otherFees)/);
  });
});

describe('W4b (REV-7) — the fee split shows on a bill of ANY status', () => {
  it('a VERIFIED bill with ₱500 delivery + ₱200 other fees still shows both rows; a no-fee verified bill shows neither. Mutant: rows inside the pending-only section -> red', async () => {
    const f = await fixture('w4b');
    const s = await supplier(f, 'w4b');
    const feeBill = await verified(f, s, { totalAmount: '10700.00', deliveryFee: '500.00', otherFees: '200.00' });
    const plain = await verified(f, s, { totalAmount: '1000.00' });
    const fee = TEXT(await renderInvoicePage(f, feeBill));
    expect(fee).toMatch(/Delivery fee[^₱]*₱500\.00/);
    expect(fee).toMatch(/Other fees[^₱]*₱200\.00/);
    expect(TEXT(await renderInvoicePage(f, plain))).not.toMatch(/Delivery fee|Other fees/);
  });
});

describe('W5 (REV-6) — the log-a-bill form has both fee inputs and says both are added to cost', () => {
  it('/ap: inputs deliveryFee and otherFees, neither required, and the help text. Mutant: the old one-fee text -> red', async () => {
    const f = await fixture('w5');
    asSession(f);
    const html = renderToStaticMarkup((await ApPage({ searchParams: Promise.resolve({}) })) as never);
    for (const name of ['deliveryFee', 'otherFees']) {
      const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0];
      expect(tag, `no <input name="${name}"> on /ap`).toBeDefined();
      expect(tag).not.toMatch(/\brequired\b/);
    }
    expect(TEXT(html)).toContain("Part of the total above. Both are added to the items' cost; neither is a line.");
  });
});

describe('W6 (money, end to end) — the fee reaches the item price history', () => {
  it('after W1, itemising X 10 kg at ₱10,000: landed 1050.0000 per kg against a raw 1000.0000. Mutant: fees dropped by the action -> the itemise is refused', async () => {
    const f = await fixture('w6');
    const s = await supplier(f, 'w6');
    const x = await item(f);
    const { id } = await logBill(f, s, { totalAmount: '10500.00', deliveryFee: '500.00' });
    expect(errorOf(await itemise(f, id, x, '1000')), 'itemising the goods was refused').toBeNull();
    const { itemsRepo } = await import('@shareat/db');
    const history = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, x));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ basePrice: '1000.0000', landedBasePrice: '1050.0000' });
  });
});
