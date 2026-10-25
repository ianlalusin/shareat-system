import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-475 S1 (TESTER) - parity: the live check and the server refusal are the SAME rule and the SAME sentence
 * (spec 3.1 "one source", 7 S1 "every leaf check's sentence equals the domain refusal's userMessage for the same case").
 *
 * For each case the test builds the facts a page would give the leaf, asks the leaf (BUSINESS_CHECKS[id].run), then drives the
 * REAL domain function with the same values (as if the client were bypassed) and asserts:
 *   refusal.userMessage === verdict.sentence      (client === server)
 * and that the refused call wrote nothing. A clean control per family proves the call itself is valid, so a refusal means the
 * rule fired.
 *
 * Ids and fact shapes are the ones pinned in t475-s1-business-rules.test.ts (its ADAPTER table).
 *
 * MUTANTS: a sentence edited in the leaf only, or in the domain only; the domain keeping its own inline copy that drifts;
 * a rule the leaf has but the server does not enforce (client blocks, server accepts) or the reverse; the V5 sentence on the
 * server missing the "This invoice can't be verified yet: ..." frame; the duplicate warning dropped or turned into a refusal.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { recordInvoice, verifyInvoice } from '@shareat/domain';
import * as leaf from '../../../../packages/domain/src/business-rules';
import * as approveModule from '../../../../packages/domain/src/expenses/approve';
import { ap475Fixture, asOrg, type Fixture } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Verdict = null | { level: 'block' | 'warn'; sentence: string };
const REGISTRY = (leaf as unknown as { BUSINESS_CHECKS: Record<string, { run(facts: unknown, values: Record<string, string>): Verdict }> }).BUSINESS_CHECKS;
const ask = (id: string, facts: unknown, values: Record<string, string>) => REGISTRY[id]!.run(facts, values);

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? `RAW: ${(err as Error).message}`;
  }
}
const invoiceCount = async (f: Fixture) => Number((await sql<{ n: string }[]>`select count(*)::text as n from supplier_invoices where org_id = ${f.orgId}`)[0]!.n);

async function supplierFacts(f: Fixture, id: string) {
  const [s] = await sql<{ name: string; status: string; vat_status: string | null }[]>`select name, status, vat_status from suppliers where id = ${id}`;
  return { suppliers: { [id]: { name: s!.name, status: s!.status, vatStatus: s!.vat_status } } };
}

const BASE = { invoiceDate: '2026-01-10', totalAmount: '1000.00' };
const log = (f: Fixture, supplierId: string, extra: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) => recordInvoice(tx, f.admin, { storeId: f.storeId, supplierId, ...BASE, ...extra } as never));

describe('T-475 S1 - log invoice: leaf sentence === recordInvoice refusal', () => {
  it('control: a clean invoice is accepted and the leaf says nothing', async () => {
    const f = await ap475Fixture(sql, 'logclean');
    const s = await f.supplier();
    for (const id of ['ap.invoice.supplierActive', 'ap.invoice.dueNotBeforeInvoice', 'ap.invoice.feesNotOverTotal'])
      expect(ask(id, await supplierFacts(f, s), { supplierId: s, ...BASE, dueDate: '2026-01-20', deliveryFee: '10', otherFees: '' })).toBeNull();
    expect(await refusal(() => log(f, s, { dueDate: '2026-01-20', deliveryFee: '10' }))).toBeNull();
  });

  it('A1 inactive supplier', async () => {
    const f = await ap475Fixture(sql, 'a1');
    const s = await f.supplier({ status: 'inactive' });
    const v = ask('ap.invoice.supplierActive', await supplierFacts(f, s), { supplierId: s })!;
    const before = await invoiceCount(f);
    expect(await refusal(() => log(f, s))).toBe(v.sentence);
    expect(await invoiceCount(f)).toBe(before);
  });

  it('A2 due date before the invoice date; the equal date is accepted by both', async () => {
    const f = await ap475Fixture(sql, 'a2');
    const s = await f.supplier();
    const v = ask('ap.invoice.dueNotBeforeInvoice', {}, { invoiceDate: '2026-01-10', dueDate: '2026-01-09' })!;
    expect(await refusal(() => log(f, s, { dueDate: '2026-01-09' }))).toBe(v.sentence);
    expect(ask('ap.invoice.dueNotBeforeInvoice', {}, { invoiceDate: '2026-01-10', dueDate: '2026-01-10' })).toBeNull();
    expect(await refusal(() => log(f, s, { dueDate: '2026-01-10' }))).toBeNull();
  });

  it('A3 fees over the total; fees equal to the total are accepted by both', async () => {
    const f = await ap475Fixture(sql, 'a3');
    const s = await f.supplier();
    const over = { totalAmount: '1000.00', deliveryFee: '600.00', otherFees: '400.01' };
    const v = ask('ap.invoice.feesNotOverTotal', {}, over)!;
    expect(await refusal(() => log(f, s, over))).toBe(v.sentence);
    const equal = { totalAmount: '1000.00', deliveryFee: '600.00', otherFees: '400.00' };
    expect(ask('ap.invoice.feesNotOverTotal', {}, equal)).toBeNull();
    expect(await refusal(() => log(f, s, equal))).toBeNull();
  });

  it('A4 the VAT family: every branch the leaf blocks the server refuses with the same words, and every branch it passes the server accepts', async () => {
    const f = await ap475Fixture(sql, 'a4');
    const reg = await f.supplier({ vatStatus: 'vat_registered', name: 'Registered Co' });
    const non = await f.supplier({ vatStatus: 'non_vat', name: 'Plain Co' });
    const unset = await f.supplier({ vatStatus: null, name: 'Unset Co' });
    const cases: Array<[string, string, Record<string, string>]> = [
      ['non-VAT, explicit vatable', non, { vatType: 'vatable', vatAmount: '' }],
      ['non-VAT, zero-rated', non, { vatType: 'zero_rated', vatAmount: '' }],
      ['non-VAT, amount typed', non, { vatType: 'exempt', vatAmount: '5.00' }],
      ['non-VAT, default + amount', non, { vatType: 'supplier_default', vatAmount: '5.00' }],
      ['registered, default, no amount', reg, { vatType: 'supplier_default', vatAmount: '' }],
      ['vatable, zero amount', reg, { vatType: 'vatable', vatAmount: '0' }],
      ['vatable, over the total', reg, { vatType: 'vatable', vatAmount: '1000.01' }],
      ['zero-rated with an amount', reg, { vatType: 'zero_rated', vatAmount: '5.00' }],
      ['exempt with an amount', reg, { vatType: 'exempt', vatAmount: '5.00' }],
      ['unset supplier, default, amount', unset, { vatType: 'supplier_default', vatAmount: '5.00' }],
      // passes
      ['registered, vatable equal to total', reg, { vatType: 'vatable', vatAmount: '1000.00' }],
      ['registered, zero-rated, 0', reg, { vatType: 'zero_rated', vatAmount: '0' }],
      ['non-VAT, default, none', non, { vatType: 'supplier_default', vatAmount: '' }],
      ['unset, default, none', unset, { vatType: 'supplier_default', vatAmount: '' }],
    ];
    for (const [label, supplierId, vat] of cases) {
      const values = { supplierId, totalAmount: BASE.totalAmount, ...vat };
      const v = ask('ap.invoice.vat', await supplierFacts(f, supplierId), values);
      const server = await refusal(() => log(f, supplierId, { vatType: vat.vatType, vatAmount: vat.vatAmount || null }));
      expect(server, label).toBe(v ? v.sentence : null);
    }
  });
});

describe('T-475 S1 - a repeated invoice number WARNS (Q1 A): the leaf warns, the server still saves', () => {
  it('recordInvoice saves, returns a duplicateWarning that carries the leaf sentence body plus the "Saved anyway" suffix', async () => {
    const f = await ap475Fixture(sql, 'dup');
    const s = await f.supplier({ name: 'Dup Co' });
    const first = await log(f, s, { invoiceNo: 'INV-7' });
    expect(first.duplicateWarning).toBeUndefined();
    const [row] = await sql<{ invoice_date: string; total_amount: string }[]>`select invoice_date::text, total_amount::text from supplier_invoices where id = ${first.id}`;
    const v = ask(
      'ap.invoice.duplicateNumber',
      { supplierName: 'Dup Co', invoiceNo: 'INV-7', matches: [{ invoiceDate: row!.invoice_date, totalAmount: row!.total_amount }] },
      { invoiceNo: 'INV-7' },
    )!;
    expect(v.level).toBe('warn');
    const before = await invoiceCount(f);
    const second = await log(f, s, { invoiceNo: 'INV-7' });
    expect(await invoiceCount(f)).toBe(before + 1); // saved anyway: never a block
    const body = v.sentence.replace(/ Check it is not the same bill twice\.$/, '');
    expect(second.duplicateWarning).toContain(body);
    expect(second.duplicateWarning).toContain('Saved anyway');
  });
});

describe('T-475 S1 - verify: leaf sentence === verifyInvoice refusal', () => {
  const T4 = { supplier: true, invoice: true, items: true, price: true };
  const verify = (f: Fixture, id: string, attest = T4, options?: unknown) =>
    asOrg(f.orgId, (tx) => verifyInvoice(tx, f.verifier, id, attest, options as never));
  const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from supplier_invoices where id = ${id}`)[0]!.status;

  it('control: a clean pending invoice verifies', async () => {
    const f = await ap475Fixture(sql, 'vclean');
    const inv = await f.invoice();
    expect(await refusal(() => verify(f, inv))).toBeNull();
    expect(await statusOf(inv)).toBe('verified');
  });

  it("V1 (kept today, S3 adds the exemption): a manager who logged the invoice cannot verify it; the sentence is the 'Verification is a second pair of eyes' one", async () => {
    const f = await ap475Fixture(sql, 'v1');
    const inv = await f.invoice({ createdBy: f.managerId });
    const msg = await refusal(() => asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, inv, T4)));
    const v = ask('ap.verify.selfVerify', { createdByViewer: true }, {})!;
    expect(v.level).toBe('block');
    expect(msg).toBe(v.sentence);
    expect(ask('ap.verify.selfVerify', { createdByViewer: false }, {})).toBeNull();
    expect(await statusOf(inv)).toBe('pending');
  });

  it('V2 each missing tick, and several: same sentence; the invoice stays pending', async () => {
    const f = await ap475Fixture(sql, 'v2');
    const inv = await f.invoice();
    const FORM = { supplier: 'attestSupplier', invoice: 'attestInvoice', items: 'attestItems', price: 'attestPrice' } as const;
    const subsets: Array<Array<keyof typeof FORM>> = [['supplier'], ['invoice'], ['items'], ['price'], ['items', 'price'], ['supplier', 'invoice', 'items'], ['supplier', 'invoice', 'items', 'price']];
    for (const missing of subsets) {
      const attest = { ...T4 };
      const values: Record<string, string> = { attestSupplier: 'on', attestInvoice: 'on', attestItems: 'on', attestPrice: 'on' };
      for (const m of missing) {
        attest[m] = false;
        delete values[FORM[m]];
      }
      const v = ask('ap.verify.attestation', {}, values)!;
      expect(await refusal(() => verify(f, inv, attest)), missing.join('+')).toBe(v.sentence);
    }
    expect(await statusOf(inv)).toBe('pending');
  });

  it('V3 inactive supplier', async () => {
    const f = await ap475Fixture(sql, 'v3');
    const s = await f.supplier({ status: 'inactive', name: 'Gone Co' });
    const inv = await f.invoice({ supplierId: s });
    const v = ask('ap.verify.supplierActive', { supplier: { name: 'Gone Co', status: 'inactive' } }, {})!;
    expect(await refusal(() => verify(f, inv))).toBe(v.sentence);
    expect(await statusOf(inv)).toBe('pending');
  });

  it('V4 no receipt photo / a receipt from another store', async () => {
    const f = await ap475Fixture(sql, 'v4');
    const none = await f.invoice({ receiptFileId: null });
    const vNone = ask('ap.verify.receiptPhoto', { isCommissaryMirror: false, receiptFileId: null, file: null, invoiceStoreId: f.storeId }, {})!;
    expect(await refusal(() => verify(f, none))).toBe(vNone.sentence);
    const foreignFile = await f.file(f.store2Id);
    const foreign = await f.invoice({ receiptFileId: foreignFile });
    const vForeign = ask('ap.verify.receiptPhoto', { isCommissaryMirror: false, receiptFileId: foreignFile, file: { storeId: f.store2Id }, invoiceStoreId: f.storeId }, {})!;
    expect(await refusal(() => verify(f, foreign))).toBe(vForeign.sentence);
    expect(await statusOf(none)).toBe('pending');
    expect(await statusOf(foreign)).toBe('pending');
  });

  it('V5 a draft that would not post (unmapped category): the leaf, fed the approval evaluator, gives the verifyInvoice sentence, and the invoice stays pending with the draft a draft', async () => {
    const f = await ap475Fixture(sql, 'v5');
    const inv = await f.invoice();
    const particulars = 'Mystery pork';
    const d = await f.draft(inv, { categoryId: await f.unmappedCategory(), particulars });
    const mod = approveModule as unknown as {
      gatherApprovalFacts(tx: unknown, actor: unknown, id: string, o: { lock: boolean }): Promise<unknown>;
      approvalVerdict(facts: unknown, o?: { invoiceVerifiedInThisTx?: boolean }): null | { sentence: string };
    };
    const verdict = await asOrg(f.orgId, async (tx) => mod.approvalVerdict(await mod.gatherApprovalFacts(tx, f.verifier, d, { lock: false }), { invoiceVerifiedInThisTx: true }));
    expect(verdict, 'the evaluator found nothing wrong with an unmapped draft').not.toBeNull();
    const v = ask('ap.verify.draftsWouldPost', { drafts: [{ particulars, sentence: verdict!.sentence, liftable: false }] }, {})!;
    expect(v.sentence).toBe(`This invoice can't be verified yet: "${particulars}" — ${verdict!.sentence}`);
    expect(await refusal(() => verify(f, inv))).toBe(v.sentence);
    // the whole sentence, frame included (mutant: frame reworded)
    expect(await refusal(() => verify(f, inv))).toBe(`This invoice can't be verified yet: "${particulars}" — ${verdict!.sentence}`);
    expect(await statusOf(inv)).toBe('pending');
    expect((await sql<{ status: string }[]>`select status from expenses where id = ${d}`)[0]!.status).toBe('draft');
  });

  it('V5 a CLOSED month: refused without the override with the same sentence; the leaf lifts it when the override is ticked, and the server then verifies', async () => {
    const f = await ap475Fixture(sql, 'v5c');
    const inv = await f.invoice({ on: '2026-01-10' });
    const d = await f.draft(inv, { on: '2026-01-10', particulars: 'January pork' });
    await f.setPeriod('2026-01-01', 'closed');
    const mod = approveModule as unknown as {
      gatherApprovalFacts(tx: unknown, actor: unknown, id: string, o: { lock: boolean }): Promise<unknown>;
      approvalVerdict(facts: unknown, o?: { invoiceVerifiedInThisTx?: boolean }): null | { sentence: string };
    };
    const verdict = await asOrg(f.orgId, async (tx) => mod.approvalVerdict(await mod.gatherApprovalFacts(tx, f.verifier, d, { lock: false }), { invoiceVerifiedInThisTx: true }));
    const facts = { drafts: [{ particulars: 'January pork', sentence: verdict!.sentence, liftable: true }] };
    const v = ask('ap.verify.draftsWouldPost', facts, {})!;
    expect(await refusal(() => verify(f, inv))).toBe(v.sentence);
    expect(ask('ap.verify.draftsWouldPost', facts, { periodOverrideConfirm: 'on' })).toBeNull();
    expect(await refusal(() => verify(f, inv, T4, { periodOverride: { reason: 'late_supplier_invoice', note: null } }))).toBeNull();
    expect(await statusOf(inv)).toBe('verified');
  });
});
