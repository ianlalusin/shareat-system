/**
 * recordInvoiceExpensesBatch - T-502 section 12: record several parts of ONE itemised invoice as expenses in one go.
 *
 * One expense per ticked part, amount = what that part has left, in ONE transaction (all or none). There is no second validation
 * path: every expense goes through the same `createExpense` (itemised rule, per-part ceiling, supplier, cash-on-delivery, capacity),
 * and on a VERIFIED invoice each is approved straight after, exactly as "+ Record expense" does (`recordExpenseForInvoice`). A
 * PENDING invoice leaves them as drafts (verifying posts them, as today). No new capability: it is `create_expense`, plus
 * `approve_expense` through `approveExpense` when the invoice is verified.
 *
 * The payments may come from several sources and must EQUAL the ticked parts' total. `allocateBatchPayments` (the SAME function the
 * page's live preview calls) splits them in order across the parts; each expense gets one payment row per source it drew from.
 *
 * Audit: each expense's own `expense.drafted` (+ `expense.approved`), plus one `expense.batch_recorded` naming the invoice and every
 * expense id, written after the last expense in the same transaction.
 */
import { authorize, type Actor } from '@shareat/auth';
import { apRepo, auditLogRepo, expensesRepo, type Tx } from '@shareat/db';
import { add, compare, ZERO, type Money } from '@shareat/core/money';
import { createExpense, parsePaymentAmount, type CreateExpensePaymentInput } from './create';
import { approveExpense } from './approve';
import { allocateBatchPayments, paymentsDontMatchSentence } from './allocate';
import {
  ALREADY_RECORDED_SENTENCE,
  buildInvoiceParts,
  LINES_OVER_TOTAL_SENTENCE,
  NOT_ITEMISED_SENTENCE,
  nothingUnderSentence,
  PICK_CATEGORY_SENTENCE,
  type InvoicePart,
} from './parts';
import { gone, refuse } from '../shared/refusal';

export interface BatchGroupInput {
  /** The category of a category part; null for the two open-room parts. */
  categoryId: string | null;
  /** True for the "Fees and other charges" part (categoryId null); omitted or false for "Uncategorised". */
  fees?: boolean;
  /** The category the person picks for an Uncategorised / Fees part. Required for those, ignored for a category part. */
  pickedCategoryId?: string | null;
  /** Overrides the pre-filled particulars (the part's item names). */
  particulars?: string;
}

export interface RecordInvoiceExpensesBatchInput {
  storeId: string;
  supplierInvoiceId: string;
  supplierId: string;
  groups: BatchGroupInput[];
  payments: CreateExpensePaymentInput[];
}

export interface RecordInvoiceExpensesBatchResult {
  expenseIds: string[];
  /** 'posted' on a verified invoice, 'draft' on a pending one. */
  status: 'posted' | 'draft';
}

/** The particulars a part pre-fills with: its item names, joined. A part with no items (fees) says what it is. */
export function defaultParticulars(part: Pick<InvoicePart, 'kind' | 'itemNames'>): string {
  if (part.kind === 'fees') return 'Fees and other charges';
  const unique = [...new Set(part.itemNames)];
  return unique.length > 0 ? unique.join(', ') : 'Items on this bill';
}

export async function recordInvoiceExpensesBatch(
  tx: Tx,
  actor: Actor,
  input: RecordInvoiceExpensesBatchInput,
): Promise<RecordInvoiceExpensesBatchResult> {
  // Bible section 7 rule 1: first statement. The same capability and store scope createExpense checks, so the same refusal.
  await authorize(tx, actor, 'create_expense', { storeId: input.storeId });

  const invoice = await apRepo.getSupplierInvoiceById(tx, actor.orgId, input.supplierInvoiceId);
  if (!invoice || invoice.storeId !== input.storeId) {
    throw gone(
      `recordInvoiceExpensesBatch: supplier invoice ${input.supplierInvoiceId} does not exist in org ${actor.orgId} at store ${input.storeId}`,
      'supplier invoice',
    );
  }
  await apRepo.lockInvoiceForRecording(tx, actor.orgId, input.supplierInvoiceId);

  const facts = await expensesRepo.invoicePartsFacts(tx, actor.orgId, input.supplierInvoiceId);
  const parts = facts ? buildInvoiceParts(facts) : undefined;
  if (!parts || !parts.itemised) throw refuse('recordInvoiceExpensesBatch: the invoice has no lines', NOT_ITEMISED_SENTENCE);
  if (parts.linesExceedTotal) throw refuse('recordInvoiceExpensesBatch: lines exceed the invoice total', LINES_OVER_TOTAL_SENTENCE);

  if (input.groups.length === 0) throw refuse('recordInvoiceExpensesBatch: no part was ticked', 'Tick at least one part of the bill to record.');

  // Resolve every ticked part: which part, its amount (what it has left), the category it records under, its particulars.
  const seen = new Set<string>();
  const chosen: { part: InvoicePart; categoryId: string | null; particulars: string; picked: string | null }[] = [];
  for (const g of input.groups) {
    const key = g.categoryId !== null ? g.categoryId : g.fees ? 'fees' : 'uncategorised';
    if (seen.has(key)) continue; // a part ticked twice is one part
    seen.add(key);
    const part = parts.parts.find((p) => p.key === key);
    if (!part) {
      const named = g.categoryId ? await expensesRepo.getCategoryById(tx, actor.orgId, g.categoryId) : undefined;
      throw refuse(`recordInvoiceExpensesBatch: the invoice has no part ${key}`, nothingUnderSentence(named?.category ?? 'that part'));
    }
    chosen.push({
      part,
      categoryId: part.categoryId,
      particulars: g.particulars?.trim() || defaultParticulars(part),
      picked: g.pickedCategoryId ?? null,
    });
  }

  // A part with nothing left drops out; if nothing is left at all there is nothing to do.
  const live = chosen.filter((c) => compare(c.part.left, ZERO) > 0);
  if (live.length === 0) throw refuse('recordInvoiceExpensesBatch: every ticked part is already recorded', ALREADY_RECORDED_SENTENCE);
  for (const c of live) {
    if (c.part.kind !== 'category' && !c.picked) {
      throw refuse('recordInvoiceExpensesBatch: no category picked for an open-room part', PICK_CATEGORY_SENTENCE);
    }
  }

  const total: Money = add(...live.map((c) => c.part.left));
  const payments = input.payments.map((p, i) => ({ ...p, amount: parsePaymentAmount(p.amount, i, 'recordInvoiceExpensesBatch') }));
  const paid: Money = add(...payments.map((p) => p.amount));
  if (compare(paid, total) !== 0) {
    throw refuse('recordInvoiceExpensesBatch: the payments do not equal the ticked total', paymentsDontMatchSentence(paid, total));
  }

  const split = allocateBatchPayments(
    live.map((c) => ({ key: c.part.key, amount: c.part.left })),
    payments,
  );

  const expenseIds: string[] = [];
  for (const c of live) {
    // allocateBatchPayments returns one entry per group it was given, under the same key.
    const lines = split.find((s) => s.key === c.part.key)?.lines ?? [];
    const { id } = await createExpense(tx, actor, {
      storeId: input.storeId,
      businessDate: '', // ignored: createExpense forces it from the invoice's own date
      categoryId: c.categoryId ?? c.picked ?? '',
      supplierId: input.supplierId,
      supplierInvoiceId: input.supplierInvoiceId,
      particulars: c.particulars,
      payments: lines.map((l) => ({ ...l, amount: String(l.amount) })),
    });
    expenseIds.push(id);
    if (invoice.status === 'verified') await approveExpense(tx, actor, id);
  }

  const status = invoice.status === 'verified' ? 'posted' : 'draft';
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'expense.batch_recorded',
    storeId: input.storeId,
    entityId: input.supplierInvoiceId,
    before: null,
    after: { supplierInvoiceId: input.supplierInvoiceId, expenseIds, amount: String(total), status },
    source: 'web',
  });

  return { expenseIds, status };
}
