import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-475 S2 (TESTER) - the domain side of the expense rules: createExpense (E1-E3), editExpense (E4, R12) and approveExpense (P1-P3)
 * refuse when the page is bypassed, with the leaf's sentence. Spec: docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md
 * sections 3.1, 4, 7 S2; amendments R8 (one source of facts and sentences), R12.
 *
 * What is RED on HEAD: E4 (editExpense has no category check at all). E1, E2, E3 and P1 are already refused by the domain today;
 * those legs are GUARDS (they must stay green and byte-identical when the sentences move into the leaf) - the red half for them is
 * the page (integration/t475-s2-expense-pages.test.ts) and the leaf (apps/erp/tests/t475-s2-expense-rules.test.ts).
 *
 * MUTANTS: E1 `>=` for `>` (an amount equal to the room refused, or one centavo over allowed); the E3 / E2 sentence edited in one place
 * only; the E4 check removed; the E4 check refusing ANY edit of a draft that already sits on an unmapped category (R12: recurring
 * drafts do - findings.ts:2050); the E4 check refusing the SAME unmapped category being re-posted (the edit form always posts it);
 * the domain pre-check and the repo backstop (`assertOpenForRecording`) giving different sentences.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { apRepo, closeDb } from '@shareat/db';
import { createExpense, editExpense } from '@shareat/domain';
import { capacityRefusal } from '../../src/business-rules';
import { cashOnDeliverySentence } from '../../src/shared/money-lines';
import { ap475Fixture, asOrg, type Fixture } from './_fixtures/t475-ap';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const E4 = "This category has no ledger account yet, so the draft can't post. Pick another category.";

/** The sentence a refusal carries (what a person reads), or null when it did not refuse. A non-refusal throw is surfaced as RAW. */
async function sentenceOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? `RAW: ${(err as Error).message}`;
  }
}
const create = (f: Fixture, invoiceId: string, o: { supplierId?: string; amount: string; method?: 'cash' | 'credit'; categoryId?: string }) =>
  asOrg(f.orgId, (tx) =>
    createExpense(tx, f.admin, {
      storeId: f.storeId,
      supplierId: o.supplierId ?? f.supplierId,
      supplierInvoiceId: invoiceId,
      businessDate: '2026-01-10',
      categoryId: o.categoryId ?? f.categoryId,
      particulars: 'T-475 S2',
      payments: [o.method === 'credit' ? { method: 'credit', amount: o.amount } : { method: 'cash', amount: o.amount, moneyAccountId: f.cashId }],
    }),
  );
const rowsFor = async (invoiceId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceId}`)[0]!.n);
const capacity = (f: Fixture, invoiceId: string) => asOrg(f.orgId, (tx) => apRepo.capacityOf(tx, f.orgId, invoiceId));
const categoryOf = async (id: string) => (await sql<{ category_id: string }[]>`select category_id from expenses where id = ${id}`)[0]!.category_id;

describe('T-475 S2 / E1 - an amount over the invoice\'s room', () => {
  it('equal to the room passes, one centavo over is refused with the leaf\'s capacity sentence, and nothing is written (mutant: `>=`)', async () => {
    const f = await ap475Fixture(sql, 'e1');
    const inv = await f.invoice({ total: '5000.00', status: 'verified' });
    await f.draft(inv, { amount: '100.00' }); // 4900.00 left
    const row = (await capacity(f, inv))!;
    expect(row.remaining, 'fixture: 4900.00 is left').toBe('4900.00');

    const before = await rowsFor(inv);
    const over = await sentenceOf(() => create(f, inv, { amount: '4900.01' }));
    expect(over, 'one centavo over the room must be refused').not.toBeNull();
    expect(over).toBe(capacityRefusal(row, '4900.01', 'draft')!.sentence);
    expect(over).toMatch(/has only ₱4900\.00 left of ₱5000\.00; ₱4900\.01 doesn't fit\.$/);
    expect(await rowsFor(inv), 'refused: nothing written').toBe(before);

    expect(await sentenceOf(() => create(f, inv, { amount: '4900.00' })), 'equal to the room passes').toBeNull();
    expect(await rowsFor(inv)).toBe(before + 1);
  });

  it('the domain pre-check and the repo backstop say the same words for the same case (R8 parity: assertOpenForRecording vs the leaf)', async () => {
    const f = await ap475Fixture(sql, 'e1b');
    const pending = await f.invoice({ total: '1000.00', status: 'pending' });
    const rowP = (await capacity(f, pending))!;
    const backstopFit = await sentenceOf(() => asOrg(f.orgId, (tx) => apRepo.assertOpenForRecording(tx, f.orgId, pending, '1000.01' as never, 'draft')));
    expect(backstopFit).toBe(capacityRefusal(rowP, '1000.01', 'draft')!.sentence);
    const backstopPending = await sentenceOf(() => asOrg(f.orgId, (tx) => apRepo.assertOpenForRecording(tx, f.orgId, pending, '10.00' as never, 'posted')));
    expect(backstopPending).toBe(capacityRefusal(rowP, '10.00', 'posted')!.sentence);
  });
});

describe('T-475 S2 / E2 - a credit line on a cash-on-delivery supplier', () => {
  it('refused with cashOnDeliverySentence(name) and nothing written; the same credit line on a terms supplier is saved (positive control)', async () => {
    const f = await ap475Fixture(sql, 'e2');
    const cod = await f.supplier({ name: 'Cash Only Co', creditTermsDays: null });
    const terms = await f.supplier({ name: 'Terms Co', creditTermsDays: 30 });
    const codInv = await f.invoice({ supplierId: cod, status: 'verified' });
    const termsInv = await f.invoice({ supplierId: terms, status: 'verified' });

    const before = await rowsFor(codInv);
    const refused = await sentenceOf(() => create(f, codInv, { supplierId: cod, amount: '500.00', method: 'credit' }));
    expect(refused).toBe(cashOnDeliverySentence('Cash Only Co'));
    expect(refused).toBe('Cash Only Co is cash-on-delivery. Set payment terms on the supplier to pay on credit.');
    expect(await rowsFor(codInv)).toBe(before);

    expect(await sentenceOf(() => create(f, codInv, { supplierId: cod, amount: '500.00', method: 'cash' })), 'cash on a COD supplier is fine').toBeNull();
    expect(await sentenceOf(() => create(f, termsInv, { supplierId: terms, amount: '500.00', method: 'credit' })), 'credit on a terms supplier is fine').toBeNull();
  });
});

describe('T-475 S2 / E3 - the invoice\'s supplier must be active', () => {
  it('an invoice of an inactive supplier is refused with the exact sentence and nothing written; an active supplier is saved (positive control)', async () => {
    const f = await ap475Fixture(sql, 'e3');
    const dormant = await f.supplier({ name: 'Dormant Co', status: 'inactive' });
    const inv = await f.invoice({ supplierId: dormant, status: 'verified' });
    const before = await rowsFor(inv);
    const refused = await sentenceOf(() => create(f, inv, { supplierId: dormant, amount: '100.00' }));
    expect(refused).toBe('Dormant Co is inactive, not active — an expense cannot be recorded against a supplier the business has stopped buying from.');
    expect(await rowsFor(inv)).toBe(before);

    const okInv = await f.invoice({ status: 'verified' });
    expect(await sentenceOf(() => create(f, okInv, { amount: '100.00' }))).toBeNull();
  });
});

describe('T-475 S2 / E4 + R12 - editExpense and a category with no ledger account', () => {
  it('a CHANGE onto an unmapped category is refused with the exact sentence and the category does not move; a change onto a mapped one works (mutant: check removed)', async () => {
    const f = await ap475Fixture(sql, 'e4');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv);
    const unmapped = await f.unmappedCategory();
    const other = (await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and account_code is not null and id <> ${f.categoryId} limit 1`)[0]!.id;

    const refused = await sentenceOf(() => asOrg(f.orgId, (tx) => editExpense(tx, f.admin, id, { categoryId: unmapped })));
    expect(refused, 'editExpense must refuse a change onto an unmapped category').toBe(E4);
    expect(await categoryOf(id), 'refused: the draft stays where it was').toBe(f.categoryId);

    expect(await sentenceOf(() => asOrg(f.orgId, (tx) => editExpense(tx, f.admin, id, { categoryId: other })))).toBeNull();
    expect(await categoryOf(id)).toBe(other);
  });

  it('R12: a draft that already sits on an unmapped category can still be edited in particulars, and re-posting the SAME category is allowed (mutant: refuse any edit of such a draft)', async () => {
    const f = await ap475Fixture(sql, 'r12');
    const inv = await f.invoice({ status: 'verified' });
    const unmapped = await f.unmappedCategory();
    const id = await f.draft(inv, { categoryId: unmapped });

    // the edit form always posts the category along with the particulars
    expect(await sentenceOf(() => asOrg(f.orgId, (tx) => editExpense(tx, f.admin, id, { particulars: 'Corrected particulars' })))).toBeNull();
    expect(await sentenceOf(() => asOrg(f.orgId, (tx) => editExpense(tx, f.admin, id, { categoryId: unmapped, particulars: 'Corrected again' })))).toBeNull();
    const [row] = await sql<{ particulars: string }[]>`select particulars from expenses where id = ${id}`;
    expect(row!.particulars).toBe('Corrected again');
  });

  it('R12: moving that draft from one unmapped category to ANOTHER unmapped one is a change and is refused; moving it onto a mapped one is allowed', async () => {
    const f = await ap475Fixture(sql, 'r12b');
    const inv = await f.invoice({ status: 'verified' });
    const unmappedA = await f.unmappedCategory();
    const unmappedB = await f.unmappedCategory();
    const id = await f.draft(inv, { categoryId: unmappedA });
    expect(await sentenceOf(() => asOrg(f.orgId, (tx) => editExpense(tx, f.admin, id, { categoryId: unmappedB })))).toBe(E4);
    expect(await categoryOf(id)).toBe(unmappedA);
    expect(await sentenceOf(() => asOrg(f.orgId, (tx) => editExpense(tx, f.admin, id, { categoryId: f.categoryId })))).toBeNull();
    expect(await categoryOf(id)).toBe(f.categoryId);
  });

  it('the draft that sits on an unmapped category is still refused when it is APPROVED (P3 stays the backstop)', async () => {
    const f = await ap475Fixture(sql, 'r12c');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv, { categoryId: await f.unmappedCategory() });
    const { approveExpense } = await import('@shareat/domain');
    const refused = await sentenceOf(() => asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, id)));
    expect(refused).not.toBeNull();
    expect(refused).not.toMatch(/^RAW:/);
    const [row] = await sql<{ status: string }[]>`select status from expenses where id = ${id}`;
    expect(row!.status).toBe('draft');
  });
});

describe('T-475 S2 / P1 - approving a draft whose invoice is still pending', () => {
  it('refused with the "hasn\'t been verified yet" sentence and the draft stays a draft; once the invoice is verified it posts (positive control)', async () => {
    const f = await ap475Fixture(sql, 'p1');
    const inv = await f.invoice({ status: 'pending' });
    const id = await f.draft(inv);
    const { approveExpense } = await import('@shareat/domain');
    const refused = await sentenceOf(() => asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, id)));
    expect(refused).toMatch(/hasn't been verified yet, so this can't post against it\.$/);
    expect((await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status).toBe('draft');

    await sql`update supplier_invoices set status = 'verified', verified_by = ${f.verifierId}, verified_at = now(),
                attested_supplier = true, attested_invoice = true, attested_items = true, attested_price = true where id = ${inv}`;
    expect(await sentenceOf(() => asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, id)))).toBeNull();
    expect((await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status).toBe('posted');
  });
});
