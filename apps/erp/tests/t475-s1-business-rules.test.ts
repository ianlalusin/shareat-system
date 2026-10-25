/**
 * T-475 S1 (TESTER) - the business-rule leaf `@shareat/domain/business-rules`: checks A1-A5 (log invoice) and V2-V5 (verify).
 * Spec: docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md sections 3.1, 4, 7 S1. Node, no database.
 *
 * ASSUMED CONTRACT (the spec fixes the shape, not the ids or the facts; edit the ONE table below if the builder names them
 * differently - nothing else in this file hard-codes a name):
 *   BUSINESS_CHECKS[id].run(facts, values) -> null | { level: 'block' | 'warn', sentence }
 *   `values` = the form control names -> typed strings (storeId, supplierId, invoiceNo, invoiceDate, dueDate, totalAmount,
 *   deliveryFee, otherFees, vatType, vatAmount; verify form: attestSupplier/attestInvoice/attestItems/attestPrice = 'on' | absent,
 *   periodOverrideConfirm = 'on' | absent).
 *   facts are plain JSON: see the FACT_* builders.
 *
 * MUTANTS killed (named per test): `<=` for `<` on the due date; `>=` for `>` on fees; a VAT branch dropped or re-ordered;
 * `some` for `every` on the four ticks; a warn treated as a block; a verdict computed from a stale lookup; a check that reads a
 * control it does not list in `watch`; a sentence edited in the leaf only, or left inline in the domain (divergence); a typed
 * amount echoed into a sentence; a closed-month draft blocked even when the override is ticked; a locked month lifted by it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as leaf from '../../../packages/domain/src/business-rules';

// ---------------------------------------------------------------------------------------------------------------------
// THE ADAPTER: ids and fact shapes. Change here only.
// ---------------------------------------------------------------------------------------------------------------------
const ID = {
  supplierActive: 'ap.invoice.supplierActive',
  dueNotBeforeInvoice: 'ap.invoice.dueNotBeforeInvoice',
  feesNotOverTotal: 'ap.invoice.feesNotOverTotal',
  vat: 'ap.invoice.vat',
  duplicateNumber: 'ap.invoice.duplicateNumber',
  attestation: 'ap.verify.attestation',
  verifySupplierActive: 'ap.verify.supplierActive',
  receiptPhoto: 'ap.verify.receiptPhoto',
  draftsWouldPost: 'ap.verify.draftsWouldPost',
} as const;

type Verdict = null | { level: 'block' | 'warn'; sentence: string };
type Check = { id: string; watch: readonly string[]; run(facts: unknown, values: Record<string, string>): Verdict };
const REGISTRY = (leaf as unknown as { BUSINESS_CHECKS: Record<string, Check> }).BUSINESS_CHECKS;
const run = (id: string, facts: unknown, values: Record<string, string>): Verdict => REGISTRY[id]!.run(facts, values);

const SUP = 'sup-1';
type VatStatus = 'vat_registered' | 'non_vat' | null;
/** Per-supplier facts the page already has (listSuppliersWithPosition). */
const suppliers = (o: { status?: string; vatStatus?: VatStatus; name?: string } = {}) => ({
  suppliers: { [SUP]: { name: o.name ?? 'Pork Co', status: o.status ?? 'active', vatStatus: o.vatStatus === undefined ? 'vat_registered' : o.vatStatus } },
});
const FACT_DUP = (matches: Array<{ invoiceDate: string; totalAmount: string }> | null | undefined, invoiceNo = 'INV-7') => ({
  supplierName: 'Pork Co',
  invoiceNo,
  matches,
});
const FACT_RECEIPT = (o: { mirror?: boolean; receiptFileId?: string | null; file?: { storeId: string | null } | null; invoiceStoreId?: string } = {}) => ({
  isCommissaryMirror: o.mirror ?? false,
  receiptFileId: o.receiptFileId === undefined ? 'file-1' : o.receiptFileId,
  file: o.file === undefined ? { storeId: 'store-1' } : o.file,
  invoiceStoreId: o.invoiceStoreId ?? 'store-1',
});
/** One entry per draft against the invoice: `sentence` null = it would post; `liftable` = a CLOSED month the override lifts. */
const FACT_DRAFTS = (drafts: Array<{ particulars: string; sentence: string | null; liftable?: boolean }>) => ({ drafts });

const ALL_TICKED = { attestSupplier: 'on', attestInvoice: 'on', attestItems: 'on', attestPrice: 'on' };

describe('T-475 S1 - the registry', () => {
  it('holds every S1 check, keyed by its own id, each with a non-empty watch list of control names', () => {
    expect(REGISTRY, 'BUSINESS_CHECKS is not exported by @shareat/domain/business-rules').toBeTruthy();
    for (const id of Object.values(ID)) {
      const c = REGISTRY[id];
      expect(c, `missing check ${id}`).toBeTruthy();
      expect(c!.id).toBe(id);
      expect(Array.isArray(c!.watch) && c!.watch.length > 0, `${id} watches nothing`).toBe(true);
      expect(typeof c!.run).toBe('function');
    }
  });

  it('A5 is the only warn: every other S1 check returns level "block" (mutant: a warn written as a block, or the reverse)', () => {
    const levels = new Map<string, string>();
    levels.set(ID.supplierActive, run(ID.supplierActive, suppliers({ status: 'inactive' }), { supplierId: SUP })!.level);
    levels.set(ID.dueNotBeforeInvoice, run(ID.dueNotBeforeInvoice, {}, { invoiceDate: '2026-01-10', dueDate: '2026-01-09' })!.level);
    levels.set(ID.feesNotOverTotal, run(ID.feesNotOverTotal, {}, { totalAmount: '10', deliveryFee: '11' })!.level);
    levels.set(ID.vat, run(ID.vat, suppliers({ vatStatus: 'non_vat' }), { supplierId: SUP, vatType: 'vatable', totalAmount: '10' })!.level);
    levels.set(ID.duplicateNumber, run(ID.duplicateNumber, FACT_DUP([{ invoiceDate: '2026-01-02', totalAmount: '5.00' }]), { invoiceNo: 'INV-7' })!.level);
    levels.set(ID.attestation, run(ID.attestation, {}, {})!.level);
    levels.set(ID.verifySupplierActive, run(ID.verifySupplierActive, { supplier: { name: 'Pork Co', status: 'inactive' } }, {})!.level);
    levels.set(ID.receiptPhoto, run(ID.receiptPhoto, FACT_RECEIPT({ receiptFileId: null }), {})!.level);
    levels.set(ID.draftsWouldPost, run(ID.draftsWouldPost, FACT_DRAFTS([{ particulars: 'x', sentence: 'no.' }]), {})!.level);
    for (const [id, level] of levels) expect(level, id).toBe(id === ID.duplicateNumber ? 'warn' : 'block');
  });

  it('the rule leaf is pure: running twice gives the same verdict and never mutates frozen facts or values', () => {
    const facts = Object.freeze({ ...suppliers({ status: 'inactive' }) });
    const values = Object.freeze({ supplierId: SUP });
    expect(run(ID.supplierActive, facts, values)).toEqual(run(ID.supplierActive, facts, values));
  });

  it('each check reads ONLY controls it lists in `watch` (mutant: reads one it does not list, so it never re-runs on that edit)', () => {
    const probes: Array<[string, unknown, Record<string, string>]> = [
      [ID.supplierActive, suppliers({ status: 'inactive' }), { supplierId: SUP }],
      [ID.dueNotBeforeInvoice, {}, { invoiceDate: '2026-01-10', dueDate: '2026-01-09' }],
      [ID.feesNotOverTotal, {}, { totalAmount: '10', deliveryFee: '6', otherFees: '6' }],
      [ID.vat, suppliers(), { supplierId: SUP, vatType: 'vatable', vatAmount: '1', totalAmount: '10' }],
      [ID.duplicateNumber, FACT_DUP([{ invoiceDate: '2026-01-02', totalAmount: '5.00' }]), { invoiceNo: 'INV-7', supplierId: SUP }],
      [ID.attestation, {}, { attestSupplier: 'on' }],
      [ID.draftsWouldPost, FACT_DRAFTS([{ particulars: 'x', sentence: 'no.', liftable: true }]), { periodOverrideConfirm: 'on' }],
    ];
    for (const [id, facts, values] of probes) {
      const read = new Set<string>();
      const spy = new Proxy(values, {
        get(t, k) {
          if (typeof k === 'string') read.add(k);
          return Reflect.get(t, k);
        },
        has(t, k) {
          if (typeof k === 'string') read.add(k);
          return Reflect.has(t, k);
        },
      });
      REGISTRY[id]!.run(facts, spy);
      const watch = new Set(REGISTRY[id]!.watch);
      for (const k of read) expect(watch.has(k), `${id} reads "${k}" but watch is [${[...watch].join(', ')}]`).toBe(true);
    }
  });
});

describe('T-475 S1 - A1 / V3: the supplier must be active', () => {
  it('inactive: the exact sentence naming the supplier and its status; active and unknown pass', () => {
    expect(run(ID.supplierActive, suppliers({ status: 'inactive' }), { supplierId: SUP })).toEqual({
      level: 'block',
      sentence: 'Pork Co is inactive, not active — reactivate the supplier first if you really are still buying from them.',
    });
    expect(run(ID.supplierActive, suppliers({ status: 'active' }), { supplierId: SUP })).toBeNull();
    expect(run(ID.supplierActive, suppliers({ status: 'inactive' }), { supplierId: '' })).toBeNull();
    expect(run(ID.supplierActive, suppliers({ status: 'inactive' }), { supplierId: 'not-in-the-list' })).toBeNull();
  });

  it('V3 on the verify form: "{name} is {status}, not active." (mutant: the log sentence reused on the verify form)', () => {
    expect(run(ID.verifySupplierActive, { supplier: { name: 'Pork Co', status: 'archived' } }, {})).toEqual({
      level: 'block',
      sentence: 'Pork Co is archived, not active.',
    });
    expect(run(ID.verifySupplierActive, { supplier: { name: 'Pork Co', status: 'active' } }, {})).toBeNull();
  });
});

describe('T-475 S1 - A2: due date not before the invoice date', () => {
  const S = { level: 'block', sentence: "A due date can't be before the invoice date." };
  it('one day before blocks; EQUAL passes (mutant: <=); later passes', () => {
    expect(run(ID.dueNotBeforeInvoice, {}, { invoiceDate: '2026-01-10', dueDate: '2026-01-09' })).toEqual(S);
    expect(run(ID.dueNotBeforeInvoice, {}, { invoiceDate: '2026-01-10', dueDate: '2026-01-10' })).toBeNull();
    expect(run(ID.dueNotBeforeInvoice, {}, { invoiceDate: '2026-01-10', dueDate: '2026-01-11' })).toBeNull();
  });
  it('compares real dates, not strings (month and year boundaries)', () => {
    expect(run(ID.dueNotBeforeInvoice, {}, { invoiceDate: '2026-02-01', dueDate: '2026-01-31' })).toEqual(S);
    expect(run(ID.dueNotBeforeInvoice, {}, { invoiceDate: '2026-01-01', dueDate: '2025-12-31' })).toEqual(S);
    expect(run(ID.dueNotBeforeInvoice, {}, { invoiceDate: '2025-12-31', dueDate: '2026-01-01' })).toBeNull();
  });
  it('a blank or unreal date gives no verdict (the field rules own those sentences)', () => {
    for (const v of [
      { invoiceDate: '2026-01-10', dueDate: '' },
      { invoiceDate: '', dueDate: '2026-01-10' },
      { invoiceDate: '2026-01-10', dueDate: 'soon' },
      { invoiceDate: 'x', dueDate: '2026-01-10' },
    ])
      expect(run(ID.dueNotBeforeInvoice, {}, v)).toBeNull();
  });
});

describe('T-475 S1 - A3: delivery + other fees not over the total', () => {
  const S = { level: 'block', sentence: "The delivery and other fees can't be more than the invoice total." };
  it('equal passes, one centavo over blocks (mutant: >=); each fee alone and the sum are judged', () => {
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '100', deliveryFee: '60', otherFees: '40' })).toBeNull();
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '100', deliveryFee: '60', otherFees: '40.01' })).toEqual(S);
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '100', deliveryFee: '100.01', otherFees: '' })).toEqual(S);
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '100', deliveryFee: '', otherFees: '100.01' })).toEqual(S);
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '100', deliveryFee: '', otherFees: '' })).toBeNull();
  });
  it('exact decimal sums: 0.1 + 0.2 against 0.30 passes (mutant: float arithmetic)', () => {
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '0.30', deliveryFee: '0.1', otherFees: '0.2' })).toBeNull();
  });
  it('an unreadable or missing total or fee gives no verdict; the sentence never echoes a typed amount (Audit A5)', () => {
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '', deliveryFee: '5', otherFees: '' })).toBeNull();
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: 'abc', deliveryFee: '5', otherFees: '' })).toBeNull();
    expect(run(ID.feesNotOverTotal, {}, { totalAmount: '100', deliveryFee: 'abc', otherFees: '' })).toBeNull();
    const v = run(ID.feesNotOverTotal, {}, { totalAmount: '123.45', deliveryFee: '987.65', otherFees: '' })!;
    expect(v.sentence).not.toMatch(/123\.45|987\.65/);
  });
});

describe('T-475 S1 - A4: the VAT family', () => {
  const NOT_REG = (n = 'Pork Co') => `${n} is not VAT-registered, so this bill can't be vatable or zero-rated.`;
  const NO_AMT = (n = 'Pork Co') => `${n} is not VAT-registered, so this bill can't carry a VAT amount.`;
  const base = { supplierId: SUP, totalAmount: '1000', vatType: 'supplier_default', vatAmount: '' };
  const vat = (s: ReturnType<typeof suppliers>, v: Partial<typeof base>) => run(ID.vat, s, { ...base, ...v });
  const block = (sentence: string) => ({ level: 'block', sentence });

  it('non-VAT supplier: explicit vatable or zero-rated is refused with the registration sentence (mutant: branch dropped)', () => {
    const s = suppliers({ vatStatus: 'non_vat' });
    expect(vat(s, { vatType: 'vatable', vatAmount: '' })).toEqual(block(NOT_REG()));
    expect(vat(s, { vatType: 'zero_rated' })).toEqual(block(NOT_REG()));
  });
  it('non-VAT supplier: a VAT amount is refused whatever the type; exempt / non_vat / default with no amount pass', () => {
    const s = suppliers({ vatStatus: 'non_vat' });
    expect(vat(s, { vatType: 'exempt', vatAmount: '5' })).toEqual(block(NO_AMT()));
    expect(vat(s, { vatType: 'supplier_default', vatAmount: '5' })).toEqual(block(NO_AMT()));
    for (const t of ['exempt', 'non_vat', 'supplier_default']) expect(vat(s, { vatType: t })).toBeNull();
  });
  it('ORDER: a non-VAT supplier with an explicit vatable type AND an amount gets the registration sentence first (mutant: branches re-ordered)', () => {
    expect(vat(suppliers({ vatStatus: 'non_vat' }), { vatType: 'vatable', vatAmount: '5' })).toEqual(block(NOT_REG()));
  });
  it('supplier_default resolves from the supplier: VAT-registered -> vatable (needs an amount); non-VAT -> non_vat; unset -> no type', () => {
    expect(vat(suppliers({ vatStatus: 'vat_registered' }), { vatType: 'supplier_default', vatAmount: '' })).toEqual(block('A vatable bill needs the VAT amount printed on it.'));
    expect(vat(suppliers({ vatStatus: 'vat_registered' }), { vatType: 'supplier_default', vatAmount: '120' })).toBeNull();
    expect(vat(suppliers({ vatStatus: null }), { vatType: 'supplier_default', vatAmount: '' })).toBeNull();
    expect(vat(suppliers({ vatStatus: null }), { vatType: 'supplier_default', vatAmount: '5' })).toEqual(
      block('A VAT amount only goes with a vatable bill. Clear the amount, or choose the vatable type.'),
    );
  });
  it('vatable: blank needs the amount; zero is not greater than zero; EQUAL to the total passes, one centavo over blocks', () => {
    const s = suppliers({ vatStatus: 'vat_registered' });
    expect(vat(s, { vatType: 'vatable', vatAmount: '' })).toEqual(block('A vatable bill needs the VAT amount printed on it.'));
    expect(vat(s, { vatType: 'vatable', vatAmount: '0' })).toEqual(block('The VAT amount has to be greater than zero.'));
    expect(vat(s, { vatType: 'vatable', vatAmount: '1000' })).toBeNull();
    expect(vat(s, { vatType: 'vatable', vatAmount: '1000.01' })).toEqual(block("The VAT amount can't be more than the invoice total."));
    expect(vat(s, { vatType: 'vatable', vatAmount: '0.01' })).toBeNull();
  });
  it('zero-rated: blank or 0 passes, anything else is refused', () => {
    const s = suppliers({ vatStatus: 'vat_registered' });
    expect(vat(s, { vatType: 'zero_rated', vatAmount: '' })).toBeNull();
    expect(vat(s, { vatType: 'zero_rated', vatAmount: '0' })).toBeNull();
    expect(vat(s, { vatType: 'zero_rated', vatAmount: '5' })).toEqual(block('A zero-rated bill has no VAT amount. Leave it blank or enter 0.'));
  });
  it('a VAT amount with exempt or non_vat type (VAT-registered supplier) is refused with the "only goes with vatable" sentence', () => {
    const s = suppliers({ vatStatus: 'vat_registered' });
    for (const t of ['exempt', 'non_vat'])
      expect(vat(s, { vatType: t, vatAmount: '5' })).toEqual(block('A VAT amount only goes with a vatable bill. Clear the amount, or choose the vatable type.'));
  });
  it('no supplier chosen, or an unreadable amount or total: no verdict (the field rules speak)', () => {
    expect(vat(suppliers(), { supplierId: '', vatType: 'vatable' })).toBeNull();
    expect(vat(suppliers(), { vatType: 'vatable', vatAmount: 'abc' })).toBeNull();
    expect(vat(suppliers(), { vatType: 'vatable', vatAmount: '5', totalAmount: '' })).toBeNull();
  });
});

describe('T-475 S1 - A5: a repeated invoice number is a WARNING (Q1, option A)', () => {
  const m = [{ invoiceDate: '2026-01-02', totalAmount: '1200.00' }];
  it('one match: level warn, the exact sentence', () => {
    expect(run(ID.duplicateNumber, FACT_DUP(m), { invoiceNo: 'INV-7' })).toEqual({
      level: 'warn',
      sentence: 'Pork Co already has invoice "INV-7" recorded (2026-01-02 ₱1200.00). Check it is not the same bill twice.',
    });
  });
  it('two matches are listed in order, comma separated, as the after-save warning does', () => {
    const v = run(ID.duplicateNumber, FACT_DUP([...m, { invoiceDate: '2026-02-03', totalAmount: '88.50' }]), { invoiceNo: 'INV-7' })!;
    expect(v.sentence).toContain('(2026-01-02 ₱1200.00, 2026-02-03 ₱88.50)');
  });
  it('NO verdict while the lookup is unanswered, failed, empty, or answered for a different number (never blocks or warns on a pending lookup)', () => {
    expect(run(ID.duplicateNumber, FACT_DUP(undefined), { invoiceNo: 'INV-7' })).toBeNull();
    expect(run(ID.duplicateNumber, FACT_DUP(null), { invoiceNo: 'INV-7' })).toBeNull();
    expect(run(ID.duplicateNumber, FACT_DUP([]), { invoiceNo: 'INV-7' })).toBeNull();
    expect(run(ID.duplicateNumber, undefined, { invoiceNo: 'INV-7' })).toBeNull();
    // mutant: a stale answer (for INV-7) still shown after the person edited the number to INV-8
    expect(run(ID.duplicateNumber, FACT_DUP(m, 'INV-7'), { invoiceNo: 'INV-8' })).toBeNull();
    expect(run(ID.duplicateNumber, FACT_DUP(m, 'INV-7'), { invoiceNo: '' })).toBeNull();
  });
  it('surrounding spaces in the typed number do not hide the answer (the server trims)', () => {
    expect(run(ID.duplicateNumber, FACT_DUP(m, 'INV-7'), { invoiceNo: '  INV-7 ' })?.level).toBe('warn');
  });
});

describe('T-475 S1 - V2: all four ticks', () => {
  const T = (joined: string) => ({
    level: 'block',
    sentence:
      `Confirm every part of the bill before verifying it — still unconfirmed: ${joined}. ` +
      'Verifying means you checked the supplier, the invoice details, the items and the prices against the photo.',
  });
  it('all four ticked passes', () => expect(run(ID.attestation, {}, ALL_TICKED)).toBeNull());
  it('each single missing tick blocks and names ONLY that part (mutant: `some` for `every`; a label swapped)', () => {
    const label: Record<string, string> = { attestSupplier: 'the supplier', attestInvoice: 'the invoice number and date', attestItems: 'the items', attestPrice: 'the prices' };
    for (const k of Object.keys(ALL_TICKED)) {
      const rest: Record<string, string> = { ...ALL_TICKED };
      delete rest[k];
      expect(run(ID.attestation, {}, rest), k).toEqual(T(label[k]!));
    }
  });
  it('three ticks missing blocks (mutant: only blocks when ALL are missing); two read "a and b", three "a, b and c", four lists all', () => {
    expect(run(ID.attestation, {}, { attestSupplier: 'on' })).toEqual(T('the invoice number and date, the items and the prices'));
    expect(run(ID.attestation, {}, { attestSupplier: 'on', attestInvoice: 'on' })).toEqual(T('the items and the prices'));
    expect(run(ID.attestation, {}, {})).toEqual(T('the supplier, the invoice number and date, the items and the prices'));
  });
  it('only the value "on" counts as ticked', () => {
    expect(run(ID.attestation, {}, { ...ALL_TICKED, attestItems: 'off' })).toEqual(T('the items'));
  });
});

describe('T-475 S1 - V4: the receipt photo', () => {
  it('present, in this store: passes', () => expect(run(ID.receiptPhoto, FACT_RECEIPT(), {})).toBeNull());
  it('a file with no store (org-level) passes', () => expect(run(ID.receiptPhoto, FACT_RECEIPT({ file: { storeId: null } }), {})).toBeNull());
  it('no photo: the exact sentence', () => {
    expect(run(ID.receiptPhoto, FACT_RECEIPT({ receiptFileId: null }), {})).toEqual({
      level: 'block',
      sentence: 'This invoice has no receipt photo — upload one before verifying. A photo of the paper is the evidence the whole gate rests on.',
    });
  });
  it('a file that does not exist in this org: the exact sentence', () => {
    expect(run(ID.receiptPhoto, FACT_RECEIPT({ file: null }), {})).toEqual({
      level: 'block',
      sentence: 'This invoice names a receipt file that does not exist in this org.',
    });
  });
  it("another store's photo: the exact sentence (mutant: store comparison dropped)", () => {
    expect(run(ID.receiptPhoto, FACT_RECEIPT({ file: { storeId: 'store-2' } }), {})).toEqual({
      level: 'block',
      sentence: 'This invoice names a receipt belonging to another store — a photo from somewhere else is not evidence for this invoice.',
    });
  });
  it('a commissary-mirror supplier is exempt from all three (mutant: exemption dropped)', () => {
    for (const o of [{ receiptFileId: null }, { file: null }, { file: { storeId: 'store-2' } }])
      expect(run(ID.receiptPhoto, FACT_RECEIPT({ mirror: true, ...o }), {})).toBeNull();
  });
});

describe('T-475 S1 - V5: every draft would post', () => {
  const P = (particulars: string, s: string) => ({ level: 'block', sentence: `This invoice can't be verified yet: "${particulars}" — ${s}` });
  it('no drafts, or every draft clear: passes', () => {
    expect(run(ID.draftsWouldPost, FACT_DRAFTS([]), {})).toBeNull();
    expect(run(ID.draftsWouldPost, FACT_DRAFTS([{ particulars: 'Pork', sentence: null }]), {})).toBeNull();
  });
  it("the FIRST blocked draft is named with its own sentence (mutant: names the last, or drops the draft's sentence)", () => {
    const facts = FACT_DRAFTS([
      { particulars: 'Fine', sentence: null },
      { particulars: 'Chicken', sentence: "This expense can't be posted yet: its category has no ledger account." },
      { particulars: 'Beef', sentence: 'Another reason.' },
    ]);
    expect(run(ID.draftsWouldPost, facts, {})).toEqual(P('Chicken', "This expense can't be posted yet: its category has no ledger account."));
  });
  it('a CLOSED month lifts when the override is ticked, and not otherwise (mutant: blocks regardless)', () => {
    const facts = FACT_DRAFTS([{ particulars: 'Jan', sentence: 'January 2026 is closed. Ask an administrator to post this one entry into it.', liftable: true }]);
    expect(run(ID.draftsWouldPost, facts, {})?.level).toBe('block');
    expect(run(ID.draftsWouldPost, facts, { periodOverrideConfirm: 'on' })).toBeNull();
  });
  it('a LOCKED month never lifts (mutant: the override lifts everything)', () => {
    const facts = FACT_DRAFTS([{ particulars: 'Jan', sentence: 'January 2026 is locked. Nothing can be posted into it, not even with the closed-month override.', liftable: false }]);
    expect(run(ID.draftsWouldPost, facts, { periodOverrideConfirm: 'on' })?.level).toBe('block');
  });
  it('a liftable draft does not hide a later non-liftable one when the override is ticked', () => {
    const facts = FACT_DRAFTS([
      { particulars: 'Jan', sentence: 'closed', liftable: true },
      { particulars: 'Unmapped', sentence: 'no account', liftable: false },
    ]);
    expect(run(ID.draftsWouldPost, facts, { periodOverrideConfirm: 'on' })).toEqual(P('Unmapped', 'no account'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// One source for the sentences: moved, not copied (spec 3.1). A literal left behind in the domain is the divergence mutant.
// ---------------------------------------------------------------------------------------------------------------------
const REPO = resolve(__dirname, '..', '..', '..');
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === 'tests') continue;
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
describe('T-475 S1 - the sentences live in the leaf and nowhere else', () => {
  const FRAGMENTS = [
    "A due date can't be before the invoice date.",
    "The delivery and other fees can't be more than the invoice total.",
    "is not VAT-registered, so this bill can't be vatable or zero-rated.",
    "so this bill can't carry a VAT amount.",
    'A vatable bill needs the VAT amount printed on it.',
    'The VAT amount has to be greater than zero.',
    "The VAT amount can't be more than the invoice total.",
    'A zero-rated bill has no VAT amount. Leave it blank or enter 0.',
    'A VAT amount only goes with a vatable bill. Clear the amount, or choose the vatable type.',
    ', not active — reactivate the supplier first if you really are still buying from them.',
    'Confirm every part of the bill before verifying it — still unconfirmed:',
    'This invoice has no receipt photo — upload one before verifying.',
    'This invoice names a receipt file that does not exist in this org.',
    'This invoice names a receipt belonging to another store',
  ];
  const files = [...tsFiles(join(REPO, 'packages/domain/src')), ...tsFiles(join(REPO, 'apps/erp/src'))].filter(
    (f) => !f.split(/[\\/]/).includes('business-rules'),
  );
  // Adjacent string pieces joined by `+` across lines are read as one literal.
  const texts = files.map((f) => [f, readFileSync(f, 'utf8').replace(/['"`]\s*\+\s*\n\s*['"`]/g, '')] as const);
  for (const frag of FRAGMENTS) {
    it(`"${frag.slice(0, 48)}..." is not written inline outside business-rules/ (mutant: a literal left in ap/index.ts)`, () => {
      const hits = texts.filter(([, t]) => t.includes(frag)).map(([f]) => f.slice(REPO.length + 1));
      expect(hits).toEqual([]);
    });
  }
});
