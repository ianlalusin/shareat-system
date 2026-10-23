import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-414 S3 - New expense: the store is chosen FIRST (a GET filter row above the form), the form carries it as a hidden input,
 * and the float list, the invoice list and the action all read the SAME store. `docs/tasks/414-expense-cash-request-source.md` I1, I2, I11.
 * Ian's open question (does a store switch keep typing?) is built as the RECOMMENDED option: switching reloads and clears typing.
 *
 *   I1   `?store=B` shows B's floats, not A's.            Mutant M1: page uses `storeRows[0]` and ignores `?store=`.
 *   I1b  the store picker is a GET filter ("Use this store") outside the expense form; the form holds a hidden `storeId`.
 *   I2   the list the page offered === the list the action accepts. M2: the action loads sources for `storeRows[0]`, not the posted store.
 *   I11  the invoice picker shows only the chosen store's invoices.   M11: drop the `storeId` filter.
 *   I1c  switching the store reloads with the store in the URL and carries nothing typed (no particulars/amount in any link or hidden field).
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
import { createCashRequest, decideCashRequest, releaseCashRequest } from '@shareat/domain';
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
const actor = (orgId: string, personId: string): Actor => ({ orgId, personId });

/** Two stores, "Alpha" (sorts first, so it is the page's default) and "Bravo". Each: one open float with a distinct holder and one verified invoice. */
async function fixture() {
  const code = uid('t414s3');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`)[0]!.id;
  const alphaId = await mkStore('Alpha');
  const bravoId = await mkStore('Bravo');
  const mk = async (name: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
    for (const s of [alphaId, bravoId]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    for (const s of [alphaId, bravoId]) {
      const [e] = await sql<{ id: string }[]>`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${orgId}, ${s}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
      await grantEverydayPositionAccess(sql, { orgId, storeId: s, employmentId: e!.id, personId: p!.id, setBy: p!.id });
    }
    return p!.id;
  };
  const adminId = await mk('Admin');
  const verifierId = await mk('Verifier');
  const admin = actor(orgId, adminId);
  const verifier = actor(orgId, verifierId);

  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  const safeOf = async (sid: string) => (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${sid} and custodian = 'office' and instrument = 'cash'`)[0]!.id;
  const staffAcctOf = async (sid: string) => (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${sid} and custodian = 'staff' and instrument = 'cash'`)[0]!.id;
  for (const sid of [alphaId, bravoId]) {
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
      const [t] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1130'`;
      const [q] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${t!.id}, ${sid}, '500000.00', '0')`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${q!.id}, ${sid}, '0', '500000.00')`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
  }
  const safes: Record<string, string> = { [alphaId]: await safeOf(alphaId), [bravoId]: await safeOf(bravoId) };
  const floatAt = async (sid: string, holderName: string) => {
    const [h] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${holderName}) returning id`;
    const { id } = await asOrg(orgId, (tx) => createCashRequest(tx, admin, { storeId: sid, requestedFor: h!.id, purpose: 'Run', amount: '1000.00', on: '2026-01-05' }));
    await asOrg(orgId, (tx) => decideCashRequest(tx, verifier, { requestId: id, decision: 'approve', amount: '1000.00', on: '2026-01-05' }));
    await asOrg(orgId, (tx) => releaseCashRequest(tx, verifier, { requestId: id, amount: '1000.00', fromMoneyAccountId: safes[sid]!, on: '2026-01-05' }));
    return id;
  };
  const alphaFloat = await floatAt(alphaId, 'Holder Of Alpha');
  const bravoFloat = await floatAt(bravoId, 'Holder Of Bravo');

  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Test Supplier', ${adminId}) returning id`;
  const invoiceAt = async (sid: string, no: string) => {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${sid}, 'receipt_photo', ${`orgs/${orgId}/${no}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${adminId}) returning id`;
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
        attested_supplier, attested_invoice, attested_items, attested_price)
      values (${orgId}, ${sid}, ${supplier!.id}, ${no}, '2026-01-10', '5000.00', 'verified', ${file!.id}, ${verifierId}, now(), ${adminId}, true, true, true, true) returning id`;
    return inv!.id;
  };
  const alphaInvoice = await invoiceAt(alphaId, 'INV-ALPHA-1');
  const bravoInvoice = await invoiceAt(bravoId, 'INV-BRAVO-1');
  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and account_code is not null limit 1`;
  return {
    orgId, admin, alphaId, bravoId, alphaFloat, bravoFloat, alphaInvoice, bravoInvoice, categoryId: category!.id,
    bravoStaffAcct: await staffAcctOf(bravoId), alphaStaffAcct: await staffAcctOf(alphaId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;
let shared: Promise<F> | null = null;
const world = () => (shared ??= fixture());

async function renderNew(f: F, store?: string): Promise<string> {
  ACTOR_HOLDER.actor = f.admin;
  const { default: Page } = await import('../../src/app/expenses/new/page');
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(store ? { store } : {}) } as never)) as never);
}
const floatIdsIn = (html: string) => [...html.matchAll(/value="float:([0-9a-f-]{36})"/g)].map((m) => m[1]!);
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe('I1 - ?store= decides the float list', () => {
  it('?store=Bravo offers Bravo\'s float and not Alpha\'s', async () => {
    const f = await world();
    const html = await renderNew(f, f.bravoId);
    expect(floatIdsIn(html)).toEqual([f.bravoFloat]);
    expect(html).toContain('Holder Of Bravo');
    expect(html).not.toContain('Holder Of Alpha');
  });

  it('?store=Alpha offers Alpha\'s float and not Bravo\'s; no ?store= falls back to the first store (Alpha)', async () => {
    const f = await world();
    expect(floatIdsIn(await renderNew(f, f.alphaId))).toEqual([f.alphaFloat]);
    const dflt = await renderNew(f);
    expect(floatIdsIn(dflt)).toEqual([f.alphaFloat]);
    expect(dflt).not.toContain('Holder Of Bravo');
  });
});

describe('I1b / I1c - the store is picked first, by a GET filter row outside the form', () => {
  it('a GET form with a "store" select and a "Use this store" button; the expense form carries a hidden storeId and has no store select of its own', async () => {
    const f = await world();
    const html = await renderNew(f, f.bravoId);
    // The filter row: a method=get form containing a select named `store` and the button.
    const getForm = html.match(/<form[^>]*method="get"[^>]*>[\s\S]*?<\/form>/);
    expect(getForm, 'a method="get" filter form must exist').not.toBeNull();
    expect(getForm![0]).toMatch(/<select[^>]*name="store"/);
    expect(getForm![0]).toContain('Use this store');
    // The currently chosen store is the selected option of that picker.
    expect(getForm![0]).toMatch(new RegExp(`<option[^>]*value="${f.bravoId}"[^>]*selected`));
    // The expense form: hidden storeId = the chosen store, and NO <select name="storeId">.
    expect(html).toMatch(new RegExp(`<input[^>]*type="hidden"[^>]*name="storeId"[^>]*value="${f.bravoId}"|<input[^>]*name="storeId"[^>]*type="hidden"[^>]*value="${f.bravoId}"|<input[^>]*name="storeId"[^>]*value="${f.bravoId}"[^>]*type="hidden"`));
    expect(html).not.toMatch(/<select[^>]*name="storeId"/);
    // No typed value rides along in the picker (T-380: typed values never go in the URL; a switch clears typing).
    expect(getForm![0]).not.toMatch(/name="(particulars|lineAmount_|supplierInvoiceId|categoryId)/);
  });
});

describe('I11 - the invoice picker follows the store', () => {
  it('?store=Bravo lists only Bravo\'s invoice; ?store=Alpha only Alpha\'s', async () => {
    const f = await world();
    const bravo = await renderNew(f, f.bravoId);
    expect(bravo).toContain('INV-BRAVO-1');
    expect(bravo).not.toContain('INV-ALPHA-1');
    const alpha = await renderNew(f, f.alphaId);
    expect(alpha).toContain('INV-ALPHA-1');
    expect(alpha).not.toContain('INV-BRAVO-1');
  });
});

describe('I2 - the list the page offered is the list the action accepts', () => {
  async function post(f: F, o: { store: string; invoiceId: string; request: string; account: string }) {
    ACTOR_HOLDER.actor = f.admin;
    const fd = new FormData();
    fd.set('returnTo', '/expenses/new');
    fd.set('storeId', o.store);
    fd.set('supplierInvoiceId', o.invoiceId);
    fd.set('categoryId', f.categoryId);
    fd.set('particulars', 'T-414 S3');
    fd.set('lineCount', '1');
    fd.set('lineMethod_0', 'cash');
    fd.set('lineAmount_0', '50.00');
    fd.set('lineAccount_0', o.account);
    fd.set('lineRequest_0', o.request);
    const { createExpenseAction } = await import('../../src/app/expenses/actions');
    try {
      await createExpenseAction(fd);
    } catch (err) {
      if (err instanceof RedirectSignal) return { to: err.to, error: paramsOf(err.to).get('error') };
      throw err;
    }
    throw new Error('expected a redirect');
  }

  it('every float the page offers for Bravo is accepted by the action for Bravo (a draft is created)', async () => {
    const f = await world();
    const offered = floatIdsIn(await renderNew(f, f.bravoId));
    expect(offered).toEqual([f.bravoFloat]);
    const r = await post(f, { store: f.bravoId, invoiceId: f.bravoInvoice, request: offered[0]!, account: f.bravoStaffAcct });
    expect(r.error, decode(r.to)).toBeNull();
    expect(r.to).toMatch(/^\/expenses\/[0-9a-f-]{36}/);
  });

  it("a float the page did NOT offer for Bravo (Alpha's) is refused by the action for Bravo", async () => {
    const f = await world();
    const r = await post(f, { store: f.bravoId, invoiceId: f.bravoInvoice, request: f.alphaFloat, account: f.bravoStaffAcct });
    expect(r.error, decode(r.to)).not.toBeNull();
  });

  it('and the reverse: Alpha\'s float is accepted for Alpha, Bravo\'s refused for Alpha', async () => {
    const f = await world();
    const ok = await post(f, { store: f.alphaId, invoiceId: f.alphaInvoice, request: f.alphaFloat, account: f.alphaStaffAcct });
    expect(ok.error, decode(ok.to)).toBeNull();
    const no = await post(f, { store: f.alphaId, invoiceId: f.alphaInvoice, request: f.bravoFloat, account: f.alphaStaffAcct });
    expect(no.error, decode(no.to)).not.toBeNull();
  });
});
