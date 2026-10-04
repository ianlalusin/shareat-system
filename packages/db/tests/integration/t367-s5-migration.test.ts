import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-367 S5 (DEF-054) F4 — migration 0182's own change (`docs/tasks/367-ap-ar-money.md` §S5 step 1): the
 * `expense_payments_method_check` CHECK becomes the four live methods and is added NOT VALID, so legacy rows survive.
 * Raw SQL as the migration role — same convention as `t367-s2-migration.test.ts`.
 *
 * ⛔ TESTER. At HEAD the CHECK still lists six methods, so the 'other' / 'ar_collection' inserts SUCCEED and the
 * `convalidated` read is true: M1, M2 and M4 fail on those assertions.
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
  const code = uid(`t367s5m-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Creator') returning id`;
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, status, created_by) values (${orgId}, ${`Supplier ${code}`}, 'active', ${p!.id}) returning id`;
  const [verifier] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Verifier') returning id`;
  const [cat] = await sql<{ id: string }[]>`insert into expense_categories (org_id, category, "group") values (${orgId}, 'COGS - Test', 'COGS') returning id`;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
                                   attested_supplier, attested_invoice, attested_items, attested_price, created_by)
    values (${orgId}, ${store!.id}, ${supplier!.id}, '2027-02-03', '100000.00', 'verified', ${verifier!.id}, now(), true, true, true, true, ${p!.id}) returning id`;
  const [exp] = await sql<{ id: string }[]>`
    insert into expenses (org_id, store_id, business_date, category_id, supplier_id, supplier_invoice_id, particulars, total_amount, status, created_by)
    values (${orgId}, ${store!.id}, '2027-02-03', ${cat!.id}, ${supplier!.id}, ${invoice!.id}, 'migration test', '100.00', 'draft', ${p!.id}) returning id`;
  return { expenseId: exp!.id };
}

const insertPayment = (expenseId: string, method: string) =>
  sql`insert into expense_payments (expense_id, method, amount) values (${expenseId}, ${method}, '1.00')`;

describe('M1 — a NEW row of a retired method is refused by the CHECK', () => {
  for (const method of ['other', 'ar_collection']) {
    it(`'${method}' -> 23514 on expense_payments_method_check — Mutant: the six-value CHECK (HEAD) accepts it, red`, async () => {
      const f = await fixture(`m1-${method}`);
      const err = await insertPayment(f.expenseId, method).catch((e) => e);
      expect(err, `today the CHECK still lists '${method}', so the insert succeeds`).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe('23514');
      expect(String((err as Error).message)).toMatch(/expense_payments_method_check/);
    });
  }
});

describe('M2 — +control: the four live methods are accepted', () => {
  for (const method of ['cash', 'online', 'credit', 'reimbursable']) {
    it(`'${method}' inserts`, async () => {
      const f = await fixture(`m2-${method}`);
      await expect(insertPayment(f.expenseId, method)).resolves.toBeDefined();
    });
  }
});

describe('M3 — the constraint is NOT VALID, and legacy rows of both retired methods survive it', () => {
  it('pg_constraint.convalidated = false for expense_payments_method_check — Mutant: a validated CHECK (HEAD) is true, red', async () => {
    const [row] = await sql<{ convalidated: boolean }[]>`
      select convalidated from pg_constraint where conname = 'expense_payments_method_check' and conrelid = 'expense_payments'::regclass`;
    expect(row, 'the constraint must exist').toBeDefined();
    expect(row!.convalidated).toBe(false);
  });

  it('rows of both retired methods written BEFORE the CHECK was tightened still read back (simulated as a legacy fixture: drop, insert, re-add the same definition NOT VALID, in one transaction)', async () => {
    const f = await fixture('m3');
    await sql.begin(async (tx) => {
      const [def] = await tx<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'expense_payments_method_check' and conrelid = 'expense_payments'::regclass`;
      const check = def!.def.replace(/\s+NOT VALID$/i, '');
      await tx.unsafe('alter table expense_payments drop constraint expense_payments_method_check');
      await tx`insert into expense_payments (expense_id, method, amount) values (${f.expenseId}, 'other', '1.00'), (${f.expenseId}, 'ar_collection', '2.00')`;
      await tx.unsafe(`alter table expense_payments add constraint expense_payments_method_check ${check} not valid`);
    });
    const rows = await sql<{ method: string }[]>`select method from expense_payments where expense_id = ${f.expenseId} order by method`;
    expect(rows.map((r) => r.method)).toEqual(['ar_collection', 'other']);
    // and the surviving constraint still refuses a NEW retired row, i.e. it was re-added as the live definition
    const err = await insertPayment(f.expenseId, 'other').catch((e) => e);
    expect(err, "after 0182 the re-added definition refuses a new 'other'").toBeInstanceOf(Error);
  });
});
