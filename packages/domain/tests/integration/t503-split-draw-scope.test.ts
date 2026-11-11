import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { approveExpense, createExpense, previewInvoiceDrafts } from '@shareat/domain';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';

/**
 * T-503 (DEF-807) - TESTER. docs/tasks/503-def807-split-draw-scope.md section 3.
 * One split expense naming two money accounts that share ONE balance pool (same store, same cash GL code) must be judged
 * against the pool once: 700 + 700 over a pooled 1,000 is refused, not two passing 700-against-1,000 checks.
 * Real Postgres (TEST_DATABASE_URL, `_test` guard).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 6 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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

async function fixture(hint: string) {
  const code = uid(`sd-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const admin: Actor = { personId: p!.id, orgId };
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  // A second office safe in the same store: the pooled setup the screens refuse but a race, an old retired account or an import can leave.
  const [safe2] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Second safe', 'cash', '1130', 'office') returning id`;
  const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const [ver] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('sup')}, ${p!.id}) returning id`;
  return { orgId, storeId, admin, safe: safe!, safe2: safe2!, catId: cat!.id, verifierId: ver!.id, supplierId: sup!.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

/** Puts money straight into the ledger (not through any service). `partyId` names the wallet for 1140. */
async function postCash(f: Fx, debitCode: string, amount: string, partyId?: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-05', ${period!.id}, 'test', ${uid('src')}, 'draft') returning id`;
    let n = 0;
    for (const [code, dr, cr] of [[debitCode, amount, '0'], ['4100', '0', amount]] as const) {
      const [acct] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = ${code}`;
      const party = code === debitCode && partyId;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
               values (${e!.id}, ${++n}, ${acct!.id}, ${f.storeId}, ${dr}, ${cr}, ${party ? 'money_account' : null}, ${party || null})`;
    }
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/** Net committed ledger balance of a store's cash GL code; for 1140, of one wallet's own lines. */
async function ledgerBalance(f: Fx, code: string, partyId?: string): Promise<number> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${f.orgId} and je.status <> 'draft' and a.code = ${code} and jl.store_id = ${f.storeId}
      and (${partyId ?? null}::text is null or jl.party_id = ${partyId ?? null})`;
  return Number(r!.b);
}

async function invoiceFor(f: Fx): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.admin.personId})
    returning id`;
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price)
    values (${f.orgId}, ${f.storeId}, ${f.supplierId}, '2026-01-01', '99999999.00', 'verified', ${file!.id}, ${f.verifierId}, now(), ${f.admin.personId}, true, true, true, true)
    returning id`;
  return inv!.id;
}

type Leg = { method: 'cash' | 'online'; amount: string; moneyAccountId: string };
async function draftOn(f: Fx, invoiceId: string, payments: Leg[]): Promise<string> {
  const made = await asOrg(f.orgId, (tx) =>
    createExpense(tx, f.admin, {
      storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: invoiceId, businessDate: '2026-01-15', categoryId: f.catId,
      particulars: 'T-503 split', payments, requireItemised: false /* legacy fixture: lineless invoice */,
    }),
  );
  return made.id;
}

const entriesFor = async (expenseId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where source_id = ${expenseId}`)[0]!.n);
const statusOf = async (expenseId: string) =>
  (await sql<{ status: string }[]>`select status from expenses where id = ${expenseId}`)[0]!.status;

describe('T-503 split expense judges a shared balance pool once (DEF-807)', () => {
  // S1 - kills: judging each money account's own draw against the shared pool's full balance (700 <= 1,000 twice).
  it('S1: 700 + 700 from two same-store office safes pooling 1,000 is refused; the draft stays a draft and nothing posts', async () => {
    const f = await fixture('s1');
    await postCash(f, '1130', '1000.00');
    const id = await draftOn(f, await invoiceFor(f), [
      { method: 'cash', amount: '700.00', moneyAccountId: f.safe.id },
      { method: 'cash', amount: '700.00', moneyAccountId: f.safe2.id },
    ]);
    const err = await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, id)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/holds 1000\.00 and this takes 1400\.00/);
    expect(await statusOf(id)).toBe('draft');
    expect(await entriesFor(id)).toBe(0);
    expect(await ledgerBalance(f, '1130')).toBe(1000);
  });

  // S2 - positive control: the pool really does cover 500 + 500.
  it('S2: 500 + 500 from the same two safes (pool 1,000) posts, and the pool ends at 0', async () => {
    const f = await fixture('s2');
    await postCash(f, '1130', '1000.00');
    const id = await draftOn(f, await invoiceFor(f), [
      { method: 'cash', amount: '500.00', moneyAccountId: f.safe.id },
      { method: 'cash', amount: '500.00', moneyAccountId: f.safe2.id },
    ]);
    await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, id));
    expect(await statusOf(id)).toBe('posted');
    expect(await ledgerBalance(f, '1130')).toBe(0);
  });

  // S3 - kills: a fix that groups 1140 wallets by GL code (each wallet is its OWN balance, party-scoped).
  it('S3: 700 from each of two 1140 wallets that each hold their own 1,000 still posts', async () => {
    const f = await fixture('s3');
    const wallets: string[] = [];
    for (const name of ['GCash A', 'GCash B']) {
      const [w] = await sql<{ id: string }[]>`
        insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
        values (${f.orgId}, ${f.storeId}, ${name}, 'ewallet', '1140', 'cashier') returning id`;
      await postCash(f, '1140', '1000.00', w!.id);
      wallets.push(w!.id);
    }
    const id = await draftOn(f, await invoiceFor(f), wallets.map((w) => ({ method: 'online' as const, amount: '700.00', moneyAccountId: w })));
    await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, id));
    expect(await statusOf(id)).toBe('posted');
    expect(await ledgerBalance(f, '1140', wallets[0])).toBe(300);
    expect(await ledgerBalance(f, '1140', wallets[1])).toBe(300);
  });

  // S4 - kills: the verify cascade carrying draws per account id only, so the second draft on a shared pool is not named.
  it('S4: two drafts on one invoice, 700 from each of two pooled safes (pool 1,000): the first would post, the second is blocked', async () => {
    const f = await fixture('s4');
    await postCash(f, '1130', '1000.00');
    const inv = await invoiceFor(f);
    await draftOn(f, inv, [{ method: 'cash', amount: '700.00', moneyAccountId: f.safe.id }]);
    await draftOn(f, inv, [{ method: 'cash', amount: '700.00', moneyAccountId: f.safe2.id }]);
    const rows = await asOrg(f.orgId, (tx) => previewInvoiceDrafts(tx, f.admin, inv));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.verdict).toBeNull();
    expect(rows[1]!.verdict).not.toBeNull();
    expect(rows[1]!.verdict!.sentence).toMatch(/holds 1000\.00 and this takes 1400\.00/);
  });
});
