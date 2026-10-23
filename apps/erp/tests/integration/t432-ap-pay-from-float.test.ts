import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-432 - the supplier payment form can pay a booked bill from a cash request (DEF-662).
 * `docs/tasks/432-ap-payment-float-picker.md`, cases 1-3 and 6-17. Cases 4-5 are in
 * `apps/erp/tests/t432-ap-payment-form-render.test.ts`; 18-21 in `t432-bill-pay-link.test.ts`.
 *
 * TESTER file. Every case below is red today because nothing in the app posts `source=float:<id>`, the loader
 * wrapper `openFloatsForStore` does not exist, and the supplier page offers no float. A case that goes red for any
 * OTHER reason (a broken fixture) is a bug in this file.
 *
 * Mutants (spec): M1 drop the storeId filter | M2 `> 0` -> `>= 0` in openFloatsFor | M3 offer moneyAccountId:null floats |
 * M6 drop the `can` check in openFloatsForStore | M7 action passes cashRequestId null | M8 posted account id wins |
 * M9 action takes the store/account from the request's store | M10 action pre-reads the request without the org filter |
 * M11 delete the uuid shape check | M12 generic error instead of S5 | M13 pass moneyAccountId '' | M14 delete the
 * authorize(record_ap_payment) call in recordPayment | M15 action always sets cashRequestId | M16 fallback drops
 * cashRequestId | M17 floats for storeOptions[0].
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

import { transaction, APP_ROLE, cashRequestsRepo, moneyAccountsRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createCashRequest, decideCashRequest, releaseCashRequest, createSupplier, recordInvoice, verifyInvoice,
  recordExpenseForInvoice, recordPayment,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 6 });
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

// ---------------------------------------------------------------- fixture
async function fundSafe(orgId: string, storeId: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
    const [t] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1130'`;
    const [q] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${t!.id}, ${storeId}, '500000.00', '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${q!.id}, ${storeId}, '0', '500000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function setup(hint: string) {
  const code = uid(`t432-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${`${name} ${hint}`}) returning id`)[0]!.id;
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');

  const person = async (name: string, role: 'staff' | 'manager', stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await person(`${hint} Manager`, 'manager', [storeA, storeB]);
  const mgrAOnlyId = await person(`${hint} ManagerAOnly`, 'manager', [storeA]);
  const staffId = await person(`${hint} Staffer`, 'staff', [storeA, storeB]);
  for (const sid of [storeA, storeB]) {
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${sid}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId, storeId: sid, employmentId: emp!.id, personId: staffId, setBy: managerId });
  }

  const acct = async (sid: string, custodian: 'staff' | 'office') =>
    (await sql<{ id: string }[]>`
      select id from money_accounts where org_id = ${orgId} and store_id = ${sid} and custodian = ${custodian} and instrument = 'cash' order by created_at limit 1`)[0]?.id ?? null;
  await fundSafe(orgId, storeA);
  await fundSafe(orgId, storeB);

  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const manager = actorOf(orgId, managerId);
  const files: Record<string, string> = {};
  for (const sid of [storeA, storeB]) {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${sid}, 'receipt_photo', ${`orgs/${orgId}/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${staffId}) returning id`;
    files[sid] = file!.id;
  }
  return {
    orgId, storeA, storeB, hint, managerId, mgrAOnlyId, staffId, manager,
    mgrAOnly: actorOf(orgId, mgrAOnlyId), staff: actorOf(orgId, staffId),
    safeA: (await acct(storeA, 'office'))!, safeB: (await acct(storeB, 'office'))!,
    staffAcctA: () => acct(storeA, 'staff'), staffAcctB: () => acct(storeB, 'staff'),
    categoryId: category!.id, files,
  };
}
type F = Awaited<ReturnType<typeof setup>>;
let shared: Promise<F> | null = null;
const world = () => (shared ??= setup('w'));

/** Request -> approve -> release from the store's office safe. A NEW holder each time (one open float per person, DEF-159). */
async function float(f: F, holderName: string, amount: string, storeId = f.storeA): Promise<string> {
  const [h] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${holderName}) returning id`;
  const safe = storeId === f.storeA ? f.safeA : f.safeB;
  const { id } = await asOrg(f.orgId, (tx) => createCashRequest(tx, f.manager, { storeId, requestedFor: h!.id, purpose: 'Market run', amount, on: '2026-01-05' }));
  await asOrg(f.orgId, (tx) => decideCashRequest(tx, f.manager, { requestId: id, decision: 'approve', amount, on: '2026-01-05' }));
  await asOrg(f.orgId, (tx) => releaseCashRequest(tx, f.manager, { requestId: id, amount, fromMoneyAccountId: safe, on: '2026-01-05' }));
  return id;
}
/** A spend leg posted straight against the request (drains the float; status stays released). */
async function spend(f: F, requestId: string, amount: string, storeId = f.storeA): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-07', ${period!.id}, 'expense_payment', ${uid('exp')}, 'draft') returning id`;
    const [x] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '6160'`;
    const [fl] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1120'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${x!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
             values (${e!.id}, 2, ${fl!.id}, ${storeId}, '0', ${amount}, 'cash_request', ${requestId})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
const outstandingOf = async (f: F, id: string) => (await asOrg(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, id))).outstanding;

async function supplier(f: F, name: string): Promise<string> {
  return (await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `${f.hint} ${name}`, creditTermsDays: 30 }))).id;
}
/** A VERIFIED bill of `amount` booked on credit at `storeId`; returns the credit expense (the open item) and the bill. */
async function bill(f: F, supplierId: string, amount: string, storeId = f.storeA): Promise<{ expenseId: string; invoiceId: string }> {
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, { storeId, supplierId, invoiceDate: '2026-01-10', totalAmount: amount, receiptFileId: f.files[storeId]! }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId, supplierId, supplierInvoiceId: created.id, categoryId: f.categoryId, particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
    }),
  );
  return { expenseId: exp.expenseId, invoiceId: created.id };
}

// ---------------------------------------------------------------- posting through the real action
interface Post {
  as?: Actor; storeId: string; supplierId: string; expenseId: string; amount: string; applied?: string;
  source?: string; moneyAccountId?: string; cashRequestId?: string;
}
async function post(f: F, p: Post): Promise<{ error: string | null; ok: string | null }> {
  H.actor = p.as ?? f.manager;
  resetJar();
  const fd = new FormData();
  fd.set('supplierId', p.supplierId);
  fd.set('storeId', p.storeId);
  fd.set('businessDate', '2026-01-15');
  fd.set('amount', p.amount);
  fd.append('allocateExpenseId', p.expenseId);
  fd.set(`allocateAmount_${p.expenseId}`, p.applied ?? p.amount);
  if (p.source !== undefined) fd.set('source', p.source);
  if (p.moneyAccountId !== undefined) fd.set('moneyAccountId', p.moneyAccountId);
  if (p.cashRequestId !== undefined) fd.set('cashRequestId', p.cashRequestId);
  const { recordPaymentAction } = await import('../../src/app/ap/actions');
  const signal = await captureRedirect(() => recordPaymentAction(fd));
  const flash = outcomeOf(signal).flash as Record<string, string | undefined>;
  return { error: flash.error ?? null, ok: flash.ok ?? null };
}
const paymentsOf = (f: F, supplierId: string) =>
  sql<{ cash_request_id: string | null; money_account_id: string; status: string }[]>`
    select cash_request_id, money_account_id, status from ap_payments where org_id = ${f.orgId} and supplier_id = ${supplierId}`;

const R1 = 'That cash request could not be found. Refresh the page and pick it again.';
const R2 = 'This store has no staff cash account, so a cash request cannot pay a supplier here yet.';
const NOTE = 'A cash request at this store has no staff cash account yet; it can be spent on a new expense.';
const S4 = (holder: string) => `${holder}'s cash request belongs to another store, so this payment cannot draw from it. Pick another source.`;
const GONE = 'That cash request could not be found. Someone may have changed it — reload the page and try again.';

async function loaderFor(f: F, storeId: string, as: Actor) {
  const mod = (await import('../../src/lib/money-lines/load')) as unknown as {
    openFloatsForStore: (orgId: string, storeId: string, actor: Actor) => Promise<Array<{ cashRequestId: string; holderName: string; outstanding: string; moneyAccountId: string | null; storeId: string }>>;
  };
  return mod.openFloatsForStore(f.orgId, storeId, as);
}

// ---------------------------------------------------------------- the loader (cases 1-3, and its gate)
describe('case 1 - the loader lists this store\'s released float, not another store\'s (M1)', () => {
  it("manager of A at store A: A's 1,000.00 float is listed, B's is not", async () => {
    const f = await world();
    const a = await float(f, 'c1 Alpha Holder', '1000.00', f.storeA);
    const b = await float(f, 'c1 Bravo Holder', '1000.00', f.storeB);
    const rows = await loaderFor(f, f.storeA, f.mgrAOnly);
    expect(rows.find((r) => r.cashRequestId === a)).toMatchObject({ holderName: 'c1 Alpha Holder', outstanding: '1000.00', storeId: f.storeA });
    expect(rows.map((r) => r.cashRequestId)).not.toContain(b);
  });
});

describe('case 2 - a drained float is not offered (M2)', () => {
  it('outstanding 0.00 (status still released) is left out; a live one beside it stays', async () => {
    const f = await world();
    const drained = await float(f, 'c2 Drained', '500.00');
    const live = await float(f, 'c2 Live', '700.00');
    await spend(f, drained, '500.00');
    const ids = (await loaderFor(f, f.storeA, f.manager)).map((r) => r.cashRequestId);
    expect(ids).toContain(live);
    expect(ids).not.toContain(drained);
  });
});

describe('case 3 - a float whose store has no staff cash account is not offered; the page says why to a holder (M3)', () => {
  it('loader leaves it out; supplier page shows the note to the manager, not to staff, and no float option', async () => {
    const f = await setup('c3');
    const legacy = await float(f, 'c3 Legacy Holder', '1000.00');
    await sql`delete from money_accounts where org_id = ${f.orgId} and store_id = ${f.storeA} and custodian = 'staff'`;
    expect((await loaderFor(f, f.storeA, f.manager)).map((r) => r.cashRequestId)).not.toContain(legacy);

    const sup = await supplier(f, 'Sup3');
    await bill(f, sup, '2000.00');
    const mgrHtml = await renderSupplierPage(f, f.manager, sup, f.storeA);
    expect(mgrHtml).not.toContain(`float:${legacy}`);
    expect(decode(mgrHtml)).toContain(NOTE);
    const staffHtml = await renderSupplierPage(f, f.staff, sup, f.storeA);
    expect(decode(staffHtml)).not.toContain(NOTE);
    expect(staffHtml).not.toContain('c3 Legacy Holder');
  });
});

// ---------------------------------------------------------------- the supplier page (cases 6, 17)
let SupplierPage: typeof import('../../src/app/ap/suppliers/[id]/page').default;
beforeAll(async () => {
  SupplierPage = (await import('../../src/app/ap/suppliers/[id]/page')).default;
}, 30_000);
async function renderSupplierPage(f: F, as: Actor, supplierId: string, store?: string): Promise<string> {
  H.actor = as;
  resetJar();
  const el = await SupplierPage({ params: Promise.resolve({ id: supplierId }), searchParams: Promise.resolve(store ? { store } : {}) });
  return renderToStaticMarkup(el as never);
}
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const floatIdsIn = (html: string) => [...html.matchAll(/value="float:([0-9a-f-]{36})"/g)].map((m) => m[1]!);

describe('case 6 - the gate: floats are shown only to someone who could spend them at that store (M6)', () => {
  it('positive control: a manager of A at ?store=A sees A\'s float and its holder', async () => {
    const f = await setup('c6');
    const fa = await float(f, 'c6 Holder Alpha', '1000.00');
    const sup = await supplier(f, 'Sup6');
    await bill(f, sup, '2000.00', f.storeA);
    await bill(f, sup, '2000.00', f.storeB);
    const html = await renderSupplierPage(f, f.mgrAOnly, sup, f.storeA);
    expect(floatIdsIn(html)).toEqual([fa]);
    expect(html).toContain('c6 Holder Alpha');
  });

  it('a staff session at ?store=A: no float option, no holder name', async () => {
    const f = await setup('c6s');
    await float(f, 'c6s Holder Alpha', '1000.00');
    const sup = await supplier(f, 'Sup6s');
    await bill(f, sup, '2000.00', f.storeA);
    const html = await renderSupplierPage(f, f.staff, sup, f.storeA);
    expect(floatIdsIn(html)).toEqual([]);
    expect(html).not.toContain('c6s Holder Alpha');
  });

  it('a manager of A only, at ?store=B: no float option, no holder name for B', async () => {
    const f = await setup('c6b');
    await float(f, 'c6b Holder Bravo', '1000.00', f.storeB);
    const sup = await supplier(f, 'Sup6b');
    await bill(f, sup, '2000.00', f.storeA);
    await bill(f, sup, '2000.00', f.storeB);
    const html = await renderSupplierPage(f, f.mgrAOnly, sup, f.storeB);
    expect(floatIdsIn(html)).toEqual([]);
    expect(html).not.toContain('c6b Holder Bravo');
  });

  it('the loader itself returns [] for staff and for a manager of A only at B', async () => {
    const f = await world();
    const fb = await float(f, 'c6l Holder Bravo', '1000.00', f.storeB);
    const fa = await float(f, 'c6l Holder Alpha', '1000.00', f.storeA);
    expect(await loaderFor(f, f.storeA, f.staff)).toEqual([]);
    expect(await loaderFor(f, f.storeB, f.mgrAOnly)).toEqual([]);
    expect((await loaderFor(f, f.storeB, f.manager)).map((r) => r.cashRequestId)).toContain(fb);
    expect((await loaderFor(f, f.storeA, f.manager)).map((r) => r.cashRequestId)).toContain(fa);
  });
});

describe('case 17 - the page at ?store=B lists B\'s floats, and the action for B accepts the same id (M17)', () => {
  it('manager of both: ?store=B offers only B\'s float; posting that option pays', async () => {
    const f = await setup('c17');
    const fa = await float(f, 'c17 Holder Alpha', '1000.00', f.storeA);
    const fb = await float(f, 'c17 Holder Bravo', '1000.00', f.storeB);
    const sup = await supplier(f, 'Sup17');
    await bill(f, sup, '2000.00', f.storeA);
    const b = await bill(f, sup, '2000.00', f.storeB);
    const html = await renderSupplierPage(f, f.manager, sup, f.storeB);
    expect(floatIdsIn(html)).toEqual([fb]);
    expect(floatIdsIn(html)).not.toContain(fa);
    const r = await post(f, { storeId: f.storeB, supplierId: sup, expenseId: b.expenseId, amount: '300.00', source: `float:${floatIdsIn(html)[0]}` });
    expect(r.error).toBeNull();
    expect(r.ok).toMatch(/^Paid\./);
    expect(await outstandingOf(f, fb)).toBe('700.00');
  });
});

// ---------------------------------------------------------------- the action (cases 7-16)
describe('case 7 - source=float:<id> pays from the float (M7)', () => {
  it('600 of 1,000: one payment on the float and the staff cash account; float 400.00; flash "Paid."', async () => {
    const f = await world();
    const req = await float(f, 'c7 Ana', '1000.00');
    const sup = await supplier(f, 'Sup7');
    const b = await bill(f, sup, '2000.00');
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '600.00', source: `float:${req}` });
    expect(r.error).toBeNull();
    expect(r.ok).toMatch(/^Paid\./);
    const rows = await paymentsOf(f, sup);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cash_request_id: req, money_account_id: (await f.staffAcctA())!, status: 'posted' });
    expect(await outstandingOf(f, req)).toBe('400.00');
  });
});

describe("case 8 - the server picks the account: a forged moneyAccountId is ignored (M8)", () => {
  it("source=float plus moneyAccountId = A's office safe: still pays from the staff cash account; the safe is untouched", async () => {
    const f = await world();
    const req = await float(f, 'c8 Ana', '1000.00');
    const sup = await supplier(f, 'Sup8');
    const b = await bill(f, sup, '2000.00');
    const safe = (await asOrg(f.orgId, (tx) => moneyAccountsRepo.listMoneyAccounts(tx, f.orgId, { storeId: f.storeA, custodian: 'office', instrument: 'cash' })))[0]!;
    const before = await asOrg(f.orgId, (tx) => moneyAccountsRepo.balanceOf(tx, f.orgId, safe));
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '600.00', source: `float:${req}`, moneyAccountId: f.safeA });
    expect(r.error).toBeNull();
    const rows = await paymentsOf(f, sup);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cash_request_id: req, money_account_id: (await f.staffAcctA())! });
    expect(await asOrg(f.orgId, (tx) => moneyAccountsRepo.balanceOf(tx, f.orgId, safe))).toBe(before);
  });
});

describe('case 9 - forged request from another store: exactly S4, nothing posted (M9)', () => {
  it("store A posts float:<B's request>", async () => {
    const f = await world();
    const reqB = await float(f, 'c9 Bravo Ana', '1000.00', f.storeB);
    const sup = await supplier(f, 'Sup9');
    const b = await bill(f, sup, '2000.00', f.storeA);
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '300.00', source: `float:${reqB}` });
    expect(r.error).toBe(S4('c9 Bravo Ana'));
    expect(await paymentsOf(f, sup)).toHaveLength(0);
    expect(await outstandingOf(f, reqB)).toBe('1000.00');
  });
});

describe('case 10 - forged request from another org: the "could not be found" sentence, nothing posted (M10)', () => {
  it("float:<org-2 request> posted in org 1", async () => {
    const f = await world();
    const other = await setup('c10o');
    const foreign = await float(other, 'c10 Foreign Ana', '1000.00');
    const sup = await supplier(f, 'Sup10');
    const b = await bill(f, sup, '2000.00');
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '300.00', source: `float:${foreign}` });
    expect(r.error).toBe(GONE);
    expect(await paymentsOf(f, sup)).toHaveLength(0);
    expect(await outstandingOf(other, foreign)).toBe('1000.00');
  });
});

describe('case 11 - a malformed id is R1, never a database sentence (M11)', () => {
  it('float:not-a-uuid -> exactly R1', async () => {
    const f = await world();
    const sup = await supplier(f, 'Sup11');
    const b = await bill(f, sup, '2000.00');
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '300.00', source: 'float:not-a-uuid' });
    expect(r.error).toBe(R1);
    expect(r.error ?? '').not.toContain('invalid input syntax');
    expect(await paymentsOf(f, sup)).toHaveLength(0);
  });
});

describe('case 12 - over the live balance: exactly S5 (M12)', () => {
  it('1,200 on a 1,000 float', async () => {
    const f = await world();
    const req = await float(f, 'c12 Ana', '1000.00');
    const sup = await supplier(f, 'Sup12');
    const b = await bill(f, sup, '2000.00');
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '1200.00', source: `float:${req}` });
    expect(r.error).toBe("c12 Ana's cash request has ₱1,000.00 left — this payment draws ₱1,200.00 from it. Lower the amount or pay the rest another way.");
    expect(await paymentsOf(f, sup)).toHaveLength(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });
});

describe('case 13 - a store with no staff cash account: exactly R2 (M13)', () => {
  it('forged float:<id> at a store whose staff account is gone', async () => {
    const f = await setup('c13');
    const req = await float(f, 'c13 Ana', '1000.00');
    await sql`delete from money_accounts where org_id = ${f.orgId} and store_id = ${f.storeA} and custodian = 'staff'`;
    const sup = await supplier(f, 'Sup13');
    const b = await bill(f, sup, '2000.00');
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '300.00', source: `float:${req}` });
    expect(r.error).toBe(R2);
    expect(await paymentsOf(f, sup)).toHaveLength(0);
  });
});

describe('case 14 - a staff-role actor is refused by the domain, not by the form (M14)', () => {
  it('store A HAS a staff cash account; staff posts float:<A request>; the refusal is the capability one; float unchanged', async () => {
    const f = await world();
    expect(await f.staffAcctA()).not.toBeNull();
    const req = await float(f, 'c14 Ana', '1000.00');
    const sup = await supplier(f, 'Sup14');
    const b = await bill(f, sup, '2000.00');
    // The sentence staff get from the domain for ANY payment (a plain safe, no request involved).
    let baseline = '<<NO REFUSAL>>';
    try {
      await asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.staff, {
          storeId: f.storeA, supplierId: sup, businessDate: '2026-01-15', amount: '1.00', moneyAccountId: f.safeA,
          allocations: [{ expenseId: b.expenseId, amountApplied: '1.00' }],
        }),
      );
    } catch (err) {
      baseline = (err as { userMessage?: string }).userMessage ?? `NO userMessage: ${(err as Error).message}`;
    }
    expect(baseline, 'staff must be refused by recordPayment').not.toBe('<<NO REFUSAL>>');
    const r = await post(f, { as: f.staff, storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '300.00', source: `float:${req}` });
    expect(r.ok).toBeNull();
    expect(r.error).toBe(baseline);
    expect(await paymentsOf(f, sup)).toHaveLength(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });
});

describe('case 15 - a plain account id pays with no request (M15)', () => {
  it('source=<office safe id>: cash_request_id is null', async () => {
    const f = await world();
    const sup = await supplier(f, 'Sup15');
    const b = await bill(f, sup, '2000.00');
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '300.00', source: f.safeA });
    expect(r.error).toBeNull();
    expect(r.ok).toMatch(/^Paid\./);
    const rows = await paymentsOf(f, sup);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cash_request_id: null, money_account_id: f.safeA });
  });
});

describe('case 16 - no `source`: the posted moneyAccountId and cashRequestId still work (M16)', () => {
  it("older callers: staff cash account + request id posts from the float", async () => {
    const f = await world();
    const req = await float(f, 'c16 Ana', '1000.00');
    const sup = await supplier(f, 'Sup16');
    const b = await bill(f, sup, '2000.00');
    const r = await post(f, { storeId: f.storeA, supplierId: sup, expenseId: b.expenseId, amount: '300.00', moneyAccountId: (await f.staffAcctA())!, cashRequestId: req });
    expect(r.error).toBeNull();
    expect(r.ok).toMatch(/^Paid\./);
    const rows = await paymentsOf(f, sup);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cash_request_id: req, money_account_id: (await f.staffAcctA())! });
    expect(await outstandingOf(f, req)).toBe('700.00');
  });
});
