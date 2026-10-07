import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-379 S3b (DEF-568) — the refusal sentences print money the way the screen does: grouped pesos for the
 * pesos figures, the unit price's decimals untouched. `docs/tasks/379-erp-small-follow-ups.md` S3b, P1-P5.
 *
 * TESTER only. Fixture and helpers from `t367-s3-invoice-total-due-date.test.ts`. Every leg asserts the
 * TARGET sentence on both the raw `message` and the `userMessage`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, setInvoiceLines } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

/** One org/store; a manager; a floor staff member with NO position grant (so ✗ record_supplier_invoice); a 30-day supplier,
 * a cash-on-delivery supplier and one raw-material item for invoice lines. */
async function fixture(hint: string) {
  const code = uid(`t367s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  const staffId = await mk('Floor Staff', 'staff');
  const manager = actor(orgId, managerId);
  const terms30 = await asOrg(orgId, (tx) => createSupplier(tx, manager, { name: 'Thirty Day Supplier', creditTermsDays: 30 }));
  const cod = await asOrg(orgId, (tx) => createSupplier(tx, manager, { name: 'COD Supplier' }));
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${uid('ITEM')}, 'Pork Belly', 'raw_material', 'kg', ${managerId}) returning id`;
  return { orgId, storeId, manager, staff: actor(orgId, staffId), terms30Id: terms30.id, codId: cod.id, itemId: item!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const invoice = (f: Fixture, over: Record<string, unknown> = {}, who: Actor = f.manager) =>
  asOrg(f.orgId, (tx) => recordInvoice(tx, who, { storeId: f.storeId, supplierId: f.terms30Id, invoiceDate: '2027-02-03', totalAmount: '1000.00', ...over } as never));
const line = (f: Fixture, amount: string) => ({ itemId: f.itemId, quantity: '1.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: amount, lineTotal: amount });
const invoiceRows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoices where org_id = ${orgId}`)[0]!.n);
const rowOf = async (id: string) => (await sql<{ total_amount: string; delivery_fee: string; due_date: string | null }[]>`
  select total_amount::text, delivery_fee::text, due_date::text from supplier_invoices where id = ${id}`)[0]!;

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED — ${what} was saved instead (the defect this leg targets)`);
}

// -----------------------------------------------------------------------------------------------
// T1 (DEF-420) — the total is parsed, in words
// -----------------------------------------------------------------------------------------------


const TAIL = ' Either the lines are incomplete or the total is wrong — both are worth fixing before this becomes a price everyone trusts.';
const one = (f: Fixture, quantity: string, unitPrice: string, lineTotal: string) => ({ itemId: f.itemId, quantity, purchaseUnit: 'kg', conversionFactor: '1', unitPrice, lineTotal });

describe('T-379 S3b — refusal sentences group the pesos (DEF-568)', () => {
  it('P1 — lines ₱1,234,567.89 against a total of ₱1,234,567.90. Mutant: group only `pesos`, not the box-text goods figure -> the goods leg red; keep "but the invoice says" -> red', async () => {
    const f = await fixture('p1');
    const refused = await rejection(invoice(f, { totalAmount: '1234567.90', lines: [one(f, '1', '1234567.89', '1234567.89')] }), 'lines one centavo short of a seven-figure total');
    const want = `The lines total ₱1,234,567.89, but the goods on this bill come to ₱1,234,567.90.${TAIL}`;
    expect(refused.userMessage, `raw: ${refused.message}`).toBe(want);
    expect(refused.message).toBe(`validateInvoiceLines: ${want.replace('The lines', 'the lines')}`);
    expect(await invoiceRows(f.orgId)).toBe(0);
  });

  it('P1b (REV-5) — a ₱10,500 bill with a ₱500 fee: setInvoiceLines of ₱10,500 says the GOODS come to ₱10,000.00, not "the invoice says". Mutant: keep "the invoice says" -> red', async () => {
    const f = await fixture('p1b');
    const { id } = await invoice(f, { totalAmount: '10500.00', deliveryFee: '500.00' });
    const refused = await rejection(asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.manager, id, [line(f, '10500.00')] as never)), 'lines equal to the total on a bill with a fee');
    expect(refused.userMessage, `raw: ${refused.message}`).toBe(`The lines total ₱10,500.00, but the goods on this bill come to ₱10,000.00.${TAIL}`);
    expect((await sql`select 1 from supplier_invoice_lines where supplier_invoice_id = ${id}`).length, 'the refusal wrote a line').toBe(0);
  });

  it('P2 — 10 × 1234.5 stated 12345.01: the pesos group, the unit price keeps its own digits. Mutant: group the unit price decimals / skip grouping the computed figure -> red', async () => {
    const f = await fixture('p2');
    const refused = await rejection(invoice(f, { totalAmount: '12345.01', lines: [one(f, '10', '1234.5', '12345.01')] }), 'a line whose stated total is a centavo off');
    expect(refused.userMessage, `raw: ${refused.message}`).toBe('Line 1 (Pork Belly) does not add up — 10 × ₱1,234.5 is ₱12,345.00, not ₱12,345.01.');
    expect(refused.message).toContain('10 × ₱1,234.5 is ₱12,345.00, not ₱12,345.01.');
  });

  it('P3 (REV-4) — two lines of 10 × 9999999999.999 against a total one centavo high: prints ₱199,999,999,999.98 and ₱199,999,999,999.99, nothing else throws. Mutant: Number()/float for the sum -> the .98 figure wrong', async () => {
    const f = await fixture('p3');
    const big = one(f, '10', '9999999999.999', '99999999999.99');
    const refused = await rejection(invoice(f, { totalAmount: '199999999999.99', lines: [big, { ...big }] }), 'two huge lines');
    expect(refused.userMessage, `raw: ${refused.message}`).toBe(`The lines total ₱199,999,999,999.98, but the goods on this bill come to ₱199,999,999,999.99.${TAIL}`);
  });

  it('P5 (control) — the unit price keeps its decimals ungrouped and unrounded (₱33.3333, ₱0.0050); a matching bill saves. Mutant: formatMoney/Number for the unit price -> ₱0.0050 becomes ₱0.01, red', async () => {
    const f = await fixture('p5');
    const a = await rejection(invoice(f, { totalAmount: '100.01', lines: [one(f, '3.000', '33.3333', '100.01')] }), 'a 3 × 33.3333 line stated 100.01');
    expect(a.userMessage).toBe('Line 1 (Pork Belly) does not add up — 3.000 × ₱33.3333 is ₱100.00, not ₱100.01.');
    const b = await rejection(invoice(f, { totalAmount: '1000.00', deliveryFee: '1000.00', lines: [one(f, '1.000', '0.0050', '0.00')] }), 'a 1 × 0.0050 line stated 0.00');
    expect(b.userMessage).toContain('1.000 × ₱0.0050 is ₱0.01, not ₱0.00.');
    const ok = await invoice(f, { totalAmount: '1234567.89', lines: [one(f, '1', '1234567.89', '1234567.89')] });
    expect((await rowOf(ok.id)).total_amount).toBe('1234567.89');
  });
});
