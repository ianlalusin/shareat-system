import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * DEF-778 - `createMoneyTransferAction` and `recordPaymentAction` (AP) hand the form's hidden `requestId` to the domain:
 * the same form posted twice is ONE transfer / payment and still a success redirect; a form with no id (or a garbage one)
 * is refused with the "out of date" sentence and writes nothing; a new render (a new id) is a new operation.
 * The domain half is `packages/domain/tests/integration/def778-request-ids.test.ts`.
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
}));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
// the actions files import the bare `@/lib/constraint-messages` specifier the root vitest config does not resolve
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordExpenseForInvoice, recordInvoice, verifyInvoice } from '@shareat/domain';
import * as transferActions from '../../src/app/money-transfers/actions';
import * as apActions from '../../src/app/ap/actions';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { urlOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const STALE = 'This form is out of date. Reload the page and try again.';
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

afterAll(async () => {
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

async function fixture(hint: string) {
  const code = uid(`def778a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const admin = actorOf(orgId, adminId);
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
      lines: [{ accountCode: '1110', storeId, debit: '100000.00' }, { accountCode: '1130', storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '200000.00' }],
    }),
  );
  const one = async (custodian: string) =>
    (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = ${custodian} and is_foundation`)[0]!.id;
  return { orgId, storeId, adminId, admin, safe: await one('office'), drawer: await one('cashier') };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Runs an action as the admin; returns where it redirected (the actions always redirect). */
async function submit(who: Actor, fn: (fd: FormData) => Promise<void>, fd: FormData): Promise<URL> {
  ACTOR_HOLDER.actor = who;
  try {
    await fn(fd);
  } catch (err) {
    if (err instanceof RedirectSignal) return urlOf(err.to);
    throw err;
  }
  throw new Error('the action returned without redirecting');
}

function formOf(fields: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  return fd;
}

describe('DEF-778 - createMoneyTransferAction', () => {
  const transferForm = (f: Fixture, requestId: string | undefined, over: Record<string, string> = {}) =>
    formOf({
      requestId, fromMoneyAccountId: f.safe, toMoneyAccountId: f.drawer, amountOut: '500.00', amountIn: '',
      transferDate: '2026-01-10', reference: '', notes: '', ...over,
    });
  const count = async (f: Fixture) =>
    Number((await sql<{ n: string }[]>`select count(*)::text as n from money_transfers where org_id = ${f.orgId}`)[0]!.n);
  const run = (f: Fixture, fd: FormData) => submit(f.admin, transferActions.createMoneyTransferAction, fd);

  it('the same form posted twice is ONE transfer (the row id is the requestId) and both redirects are successes', async () => {
    const f = await fixture('t-dbl');
    const requestId = crypto.randomUUID();
    const first = await run(f, transferForm(f, requestId));
    const second = await run(f, transferForm(f, requestId));
    expect(first.searchParams.get('error'), `refused: ${first.searchParams.get('error')}`).toBeNull();
    expect(second.searchParams.get('error'), `the replay was refused: ${second.searchParams.get('error')}`).toBeNull();
    expect(await count(f)).toBe(1);
    expect((await sql`select id from money_transfers where id = ${requestId}`).length).toBe(1);
  });

  it('a second render (a new id) is a second transfer', async () => {
    const f = await fixture('t-two');
    await run(f, transferForm(f, crypto.randomUUID()));
    await run(f, transferForm(f, crypto.randomUUID()));
    expect(await count(f)).toBe(2);
  });

  it.each([[undefined], ['not-a-uuid']])('requestId %j -> ?error= is the out-of-date sentence and nothing is written', async (bad) => {
    const f = await fixture('t-bad');
    const to = await run(f, transferForm(f, bad));
    expect(to.searchParams.get('error')).toBe(STALE);
    expect(to.searchParams.get('ok')).toBeNull();
    expect(await count(f)).toBe(0);
  });

  it('the same id with another amount -> ?error= is the "different figures" sentence; still one transfer', async () => {
    const f = await fixture('t-diff');
    const requestId = crypto.randomUUID();
    await run(f, transferForm(f, requestId));
    const to = await run(f, transferForm(f, requestId, { amountOut: '600.00' }));
    expect(to.searchParams.get('error')).toBe('This was already recorded with different figures. Reload the page and try again.');
    expect(await count(f)).toBe(1);
  });
});

describe('DEF-778 - AP recordPaymentAction', () => {
  async function apFixture(hint: string) {
    const f = await fixture(hint);
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name: `${hint} Supplier`, creditTermsDays: 30 }));
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.adminId}) returning id`;
    const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and category = 'Cost of Goods Sold — General'`;
    const invoice = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId: supplier.id, invoiceDate: '2026-01-10', totalAmount: '20000.00', receiptFileId: file!.id }),
    );
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.admin, invoice.id, { supplier: true, invoice: true, items: true, price: true }));
    const { expenseId } = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.admin, {
        storeId: f.storeId, supplierId: supplier.id, supplierInvoiceId: invoice.id, categoryId: category!.id, particulars: 'Stock purchase',
        payments: [{ method: 'credit', amount: '20000.00' }],
      }),
    );
    return { ...f, supplierId: supplier.id, expenseId };
  }
  type ApFixture = Awaited<ReturnType<typeof apFixture>>;
  const payForm = (f: ApFixture, requestId: string | undefined, amount = '4000.00') => {
    const fd = formOf({
      requestId, supplierId: f.supplierId, storeId: f.storeId, businessDate: '2026-01-15', amount, moneyAccountId: f.drawer,
    });
    fd.append('allocateExpenseId', f.expenseId);
    fd.set(`allocateAmount_${f.expenseId}`, amount);
    return fd;
  };
  const count = async (f: ApFixture) =>
    Number((await sql<{ n: string }[]>`select count(*)::text as n from ap_payments where org_id = ${f.orgId}`)[0]!.n);
  const run = (f: ApFixture, fd: FormData) => submit(f.admin, apActions.recordPaymentAction, fd);

  it('the same form posted twice is ONE payment (the row id is the requestId) and both redirects are successes', async () => {
    const f = await apFixture('p-dbl');
    const requestId = crypto.randomUUID();
    const first = await run(f, payForm(f, requestId));
    const second = await run(f, payForm(f, requestId));
    expect(first.searchParams.get('error'), `refused: ${first.searchParams.get('error')}`).toBeNull();
    expect(second.searchParams.get('error'), `the replay was refused: ${second.searchParams.get('error')}`).toBeNull();
    expect(await count(f)).toBe(1);
    expect((await sql`select id from ap_payments where id = ${requestId}`).length).toBe(1);
  });

  it('a second render (a new id) is a second payment', async () => {
    const f = await apFixture('p-two');
    await run(f, payForm(f, crypto.randomUUID()));
    await run(f, payForm(f, crypto.randomUUID()));
    expect(await count(f)).toBe(2);
  });

  it.each([[undefined], ['not-a-uuid']])('requestId %j -> ?error= is the out-of-date sentence and nothing is written', async (bad) => {
    const f = await apFixture('p-bad');
    const to = await run(f, payForm(f, bad));
    expect(to.searchParams.get('error')).toBe(STALE);
    expect(to.searchParams.get('ok')).toBeNull();
    expect(await count(f)).toBe(0);
  });
});
