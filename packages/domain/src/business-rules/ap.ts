/**
 * T-475 S1 - the AP business rules: the "Log a supplier invoice" form (A1-A5) and the "Verify this invoice" form (V2-V5).
 * Every sentence below is the ONE copy: `recordInvoice` / `verifyInvoice` / `approveExpense` throw `refuse(raw, verdict.sentence)`
 * with it, and the page's `<RuleCheck>` prints the very same words. (Spec sections 3.1, 4.)
 *
 * The FACT BUILDERS (`buildSupplierFacts`, `buildReceiptFacts`, ...) turn repo rows into the facts a check reads. The page
 * loader and the domain both call them, so both judge identical facts and neither derives a status or a VAT rule itself.
 */
import { businessDayRange, formatBusinessDateTime, parseBusinessDate } from '@shareat/core/datetime';
import { add, compare, money, ZERO, type Money } from '@shareat/core/money';
import { block, defineCheck, typed, warn } from './check';

/** A typed amount as exact money: null for blank or unreadable (the field rules own those sentences). */
function amountOf(raw: string): Money | null {
  if (raw === '') return null;
  try {
    return money(raw);
  } catch {
    return null;
  }
}

function dateOf(raw: string): string | null {
  try {
    return parseBusinessDate(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fact builders
// ---------------------------------------------------------------------------------------------------------------------
export interface SupplierFactRow {
  id: string;
  name: string;
  status: string;
  vatStatus: string | null;
}
export interface SupplierFacts {
  suppliers: Record<string, { name: string; status: string; vatStatus: string | null }>;
}
/** The log form's supplier facts, keyed by supplier id. */
export function buildSupplierFacts(rows: readonly SupplierFactRow[]): SupplierFacts {
  const suppliers: SupplierFacts['suppliers'] = {};
  for (const r of rows) suppliers[r.id] = { name: r.name, status: r.status, vatStatus: r.vatStatus };
  return { suppliers };
}

export interface VerifySupplierFacts {
  supplier: { name: string; status: string };
}
export function buildVerifySupplierFacts(row: { name: string; status: string }): VerifySupplierFacts {
  return { supplier: { name: row.name, status: row.status } };
}

export interface ReceiptFacts {
  isCommissaryMirror: boolean;
  receiptFileId: string | null;
  /** The stored file the invoice names, or null when it does not exist in this org. */
  file: { storeId: string | null } | null;
  invoiceStoreId: string;
}
export function buildReceiptFacts(input: {
  counterpartyStoreId: string | null;
  receiptFileId: string | null;
  invoiceStoreId: string;
  file: { storeId: string | null } | null | undefined;
}): ReceiptFacts {
  return {
    isCommissaryMirror: !!input.counterpartyStoreId,
    receiptFileId: input.receiptFileId,
    file: input.file ? { storeId: input.file.storeId } : null,
    invoiceStoreId: input.invoiceStoreId,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A1 - the supplier must be active (log form)
// ---------------------------------------------------------------------------------------------------------------------
export const supplierActiveCheck = defineCheck<SupplierFacts | undefined>({
  id: 'ap.invoice.supplierActive',
  watch: ['supplierId'],
  run(facts, values) {
    const s = facts?.suppliers[typed(values, 'supplierId')];
    if (!s || s.status === 'active') return null;
    return block(`${s.name} is ${s.status}, not active — reactivate the supplier first if you really are still buying from them.`);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// A2 - the due date is not before the invoice date
// ---------------------------------------------------------------------------------------------------------------------
export const dueNotBeforeInvoiceCheck = defineCheck<unknown>({
  id: 'ap.invoice.dueNotBeforeInvoice',
  watch: ['invoiceDate', 'dueDate'],
  run(_facts, values) {
    const invoice = dateOf(typed(values, 'invoiceDate'));
    const due = dateOf(typed(values, 'dueDate'));
    if (invoice === null || due === null) return null;
    return due < invoice ? block("A due date can't be before the invoice date.") : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// A3 - delivery + other fees are not over the invoice total
// ---------------------------------------------------------------------------------------------------------------------
export const feesNotOverTotalCheck = defineCheck<unknown>({
  id: 'ap.invoice.feesNotOverTotal',
  watch: ['totalAmount', 'deliveryFee', 'otherFees'],
  run(_facts, values) {
    const total = amountOf(typed(values, 'totalAmount'));
    if (total === null) return null;
    const fees: Money[] = [];
    for (const name of ['deliveryFee', 'otherFees']) {
      const raw = typed(values, name);
      if (raw === '') continue; // a blank fee adds nothing
      const fee = amountOf(raw);
      if (fee === null) return null;
      fees.push(fee);
    }
    const over = block("The delivery and other fees can't be more than the invoice total.");
    try {
      return compare(add(...fees), total) > 0 ? over : null;
    } catch {
      return over; // two fees past the numeric(14,2) range are certainly over the total
    }
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// A4 - the VAT family
// ---------------------------------------------------------------------------------------------------------------------
const VAT_TYPES = ['vatable', 'zero_rated', 'exempt', 'non_vat'] as const;

export const vatCheck = defineCheck<SupplierFacts | undefined>({
  id: 'ap.invoice.vat',
  watch: ['supplierId', 'vatType', 'vatAmount', 'totalAmount'],
  run(facts, values) {
    const s = facts?.suppliers[typed(values, 'supplierId')];
    if (!s) return null;
    const amountRaw = typed(values, 'vatAmount');
    const amount = amountRaw === '' ? null : amountOf(amountRaw);
    if (amountRaw !== '' && amount === null) return null;
    const typedType = typed(values, 'vatType');
    // `supplier_default` resolves from the supplier's own VAT status, exactly as recordInvoice does.
    const type =
      typedType === 'supplier_default'
        ? s.vatStatus === 'vat_registered'
          ? 'vatable'
          : s.vatStatus === 'non_vat'
            ? 'non_vat'
            : null
        : typedType === ''
          ? null
          : typedType;
    if (type !== null && !(VAT_TYPES as readonly string[]).includes(type)) return null;
    if (s.vatStatus === 'non_vat') {
      if (type === 'vatable' || type === 'zero_rated') return block(`${s.name} is not VAT-registered, so this bill can't be vatable or zero-rated.`);
      if (amount !== null) return block(`${s.name} is not VAT-registered, so this bill can't carry a VAT amount.`);
    }
    if (type === 'vatable') {
      if (amount === null) return block('A vatable bill needs the VAT amount printed on it.');
      if (compare(amount, ZERO) <= 0) return block('The VAT amount has to be greater than zero.');
      const total = amountOf(typed(values, 'totalAmount'));
      if (total !== null && compare(amount, total) > 0) return block("The VAT amount can't be more than the invoice total.");
      return null;
    }
    if (type === 'zero_rated') {
      return amount !== null && compare(amount, ZERO) !== 0 ? block('A zero-rated bill has no VAT amount. Leave it blank or enter 0.') : null;
    }
    return amount !== null ? block('A VAT amount only goes with a vatable bill. Clear the amount, or choose the vatable type.') : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// A5 - a repeated invoice number is a WARNING, never a block (bible 16.10)
// ---------------------------------------------------------------------------------------------------------------------
export interface DuplicateFacts {
  supplierName: string;
  /** The number the lookup was answered for: an answer for a number since edited gives no verdict. */
  invoiceNo: string;
  supplierId?: string;
  /** null / undefined while the lookup is pending or failed. */
  matches: ReadonlyArray<{ invoiceDate: string; totalAmount: string }> | null | undefined;
}
const DUPLICATE_TAIL = ' Check it is not the same bill twice.';
export const duplicateNumberCheck = defineCheck<DuplicateFacts | undefined>({
  id: 'ap.invoice.duplicateNumber',
  watch: ['invoiceNo', 'supplierId'],
  run(facts, values) {
    const no = typed(values, 'invoiceNo');
    if (!facts || no === '' || !facts.matches || facts.matches.length === 0) return null;
    if (facts.invoiceNo.trim() !== no) return null;
    if (facts.supplierId !== undefined && facts.supplierId !== typed(values, 'supplierId')) return null;
    const list = facts.matches.map((m) => `${m.invoiceDate} ₱${m.totalAmount}`).join(', ');
    return warn(`${facts.supplierName} already has invoice "${no}" recorded (${list}).${DUPLICATE_TAIL}`);
  },
});
/** The sentence the SAVED-ANYWAY flash carries: the live warning's own words, framed for after the save. */
export function duplicateSavedAnywayFlash(sentence: string): string {
  const body = sentence.endsWith(DUPLICATE_TAIL) ? sentence.slice(0, -DUPLICATE_TAIL.length) : sentence;
  return `This looks like a duplicate — ${body} Saved anyway; check it is not the same bill twice.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// V1 - you cannot verify an invoice you logged yourself (segregation of duties). S3 lifts it for verify_own_supplier_invoice holders.
// ---------------------------------------------------------------------------------------------------------------------
export const selfVerifyCheck = defineCheck<{ createdByViewer: boolean } | undefined>({
  id: 'ap.verify.selfVerify',
  // Reads no control; it sits beside the supplier tick, so that is the name it lists (a check never watches nothing).
  watch: ['attestSupplier'],
  run(facts) {
    return facts?.createdByViewer === true
      ? block('You logged this invoice, so you cannot also verify it. Verification is a second pair of eyes — ask a manager who did not enter it, or an admin.')
      : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// V2 - all four ticks
// ---------------------------------------------------------------------------------------------------------------------
const ATTESTATIONS = [
  ['attestSupplier', 'the supplier'],
  ['attestInvoice', 'the invoice number and date'],
  ['attestItems', 'the items'],
  ['attestPrice', 'the prices'],
] as const;

/** A `VerifyInvoiceAttestation` as the verify form's control values. */
export function attestationValues(a: { supplier: boolean; invoice: boolean; items: boolean; price: boolean }): Record<string, string> {
  return {
    attestSupplier: a.supplier ? 'on' : '',
    attestInvoice: a.invoice ? 'on' : '',
    attestItems: a.items ? 'on' : '',
    attestPrice: a.price ? 'on' : '',
  };
}

export const attestationCheck = defineCheck<unknown>({
  id: 'ap.verify.attestation',
  watch: ATTESTATIONS.map(([name]) => name),
  run(_facts, values) {
    const labels = ATTESTATIONS.filter(([name]) => values[name] !== 'on').map(([, label]) => label);
    if (labels.length === 0) return null;
    const joined = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]!}` : labels[0]!;
    return block(
      `Confirm every part of the bill before verifying it — still unconfirmed: ${joined}. ` +
        'Verifying means you checked the supplier, the invoice details, the items and the prices against the photo.',
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// V3 - the supplier is still active (verify form)
// ---------------------------------------------------------------------------------------------------------------------
export const verifySupplierActiveCheck = defineCheck<VerifySupplierFacts | undefined>({
  id: 'ap.verify.supplierActive',
  // Reads no control; it sits beside the supplier tick, so that is the name it lists (a check never watches nothing).
  watch: ['attestSupplier'],
  run(facts) {
    const s = facts?.supplier;
    return s && s.status !== 'active' ? block(`${s.name} is ${s.status}, not active.`) : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// V4 - the receipt photo
// ---------------------------------------------------------------------------------------------------------------------
export const receiptPhotoCheck = defineCheck<ReceiptFacts | undefined>({
  id: 'ap.verify.receiptPhoto',
  watch: ['attestInvoice'],
  run(facts) {
    if (!facts || facts.isCommissaryMirror) return null;
    if (!facts.receiptFileId) {
      return block('This invoice has no receipt photo — upload one before verifying. A photo of the paper is the evidence the whole gate rests on.');
    }
    if (!facts.file) return block('This invoice names a receipt file that does not exist in this org.');
    if (facts.file.storeId && facts.file.storeId !== facts.invoiceStoreId) {
      return block('This invoice names a receipt belonging to another store — a photo from somewhere else is not evidence for this invoice.');
    }
    return null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// V5 - every draft against the invoice would post
// ---------------------------------------------------------------------------------------------------------------------
export interface DraftsFacts {
  /** In posting order. `sentence` null = the draft would post. `liftable` = a CLOSED month the override lifts. */
  drafts: ReadonlyArray<{ particulars: string; sentence: string | null; liftable?: boolean }>;
}
/** The verify form's V5 facts from `previewInvoiceDrafts` rows (oldest first): the blocker's sentence, and whether the closed-month override lifts it. */
export function buildDraftsFacts(
  rows: ReadonlyArray<{ particulars: string; verdict: { sentence: string; liftable?: boolean } | null }>,
): DraftsFacts {
  return { drafts: rows.map((r) => ({ particulars: r.particulars, sentence: r.verdict?.sentence ?? null, liftable: r.verdict?.liftable === true })) };
}
export const draftsWouldPostCheck = defineCheck<DraftsFacts | undefined>({
  id: 'ap.verify.draftsWouldPost',
  watch: ['periodOverrideConfirm'],
  run(facts, values) {
    const lifted = values.periodOverrideConfirm === 'on';
    for (const d of facts?.drafts ?? []) {
      if (d.sentence === null) continue;
      if (d.liftable === true && lifted) continue;
      return block(`This invoice can't be verified yet: "${d.particulars}" — ${d.sentence}`);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The invoice's room for an expense (P1 / E1's sentences). `@shareat/db` keeps its own backstop copy (assertOpenForRecording);
// the domain pre-checks with these first, and a parity test pins both equal.
// ---------------------------------------------------------------------------------------------------------------------
export interface CapacityFacts {
  status: string;
  totalAmount: string;
  recorded: string;
  remaining: string;
  invoiceNo: string | null;
  invoiceDate: string;
  supplierName: string;
}
function invoicePhrase(c: CapacityFacts): string {
  if (c.invoiceNo) return `invoice ${c.invoiceNo} from ${c.supplierName}`;
  try {
    const date = parseBusinessDate(c.invoiceDate);
    return `the ${formatBusinessDateTime(businessDayRange(date).start, { dateStyle: 'medium' })} invoice from ${c.supplierName}`;
  } catch {
    return `the invoice from ${c.supplierName}`;
  }
}
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type CapacityRefusal = { kind: 'voided' | 'pending' | 'fit'; sentence: string };
/** `target` 'posted' also requires the invoice to be verified; `skipPending` lifts only that (the verify preview). */
export function capacityRefusal(
  c: CapacityFacts,
  amount: string,
  target: 'draft' | 'posted',
  options: { skipPending?: boolean } = {},
): CapacityRefusal | null {
  const phrase = capitalise(invoicePhrase(c));
  if (c.status === 'voided') return { kind: 'voided', sentence: `${phrase} has been voided, so nothing more can be recorded against it.` };
  if (target === 'posted' && c.status !== 'verified' && !options.skipPending) {
    return { kind: 'pending', sentence: `${phrase} hasn't been verified yet, so this can't post against it.` };
  }
  if (compare(money(amount), money(c.remaining)) > 0) {
    return { kind: 'fit', sentence: `${phrase} has only ₱${c.remaining} left of ₱${c.totalAmount}; ₱${amount} doesn't fit.` };
  }
  return null;
}
