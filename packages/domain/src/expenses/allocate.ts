/**
 * T-502 section 12 - `allocateBatchPayments`: how one batch's payments are split across its category groups.
 *
 * PURE and CLIENT-SAFE (imports only `@shareat/core/money`; never `@shareat/db`): the invoice page's live preview and the domain's
 * `recordInvoiceExpensesBatch` call this SAME function, so what the person sees is exactly what is saved.
 *
 * Fill in order. The groups, in the order given, take money from the payment rows, in the order given: a group takes what is left of
 * the current source, then moves to the next. Groups 100 and 50 against 80 cash then 70 GCash -> group 1 = 80 cash + 20 GCash,
 * group 2 = 50 GCash. A source that ends exactly on a group boundary leaves no zero-amount row. Money in, Money out; centavos
 * are bigint underneath (`@shareat/core/money`), never floats.
 */
import { add, compare, fromCentavos, toCentavos, type Money } from '@shareat/core/money';

export interface BatchGroupAmount {
  key: string;
  amount: Money;
}

export interface BatchPaymentSource {
  method: string;
  moneyAccountId?: string | null;
  amount: Money;
}

/** Each line is a copy of the source row it drew from (so extra fields such as a staff id travel along) with `amount` replaced by what it gave. */
export interface BatchAllocation<P extends BatchPaymentSource = BatchPaymentSource> {
  key: string;
  lines: (Omit<P, 'amount'> & { amount: Money })[];
}

/** The refusal sentence for payments that do not equal the parts. One copy: the page, the allocator and the domain all say it. */
export function paymentsDontMatchSentence(paid: Money, parts: Money): string {
  return `The payments add up to ₱${paid}, but the parts you ticked total ₱${parts}. They must match.`;
}

/**
 * Carries `userMessage` like the domain's `RefusalError` does, so an action shows it the same way. A local class (not `refuse`)
 * because `refuse` lives in `@shareat/db`, which a client component must not import.
 */
export class PaymentsDontMatchError extends Error {
  readonly userMessage: string;
  constructor(raw: string, userMessage: string) {
    super(raw);
    this.name = 'PaymentsDontMatchError';
    this.userMessage = userMessage;
  }
}

export function allocateBatchPayments<P extends BatchPaymentSource>(groups: BatchGroupAmount[], payments: P[]): BatchAllocation<P>[] {
  const parts = add(...groups.map((g) => g.amount));
  const paid = add(...payments.map((p) => p.amount));
  if (compare(parts, paid) !== 0) {
    throw new PaymentsDontMatchError(
      'allocateBatchPayments: the payments do not equal the groups total',
      paymentsDontMatchSentence(paid, parts),
    );
  }

  // Centavos as bigint: exact, no float step anywhere.
  const left = payments.map((p) => toCentavos(p.amount));
  let source = 0;
  const out: BatchAllocation<P>[] = [];
  for (const g of groups) {
    let need = toCentavos(g.amount);
    const lines: BatchAllocation<P>['lines'] = [];
    while (need > 0n) {
      // Skip a source that is used up (this is what keeps a zero row from ever being written).
      while (source < left.length && left[source]! === 0n) source += 1;
      const avail = left[source];
      const pay = payments[source];
      if (avail === undefined || pay === undefined) break; // unreachable: totals matched
      const take = avail < need ? avail : need;
      lines.push({ ...pay, amount: fromCentavos(take) });
      left[source] = avail - take;
      need -= take;
    }
    out.push({ key: g.key, lines });
  }
  return out;
}
