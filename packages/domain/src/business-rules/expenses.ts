/**
 * T-475 S2 - the EXPENSE business rules: the "New expense" form (E1-E3), the draft's category edit (E4) and the "Approve & post"
 * card (P1-P3). Every sentence below is the ONE copy: `createExpense` / `editExpense` / `approveExpense` throw
 * `refuse(raw, verdict.sentence)` with it, and the page's `<RuleCheck>` prints the very same words. (Spec sections 3.1, 4.)
 *
 * The FACT BUILDERS (`buildNewExpenseFacts`, `buildCategoryFacts`, `buildPeriodFacts`, ...) turn repo rows into the facts a check
 * reads. The page loader and the domain both call them (R8), so both judge identical facts and neither derives a status, a
 * terms rule or a month sentence itself.
 *
 * Client-safe leaf: imports only ./*, ../shared/money-lines and @shareat/core/money (see ./check.ts).
 */
import { add, compare, money, ZERO, type Money } from '@shareat/core/money';
import { cashOnDeliverySentence } from '../shared/money-lines';
import { capacityRefusal, type CapacityFacts } from './ap';
import { block, defineCheck, typed, type FormValues } from './check';

// ---------------------------------------------------------------------------------------------------------------------
// The payment lines a MoneyLines block posts: `lineCount`, then `lineMethod_i` / `lineAmount_i` per row (the server's parse
// skips a row with no method or no amount, so the checks below do too).
// ---------------------------------------------------------------------------------------------------------------------
/** The most payment lines an expense carries (the server refuses a 51st). */
export const MAX_EXPENSE_LINES = 50;
const LINE_INDEXES = Array.from({ length: MAX_EXPENSE_LINES }, (_, i) => i);
const LINE_WATCH: readonly string[] = ['lineCount', ...LINE_INDEXES.map((i) => `lineMethod_${i}`), ...LINE_INDEXES.map((i) => `lineAmount_${i}`)];

/** The form's payment rows as typed (blank rows dropped). An unreadable `lineCount` gives no rows: no verdict. */
function paymentRows(values: FormValues): Array<{ method: string; amount: string }> {
  const countRaw = typed(values, 'lineCount');
  if (!/^\d+$/.test(countRaw)) return [];
  const count = Math.min(Number(countRaw), MAX_EXPENSE_LINES);
  const rows: Array<{ method: string; amount: string }> = [];
  for (const i of LINE_INDEXES.slice(0, count)) {
    const amount = typed(values, `lineAmount_${i}`);
    if (amount === '') continue;
    rows.push({ method: typed(values, `lineMethod_${i}`), amount });
  }
  return rows;
}

/** The control values of a payment block, as the form posts them: what the domain feeds the same checks the page runs. */
export function expenseLineValues(
  supplierInvoiceId: string,
  payments: ReadonlyArray<{ method: string; amount: string }>,
): Record<string, string> {
  const values: Record<string, string> = { supplierInvoiceId, lineCount: String(payments.length) };
  payments.forEach((p, i) => {
    values[`lineMethod_${i}`] = p.method;
    values[`lineAmount_${i}`] = p.amount;
  });
  return values;
}

/** A typed amount as exact money: null for unreadable. */
function amountOf(raw: string): Money | null {
  try {
    return money(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fact builders - the New expense form (E1-E3)
// ---------------------------------------------------------------------------------------------------------------------
export interface PickerInvoiceRow {
  id: string;
  supplierName: string;
  supplierStatus: string;
  /** null = cash-on-delivery. */
  creditTermsDays: number | null;
  status: string;
  totalAmount: string;
  recorded: string;
  remaining: string;
  invoiceNo: string | null;
  invoiceDate: string;
}
export interface NewExpenseFacts {
  invoices: Record<string, { supplierName: string; supplierStatus: string; creditTermsDays: number | null; capacity: CapacityFacts }>;
}
/** The invoice picker's facts, keyed by invoice id. The page hands the whole picker; the domain hands the one invoice it is recording against. */
export function buildNewExpenseFacts(rows: readonly PickerInvoiceRow[]): NewExpenseFacts {
  const invoices: NewExpenseFacts['invoices'] = {};
  for (const r of rows) {
    invoices[r.id] = {
      supplierName: r.supplierName,
      supplierStatus: r.supplierStatus,
      creditTermsDays: r.creditTermsDays,
      capacity: {
        status: r.status,
        totalAmount: r.totalAmount,
        recorded: r.recorded,
        remaining: r.remaining,
        invoiceNo: r.invoiceNo,
        invoiceDate: r.invoiceDate,
        supplierName: r.supplierName,
      },
    };
  }
  return { invoices };
}

// ---------------------------------------------------------------------------------------------------------------------
// E1 - the amount is not over what the picked invoice has left
// ---------------------------------------------------------------------------------------------------------------------
export const amountWithinRemainingCheck = defineCheck<NewExpenseFacts | undefined>({
  id: 'expense.new.amountWithinRemaining',
  watch: ['supplierInvoiceId', ...LINE_WATCH],
  run(facts, values) {
    const invoice = facts?.invoices[typed(values, 'supplierInvoiceId')];
    if (!invoice) return null;
    const amounts: Money[] = [];
    for (const row of paymentRows(values)) {
      const amount = amountOf(row.amount);
      if (amount !== null) amounts.push(amount);
    }
    if (amounts.length === 0) return null;
    let total: Money;
    try {
      total = add(...amounts);
    } catch {
      return null; // past the numeric(14,2) range: the field rules own that sentence
    }
    if (compare(total, ZERO) <= 0) return null;
    const refusal = capacityRefusal(invoice.capacity, total, 'draft');
    return refusal ? block(refusal.sentence) : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// E2 - a credit line on a cash-on-delivery supplier
// ---------------------------------------------------------------------------------------------------------------------
export const creditNeedsTermsCheck = defineCheck<NewExpenseFacts | undefined>({
  id: 'expense.new.creditNeedsTerms',
  watch: ['supplierInvoiceId', ...LINE_WATCH],
  run(facts, values) {
    const invoice = facts?.invoices[typed(values, 'supplierInvoiceId')];
    if (!invoice || invoice.creditTermsDays !== null) return null;
    return paymentRows(values).some((r) => r.method === 'credit') ? block(cashOnDeliverySentence(invoice.supplierName)) : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// E3 - the invoice's supplier is still active
// ---------------------------------------------------------------------------------------------------------------------
export const expenseSupplierActiveCheck = defineCheck<NewExpenseFacts | undefined>({
  id: 'expense.new.supplierActive',
  watch: ['supplierInvoiceId'],
  run(facts, values) {
    const invoice = facts?.invoices[typed(values, 'supplierInvoiceId')];
    if (!invoice || invoice.supplierStatus === 'active') return null;
    return block(
      `${invoice.supplierName} is ${invoice.supplierStatus}, not active — an expense cannot be recorded against a supplier the business has stopped buying from.`,
    );
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// E4 - a draft may not be MOVED onto a category with no ledger account (R12: keeping the one it has is always fine)
// ---------------------------------------------------------------------------------------------------------------------
export interface CategoryFacts {
  /** The category the draft sits on now. */
  currentCategoryId: string;
  categories: Record<string, { accountCode: string | null }>;
}
export function buildCategoryFacts(currentCategoryId: string, rows: ReadonlyArray<{ id: string; accountCode: string | null }>): CategoryFacts {
  const categories: CategoryFacts['categories'] = {};
  for (const r of rows) categories[r.id] = { accountCode: r.accountCode ?? null };
  return { currentCategoryId, categories };
}
export const categoryMappedCheck = defineCheck<CategoryFacts | undefined>({
  id: 'expense.edit.categoryMapped',
  watch: ['categoryId'],
  run(facts, values) {
    const picked = typed(values, 'categoryId');
    if (!facts || picked === '' || picked === facts.currentCategoryId) return null;
    const category = facts.categories[picked];
    return category && !category.accountCode
      ? block("This category has no ledger account yet, so the draft can't post. Pick another category.")
      : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The fiscal period an approval posts into (P2)
// ---------------------------------------------------------------------------------------------------------------------
export interface PeriodFacts {
  status: string;
  startsOn: string;
}
export function buildPeriodFacts(period: { status: string; startsOn: string } | null | undefined): PeriodFacts | null {
  return period ? { status: period.status, startsOn: period.startsOn } : null;
}
/** "January 2026" - the month a fiscal period covers, for a sentence a person reads. */
function monthLabel(startsOn: string): string {
  return new Date(`${startsOn}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export type PeriodRefusal = { kind: 'locked' | 'closed'; sentence: string };
/** A LOCKED month never takes the posting; a CLOSED one does only with the override (`override`). */
export function periodRefusal(period: PeriodFacts | null | undefined, options: { override: boolean }): PeriodRefusal | null {
  if (!period) return null;
  if (period.status === 'locked') {
    return { kind: 'locked', sentence: `${monthLabel(period.startsOn)} is locked. Nothing can be posted into it, not even with the closed-month override.` };
  }
  if (period.status === 'closed' && !options.override) {
    return { kind: 'closed', sentence: `${monthLabel(period.startsOn)} is closed. Ask an administrator to post this one entry into it.` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// P1 - the draft's invoice has to be verified (and open, with room) before the draft can post
// ---------------------------------------------------------------------------------------------------------------------
export interface InvoiceVerifiedFacts {
  capacity: CapacityFacts;
  /** The draft's own total (what would post). */
  amount: string;
}
export const invoiceVerifiedCheck = defineCheck<InvoiceVerifiedFacts | undefined>({
  id: 'expense.approve.invoiceVerified',
  // Reads no control; it sits beside the hidden expense id, so that is the name it lists (a check never watches nothing).
  watch: ['expenseId'],
  run(facts) {
    if (!facts) return null;
    const refusal = capacityRefusal(facts.capacity, facts.amount, 'posted');
    return refusal ? block(refusal.sentence) : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// P2 - the month the draft would post into
// ---------------------------------------------------------------------------------------------------------------------
export interface PeriodOpenFacts {
  period: PeriodFacts | null;
  /** The viewer holds `override_period_lock` (the tick only lifts a CLOSED month, and only for a holder). */
  canOverride: boolean;
}
export const periodOpenCheck = defineCheck<PeriodOpenFacts | undefined>({
  id: 'expense.approve.periodOpen',
  watch: ['periodOverrideConfirm'],
  run(facts, values) {
    if (!facts) return null;
    const refusal = periodRefusal(facts.period, { override: facts.canOverride && values.periodOverrideConfirm === 'on' });
    return refusal ? block(refusal.sentence) : null;
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// P3 - any other blocker `approveExpense` would give (unmapped category, money account, cash request, routing ...)
// ---------------------------------------------------------------------------------------------------------------------
export interface WouldPostFacts {
  /** The first blocker's own sentence from the shared approval evaluator, or null when nothing else stops the posting. */
  sentence: string | null;
}
export function buildWouldPostFacts(blocker: { sentence: string } | null | undefined): WouldPostFacts {
  return { sentence: blocker?.sentence ?? null };
}
export const wouldPostCheck = defineCheck<WouldPostFacts | undefined>({
  id: 'expense.approve.wouldPost',
  watch: ['expenseId'],
  run(facts) {
    return facts?.sentence ? block(facts.sentence) : null;
  },
});
