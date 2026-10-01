import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-367 S2 — migration `0176`'s own trigger change (`docs/tasks/367-ap-ar-money.md` §S2,
 * "Migration"): `expenses_check_invoice_open_for_recording()` keeps 0113's body byte-identical
 * except the invoice read gains a store-mismatch check, run right after the not-found check and
 * before every existing one (voided, not-verified-for-posting, capacity). Raw SQL, as the
 * migration role — same convention as `t366-0172-migration.test.ts`/`t367-s1-migration.test.ts`.
 *
 * ⛔ TESTER, not BUILDER. The store-mismatch RAISE does not exist yet.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t367s2m-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [storeA] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-A`)}, ${`Store A ${hint}`}) returning id`;
  const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-B`)}, ${`Store B ${hint}`}) returning id`;
  const [p1] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Creator') returning id`;
  const [p2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, status, created_by) values (${orgId}, ${`Supplier ${code}`}, 'active', ${p1!.id}) returning id`;
  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} limit 1`;
  let categoryId = category?.id;
  if (!categoryId) {
    const [c] = await sql<{ id: string }[]>`insert into expense_categories (org_id, category, "group") values (${orgId}, 'COGS - Test', 'COGS') returning id`;
    categoryId = c!.id;
  }
  return { orgId, storeA: storeA!.id, storeB: storeB!.id, creatorId: p1!.id, verifierId: p2!.id, supplierId: supplier!.id, categoryId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function verifiedInvoiceAt(f: Fixture, storeId: string, totalAmount: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into supplier_invoices (
      org_id, store_id, supplier_id, invoice_date, total_amount, status,
      verified_by, verified_at, attested_supplier, attested_invoice, attested_items, attested_price, created_by
    )
    values (
      ${f.orgId}, ${storeId}, ${f.supplierId}, '2027-02-03', ${totalAmount}, 'verified',
      ${f.verifierId}, now(), true, true, true, true, ${f.creatorId}
    ) returning id`;
  return row!.id;
}

async function draftExpenseAt(f: Fixture, storeId: string, supplierInvoiceId: string, amount: string) {
  return sql`
    insert into expenses (org_id, store_id, business_date, category_id, supplier_id, supplier_invoice_id, particulars, total_amount, status, created_by)
    values (${f.orgId}, ${storeId}, '2027-02-03', ${f.categoryId}, ${f.supplierId}, ${supplierInvoiceId}, 'migration test', ${amount}, 'draft', ${f.creatorId})
  `;
}

describe('M1 — a draft expense at a DIFFERENT store than its invoice', () => {
  it("raises 'expense … is at a different store from supplier invoice …' — Mutant: the store check absent (HEAD), succeeds, red", async () => {
    const f = await fixture('m1');
    const invoiceAtB = await verifiedInvoiceAt(f, f.storeB, '1000.00');
    const err = await draftExpenseAt(f, f.storeA, invoiceAtB, '100.00').catch((e) => e);
    expect(err, 'today: the trigger never compares store_id, so this insert succeeds').toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/is at a different store from supplier invoice/);
  });
});

describe('M2 — +control: the same store succeeds', () => {
  it('a draft expense at the SAME store as its invoice still succeeds', async () => {
    const f = await fixture('m2');
    const invoiceAtA = await verifiedInvoiceAt(f, f.storeA, '1000.00');
    await expect(draftExpenseAt(f, f.storeA, invoiceAtA, '100.00')).resolves.toBeDefined();
  });
});

describe('M3 — +control: the pre-existing voided-invoice refusal survives untouched', () => {
  it('a same-store draft against a VOIDED invoice still raises 0113\'s own message, not the store one', async () => {
    const f = await fixture('m3');
    const invoiceAtA = await verifiedInvoiceAt(f, f.storeA, '1000.00');
    await sql`update supplier_invoices set status = 'voided', voided_by = ${f.verifierId}, voided_at = now(), void_reason = 'x' where id = ${invoiceAtA}`;
    const err = await draftExpenseAt(f, f.storeA, invoiceAtA, '100.00').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/is voided — nothing further may be recorded against it/);
  });
});
