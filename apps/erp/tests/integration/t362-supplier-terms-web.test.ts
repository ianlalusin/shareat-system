import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-362 (DEF-495) — web legs W1-W13. `docs/tasks/362-def-495-supplier-credit-terms.md` §Legs, "Web".
 *
 * ⛔ TESTER, not BUILDER. Harness copied from `t358-ap-invoice-expense-form.test.ts:23-72`:
 * `RedirectSignal`, `ACTOR_HOLDER`/`SESSION_HOLDER`, the `Page` stub. `fixture`, `fund`,
 * `receiptFile`, the `verifiedInvoice` helper and `expectRedirectTo` are the same shapes, adapted
 * for suppliers with terms. ⛔ NOT copied: the `@/lib/constraint-messages` vi.mock-forward (t358
 * :51-55) — that existed only because the root `vitest.config.mts` had no `@` alias; T-348 added
 * one, so `@/lib/constraint-messages` and `@/components/shell/PageDescription` now resolve
 * directly (orchestrator ruling, T-360, 2026-09-29, applied here too).
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
import { MoneyLines } from '../../src/components/money/MoneyLines';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { paramsOf, urlOf } from '../helpers/flash-jar';

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
    values (${orgId}, ${storeId}, ${adminId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
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
    values (${orgId}, ${storeId}, ${verifierId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
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

async function creditTermsOf(id: string): Promise<number | null> {
  const [row] = await sql<{ credit_terms_days: number | null }[]>`select credit_terms_days from suppliers where id = ${id}`;
  return row!.credit_terms_days;
}
async function auditCountFor(id: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where entity = 'suppliers' and entity_id = ${id}`;
  return Number(row!.n);
}

async function codSupplier(f: Fixture, hint: string): Promise<{ id: string; name: string }> {
  const name = `COD ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name }));
  return { id, name };
}
async function thirtyDaySupplier(f: Fixture, hint: string): Promise<{ id: string; name: string }> {
  const s = await codSupplier(f, hint);
  await sql`update suppliers set credit_terms_days = 30 where id = ${s.id}`;
  return s;
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

/** Verbatim shape of the editSupplierAction form — `name` always carries the CURRENT name, the
 * way a real edit form pre-fills it, so legs not testing the name field never trip it. */
function editFormData(supplier: { id: string; name: string }, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('supplierId', supplier.id);
  fd.set('name', supplier.name);
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

const TERMS_BLANK = 'Enter how many days of credit this supplier gives (0 to 365), or choose Cash on delivery.';
const M = (v: string) => `Payment terms — "${v}" is not a whole number of days from 0 to 365.`;

describe('W1 — editSupplierAction on a COD supplier, termsMode=credit, creditTermsDays=30', () => {
  it('redirect ok=Supplier updated.; row 30; 1 AUD row — was red today: row null', async () => {
    const f = await fixture('w1');
    const s = await codSupplier(f, 'w1');
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() =>
      editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: '30' })),
    );
    expect(okOf(to), `redirect URL was: ${to}`).toBe('Supplier updated.');
    expect(await creditTermsOf(s.id)).toBe(30);
    expect(await auditCountFor(s.id)).toBe(1);
  });
});

describe('W2 — editSupplierAction on a 30-day supplier, termsMode=cod, creditTermsDays=30 (a leftover)', () => {
  it('row null (the leftover is ignored) — was red today: row 30', async () => {
    const f = await fixture('w2');
    const s = await thirtyDaySupplier(f, 'w2');
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() =>
      editSupplierAction(editFormData(s, { termsMode: 'cod', creditTermsDays: '30' })),
    );
    expect(okOf(to), `redirect URL was: ${to}`).toBe('Supplier updated.');
    expect(await creditTermsOf(s.id)).toBeNull();
  });
});

describe('W3 (green, guard; Amendment A1 mutant 5) — editSupplierAction on a 30-day supplier, full edit form WITHOUT termsMode', () => {
  it('row 30 (absent means untouched)', async () => {
    const f = await fixture('w3');
    const s = await thirtyDaySupplier(f, 'w3');
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(editFormData(s, { address: 'New address' })));
    expect(okOf(to), `redirect URL was: ${to}`).toBe('Supplier updated.');
    expect(await creditTermsOf(s.id)).toBe(30);
  });
});

describe('W4 — editSupplierAction, termsMode=credit, creditTermsDays= (blank)', () => {
  it(`error = ${JSON.stringify(TERMS_BLANK)}; nothing written — was red today: ok`, async () => {
    const f = await fixture('w4');
    const s = await codSupplier(f, 'w4');
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: '' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(TERMS_BLANK);
    expect(await creditTermsOf(s.id)).toBeNull();
  });
});

describe('W5 — editSupplierAction, termsMode=credit, creditTermsDays=400', () => {
  it(`error = M('400'); nothing written — was red today: ok`, async () => {
    const f = await fixture('w5');
    const s = await codSupplier(f, 'w5');
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: '400' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(M('400'));
    expect(await creditTermsOf(s.id)).toBeNull();
  });
});

describe('W6 — editSupplierAction, termsMode=bogus', () => {
  it(`error = M('bogus'); nothing written — was red today: ok`, async () => {
    const f = await fixture('w6');
    const s = await codSupplier(f, 'w6');
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'bogus' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(M('bogus'));
    expect(await creditTermsOf(s.id)).toBeNull();
  });
});

describe('W6b (audit finding) — editSupplierAction, termsMode is a NUMBER-LOOKING string, no creditTermsDays field', () => {
  // R4: "any other value → that raw string, which the domain then refuses as malformed. An
  // unknown mode is never silently read as COD." The mapping's "any other value" branch passes
  // termsMode ITSELF through as the creditTermsDays input — which only "refuses as malformed" if
  // that string fails parseCreditTermsDays. A termsMode that happens to look like a valid day
  // count (e.g. "30", "0") passes validation and is silently ACCEPTED as real terms — the
  // unrecognised-mode guard is bypassed by coincidence of spelling, not enforced by mode.
  for (const mode of ['30', '0']) {
    it(`termsMode='${mode}' rejects with M('${mode}'), same as W6; nothing written — was red today: ok, row set to ${mode}`, async () => {
      const f = await fixture(`w6b-${mode}`);
      const s = await codSupplier(f, `w6b-${mode}`);
      ACTOR_HOLDER.actor = f.admin;
      const { editSupplierAction } = await import('../../src/app/ap/actions');
      const to = await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: mode })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(M(mode));
      expect(await creditTermsOf(s.id)).toBeNull();
    });
  }
});

describe('W7 (green, guard; ordering) — staff, termsMode=credit, creditTermsDays=abc', () => {
  it('error equals the same staff member\'s error for creditTermsDays=30; ⛔ no "Payment terms"', async () => {
    const f = await fixture('w7');
    const s = await codSupplier(f, 'w7');
    ACTOR_HOLDER.actor = f.staff;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const toValid = await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: '30' })));
    const toMalformed = await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: 'abc' })));
    const baseline = errorOf(toValid);
    const malformed = errorOf(toMalformed);
    expect(baseline, `no error on baseline — redirect URL was: ${toValid}`).not.toBeNull();
    expect(malformed, `redirect URL was: ${toMalformed}`).toBe(baseline);
    expect(malformed ?? '', 'the field sentence must never leak past the auth gate').not.toContain('Payment terms');
    expect(await creditTermsOf(s.id)).toBeNull();
  });
});

describe('W8 — createSupplierAction, name, termsMode=credit, creditTermsDays=15', () => {
  it('redirect to /ap with ok; new row has 15 — was red today: row null', async () => {
    const f = await fixture('w8');
    ACTOR_HOLDER.actor = f.admin;
    const { createSupplierAction } = await import('../../src/app/ap/actions');
    const name = `W8 ${uid('s')}`;
    const fd = new FormData();
    fd.set('name', name);
    fd.set('termsMode', 'credit');
    fd.set('creditTermsDays', '15');
    const to = await expectRedirectTo(() => createSupplierAction(fd));
    const url = urlOf(to);
    expect(url.pathname, `redirect URL was: ${to}`).toBe('/ap');
    expect(url.searchParams.get('ok')).not.toBeNull();
    const [row] = await sql<{ id: string; credit_terms_days: number | null }[]>`select id, credit_terms_days from suppliers where name = ${name}`;
    expect(row, 'expected the new supplier row to exist').toBeDefined();
    expect(row!.credit_terms_days).toBe(15);
  });
});

describe('W9 (green, guard) — createSupplierAction, name only', () => {
  it('new row null', async () => {
    const f = await fixture('w9');
    ACTOR_HOLDER.actor = f.admin;
    const { createSupplierAction } = await import('../../src/app/ap/actions');
    const name = `W9 ${uid('s')}`;
    const fd = new FormData();
    fd.set('name', name);
    await expectRedirectTo(() => createSupplierAction(fd));
    const [row] = await sql<{ credit_terms_days: number | null }[]>`select credit_terms_days from suppliers where name = ${name}`;
    expect(row!.credit_terms_days).toBeNull();
  });
});

// =================================================================================================
// W10-W11 — row 247 end to end. Fixture/renderInvoicePage/emittedNames shape from
// t358-ap-invoice-expense-form.test.ts:113-259 (verifiedInvoice, renderInvoicePage, emittedNames),
// trimmed to a single supplier. Amendment A1 §3/§4: row 247's default is already proven against a
// SQL-set 30 (t358 C1, :316-332) — what is new here is that editSupplierAction (a PERSON, via the
// real screen) is what put the 30 there. Each leg arranges its own terms (A1 §4).
// =================================================================================================

let InvoiceDetailPage: typeof import('../../src/app/ap/invoices/[id]/page').default;
let requireSessionMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  InvoiceDetailPage = (await import('../../src/app/ap/invoices/[id]/page')).default;
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
}, 30_000);

async function verifiedInvoice(f: Fixture, supplierId: string, totalAmount: string): Promise<string> {
  const fileId = await receiptFile(f.orgId, f.storeId, f.admin.personId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId, invoiceDate: '2026-01-10', totalAmount, receiptFileId: fileId }),
  );
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.verifier, created.id, { supplier: true, invoice: true, items: true, price: true }),
  );
  return created.id;
}

async function renderInvoicePage(f: Fixture, invoiceId: string): Promise<string> {
  requireSessionMock.mockResolvedValue({
    actor: f.admin, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  });
  const element = await InvoiceDetailPage({ params: Promise.resolve({ id: invoiceId }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as never);
}

describe('W10 (row 247, end to end) — W1 on the supplier, then renderInvoicePage for its verified invoice', () => {
  it('line 0 is credit, pre-selected, amount = remaining — was red today: line 0 is cash (the COD render)', async () => {
    const f = await fixture('w10');
    const s = await codSupplier(f, 'w10');
    const invoiceId = await verifiedInvoice(f, s.id, '1000.00');

    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: '30' })));
    // Not a fixture bug: this is the SAME W1 defect (editSupplierAction doesn't write terms yet),
    // so this leg is red here today too, before ever reaching the render assertion below.
    expect(await creditTermsOf(s.id), "editSupplierAction did not persist the terms — W1's own target").toBe(30);

    const html = await renderInvoicePage(f, invoiceId);
    const capacity = await asOrg(f.orgId, (tx) => apRepo.capacityOf(tx, f.orgId, invoiceId));
    const remaining = capacity?.remaining ?? '1000.00';

    const methodIdx = html.indexOf('lineMethod_0');
    expect(methodIdx, `expected to find the method select in: ${html}`).toBeGreaterThanOrEqual(0);
    const methodWindow = html.slice(Math.max(0, methodIdx - 100), methodIdx + 600);
    expect(methodWindow, `today's red — window: ${methodWindow}`).toMatch(/<option value="credit"[^>]*selected/);

    const amountIdx = html.indexOf('lineAmount_0');
    const amountWindow = html.slice(Math.max(0, amountIdx - 50), amountIdx + 300);
    expect(amountWindow, `today's red — window: ${amountWindow}`).toContain(`value="${remaining}"`);
  });
});

describe('W11 — the same supplier after W1: recordExpenseForInvoiceAction with a credit line', () => {
  it('redirects to /expenses/<uuid>; posted; one credit payment — was red today: the "…is cash-on-delivery…" sentence', async () => {
    const f = await fixture('w11');
    const s = await codSupplier(f, 'w11');
    const invoiceId = await verifiedInvoice(f, s.id, '1000.00');

    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: '30' })));

    const { recordExpenseForInvoiceAction } = await import('../../src/app/expenses/actions');
    const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
    const moneyLines = await loadMoneyLines(f.orgId, f.storeId);
    const html = renderToStaticMarkup(
      createElement('form', null, createElement(MoneyLines, {
        direction: 'out', sources: moneyLines.sources, staff: moneyLines.staff, supplierId: s.id, supplierCreditTermsDays: 30,
      })),
    );
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);

    const fd = new FormData();
    fd.set('returnTo', `/ap/invoices/${invoiceId}`);
    fd.set('supplierId', s.id);
    fd.set('supplierInvoiceId', invoiceId);
    fd.set('storeId', f.storeId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-362 W11 credit line');
    fd.set(names.find((n) => /Count$/.test(n))!, '1');
    fd.set(names.find((n) => /Method_0$/.test(n))!, 'credit');
    fd.set(names.find((n) => /Amount_0$/.test(n))!, '500.00');
    fd.set(names.find((n) => /Account_0$/.test(n))!, '');

    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(fd));
    expect(to, `today's red — got redirect: ${to}`).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
    const [payment] = await sql<{ method: string }[]>`
      select method from expense_payments
      where expense_id = (select id from expenses where supplier_invoice_id = ${invoiceId} order by created_at desc limit 1)`;
    expect(payment!.method).toBe('credit');
  });
});

describe('the 0-day render leg (Amendment A1 §2a) — editSupplierAction sets terms to 0, then renderInvoicePage', () => {
  it('Credit is offered and pre-selected, not "— no terms set" — was red today: editSupplierAction does not persist terms yet (same root cause as W10)', async () => {
    const f = await fixture('w-zero');
    const s = await codSupplier(f, 'w-zero');
    const invoiceId = await verifiedInvoice(f, s.id, '1000.00');

    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    await expectRedirectTo(() => editSupplierAction(editFormData(s, { termsMode: 'credit', creditTermsDays: '0' })));
    expect(await creditTermsOf(s.id), "editSupplierAction did not persist 0 — W1's own defect, 0 days here too").toBe(0);

    const html = await renderInvoicePage(f, invoiceId);
    const methodIdx = html.indexOf('lineMethod_0');
    expect(methodIdx, `expected to find the method select in: ${html}`).toBeGreaterThanOrEqual(0);
    const window = html.slice(Math.max(0, methodIdx - 100), methodIdx + 600);
    expect(window, `today's red — window: ${window}`).not.toMatch(/no terms set/);
    expect(window, `today's red — window: ${window}`).toMatch(/<option value="credit"[^>]*selected/);
  });
});

// =================================================================================================
// W12-W13 — render legs for the supplier screens themselves.
// =================================================================================================

let SupplierDetailPage: typeof import('../../src/app/ap/suppliers/[id]/page').default;
let SuppliersListPage: typeof import('../../src/app/ap/suppliers/page').default;

beforeAll(async () => {
  SupplierDetailPage = (await import('../../src/app/ap/suppliers/[id]/page')).default;
  SuppliersListPage = (await import('../../src/app/ap/suppliers/page')).default;
}, 30_000);

async function renderSupplierDetail(f: Fixture, supplierId: string): Promise<string> {
  requireSessionMock.mockResolvedValue({
    actor: f.admin, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  });
  const element = await SupplierDetailPage({ params: Promise.resolve({ id: supplierId }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as never);
}

describe('W12 (render) — /ap/suppliers/[id] for a 30-day supplier and a COD supplier', () => {
  it('30-day: termsMode has credit selected and creditTermsDays value 30 — was red today: both names absent', async () => {
    const f = await fixture('w12-terms');
    const s = await thirtyDaySupplier(f, 'w12t');
    const html = await renderSupplierDetail(f, s.id);
    expect(html, `page did not render termsMode at all: ${html.slice(0, 2000)}`).toMatch(/name="termsMode"/);
    const idx = html.indexOf('name="termsMode"');
    const window = html.slice(Math.max(0, idx - 200), idx + 600);
    expect(window).toMatch(/<option value="credit"[^>]*selected/);
    expect(window).toMatch(/name="creditTermsDays"[^>]*value="30"/);
  });

  it('COD: cod selected and days empty — was red today: both names absent', async () => {
    const f = await fixture('w12-cod');
    const s = await codSupplier(f, 'w12c');
    const html = await renderSupplierDetail(f, s.id);
    expect(html).toMatch(/name="termsMode"/);
    const idx = html.indexOf('name="termsMode"');
    const window = html.slice(Math.max(0, idx - 200), idx + 600);
    expect(window).toMatch(/<option value="cod"[^>]*selected/);
    expect(window).toMatch(/name="creditTermsDays"[^>]*value=""/);
  });
});

describe('W13 (render; Amendment A1 §2b) — /ap/suppliers list with a supplier of each kind', () => {
  it('a Terms header; cells "30 days", "Cash on delivery" and "0 days" — was red today: absent', async () => {
    const f = await fixture('w13');
    await thirtyDaySupplier(f, 'w13-thirty');
    await codSupplier(f, 'w13-cod');
    const zeroDay = await codSupplier(f, 'w13-zero');
    await sql`update suppliers set credit_terms_days = 0 where id = ${zeroDay.id}`;

    requireSessionMock.mockResolvedValue({
      actor: f.admin, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
    });
    const element = await SuppliersListPage({ searchParams: Promise.resolve({}) } as never);
    const html = renderToStaticMarkup(element as never);

    expect(html, `page did not render a Terms header: ${html.slice(0, 2000)}`).toMatch(/Terms/);
    expect(html).toMatch(/30 days/);
    // Amendment A1 §2b: the Terms cell must gate on `creditTermsDays === null`, never truthiness —
    // a truthy check would render the 0-day supplier as "Cash on delivery" too, so this counts
    // occurrences rather than merely matching once. Exactly ONE real COD supplier exists here.
    const codCount = (html.match(/Cash on delivery/g) ?? []).length;
    expect(codCount, `"Cash on delivery" appeared ${codCount} times — the 0-day row must not be one of them`).toBe(1);
    expect(html).toMatch(/0 days/);
  });
});
