import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-408 S2 (TESTER) - the monthly "invoices by VAT type x OR" list at /ap/vat?store=&month=YYYY-MM. Invariants 9-11.
 * Spec: docs/tasks/408-supplier-invoice-vat-or.md, R4. Recommended option Q2a built: managers and admins at their OWN stores.
 *
 * Invoices are inserted with raw SQL, NOT through recordInvoice, so this slice is independent of S1 (a red here is the
 * list's own, never S1's).
 *
 * CONTRACT PINNED HERE: the page is the default export of apps/erp/src/app/ap/vat/page.tsx, props
 * `{ searchParams: Promise<{ store?: string; month?: string }> }` (store = the store id), reads the session like the other
 * /ap pages, shows money with the existing peso() format (₱1,680.50), shows an invoice list that carries each invoice no,
 * and labels invoices with no VAT type "not recorded" (R4). The grid's exact wording / layout is NOT pinned: cells are
 * checked by their exact peso strings. A refusal may be a throw OR a page that shows no data - both are accepted; showing
 * the data is not.
 *
 * FIXTURE (store A, March 2026; every amount is distinct so a leak is visible):
 *   vatable/OR   : 1,120.00 (VAT 120.00, 5 Mar) + 560.50 (VAT 60.05, 31 Mar)  -> count 2, total 1,680.50, VAT 180.05
 *   vatable/no OR: 224.00 (VAT 24.00, 1 Mar)                                  -> count 1, total 224.00,  VAT 24.00
 *   zero_rated/OR: 1,000.00 (VAT 0.00, 10 Mar)
 *   exempt/OR    : 300.00 (15 Mar)          not recorded/no OR: 99.99 (20 Mar)
 *   non_vat/no OR: 50.00 (12 Mar, created_at in APRIL - a month taken from created_at would drop it)
 *   EXCLUDED: voided March 5,000.00 (VAT 535.71) | 7,000.00 dated 1 Apr but created in March | 8,000.00 dated 28 Feb
 *             store B March 2,222.00 | other org March 3,333.00
 * Each test names its killing mutant.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called');
  },
}));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(),
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

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

async function person(orgId: string, storeId: string, role: 'admin' | 'manager' | 'staff', name: string, adminId?: string) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: e!.id, personId: p!.id, setBy: adminId ?? p!.id });
  return p!.id;
}

async function org(hint: string) {
  const code = uid(`t408s2-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, ${`Store A ${hint}`}) returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('B')}, ${`Store B ${hint}`}) returning id`;
  const adminId = await person(orgId, a!.id, 'admin', 'Admin');
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${b!.id})`;
  const sup = (await asOrg(orgId, (tx) => createSupplier(tx, actor(orgId, adminId), { name: `Sup ${uid(hint)}` }))).id;
  return { orgId, storeA: a!.id, storeB: b!.id, adminId, supplierId: sup };
}
type Org = Awaited<ReturnType<typeof org>>;

interface Inv {
  no: string;
  storeId: string;
  date: string;
  total: string;
  vatType: string | null;
  vat: string | null;
  or: boolean;
  voided?: boolean;
  createdAt?: string;
}
async function insertInvoice(o: Org, i: Inv) {
  const voided = i.voided ?? false;
  await sql`
    insert into supplier_invoices
      (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, vat_type, vat_amount, is_official_receipt,
       created_by, created_at, voided_by, voided_at, void_reason)
    values
      (${o.orgId}, ${i.storeId}, ${o.supplierId}, ${i.no}, ${i.date}, ${i.total}, ${voided ? 'voided' : 'pending'}, ${i.vatType}, ${i.vat},
       ${i.or}, ${o.adminId}, ${i.createdAt ?? `${i.date}T08:00:00Z`},
       ${voided ? o.adminId : null}, ${voided ? '2026-03-20T08:00:00Z' : null}, ${voided ? 'test void' : null})`;
}

const INCLUDED: Inv[] = [];
const EXCLUDED_NOS = ['X-VOID', 'X-APR', 'X-FEB', 'X-STOREB', 'X-OTHERORG'];
let A: Org;
let managerA: string;
let managerB: string;
let staffA: string;
let OTHER: Org;

async function seedAll() {
  A = await org('a');
  OTHER = await org('other');
  managerA = await person(A.orgId, A.storeA, 'manager', 'Manager A', A.adminId);
  managerB = await person(A.orgId, A.storeB, 'manager', 'Manager B', A.adminId);
  staffA = await person(A.orgId, A.storeA, 'staff', 'Staff A', A.adminId);
  const s = A.storeA;
  const inc = (no: string, date: string, total: string, vatType: string | null, vat: string | null, or: boolean, createdAt?: string): Inv => ({
    no, storeId: s, date, total, vatType, vat, or, ...(createdAt ? { createdAt } : {}),
  });
  INCLUDED.push(
    inc('I-V1', '2026-03-05', '1120.00', 'vatable', '120.00', true),
    inc('I-V2', '2026-03-31', '560.50', 'vatable', '60.05', true),
    inc('I-V3', '2026-03-01', '224.00', 'vatable', '24.00', false),
    inc('I-ZR', '2026-03-10', '1000.00', 'zero_rated', '0.00', true),
    inc('I-EX', '2026-03-15', '300.00', 'exempt', null, true),
    inc('I-NR', '2026-03-20', '99.99', null, null, false),
    inc('I-NV', '2026-03-12', '50.00', 'non_vat', null, false, '2026-04-02T08:00:00Z'),
  );
  for (const i of INCLUDED) await insertInvoice(A, i);
  await insertInvoice(A, { no: 'X-VOID', storeId: s, date: '2026-03-08', total: '5000.00', vatType: 'vatable', vat: '535.71', or: true, voided: true });
  await insertInvoice(A, { no: 'X-APR', storeId: s, date: '2026-04-01', total: '7000.00', vatType: 'vatable', vat: '750.00', or: true, createdAt: '2026-03-12T08:00:00Z' });
  await insertInvoice(A, { no: 'X-FEB', storeId: s, date: '2026-02-28', total: '8000.00', vatType: 'vatable', vat: '857.14', or: true });
  await insertInvoice(A, { no: 'X-STOREB', storeId: A.storeB, date: '2026-03-10', total: '2222.00', vatType: 'vatable', vat: '238.07', or: true });
  await insertInvoice(OTHER, { no: 'X-OTHERORG', storeId: OTHER.storeA, date: '2026-03-10', total: '3333.00', vatType: 'vatable', vat: '357.11', or: true });
}

let VatPage: typeof import('../../src/app/ap/vat/page').default;
let requireSessionMock: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  await seedAll();
  VatPage = (await import('../../src/app/ap/vat/page')).default;
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
}, 90_000);

const TEXT = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const count = (text: string, needle: string) => text.split(needle).length - 1;

type Outcome = { html: string; threw: null } | { html: null; threw: unknown };
async function view(orgId: string, personId: string, storeId: string, month = '2026-03'): Promise<Outcome> {
  ACTOR_HOLDER.actor = { orgId, personId };
  requireSessionMock.mockResolvedValue({ actor: actor(orgId, personId), sessionId: 's', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
  try {
    const html = renderToStaticMarkup((await VatPage({ searchParams: Promise.resolve({ store: storeId, month }) })) as never);
    return { html: TEXT(html), threw: null };
  } catch (err) {
    return { html: null, threw: err };
  }
}
/** The page rendered for this viewer; a throw here is a test failure with the reason attached. */
async function mustRender(orgId: string, personId: string, storeId: string, month?: string): Promise<string> {
  const r = await view(orgId, personId, storeId, month);
  if (r.threw) throw new Error(`the list threw for an allowed viewer: ${String(r.threw)}`);
  return r.html!;
}

describe('I9 - /ap/vat for March: cell sums exact; voided, April and February invoices absent; month is by invoice_date', () => {
  it('the vatable/OR cell is count 2 / ₱1,680.50 / VAT ₱180.05, the not-OR cell ₱224.00 / ₱24.00, zero-rated ₱1,000.00. Mutant: sums wrong or cells merged -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeA);
    expect(text, 'vatable OR total').toContain('₱1,680.50');
    expect(text, 'vatable OR VAT').toContain('₱180.05');
    // single-invoice cells show in the grid AND in the list: at least twice
    expect(count(text, '₱224.00'), 'vatable no-OR total: grid + list').toBeGreaterThanOrEqual(2);
    expect(count(text, '₱24.00'), 'vatable no-OR VAT: grid + list').toBeGreaterThanOrEqual(2);
    expect(count(text, '₱1,000.00'), 'zero-rated total: grid + list').toBeGreaterThanOrEqual(2);
    expect(count(text, '₱99.99'), 'not recorded total: grid + list').toBeGreaterThanOrEqual(2);
  });
  it('the "not recorded" row exists for the invoice with no VAT type. Mutant: null-type invoices dropped (inner join / where vat_type is not null) -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeA);
    expect(text).toMatch(/not recorded/i);
    expect(text).toContain('I-NR');
  });
  it('the list carries every March invoice of the store (7) by invoice no. Mutant: a status or date filter too tight -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeA);
    for (const i of INCLUDED) expect(text, `invoice ${i.no} is missing from the list`).toContain(i.no);
  });
  it('a VOIDED March invoice is absent (no number, no ₱5,000.00, no VAT 535.71). Mutant: void not filtered -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeA);
    expect(text).not.toContain('X-VOID');
    expect(text).not.toContain('₱5,000.00');
    expect(text).not.toContain('₱535.71');
  });
  it('an April-dated invoice CREATED in March and a Feb-28 invoice are absent; a March-dated invoice CREATED in April is present (31 Mar and 1 Mar boundaries both in). Mutant: month taken from created_at, or boundary off by one -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeA);
    expect(text).not.toContain('X-APR');
    expect(text).not.toContain('₱7,000.00');
    expect(text).not.toContain('X-FEB');
    expect(text).not.toContain('₱8,000.00');
    expect(text, 'a March-dated invoice created in April must be listed').toContain('I-NV');
    expect(text, '31 March').toContain('I-V2');
    expect(text, '1 March').toContain('I-V3');
  });
  it('April selects the April invoice and none of the March ones (the month param is honoured). Mutant: month ignored -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeA, '2026-04');
    expect(text).toContain('X-APR');
    expect(text).toContain('₱7,000.00');
    expect(text).not.toContain('I-V1');
    expect(text).not.toContain('₱1,680.50');
  });
});

describe('I10 - the gate: verify_supplier_invoice at the chosen store', () => {
  it('a manager scoped to the store sees the list (Q2a); an admin sees it. Mutant: gate set to admin-only -> red', async () => {
    for (const who of [managerA, A.adminId]) {
      const text = await mustRender(A.orgId, who, A.storeA);
      expect(text).toContain('I-V1');
      expect(text).toContain('₱1,680.50');
    }
  });
  it('a staff actor is refused: it throws or shows no invoice data. Mutant: authorize removed -> red', async () => {
    const r = await view(A.orgId, staffA, A.storeA);
    if (r.threw) return;
    expect(r.html).not.toContain('I-V1');
    expect(r.html).not.toContain('₱1,680.50');
  });
  it('a manager scoped to ANOTHER store (B) is refused store A. Mutant: gate checks role only, not the store -> red', async () => {
    const r = await view(A.orgId, managerB, A.storeA);
    if (r.threw) return;
    expect(r.html).not.toContain('I-V1');
    expect(r.html).not.toContain('₱1,680.50');
  });
});

describe('I11 - tenancy: another store and another org never appear', () => {
  it('store A shows no store-B or other-org invoice (numbers and amounts). Mutant: the store_id filter dropped -> X-STOREB / ₱2,222.00 appear -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeA);
    expect(text).not.toContain('X-STOREB');
    expect(text).not.toContain('₱2,222.00');
    expect(text).not.toContain('X-OTHERORG');
    expect(text).not.toContain('₱3,333.00');
  });
  it('store B (admin) shows only its own invoice, none of store A\'s. Mutant: store filter reads the wrong id -> red', async () => {
    const text = await mustRender(A.orgId, A.adminId, A.storeB);
    expect(text).toContain('X-STOREB');
    expect(text).toContain('₱2,222.00');
    expect(text).not.toContain('I-V1');
    expect(text).not.toContain('₱1,680.50');
  });
  it('an actor of ANOTHER org pointed at store A\'s id gets nothing of A (throws or shows no A data). Mutant: org_id filter dropped -> red', async () => {
    const otherAdmin = OTHER.adminId;
    const r = await view(OTHER.orgId, otherAdmin, A.storeA);
    if (r.threw) return;
    expect(r.html).not.toContain('I-V1');
    expect(r.html).not.toContain('₱1,680.50');
  });
});
