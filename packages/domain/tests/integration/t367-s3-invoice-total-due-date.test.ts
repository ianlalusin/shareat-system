import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-367 S3 (DEF-420 total parse · DEF-499 due date from terms · DEF-500 terms CHECK) — the DOMAIN legs.
 * `docs/tasks/367-ap-ar-money.md` §S3, T1–T5 and the staff refusal. (T5's UNIT half — the Drizzle check — is
 * `packages/db/tests/unit/t367-s3-supplier-terms-check.test.ts`.)
 *
 * ⛔ TESTER, not BUILDER. Every red leg asserts the TARGET: a written sentence (the parser's own, no id, never
 * a raw 23514), nothing written, the PARSED value stored, and the due date the supplier's terms give. Each refusal
 * has a positive control that saves.
 *
 * What the spec pins literally: "An invoice total has to be greater than zero." for 0 and -1; "The delivery and
 * other fees can't be more than the invoice total." for fees above the total; "A due date can't be before the
 * invoice date." for an early explicit due date; 2027-03-05 / 2027-02-03 / null for terms 30 / 0 / none. For
 * 'abc' / 'NaN' / '' the spec says "the parser's human sentence"; `parseMoneyInput`'s shape is
 * `The invoice total — "abc" is not a valid amount. …`, so the leg requires that prefix (label "The invoice
 * total"), not the whole text. For the 900.01 / 899.99 line refusals the spec gives no sentence: a written sentence
 * with no id is required.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createSupplier, recordInvoice, setInvoiceLines, lineTotalFromParts } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

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

describe('T1 — an invoice total that is not a number is refused in a plain sentence', () => {
  for (const bad of ['abc', 'NaN', '']) {
    it(`total ${JSON.stringify(bad)} -> a RefusalError with the parser's sentence for "The invoice total" (no id, never a raw 23514); no row — Mutant: Number() back -> a raw 23514 from the DB, red`, async () => {
      const f = await fixture(`t1-${bad || 'blank'}`);
      const refused = await rejection(invoice(f, { totalAmount: bad }), `an invoice with total ${JSON.stringify(bad)}`);
      expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toMatch(/^The invoice total — /);
      expect(refused.userMessage ?? "").not.toMatch(UUID);
      expect(refused.message).not.toMatch(/23514|violates check constraint/);
      expect(await invoiceRows(f.orgId)).toBe(0);
    });
  }

  for (const bad of ['0', '-1']) {
    it(`total "${bad}" -> "An invoice total has to be greater than zero."; no row`, async () => {
      const f = await fixture(`t1-${bad}`);
      const refused = await rejection(invoice(f, { totalAmount: bad }), `an invoice with total ${bad}`);
      expect(refused.userMessage).toBe('An invoice total has to be greater than zero.');
      expect(await invoiceRows(f.orgId)).toBe(0);
    });
  }

  it("positive control: total '1000.00' saves, stored as 1000.00", async () => {
    const f = await fixture('t1-ok');
    const { id } = await invoice(f, { totalAmount: '1000.00' });
    expect((await rowOf(id)).total_amount).toBe('1000.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T2 — the goods total (total − fees) against the lines
// -----------------------------------------------------------------------------------------------

describe('T2 — the goods total is total − delivery − other fees, exactly', () => {
  it('total 1,000.00, delivery 100.00: lines of 900.00 are accepted; lines of 900.01 are refused with a sentence', async () => {
    const f = await fixture('t2a');
    const ok = await invoice(f, { totalAmount: '1000.00', deliveryFee: '100.00', lines: [line(f, '900.00')] });
    expect((await rowOf(ok.id)).delivery_fee).toBe('100.00');

    const before = await invoiceRows(f.orgId);
    const refused = await rejection(invoice(f, { totalAmount: '1000.00', deliveryFee: '100.00', lines: [line(f, '900.01')] }), 'lines that exceed the goods total by a centavo');
    expect(refused.userMessage, `the written sentence is the target; raw: ${refused.message}`).toBe('The lines total ₱900.01, but the invoice says ₱900.00. Either the lines are incomplete or the total is wrong — both are worth fixing before this becomes a price everyone trusts.');
    expect(refused.userMessage ?? "").not.toMatch(UUID);
    expect(await invoiceRows(f.orgId), 'a refused invoice left a row').toBe(before);
  });

  it('exact centavos (builder: integer centavos, not a 0.01 float epsilon): goods 900.00 vs lines 900.01 is refused with a sentence and no row; lines 900.00 is the positive control', async () => {
    const f = await fixture('t2exact');
    const ok = await invoice(f, { totalAmount: '900.00', lines: [line(f, '900.00')], invoiceNo: 'EX-OK' });
    expect((await rowOf(ok.id)).total_amount).toBe('900.00');

    const before = await invoiceRows(f.orgId);
    const refused = await rejection(invoice(f, { totalAmount: '900.00', lines: [line(f, '900.01')], invoiceNo: 'EX-BAD' }), 'lines 900.01 against a goods total of 900.00');
    expect(refused.userMessage, `the written sentence is the target; raw: ${refused.message}`).toBe('The lines total ₱900.01, but the invoice says ₱900.00. Either the lines are incomplete or the total is wrong — both are worth fixing before this becomes a price everyone trusts.');
    expect(refused.userMessage ?? "").not.toMatch(UUID);
    expect(await invoiceRows(f.orgId), 'a refused invoice left a row').toBe(before);
  });

  describe('line level: 3 × 33.3333 (= 99.9999) rounds to a stated line total of 100.00', () => {
    const mkLine = (f: Fixture, lineTotal: string) => ({ itemId: f.itemId, quantity: '3.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '33.3333', lineTotal });

    it('control: a stated line total of 100.00 is accepted and saved', async () => {
      const f = await fixture('t2line-ok');
      const ok = await invoice(f, { totalAmount: '100.00', lines: [mkLine(f, '100.00')], invoiceNo: 'LN-OK' });
      expect((await rowOf(ok.id)).total_amount).toBe('100.00');
    });

    for (const off of ['100.01', '99.99']) {
      it(`a line total of ${off} (off by exactly ₱0.01) is refused with a written sentence and no row; the 100.00 control saves in the same fixture`, async () => {
        const f = await fixture(`t2line-${off}`);
        const ok = await invoice(f, { totalAmount: '100.00', lines: [mkLine(f, '100.00')], invoiceNo: 'LN-OK' });
        expect(ok.id).toBeTruthy();
        const before = await invoiceRows(f.orgId);
        const refused = await rejection(invoice(f, { totalAmount: off, lines: [mkLine(f, off)], invoiceNo: `LN-${off}` }), `a line total of ${off} for 3 × 33.3333`);
        expect(refused.userMessage, `the written sentence is the target; raw: ${refused.message}`).toBe(`Line 1 (Pork Belly) does not add up — 3.000 × ₱33.3333 is ₱100.00, not ₱${off}.`);
        expect(refused.userMessage ?? '').not.toMatch(UUID);
        expect(await invoiceRows(f.orgId), `a line total of ${off} left a row`).toBe(before);
      });
    }
  });

  describe('rounding boundary: quantity × unit price rounds HALF-UP to the centavo', () => {
    // goods = total − delivery: total 1,000.00 with delivery 999.99 leaves goods of 0.01; delivery 1,000.00 leaves 0.00.
    const half = (f: Fixture, unitPrice: string, lineTotal: string) => ({ itemId: f.itemId, quantity: '1.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice, lineTotal });
    it('1 × 0.0050 = 0.005 -> a stated line total of 0.01 is accepted', async () => {
      const f = await fixture('t2r-a');
      const { id } = await invoice(f, { totalAmount: '1000.00', deliveryFee: '999.99', lines: [half(f, '0.0050', '0.01')], invoiceNo: 'RB-1' });
      expect((await rowOf(id)).total_amount).toBe('1000.00');
    });
    it('1 × 0.0050: a stated line total of 0.00 is refused (not rounded down), with the written sentence and no row; the 0.01 control saves', async () => {
      const f = await fixture('t2r-b');
      await invoice(f, { totalAmount: '1000.00', deliveryFee: '999.99', lines: [half(f, '0.0050', '0.01')], invoiceNo: 'RB-OK' });
      const before = await invoiceRows(f.orgId);
      const refused = await rejection(invoice(f, { totalAmount: '1000.00', deliveryFee: '1000.00', lines: [half(f, '0.0050', '0.00')], invoiceNo: 'RB-BAD' }), 'a line total of 0.00 for 1 × 0.0050');
      expect(refused.userMessage, `the written sentence is the target; raw: ${refused.message}`).toBe('Line 1 (Pork Belly) does not add up — 1.000 × ₱0.0050 is ₱0.01, not ₱0.00.');
      expect(await invoiceRows(f.orgId)).toBe(before);
    });
    it('1 × 0.0049 = 0.0049 -> a stated line total of 0.00 is accepted', async () => {
      const f = await fixture('t2r-c');
      const { id } = await invoice(f, { totalAmount: '1000.00', deliveryFee: '1000.00', lines: [half(f, '0.0049', '0.00')], invoiceNo: 'RB-2' });
      expect((await rowOf(id)).delivery_fee).toBe('1000.00');
    });
  });

  it("a non-numeric line total 'abc' is a RefusalError with a plain userMessage (not a bare Error, no id, no function-name prefix); a valid line saves in the same fixture", async () => {
    const f = await fixture('t2abc');
    const ok = await invoice(f, { totalAmount: '100.00', lines: [line(f, '100.00')], invoiceNo: 'AB-OK' });
    expect(ok.id).toBeTruthy();
    const before = await invoiceRows(f.orgId);
    const bad = { itemId: f.itemId, quantity: '1.000', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100.00', lineTotal: 'abc' };
    const refused = await rejection(invoice(f, { totalAmount: '100.00', lines: [bad], invoiceNo: 'AB-BAD' }), "a line total of 'abc'");
    expect({ userMessage: refused.userMessage, raw: refused.message }, `a written refusal naming the line and "abc" is the target; raw: ${refused.message}`).toMatchObject({ userMessage: expect.stringMatching(/Line 1.*abc/) });
    expect(refused.userMessage).not.toMatch(/validateInvoiceLines|NaN/);
    expect(refused.userMessage ?? '').not.toMatch(UUID);
    expect(await invoiceRows(f.orgId)).toBe(before);
  });

  describe('fees are parsed: delivery fee / other fees', () => {
    for (const [field, label, column] of [['deliveryFee', 'The delivery fee', 'delivery_fee'], ['otherFees', 'The other fees', 'other_fees']] as const) {
      for (const bad of ['abc', '-50']) {
        it(`${field} ${JSON.stringify(bad)} on a 1,000.00 invoice -> a RefusalError (userMessage names "${label}"), no row; fee '0' saves in the same fixture`, async () => {
          const f = await fixture(`t2fee-${field}-${bad}`);
          const ok = await invoice(f, { totalAmount: '1000.00', [field]: '0', invoiceNo: 'FEE-OK' });
          expect(ok.id).toBeTruthy();
          const before = await invoiceRows(f.orgId);
          const refused = await rejection(invoice(f, { totalAmount: '1000.00', [field]: bad, invoiceNo: 'FEE-BAD' }), `${field} ${JSON.stringify(bad)}`);
          expect({ userMessage: refused.userMessage, raw: refused.message }, `a written refusal is the target; raw: ${refused.message}`).toMatchObject({ userMessage: expect.stringContaining(label) });
          expect(refused.userMessage ?? '').not.toMatch(UUID);
          expect(await invoiceRows(f.orgId)).toBe(before);
        });
      }
      it(`${field} blank saves as 0.00 (control)`, async () => {
        const f = await fixture(`t2fee-${field}-blank`);
        const { id } = await invoice(f, { totalAmount: '1000.00', [field]: '', invoiceNo: 'FEE-BLANK' });
        const [row] = await sql<{ v: string }[]>`select (${sql(column)})::text as v from supplier_invoices where id = ${id}`;
        expect(row!.v).toBe('0.00');
      });
    }
  });

  describe('UI/domain agreement: lineTotalFromParts(quantity, unitPrice) is the half-up centavo the domain accepts', () => {
    for (const [qty, price, want] of [['1.000', '1.2550', '1.26'], ['2.000', '2.5025', '5.01'], ['3.000', '33.3333', '100.00']] as const) {
      it(`${qty} × ${price} -> "${want}", and recordInvoice (validateInvoiceLines) accepts that line total`, async () => {
        expect(lineTotalFromParts(qty, price)).toBe(want);
        const f = await fixture(`t2h-${price}`);
        const l = { itemId: f.itemId, quantity: qty, purchaseUnit: 'kg', conversionFactor: '1', unitPrice: price, lineTotal: want };
        const { id } = await invoice(f, { totalAmount: want, lines: [l], invoiceNo: 'HLP' });
        expect((await rowOf(id)).total_amount).toBe(want);
      });
    }
  });

  describe("lineTotalFromParts never throws (it runs BEFORE authorize — T-364's authorize-first rule)", () => {
    it("unparseable parts return '' ; an out-of-range product comes back as its digits", () => {
      expect(lineTotalFromParts('abc', '1')).toBe('');
      expect(lineTotalFromParts('1', 'abc')).toBe('');
      let big = '';
      expect(() => { big = lineTotalFromParts('99999999999', '9999999999'); }).not.toThrow();
      expect(big).toMatch(/^\d{13,}\.\d{2}$/);
      expect(lineTotalFromParts('1.000', '1.2550'), 'control: a parseable pair still computes').toBe('1.26');
    });
  });

  it("staff (✗ record_supplier_invoice) + an 'abc' quantity through setInvoiceLines -> AuthorizationError, not the parser's sentence; the manager with the same input gets the parser's sentence", async () => {
    const f = await fixture('t2auth');
    const { id } = await invoice(f, { totalAmount: '1000.00' });
    const bad = [{ itemId: f.itemId, quantity: 'abc', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '10.00', lineTotal: '10.00' }];
    const staffRefused = await rejection(asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, id, bad as never)), "a staff member's setInvoiceLines with quantity 'abc'");
    expect(staffRefused.err, 'authorize() must run before the quantity is parsed').toBeInstanceOf(AuthorizationError);

    const managerRefused = await rejection(asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.manager, id, bad as never)), "a manager's setInvoiceLines with quantity 'abc'");
    expect(managerRefused.err).not.toBeInstanceOf(AuthorizationError);
    expect(managerRefused.userMessage ?? `NO userMessage — raw: ${managerRefused.message}`).toMatch(/Line 1's quantity/);
  });

  it('delivery fee 1,200.00 on a 1,000.00 invoice -> "The delivery and other fees can\'t be more than the invoice total."; no row', async () => {
    const f = await fixture('t2b');
    const refused = await rejection(invoice(f, { totalAmount: '1000.00', deliveryFee: '1200.00' }), 'fees above the total');
    expect(refused.userMessage).toBe("The delivery and other fees can't be more than the invoice total.");
    expect(await invoiceRows(f.orgId)).toBe(0);
  });

  it('setInvoiceLines on the saved invoice: 900.00 accepted, 899.99 refused with a sentence (the lines are untouched by the refusal)', async () => {
    const f = await fixture('t2c');
    const { id } = await invoice(f, { totalAmount: '1000.00', deliveryFee: '100.00' });
    await asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.manager, id, [line(f, '900.00')] as never));
    const kept = (await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoice_lines where supplier_invoice_id = ${id}`)[0]?.n;
    expect(Number(kept)).toBe(1);

    const refused = await rejection(asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.manager, id, [line(f, '899.99')] as never)), 'lines short of the goods total by a centavo');
    expect(refused.userMessage, `the written sentence is the target; raw: ${refused.message}`).toBe('The lines total ₱899.99, but the invoice says ₱900.00. Either the lines are incomplete or the total is wrong — both are worth fixing before this becomes a price everyone trusts.');
    expect(refused.userMessage ?? "").not.toMatch(UUID);
    const amount = (await sql<{ amount: string }[]>`select line_total::text as amount from supplier_invoice_lines where supplier_invoice_id = ${id}`)[0]?.amount;
    expect(amount, 'the refused edit changed the saved line').toBe('900.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T3 / T4 (DEF-499) — the due date follows the supplier's terms, copied at recording time
// -----------------------------------------------------------------------------------------------

describe('T3 — a blank due date follows the supplier\'s terms', () => {
  it('terms 30 + invoice 2027-02-03 + blank due -> 2027-03-05 — Mutant: `?? null` back -> null, red', async () => {
    const f = await fixture('t3a');
    const { id } = await invoice(f, { dueDate: null });
    expect((await rowOf(id)).due_date).toBe('2027-03-05');
    const { id: omitted } = await invoice(f, {}); // dueDate key absent altogether
    expect((await rowOf(omitted)).due_date).toBe('2027-03-05');
  });

  it('terms 0 -> the invoice date itself (2027-02-03)', async () => {
    const f = await fixture('t3b');
    await sql`update suppliers set credit_terms_days = 0 where id = ${f.terms30Id}`;
    const { id } = await invoice(f, { dueDate: null });
    expect((await rowOf(id)).due_date).toBe('2027-02-03');
  });

  it('a cash-on-delivery supplier (no terms) -> null: nothing is guessed', async () => {
    const f = await fixture('t3c');
    const { id } = await invoice(f, { supplierId: f.codId, dueDate: null });
    expect((await rowOf(id)).due_date).toBeNull();
  });

  it('an explicit due date 2027-02-10 is kept; an explicit 2027-02-01 (before the invoice date) is refused "A due date can\'t be before the invoice date." and writes no row', async () => {
    const f = await fixture('t3d');
    const { id } = await invoice(f, { dueDate: '2027-02-10' });
    expect((await rowOf(id)).due_date).toBe('2027-02-10');

    const before = await invoiceRows(f.orgId);
    const refused = await rejection(invoice(f, { dueDate: '2027-02-01' }), 'a due date before the invoice date');
    expect(refused.userMessage).toBe("A due date can't be before the invoice date.");
    expect(await invoiceRows(f.orgId)).toBe(before);
  });

  it("a malformed invoiceDate ('2027-02-30') is refused \"The invoice date isn't a real date.\"; a malformed dueDate \"The due date isn't a real date.\" — no row, never a raw 22008", async () => {
    const f = await fixture('t3e');
    const before = await invoiceRows(f.orgId);
    const badInvoiceDate = await rejection(invoice(f, { invoiceDate: '2027-02-30' }), 'an invoice dated 2027-02-30');
    expect(badInvoiceDate.userMessage ?? `NO userMessage — raw: ${badInvoiceDate.message}`).toBe("The invoice date isn't a real date.");
    expect(badInvoiceDate.message).not.toMatch(/22008|out of range|invalid input syntax for type date/i);
    const badDueDate = await rejection(invoice(f, { dueDate: '2027-02-30' }), 'an invoice with a due date of 2027-02-30');
    expect(badDueDate.userMessage ?? `NO userMessage — raw: ${badDueDate.message}`).toBe("The due date isn't a real date.");
    expect(badDueDate.message).not.toMatch(/22008|out of range|invalid input syntax for type date/i);
    expect(await invoiceRows(f.orgId), 'a malformed date wrote a row').toBe(before);
  });

  it('control: the real dates the other T3 legs use (invoice 2027-02-03, due 2027-02-10) save', async () => {
    const f = await fixture('t3f');
    const { id } = await invoice(f, { invoiceDate: '2027-02-03', dueDate: '2027-02-10' });
    expect((await rowOf(id)).due_date).toBe('2027-02-10');
  });
});

describe('T4 — the due date is COPIED, not read through', () => {
  it('after the bill is saved at 30 days, changing the supplier to 60 days leaves its due date at 2027-03-05', async () => {
    const f = await fixture('t4');
    const { id } = await invoice(f, { dueDate: null });
    expect((await rowOf(id)).due_date).toBe('2027-03-05');
    await sql`update suppliers set credit_terms_days = 60 where id = ${f.terms30Id}`;
    expect((await rowOf(id)).due_date, 'a later terms change rewrote an existing bill').toBe('2027-03-05');
    const { id: later } = await invoice(f, { dueDate: null, invoiceDate: '2027-02-03' });
    expect((await rowOf(later)).due_date, 'a NEW bill uses the new terms').toBe('2027-04-04');
  });
});

// -----------------------------------------------------------------------------------------------
// T5 (DEF-500) — the live constraint
// -----------------------------------------------------------------------------------------------

describe('T5 — suppliers_credit_terms_days_check in the live database', () => {
  it('the live constraint bounds terms to 0..365: 365 is accepted, 366 and -1 are refused (the integration half; the Drizzle half is the unit file)', async () => {
    const f = await fixture('t5');
    const [def] = await sql<{ d: string }[]>`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'suppliers_credit_terms_days_check' and conrelid = 'suppliers'::regclass`;
    expect(def, 'the constraint is not in the database').toBeDefined();
    expect(def!.d).toMatch(/>=\s*0/);
    expect(def!.d).toMatch(/<=\s*365/);

    await sql`update suppliers set credit_terms_days = 365 where id = ${f.terms30Id}`;
    for (const bad of [366, -1]) {
      await expect(sql`update suppliers set credit_terms_days = ${bad} where id = ${f.terms30Id}`).rejects.toMatchObject({ code: '23514' });
    }
    const [row] = await sql<{ n: number }[]>`select credit_terms_days as n from suppliers where id = ${f.terms30Id}`;
    expect(row!.n).toBe(365);
  });
});

// -----------------------------------------------------------------------------------------------
// The refusal — staff cannot record an invoice, and are refused BEFORE any parsing
// -----------------------------------------------------------------------------------------------

describe('Staff are refused before the total is even read (T-364 rule)', () => {
  it("a staff member (✗ record_supplier_invoice) recording a total of 'abc' gets AuthorizationError — not the parser's sentence; the manager control saves", async () => {
    const f = await fixture('staff');
    const refused = await rejection(invoice(f, { totalAmount: 'abc' }, f.staff), 'a staff invoice');
    expect(refused.err, 'authorize() must run before any parse').toBeInstanceOf(AuthorizationError);
    expect(await invoiceRows(f.orgId)).toBe(0);

    const staffValid = await rejection(invoice(f, { totalAmount: '1000.00' }, f.staff), 'a staff invoice with a valid total');
    expect(staffValid.err).toBeInstanceOf(AuthorizationError);

    const control = await invoice(f, { totalAmount: '1000.00' });
    expect(control.id).toBeTruthy();
  });
});
