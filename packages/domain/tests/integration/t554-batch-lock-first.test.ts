import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-554 (audit E-001) - recordInvoiceExpensesBatch must judge the invoice AFTER it holds the row lock, not from its earlier plain read.
 * Spec: docs/tasks/554-expense-batch-lock-first.md. Real PostgreSQL, TWO connections: connection B holds the invoice row lock
 * (FOR NO KEY UPDATE) while the batch (connection A, via asOrg) has already passed its first read and is waiting for that lock; B then
 * changes the invoice and commits. The batch must act on what B committed: verified -> expenses posted + status 'posted'; still
 * pending -> drafts + 'draft'; invoice gone -> the same refusal as a missing invoice.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: database name must contain "_test".');

import { closeDb } from '@shareat/db';
import * as domain from '@shareat/domain';
import { ap475Fixture, asOrg, uid, type Fixture } from './_fixtures/t475-ap';
import { testItemCode } from './_fixtures/item-code';

vi.setConfig({ testTimeout: 45000 });
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sentenceOf = (e: unknown) => (e as { userMessage?: string }).userMessage ?? `RAW: ${(e as Error).message}`;

async function itemisedInvoice(f: Fixture, total: string): Promise<string> {
  const [cat] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${f.orgId} and is_active and account_code is not null order by category limit 1`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id)
    values (${f.orgId}, ${testItemCode()}, ${uid('Item')}, 'raw_material', 'kg', ${f.adminId}, ${cat!.id}) returning id`;
  const id = await f.invoice({ total, status: 'pending' });
  await sql`
    insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
    values (${id}, 1, ${item!.id}, '1', 'pcs', '1', ${total}, ${total})`;
  return id;
}

const runBatch = (f: Fixture, invoiceId: string, storeId: string = f.storeId) =>
  asOrg(f.orgId, (tx) =>
    domain.recordInvoiceExpensesBatch(tx, f.admin, {
      storeId,
      supplierInvoiceId: invoiceId,
      supplierId: f.supplierId,
      groups: [{ categoryId: catOf.get(invoiceId) ?? null }],
      payments: [{ method: 'cash', amount: '1000.00', moneyAccountId: f.cashId }],
    }),
  );
const catOf = new Map<string, string>();

/** Hold the invoice row lock on B, start the batch on A, wait until A is blocked on that lock, let B `act`, commit, return A's outcome. */
async function race(f: Fixture, invoiceId: string, act: (b: postgres.Sql) => PromiseLike<unknown>) {
  const b = postgres(url!, { max: 1 });
  try {
    await b.unsafe('begin');
    await b`select id from supplier_invoices where id = ${invoiceId} for no key update`;
    const a = runBatch(f, invoiceId).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, msg: sentenceOf(e) }),
    );
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const [w] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from supplier_invoices%for no key update%'`;
      waiting = w!.n > 0;
      if (!waiting) await sleep(100);
    }
    expect(waiting, 'the batch never reached the invoice lock').toBe(true);
    await act(b);
    await b.unsafe('commit');
    return await a;
  } finally {
    await b.unsafe('rollback').catch(() => undefined);
    await b.end({ timeout: 5 });
  }
}

const expensesOf = (invoiceId: string) =>
  sql<{ status: string }[]>`select status from expenses where supplier_invoice_id = ${invoiceId}`;
const batchAudit = (invoiceId: string) =>
  sql<{ after: { status: string } }[]>`select after from audit_log where action = 'expense.batch_recorded' and entity_id = ${invoiceId}`;

async function world(hint: string) {
  const f = await ap475Fixture(sql, hint);
  const id = await itemisedInvoice(f, '1000.00');
  const [row] = await sql<{ c: string }[]>`
    select i.expense_category_id as c from supplier_invoice_lines l join items i on i.id = l.item_id where l.supplier_invoice_id = ${id}`;
  catOf.set(id, row!.c);
  return { f, id };
}

describe('T-554 - the batch decides on the LOCKED invoice status', () => {
  it('(a) invoice verified by B while the batch waits for the lock -> expenses posted, result and audit say posted', async () => {
    const { f, id } = await world('t554a');
    const out = await race(f, id, (b) =>
      b`update supplier_invoices set status = 'verified', verified_by = ${f.managerId}, verified_at = now(), attested_supplier = true,
          attested_invoice = true, attested_items = true, attested_price = true where id = ${id}`,
    );
    expect(out.ok, out.ok ? '' : (out as { msg: string }).msg).toBe(true);
    expect(out.ok && out.r.status).toBe('posted');
    expect((await expensesOf(id)).map((e) => e.status)).toEqual(['posted']);
    expect((await batchAudit(id)).map((r) => r.after.status)).toEqual(['posted']);
  });

  it('(b) invoice still pending when the batch gets the lock -> drafts, result and audit say draft', async () => {
    const { f, id } = await world('t554b');
    const out = await race(f, id, (b) => b`select 1`);
    expect(out.ok, out.ok ? '' : (out as { msg: string }).msg).toBe(true);
    expect(out.ok && out.r.status).toBe('draft');
    expect((await expensesOf(id)).map((e) => e.status)).toEqual(['draft']);
    expect((await batchAudit(id)).map((r) => r.after.status)).toEqual(['draft']);
  });

  it('(c) invoice removed by B while the batch waits -> the same refusal as a missing invoice, nothing written', async () => {
    const { f, id } = await world('t554c');
    const missing = await runBatch(f, '00000000-0000-7000-8000-000000000000').catch(sentenceOf);
    const out = await race(f, id, async (b) => {
      await b`delete from supplier_invoice_lines where supplier_invoice_id = ${id}`;
      await b`delete from supplier_invoices where id = ${id}`;
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.msg).toBe(missing);
    expect(await expensesOf(id)).toHaveLength(0);
  });

  it('(d) wrong store -> the same refusal as a missing invoice', async () => {
    const { f } = await world('t554d');
    const elsewhere = await f.invoice({ total: '1000.00', storeId: f.store2Id }); // the actor is scoped to the first store only
    const missing = await runBatch(f, '00000000-0000-7000-8000-000000000000').catch(sentenceOf);
    const wrong = await runBatch(f, elsewhere).catch(sentenceOf);
    expect(typeof wrong).toBe('string');
    expect(wrong).toBe(missing);
  });
});
