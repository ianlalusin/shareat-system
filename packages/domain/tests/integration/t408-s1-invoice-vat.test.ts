import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-408 S1 (TESTER) - VAT type, VAT amount and the OR flag on `recordInvoice`. Invariants 1-7.
 * Spec: docs/tasks/408-supplier-invoice-vat-or.md, R1-R3. Recommended options built: the VAT amount is TYPED from the
 * paper (Q1a); nothing is computed at 12/112.
 *
 * Every refusal is proven twice: it throws, AND it left no invoice row and no audit row (R2: "all before the first write").
 * Each test names its killing mutant. Rows are read back with raw SQL, never through the code under test.
 * `'supplier_default'` is passed through an `as never` cast: the type widens in the builder's slice (R1), not before.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, recordInvoice } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t408s1-${hint}`);
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
  return { orgId, storeId, admin: actor(orgId, adminId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

type Vat = 'vat_registered' | 'non_vat' | null;
async function supplier(f: Fixture, vatStatus: Vat, issuesOfficialReceipt = true): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createSupplier(tx, f.admin, { name: `Sup ${uid('s')}`, vatStatus, issuesOfficialReceipt }),
  );
  return id;
}

type Over = Record<string, unknown>;
function record(f: Fixture, supplierId: string, over: Over) {
  return asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId, invoiceDate: '2026-01-10', totalAmount: '1120.00', ...over } as never),
  );
}
interface Row {
  vat_type: string | null;
  vat_rate: string | null;
  vat_amount: string | null;
  vat_exclusive_amount: string | null;
  is_official_receipt: boolean;
  total_amount: string;
}
async function row(id: string): Promise<Row> {
  return (await sql<Row[]>`
    select vat_type, vat_rate::text, vat_amount::text, vat_exclusive_amount::text, is_official_receipt, total_amount::text
    from supplier_invoices where id = ${id}`)[0]!;
}
const invoiceCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoices where org_id = ${orgId}`)[0]!.n);
const auditCount = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${orgId}`)[0]!.n);

/** Runs `over` and proves it was refused with nothing written: no invoice row, no audit row. */
async function expectRefusedClean(f: Fixture, supplierId: string, over: Over, why: string) {
  const invoicesBefore = await invoiceCount(f.orgId);
  const auditBefore = await auditCount(f.orgId);
  await expect(record(f, supplierId, over), why).rejects.toThrow();
  expect(await invoiceCount(f.orgId), `${why}: an invoice row was written`).toBe(invoicesBefore);
  expect(await auditCount(f.orgId), `${why}: an audit row was written`).toBe(auditBefore);
}

describe('I1 - "supplier_default" resolves from the supplier on the server (R1)', () => {
  it('vat_registered -> vatable (with the typed amount). Mutant: mapping ignored/inverted -> null or non_vat -> red', async () => {
    const f = await fixture('i1a');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { vatType: 'supplier_default', vatAmount: '100.00' });
    expect(await row(id)).toMatchObject({ vat_type: 'vatable', vat_amount: '100.00' });
  });
  it('non_vat -> non_vat, amount blank -> stored null. Mutant: mapping inverted -> vatable -> refused/red', async () => {
    const f = await fixture('i1b');
    const s = await supplier(f, 'non_vat');
    const { id } = await record(f, s, { vatType: 'supplier_default' });
    expect(await row(id)).toMatchObject({ vat_type: 'non_vat', vat_amount: null, vat_exclusive_amount: null });
  });
  it('vat_status null -> stored null ("not recorded"). Mutant: null falls back to vatable -> red', async () => {
    const f = await fixture('i1c');
    const s = await supplier(f, null);
    const { id } = await record(f, s, { vatType: 'supplier_default' });
    expect(await row(id)).toMatchObject({ vat_type: null, vat_amount: null, vat_exclusive_amount: null });
  });
  it('null vat_status supplier accepts ANY explicit type (master data not filled in yet): vatable + amount stores', async () => {
    const f = await fixture('i1d');
    const s = await supplier(f, null);
    const { id } = await record(f, s, { vatType: 'vatable', vatAmount: '120.00' });
    expect(await row(id)).toMatchObject({ vat_type: 'vatable', vat_amount: '120.00', vat_exclusive_amount: '1000.00' });
  });
});

describe('I2 - an omitted vatType stays null, even for a VAT-registered supplier (the recurring job path)', () => {
  it('omitted and explicit null both store null / null / null. Mutant: omit treated as the default -> vatable -> red', async () => {
    const f = await fixture('i2');
    const s = await supplier(f, 'vat_registered');
    const a = await record(f, s, {});
    const b = await record(f, s, { vatType: null });
    for (const id of [a.id, b.id]) {
      expect(await row(id)).toMatchObject({ vat_type: null, vat_rate: null, vat_amount: null, vat_exclusive_amount: null });
    }
  });
});

describe('I3 - a non_vat supplier cannot carry VAT (R2)', () => {
  it('non_vat supplier + vatable -> refused, no invoice row, no audit row. Mutant: the R2 check removed -> stores -> red', async () => {
    const f = await fixture('i3a');
    const s = await supplier(f, 'non_vat');
    await expectRefusedClean(f, s, { vatType: 'vatable', vatAmount: '100.00' }, 'non_vat supplier + vatable');
  });
  it('non_vat supplier + zero_rated -> refused clean. Mutant: only vatable is checked -> red', async () => {
    const f = await fixture('i3b');
    const s = await supplier(f, 'non_vat');
    await expectRefusedClean(f, s, { vatType: 'zero_rated' }, 'non_vat supplier + zero_rated');
  });
  it('non_vat supplier + any VAT amount (even with type non_vat or none) -> refused clean. Mutant: amount not checked against the supplier -> red', async () => {
    const f = await fixture('i3c');
    const s = await supplier(f, 'non_vat');
    await expectRefusedClean(f, s, { vatType: 'non_vat', vatAmount: '50.00' }, 'non_vat supplier + type non_vat + amount');
    await expectRefusedClean(f, s, { vatAmount: '50.00' }, 'non_vat supplier + amount, no type');
  });
});

describe('I4 - a vatable bill needs an amount that is > 0 and <= the total (R2)', () => {
  it('blank amount -> refused clean. Mutant: required-amount check dropped -> stores null VAT -> red', async () => {
    const f = await fixture('i4a');
    const s = await supplier(f, 'vat_registered');
    await expectRefusedClean(f, s, { vatType: 'vatable' }, 'vatable with no amount');
    await expectRefusedClean(f, s, { vatType: 'vatable', vatAmount: '' }, 'vatable with empty-string amount');
  });
  it('amount 0 -> refused clean. Mutant: lower bound dropped (>= 0) -> red', async () => {
    const f = await fixture('i4b');
    const s = await supplier(f, 'vat_registered');
    await expectRefusedClean(f, s, { vatType: 'vatable', vatAmount: '0' }, 'vatable with amount 0');
    await expectRefusedClean(f, s, { vatType: 'vatable', vatAmount: '0.00' }, 'vatable with amount 0.00');
  });
  it('amount above the total -> refused clean; amount equal to the total is accepted (exclusive 0.00). Mutant: upper bound dropped, or < instead of <= -> red', async () => {
    const f = await fixture('i4c');
    const s = await supplier(f, 'vat_registered');
    await expectRefusedClean(f, s, { vatType: 'vatable', vatAmount: '1120.01' }, 'vatable with amount a centavo over the total');
    const { id } = await record(f, s, { vatType: 'vatable', vatAmount: '1120.00' });
    expect(await row(id)).toMatchObject({ vat_amount: '1120.00', vat_exclusive_amount: '0.00' });
  });
  it('a negative amount -> refused clean. Mutant: sign not checked -> red', async () => {
    const f = await fixture('i4d');
    const s = await supplier(f, 'vat_registered');
    await expectRefusedClean(f, s, { vatType: 'vatable', vatAmount: '-5.00' }, 'vatable with a negative amount');
  });
});

describe('I5 - the typed amount is stored; the exclusive figure is DERIVED, never 12/112 (R3)', () => {
  it('1,120.00 with VAT 100.00 -> exclusive 1020.00, vat_rate null. Mutants: 12/112 recompute stores 120.00; exclusive typed instead of derived -> red', async () => {
    const f = await fixture('i5a');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { totalAmount: '1120.00', vatType: 'vatable', vatAmount: '100.00' });
    expect(await row(id)).toMatchObject({
      vat_type: 'vatable',
      vat_amount: '100.00',
      vat_exclusive_amount: '1020.00',
      vat_rate: null,
      total_amount: '1120.00',
    });
  });
  it('a second, centavo-exact case (no float): 1000.50 with VAT 107.20 -> exclusive 893.30. Mutant: float arithmetic or rounding -> red', async () => {
    const f = await fixture('i5b');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { totalAmount: '1000.50', vatType: 'vatable', vatAmount: '107.20' });
    expect(await row(id)).toMatchObject({ vat_amount: '107.20', vat_exclusive_amount: '893.30', vat_rate: null });
  });
  it('the supplier-default route derives the same way (not a separate code path). Mutant: derivation only on the explicit-type branch -> red', async () => {
    const f = await fixture('i5c');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { totalAmount: '1120.00', vatType: 'supplier_default', vatAmount: '100.00' });
    expect(await row(id)).toMatchObject({ vat_type: 'vatable', vat_amount: '100.00', vat_exclusive_amount: '1020.00', vat_rate: null });
  });
});

describe('I6 - zero_rated stores 0.00 and exclusive = total; exempt takes no amount (R2/R3)', () => {
  it('zero_rated, amount blank -> VAT 0.00, exclusive = total. Mutant: amounts passed through (null / typed) -> red', async () => {
    const f = await fixture('i6a');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { totalAmount: '1120.00', vatType: 'zero_rated' });
    expect(await row(id)).toMatchObject({ vat_type: 'zero_rated', vat_amount: '0.00', vat_exclusive_amount: '1120.00', vat_rate: null });
  });
  it('zero_rated with an explicit 0 -> same row; with a positive amount -> refused clean. Mutant: positive amount accepted -> red', async () => {
    const f = await fixture('i6b');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { vatType: 'zero_rated', vatAmount: '0' });
    expect(await row(id)).toMatchObject({ vat_amount: '0.00', vat_exclusive_amount: '1120.00' });
    await expectRefusedClean(f, s, { vatType: 'zero_rated', vatAmount: '10.00' }, 'zero_rated with a positive amount');
  });
  it('exempt WITH an amount -> refused clean. Mutant: amount passed through -> red', async () => {
    const f = await fixture('i6c');
    const s = await supplier(f, 'vat_registered');
    await expectRefusedClean(f, s, { vatType: 'exempt', vatAmount: '10.00' }, 'exempt with an amount');
  });
  it('exempt without an amount -> stores vat_amount null and exclusive null. Mutant: stores 0.00 -> red', async () => {
    const f = await fixture('i6d');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { vatType: 'exempt' });
    expect(await row(id)).toMatchObject({ vat_type: 'exempt', vat_amount: null, vat_exclusive_amount: null, vat_rate: null });
  });
  it('an amount with NO vat type (null) -> refused clean: a figure with no label is not a record (R2: null type -> amount must be blank). Mutant: any amount accepted when the type is null -> red', async () => {
    const f = await fixture('i6e');
    const s = await supplier(f, 'vat_registered');
    await expectRefusedClean(f, s, { vatAmount: '10.00' }, 'an amount with no type');
  });
});

describe('I7 - a caller-sent exclusive figure that disagrees is refused, not overwritten (R3)', () => {
  it('vatable 1120/100 with vatExclusiveAmount 1000.00 -> refused clean. Mutant: silently overwritten with the derived value -> red', async () => {
    const f = await fixture('i7a');
    const s = await supplier(f, 'vat_registered');
    await expectRefusedClean(
      f,
      s,
      { totalAmount: '1120.00', vatType: 'vatable', vatAmount: '100.00', vatExclusiveAmount: '1000.00' },
      'disagreeing vatExclusiveAmount',
    );
  });
  it('the AGREEING figure (1020.00) is accepted and stored as derived. Mutant: any caller exclusive refused -> red', async () => {
    const f = await fixture('i7b');
    const s = await supplier(f, 'vat_registered');
    const { id } = await record(f, s, { totalAmount: '1120.00', vatType: 'vatable', vatAmount: '100.00', vatExclusiveAmount: '1020.00' });
    expect(await row(id)).toMatchObject({ vat_exclusive_amount: '1020.00' });
  });
});

describe('Controls - a bill with no VAT fields is unaffected (Done-when: existing AP tests unchanged)', () => {
  it('no VAT fields at all: stores exactly as before, and the OR flag still copies the supplier habit', async () => {
    const f = await fixture('c1');
    const yes = await supplier(f, null, true);
    const no = await supplier(f, null, false);
    const a = await record(f, yes, {});
    const b = await record(f, no, {});
    expect(await row(a.id)).toMatchObject({ vat_type: null, vat_amount: null, is_official_receipt: true });
    expect(await row(b.id)).toMatchObject({ vat_type: null, vat_amount: null, is_official_receipt: false });
  });
  it('an explicit isOfficialReceipt overrides the supplier habit both ways (domain level)', async () => {
    const f = await fixture('c2');
    const yes = await supplier(f, null, true);
    const no = await supplier(f, null, false);
    expect((await row((await record(f, yes, { isOfficialReceipt: false })).id)).is_official_receipt).toBe(false);
    expect((await row((await record(f, no, { isOfficialReceipt: true })).id)).is_official_receipt).toBe(true);
  });
});
