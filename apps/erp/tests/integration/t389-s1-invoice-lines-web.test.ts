import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-389 S1 (TESTER) - the supplier-invoice LINES form keeps what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md - R1-R5, K5 (invoice lines), section 9.4 steps 1-5.
 *
 * Multi-row form (`line1..5_*`): the case the per-form keep-key design could not do. The refusal is the one the
 * spec names: lines that do not add up to the invoice total. Harness copied from t379-s3b-ap-fees-web.test.ts, with
 * the flash-jar doubles (next/navigation, cookie jar) instead of its private RedirectSignal.
 *
 * CONTRACT PINNED HERE:
 *  - form key `invoice.lines` (the spec's own example); record = the invoice id; allow-list = the controls the form
 *    renders, line1..5 x { itemId, quantity, purchaseUnit, conversionFactor, unitPrice } = 25 names. NOT invoiceId.
 *    (`line<i>_description` is read by the action but not rendered, so it is not a control and is not listed.)
 *  - only an invoice that already has saved lines is an EditableRecord (an invoice with none is an add form: N1,
 *    out of scope), so every refusal below edits lines that were saved first.
 * Each test names its killing mutant.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));
vi.mock('@/components/money/MoneyLines', async () => await import('../../src/components/money/MoneyLines'));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { FLASH_COOKIE, captureRedirect, currentJar, outcomeOf, pageParamsOf, resetJar } from '../helpers/flash-jar';

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
  const code = uid(`t389il-${hint}`);
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
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: adminId, setBy: adminId });
  return { orgId, storeId, admin: actor(orgId, adminId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function item(f: Fixture, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('ITEM')}, ${name}, 'raw_material', 'kg', ${f.admin.personId}) returning id`;
  return row!.id;
}

type Acts = Record<string, (fd: FormData) => Promise<void>>;
const actions = async () => (await import('../../src/app/ap/actions')) as unknown as Acts;

async function bill(f: Fixture, totalAmount: string): Promise<string> {
  h.actor = f.admin;
  const [s] = [(await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name: `Sup ${uid('s')}` }))).id];
  const fd = new FormData();
  for (const [k, v] of Object.entries({ storeId: f.storeId, supplierId: s, invoiceDate: '2026-01-10', totalAmount, deliveryFee: '', otherFees: '' })) fd.set(k, v);
  resetJar();
  const sig = await captureRedirect(() => actions().then((a) => a['recordInvoiceAction']!(fd)));
  const id = /\/ap\/invoices\/([0-9a-f-]{36})/.exec(sig.url)?.[1];
  if (!id) throw new Error(`the bill was not logged: ${sig.url}`);
  return id;
}

type Row = { itemId?: string; quantity?: string; purchaseUnit?: string; conversionFactor?: string; unitPrice?: string };
/** What the browser posts for the 5-row lines form: every row's five controls, blank rows included. */
function linesForm(invoiceId: string, rows: Row[], extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('invoiceId', invoiceId);
  for (let i = 1; i <= 5; i++) {
    const r = rows[i - 1] ?? {};
    fd.set(`line${i}_itemId`, r.itemId ?? '');
    fd.set(`line${i}_quantity`, r.quantity ?? '');
    fd.set(`line${i}_purchaseUnit`, r.purchaseUnit ?? 'pcs');
    fd.set(`line${i}_conversionFactor`, r.conversionFactor ?? '1');
    fd.set(`line${i}_unitPrice`, r.unitPrice ?? '');
  }
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}
async function saveLines(f: Fixture, fd: FormData) {
  resetJar();
  h.actor = f.admin;
  const signal = await captureRedirect(() => actions().then((a) => a['setInvoiceLinesAction']!(fd)));
  return { signal, outcome: outcomeOf(signal) };
}

/** An invoice of 10,000 with one saved line (10 kg at 1,000) - so the lines form renders as a locked EditableRecord. */
async function savedBill(f: Fixture, x: string): Promise<string> {
  const id = await bill(f, '10000.00');
  const ok = await saveLines(f, linesForm(id, [{ itemId: x, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '1000' }]));
  expect(ok.outcome.flash.error, `the first save must succeed: ${ok.signal.url}`).toBeUndefined();
  return id;
}

type TypedCookie = { form: string; record: string; fields: Record<string, string | string[]> };
async function cookiePayload(): Promise<{ keep: Record<string, string>; t?: TypedCookie; td?: { form: string; record: string } }> {
  const { decodeFlash } = await import('../../src/lib/flash');
  return decodeFlash(currentJar().get(FLASH_COOKIE)!.value) as never;
}

let InvoiceDetailPage: typeof import('../../src/app/ap/invoices/[id]/page').default;
beforeAll(async () => {
  InvoiceDetailPage = (await import('../../src/app/ap/invoices/[id]/page')).default;
  await import('../../src/app/ap/actions');
}, 120_000);

async function render(f: Fixture, invoiceId: string, params: Record<string, string> = {}): Promise<string> {
  h.actor = f.admin;
  seen.records = [];
  const el = await InvoiceDetailPage({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(el as never);
}
const linesRecord = (invoiceId: string) =>
  seen.records.find((r) => (r.hidden as Record<string, string> | undefined)?.invoiceId === invoiceId) as { typed?: { kind?: string; fields?: Record<string, unknown> } | null } | undefined;
const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** The lines form's own <form>...</form> (the one holding line1_itemId). */
function linesFormHtml(html: string): string {
  const at = html.indexOf('name="line1_itemId"');
  expect(at, 'the lines form is on the page').toBeGreaterThan(0);
  return html.slice(html.lastIndexOf('<form', at), html.indexOf('</form>', at));
}

/** Rows that do not add up: 10 kg at 1,057.25 (10,572.50, plus a second line of 11.00 = 10,583.50) against an invoice of 10,000. */
const BAD_ROWS = (x: string, y: string): Row[] => [
  { itemId: x, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '1057.25' },
  { itemId: y, quantity: '2', purchaseUnit: 'box', conversionFactor: '12', unitPrice: '5.5' },
];

describe('S1 invoice lines - lines that do not add up keep what was typed (DEF-617)', () => {
  it('L1: a refused save puts all 25 line controls in the typed slot (blank rows too), and not the invoice id', async () => {
    const f = await fixture('l1');
    const x = await item(f, 'Pork Belly');
    const y = await item(f, 'Eggs');
    const id = await savedBill(f, x);
    const r = await saveLines(f, linesForm(id, BAD_ROWS(x, y)));
    expect(r.outcome.flash.error ?? `no refusal: ${r.signal.url}`).toMatch(/^The lines total ₱10,?583\.50/);
    const p = await cookiePayload();
    expect(p.t?.form).toBe('invoice.lines');
    expect(p.t?.record).toBe(id);
    const expected: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
      const row = BAD_ROWS(x, y)[i - 1] ?? {};
      expected[`line${i}_itemId`] = row.itemId ?? '';
      expected[`line${i}_quantity`] = row.quantity ?? '';
      expected[`line${i}_purchaseUnit`] = row.purchaseUnit ?? 'pcs';
      expected[`line${i}_conversionFactor`] = row.conversionFactor ?? '1';
      expected[`line${i}_unitPrice`] = row.unitPrice ?? '';
    }
    expect(p.t?.fields).toEqual(expected);
    expect(Object.keys(p.keep)).toEqual([]);
    expect(decodeURIComponent(r.signal.url), 'nothing typed in the address').not.toMatch(/1057|Pork|line1/);
    // Red on HEAD: the action keeps nothing. Mutant: allow-list only line1 -> the toEqual is red (the multi-row case).
  });

  it('L2: with the client __changed list only the touched controls ride', async () => {
    const f = await fixture('l2');
    const x = await item(f, 'Pork Belly');
    const y = await item(f, 'Eggs');
    const id = await savedBill(f, x);
    const fd = linesForm(id, BAD_ROWS(x, y), { __changed: 'line1_unitPrice,line2_itemId,line2_quantity,line2_unitPrice,invoiceId' });
    const r = await saveLines(f, fd);
    expect(r.outcome.flash.error).toBeTruthy();
    const p = await cookiePayload();
    expect(p.t?.fields).toEqual({ line1_unitPrice: '1057.25', line2_itemId: y, line2_quantity: '2', line2_unitPrice: '5.5' });
    // Mutant: ignore __changed -> 25 names ride, red.
  });

  it('L3: a mistyped amount (1,0OO) comes back byte for byte, next to the refusal that quotes it', async () => {
    const f = await fixture('l3');
    const x = await item(f, 'Pork Belly');
    const id = await savedBill(f, x);
    const r = await saveLines(f, linesForm(id, [{ itemId: x, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '1,0OO' }]));
    expect(r.outcome.flash.error, 'a refusal').toBeTruthy();
    const p = await cookiePayload();
    expect(p.t?.fields['line1_unitPrice']).toBe('1,0OO');
    // Mutant: Number()/trim() the value -> red.
  });

  it('L4: the page reopens the lines record in edit mode, draws the STORED lines, hands the record the typing; another invoice stays locked', async () => {
    const f = await fixture('l4');
    const x = await item(f, 'Pork Belly');
    const y = await item(f, 'Eggs');
    const id = await savedBill(f, x);
    const other = await savedBill(f, x);
    const r = await saveLines(f, linesForm(id, BAD_ROWS(x, y)));
    const p = await cookiePayload();

    const html = await render(f, id, pageParamsOf(r.signal.url));
    const form = linesFormHtml(html);
    expect(form, 'reopened').not.toContain('<fieldset disabled');
    expect(form, 'Save is showing').toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
    expect(plain(form)).toContain('Cancel');
    expect(form, 'the stored line price is what is drawn').toMatch(/name="line1_unitPrice"[^>]*value="1000(\.0+)?"|value="1000(\.0+)?"[^>]*name="line1_unitPrice"/);
    expect(form, 'the typed price is never drawn by the server').not.toContain('1057.25');
    expect(linesRecord(id)?.typed).toEqual({ kind: 'typed', fields: p.t!.fields });
    expect(plain(html), 'the refusal banner still says why').toMatch(/The lines total ₱10,?583\.50/);

    const otherHtml = await render(f, other, pageParamsOf(r.signal.url));
    expect(linesFormHtml(otherHtml)).toContain('<fieldset disabled');
    expect(linesRecord(other)?.typed ?? null).toBeNull();
    // Red on HEAD: the record is locked and typed is undefined. Mutant: typedFor ignores the record -> `other` reopens, red.
  });

  it('L5 (control, green on HEAD): with no flash the saved lines render locked, nothing typed', async () => {
    const f = await fixture('l5');
    const x = await item(f, 'Pork Belly');
    const id = await savedBill(f, x);
    const html = await render(f, id);
    expect(linesFormHtml(html)).toContain('<fieldset disabled');
    expect(linesRecord(id)?.typed ?? null).toBeNull();
  });

  it('L6: typing too long to keep (a 5,000-character quantity): td, no t; the sentence shows and the record stays locked with the stored lines', async () => {
    const f = await fixture('l6');
    const x = await item(f, 'Pork Belly');
    const id = await savedBill(f, x);
    const r = await saveLines(f, linesForm(id, [{ itemId: x, quantity: '9'.repeat(5000), purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '1000' }]));
    expect(r.outcome.flash.error, 'a refusal').toBeTruthy();
    const p = await cookiePayload();
    expect(p.t).toBeUndefined();
    expect(p.td).toEqual({ form: 'invoice.lines', record: id, actor: f.admin.personId });
    const html = await render(f, id, pageParamsOf(r.signal.url));
    expect(linesFormHtml(html)).toContain('<fieldset disabled');
    expect(plain(html)).toContain('What you typed was too long to keep. This shows what is saved. Press Edit and enter your change again.');
    expect(linesRecord(id)?.typed).toEqual({ kind: 'dropped' });
    expect(linesFormHtml(html), 'the form itself never draws the typed value (the banner may quote it)').not.toContain('9999999999');
  });

  it('L7 (control): a good save is unchanged - ok banner, no typed slot, the rows are replaced', async () => {
    const f = await fixture('l7');
    const x = await item(f, 'Pork Belly');
    const id = await savedBill(f, x);
    const r = await saveLines(f, linesForm(id, [{ itemId: x, quantity: '5', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '2000' }]));
    expect(r.outcome.flash.error).toBeUndefined();
    expect(r.outcome.flash.ok).toBe('Lines saved. Prices now feed the item history.');
    const p = await cookiePayload();
    expect(p.t).toBeUndefined();
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoice_lines where supplier_invoice_id = ${id}`;
    expect(row!.n).toBe('1');
    // Mutant: keepTyping on the success path -> t present, red.
  });

  it('L8: the refusal wrote nothing - the saved line is untouched', async () => {
    const f = await fixture('l8');
    const x = await item(f, 'Pork Belly');
    const y = await item(f, 'Eggs');
    const id = await savedBill(f, x);
    await saveLines(f, linesForm(id, BAD_ROWS(x, y)));
    const rows = await sql<{ unit_price: string; quantity: string }[]>`select unit_price::text, quantity::text from supplier_invoice_lines where supplier_invoice_id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.unit_price)).toBe(1000);
  });
});
