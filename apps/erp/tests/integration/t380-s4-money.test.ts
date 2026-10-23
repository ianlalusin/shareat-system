import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-380 S4 - M7 (money does not move), M7b (a refused typed amount leaves the address) and M8 / REV-9 (the
 * `returnTo` open redirect, DEF-603). docs/tasks/380-no-typed-values-in-urls.md S4. TESTER, not BUILDER.
 *
 * Real Postgres and the real domain; only the session and Next's navigation/headers are doubled. Every leg reads the RAW
 * redirect URL as well as `outcomeOf` (`outcomeOf` falls back to the URL until S6, so a flash assertion alone passes on HEAD).
 *
 * SPEC DEFECTS (reported, worked around): (1) the spec's M7 amount `'2,500.00'` is REFUSED by the domain (money input
 * takes no thousands separator), so the money leg posts `'2500.00'` and the refused leg (M7b) uses `'2,500.00'` on purpose.
 * (2) the spec says the success lands on `/ap/invoices/<id>?...f=...`; `recordExpenseForInvoiceAction` ends on
 * `/expenses/<expenseId>?store=<id>` (no banner, so no `f`). M7 asserts that real target.
 *
 *  M7   GREEN on HEAD, by design: the money invariant. The posted lines equal what a direct domain call posts for the same
 *       input, and the address holds no amount. Named mutant: the builder re-parses/reformats a line amount while moving the
 *       redirect (e.g. `Number(amount)`), so the journal differs -> M7 red.
 *  M7b  RED on HEAD: a refused `'2,500.00'` rides in `?error=` (the sentence quotes it). No expense is written either way.
 *       Mutants: keep a template `?error=` -> red; `redirectWithFlash` not awaited on the catch path -> the success redirect
 *       wins and `flash.error` is absent -> red.
 *  M8   RED on HEAD for the hostile returnTo values: they redirect off-site (`https://evil.example?...`). Four call sites,
 *       expenses/actions.ts :237 :256 :275 :307, each with off-site, `//`, backslash, `javascript:` and control characters
  expect(seen.raw, `a redirect that starts with exactly one slash (saw: ${JSON.stringify(seen.raw)})`).toMatch(/^\/(?![/\\])/);
 *       Mutant: pass `returnTo` through unchecked -> red.
 *  M8c  a legitimate `/ap/invoices/<id>?store=<uuid>&x=hi` keeps its path and `store`, and loses `x`. RED on HEAD.
 *  M9   ap/actions.ts :399 (voidPaymentAction): an `invoiceId` holding `?` or a newline falls back to a safe `/ap...`
 *       path and the person still gets the refusal, never a thrown error. The PATH half is already true on HEAD (the id check is
 *       anchored; T-379 fixed the unanchored shape the spec names), so these legs are RED on HEAD only because the sentence rides
 *       in `?error=`. Mutant: loosen the id check to `\b...\b` -> `<uuid>?error=forged` builds a path with `?` -> R6 throws -> red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));
vi.mock('@/lib/period-override', async () => await import('../../src/lib/period-override'));

import { transaction, apRepo, APP_ROLE, closeDb, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordExpenseForInvoice, recordInvoice, verifyInvoice } from '@shareat/domain';
import * as expenseActions from '../../src/app/expenses/actions';
import * as apActions from '../../src/app/ap/actions';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

afterAll(async () => {
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

async function fund(orgId: string, storeId: string, code: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${orgId} and code in (${code}, '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id) values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0', null, null)`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id) values (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount}, null, null)`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/** One org/store, a cash drawer funded 500,000, an admin who may create and approve, a COD supplier, and a way to make verified invoices. */
async function fixture(hint: string) {
  const code = uid(`t380s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;

  const person = async (name: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
    return { personId: p!.id, employmentId: emp!.id };
  };
  const a = await person('Admin');
  const v = await person('Verifier');
  for (const x of [a, v]) await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: x.employmentId, personId: x.personId, setBy: a.personId });
  const admin = actor(orgId, a.personId);
  const verifier = actor(orgId, v.personId);

  const [drawer] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  await fund(orgId, storeId, '1110', '500000.00');
  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, admin, { name: `COD ${uid('s')}` }));

  async function verifiedInvoice(totalAmount: string): Promise<string> {
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${a.personId}) returning id`;
    const created = await asOrg(orgId, (tx) => recordInvoice(tx, admin, { storeId, supplierId: supplier.id, invoiceDate: '2026-01-10', totalAmount, receiptFileId: file!.id }));
    await asOrg(orgId, (tx) => verifyInvoice(tx, verifier, created.id, { supplier: true, invoice: true, items: true, price: true }));
    return created.id;
  }
  return { orgId, storeId, admin, drawerId: drawer!.id, categoryId: category!.id, supplierId: supplier.id, verifiedInvoice };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function formOf(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

interface Seen {
  raw: string;
  out: ReturnType<typeof outcomeOf>;
}
async function run(who: Actor, fn: (fd: FormData) => Promise<void>, fd: FormData): Promise<Seen> {
  resetJar();
  ACTOR_HOLDER.actor = who;
  const signal = await captureRedirect(() => fn(fd));
  return { raw: signal.url, out: outcomeOf(signal) };
}

const recordForInvoice = (expenseActions as unknown as { recordExpenseForInvoiceAction: (fd: FormData) => Promise<void> }).recordExpenseForInvoiceAction;
const createExpense = (expenseActions as unknown as { createExpenseAction: (fd: FormData) => Promise<void> }).createExpenseAction;
const voidPayment = (apActions as unknown as { voidPaymentAction: (fd: FormData) => Promise<void> }).voidPaymentAction;

const cashForm = (f: Fixture, invoiceId: string, amount: string, extra: Record<string, string> = {}) =>
  formOf({
    returnTo: `/ap/invoices/${invoiceId}`, supplierInvoiceId: invoiceId, storeId: f.storeId, categoryId: f.categoryId,
    particulars: 'T-380 S4', lineCount: '1', lineMethod_0: 'cash', lineAmount_0: amount, lineAccount_0: f.drawerId, ...extra,
  });

const expenseCount = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from expenses where org_id = ${orgId}`)[0]!.n);
const linesOfExpense = async (expenseId: string): Promise<Array<[string, string, string]>> => {
  const rows = await sql<{ code: string; debit: string; credit: string }[]>`
    select a.code as code, jl.debit::text as debit, jl.credit::text as credit
      from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
     where je.source_id = ${expenseId} order by a.code, jl.debit desc`;
  return rows.map((r) => [r.code, r.debit, r.credit]);
};
const decoded = (raw: string): string => decodeURIComponent(raw.replace(/\+/g, ' '));
const UUID_IN_PATH = /^\/expenses\/([0-9a-f-]{36})$/;

describe('M7 - recording an expense against a verified invoice posts exactly what the domain posts', () => {
  it('the journal equals a direct domain call with the same input; the address holds no amount', async () => {
    const f = await fixture('m7');
    const viaAction = await f.verifiedInvoice('5000.00');
    const viaDomain = await f.verifiedInvoice('5000.00');

    const seen = await run(f.admin, recordForInvoice, cashForm(f, viaAction, '2500.00'));
    expect(seen.out.path, 'lands on the new expense').toMatch(UUID_IN_PATH);
    expect(seen.out.nav.get('store')).toBe(f.storeId);
    expect(decoded(seen.raw), `no amount in the address (saw: ${seen.raw})`).not.toMatch(/2500|2,500|₱|error=|ok=/);
    const actionExpenseId = UUID_IN_PATH.exec(seen.out.path)![1]!;

    const direct = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.admin, {
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: viaDomain, categoryId: f.categoryId, particulars: 'T-380 S4',
        payments: [{ method: 'cash', amount: '2500.00', moneyAccountId: f.drawerId }],
      }),
    );
    const a = await linesOfExpense(actionExpenseId);
    const b = await linesOfExpense(direct.expenseId);
    expect(a.length, 'the action posted something').toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a.some(([, debit, credit]) => debit === '2500.0000' || credit === '2500.0000' || debit === '2500.00' || credit === '2500.00'), `a line is exactly 2500 (saw ${JSON.stringify(a)})`).toBe(true);
  });
});

describe('M7b - a refused typed amount stays out of the address and nothing is written', () => {
  it('"2,500.00" is refused; the sentence is in the flash, the URL has no amount, no expense row', async () => {
    const f = await fixture('m7b');
    const invoice = await f.verifiedInvoice('5000.00');
    const before = await expenseCount(f.orgId);
    const seen = await run(f.admin, recordForInvoice, cashForm(f, invoice, '2,500.00'));
    expect(seen.out.path, 'back on the bill page').toBe(`/ap/invoices/${invoice}`);
    expect(seen.out.nav.get('store')).toBe(f.storeId);
    expect(seen.out.flash.error, 'the person is told').toBeTruthy();
    expect(decoded(seen.raw), `no typed amount, no sentence in the address (saw: ${seen.raw})`).not.toMatch(/2,500|2500|error=/);
    expect(await expenseCount(f.orgId), 'a refusal writes nothing').toBe(before);
  });
});

const HOSTILE = [
  ['off-site', 'https://evil.example/ap'],
  ['protocol-relative', '//evil.example/ap'],
  ['backslash', '/\\evil.example'],
  ['javascript:', 'javascript:alert(1)'],
  ['newline', '/ap\nSet-Cookie: a=b'],
  ['carriage return', '/ap\r\nLocation: https://evil.example'],
  ['NUL', '/ap\u0000/x'],
  ['DEL', '/ap\u007f'],
] as const;

/** A path that is the fallback and cannot leave the app. */
function expectSafe(seen: Seen, fallback: string) {
  expect(seen.raw, `a redirect that starts with exactly one slash (saw: ${JSON.stringify(seen.raw)})`).toMatch(/^\/(?![/\\])/);
  // eslint-disable-next-line no-control-regex
  expect(seen.raw, 'no control character reaches a Location header').not.toMatch(/[\x00-\x1f\x7f]/);
  expect(seen.out.path).toBe(fallback);
}

describe('M8 / REV-9 - returnTo can never take the person off-site (DEF-603)', () => {
  // expenses/actions.ts :237 (create, parse refused) and :275 (record, parse refused): no store -> 'Choose a store.'
  // :256 (create, domain refused) and :307 (record, domain refused): a category id the domain does not know.
  describe.each(HOSTILE)('%s', (_name, hostile) => {
    it(':237 createExpenseAction, refused while parsing -> /expenses/new', async () => {
      const f = await fixture('m8a');
      const seen = await run(f.admin, createExpense, formOf({ returnTo: hostile, storeId: '' }));
      expectSafe(seen, '/expenses/new');
    });
    it(':275 recordExpenseForInvoiceAction, refused while parsing -> /ap', async () => {
      const f = await fixture('m8b');
      const seen = await run(f.admin, recordForInvoice, formOf({ returnTo: hostile, storeId: '' }));
      expectSafe(seen, '/ap');
    });
    it(':256 createExpenseAction, refused by the domain -> /expenses/new', async () => {
      const f = await fixture('m8c');
      const invoice = await f.verifiedInvoice('5000.00');
      const seen = await run(f.admin, createExpense, cashForm(f, invoice, '100.00', { returnTo: hostile, categoryId: '11111111-1111-4111-8111-111111111111' }));
      expect(seen.out.flash.error, 'the domain refused (fixture check), so a banner exists').toBeTruthy();
      expectSafe(seen, '/expenses/new');
    });
    it(':307 recordExpenseForInvoiceAction, refused by the domain -> /ap', async () => {
      const f = await fixture('m8d');
      const invoice = await f.verifiedInvoice('5000.00');
      const seen = await run(f.admin, recordForInvoice, cashForm(f, invoice, '100.00', { returnTo: hostile, categoryId: '11111111-1111-4111-8111-111111111111' }));
      expect(seen.out.flash.error, 'the domain refused (fixture check), so a banner exists').toBeTruthy();
      expectSafe(seen, '/ap');
    });
  });

  it('M8c: a legitimate returnTo keeps its path and its uuid `store`, and drops every other query key', async () => {
    const f = await fixture('m8e');
    const invoice = await f.verifiedInvoice('5000.00');
    const seen = await run(
      f.admin, recordForInvoice,
      cashForm(f, invoice, '100.00', { returnTo: `/ap/invoices/${invoice}?store=${f.storeId}&x=hi&error=forged`, categoryId: '11111111-1111-4111-8111-111111111111' }),
    );
    expect(seen.out.flash.error, 'the domain refused (fixture check)').toBeTruthy();
    expect(seen.out.path).toBe(`/ap/invoices/${invoice}`);
    expect(seen.out.nav.get('store')).toBe(f.storeId);
    expect([...seen.out.nav.keys()], 'only the id-shaped key survives').toEqual(['store']);
    expect(decoded(seen.raw)).not.toMatch(/x=hi|forged|error=/);
  });
});

describe('M9 - ap/actions.ts :399 voidPaymentAction builds its return path only from well-formed ids', () => {
  const PAYMENT = '22222222-2222-4222-8222-222222222222';
  const UUID = '33333333-3333-4333-8333-333333333333';
  it.each([
    ['an invoice id carrying a query', `${UUID}?error=forged`, '', '/ap'],
    ['an invoice id carrying a newline', `${UUID}\nX: y`, '', '/ap'],
    ['a supplier id carrying a query', '', `${UUID}?x=1`, '/ap'],
    ['a good invoice id', UUID, '', `/ap/invoices/${UUID}`],
    ['a good supplier id', '', UUID, `/ap/suppliers/${UUID}`],
  ])('%s', async (_n, invoiceId, supplierId, expected) => {
    const f = await fixture('m9');
    const seen = await run(f.admin, voidPayment, formOf({ paymentId: PAYMENT, invoiceId, supplierId, reason: 'Typed wrong' }));
    expect(seen.out.path).toBe(expected);
    expect(seen.out.flash.error, 'the refusal is shown, not thrown').toBeTruthy();
    expect(decoded(seen.raw), `the sentence is not in the address (saw: ${seen.raw})`).not.toMatch(/error=|forged|Typed wrong/);
  });
});
