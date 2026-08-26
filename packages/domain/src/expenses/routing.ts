/**
 * Expense posting routing — the pure, DB-free core of T-122's posting invariants (1-10).
 * docs/tasks/122-expenses.md §2-§4.
 *
 * Turns one expense (its category and its payment splits) into the balanced set of
 * journal lines `approve.ts` hands to `postEntry`, or names exactly why it cannot.
 * Nothing here touches the database or calls `postEntry` itself — that split (a pure
 * decision function, called from a thin service that does the actual write) mirrors
 * `packages/domain/src/ledger/legacy-adapter.ts`'s own shape, and makes every routing
 * rule testable without Postgres.
 *
 * ## Mirrors `packages/etl/src/leg-mapping.ts` and `packages/etl/src/convert.ts` —
 * ## deliberately a COPY, not an import
 *
 * T-122 §2/§3 says plainly: "Funding accounts mirror `leg-mapping.ts` exactly... **Do
 * not re-derive them**". The values below ARE those already-decided values, typed out
 * again here rather than imported, because the workspace dependency runs
 * `@shareat/etl -> @shareat/domain` (packages/etl/package.json), never the reverse —
 * `packages/domain` importing `packages/etl` would be a cycle (ADR-004's own reasoning,
 * one level over). `tests/unit/expense-routing-mirror.test.ts` imports BOTH this file
 * and the real `leg-mapping.ts`/`convert.ts` and asserts they agree — the same
 * drift-guard technique `posting-patterns-doc.test.ts` already uses for
 * POSTING-PATTERNS.md vs `fixtures.ts`, and `chart-of-accounts.test.ts` for
 * COA-ALIGNMENT.md vs the seed. If leg-mapping.ts ever changes, that test fails here,
 * not silently.
 *
 * ## The `expense_payments.account_code` finding — DEF-054/DEF-055's sibling
 *
 * T-122's Contract lists an `account_code?` column on `expense_payments` but its prose
 * (§2/§3) never explains what it is for — it only describes cash -> 1110/1120. Reading
 * `convert.ts`'s `fundingLine` (the ALREADY-DECIDED implementation §2 tells us to
 * mirror) shows the missing piece: a cash payment whose `accountId === 'office'` routes
 * to 1130 (`CASH_OFFICE`) instead of 1110. That is almost certainly what this column is
 * for — v1's `ExpensePaymentSplit.accountId` carries exactly that flag. Resolved by
 * reusing convert.ts's own, already-decided behaviour (not a new guess) rather than
 * leaving the column meaningless; reported in the task report as a fifth spec gap,
 * alongside DEF-053/054/055.
 */
import { add, equals, isZero, type Money } from '@shareat/core/money';

export type ExpensePaymentMethod = 'cash' | 'online' | 'credit' | 'other' | 'reimbursable' | 'ar_collection';

export const EXPENSE_PAYMENT_METHODS: readonly ExpensePaymentMethod[] = [
  'cash',
  'online',
  'credit',
  'other',
  'reimbursable',
  'ar_collection',
];

export type ExpenseGroup = 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';

export const EXPENSE_GROUPS: readonly ExpenseGroup[] = ['OPEX', 'COGS', 'CAPEX', 'PERSONAL'];

/** Mirrored from `packages/etl/src/leg-mapping.ts`'s `ACCOUNTS` — the funding-account
 *  subset this module needs. Do not re-derive; see this file's top comment. */
export const EXPENSE_FUNDING_ACCOUNTS = {
  CASH_CASHIER: '1110',
  CASH_STAFF: '1120',
  CASH_OFFICE: '1130',
  ONLINE: '1140',
  AP: '2110',
  REIMBURSABLE_TO_EMPLOYEES: '2130',
} as const;

/** Payment methods with no v2 account mapping — DEF-054. Blocks posting exactly like an
 *  unmapped category (invariant 10), never a silent drop from the enum. */
export const UNMAPPED_PAYMENT_METHODS: ReadonlySet<ExpensePaymentMethod> = new Set(['other', 'ar_collection']);

export interface RoutingPayment {
  method: ExpensePaymentMethod;
  amount: Money;
  /** Reimbursable's party (2130, employee) — required for that method (invariant 3). */
  staffId?: string | null;
  /** Cash paid from a staff-held float — routes to 1120 instead of 1110. */
  cashRequestId?: string | null;
  /** The 'office' cash sub-route (1130) — see this file's top comment. No other value
   *  is ever read. */
  accountCode?: string | null;
  /** ⭐ WHICH wallet an online payment left (ADR-010). `1140` is a control account covering every
   *  wallet, so the line names one as its party. Required for `online`, ignored otherwise. */
  moneyAccountId?: string | null;
}

export type RoutingLineSide = 'debit' | 'credit';

export interface RoutingLine {
  accountCode: string;
  side: RoutingLineSide;
  amount: Money;
  partyType?: 'supplier' | 'employee' | 'money_account';
  partyId?: string | null;
  lineMemo?: string | null;
}

export type RoutingResult = { ok: true; lines: RoutingLine[] } | { ok: false; reason: string };

function fundingLine(
  payment: RoutingPayment,
  index: number,
  supplierId: string | null,
): RoutingLine | { error: string } {
  switch (payment.method) {
    case 'cash': {
      const accountCode = payment.cashRequestId
        ? EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF
        : payment.accountCode === 'office'
          ? EXPENSE_FUNDING_ACCOUNTS.CASH_OFFICE
          : EXPENSE_FUNDING_ACCOUNTS.CASH_CASHIER;
      return { accountCode, side: 'credit', amount: payment.amount, lineMemo: `cash payment #${index}` };
    }
    case 'online': {
      // ⭐ Since ADR-010, 1140 is a control account keyed by the wallet — so this branch behaves
      // exactly like the credit one below, and for the same reason: an online payment that cannot
      // say which wallet it left is untracked money, which is the precise thing ADR-010 exists to
      // end. Blocking is also what the database would do anyway (1140 requires a party); doing it
      // here means the caller gets the payment number and the reason instead of a constraint name.
      if (!payment.moneyAccountId) {
        return {
          error: `payment #${index}: an online payment names no money account — 1140 is a control account and cannot say which wallet the money left`,
        };
      }
      return {
        accountCode: EXPENSE_FUNDING_ACCOUNTS.ONLINE,
        side: 'credit',
        amount: payment.amount,
        lineMemo: `online payment #${index}`,
        partyType: 'money_account',
        partyId: payment.moneyAccountId,
      };
    }
    case 'credit': {
      // T-118: 2110 is a control account — a credit payment with no supplier cannot be
      // reconstructed in the subledger, so it blocks rather than posting unattributed
      // (mirrors convert.ts's identical rule for the same account).
      if (!supplierId) {
        return {
          error: `payment #${index}: a credit (AP) payment has no supplierId — 2110 is a control account and requires a party`,
        };
      }
      return {
        accountCode: EXPENSE_FUNDING_ACCOUNTS.AP,
        side: 'credit',
        amount: payment.amount,
        partyType: 'supplier',
        partyId: supplierId,
        lineMemo: `AP payment #${index}`,
      };
    }
    case 'reimbursable': {
      // Invariant 3 — without the staff party, the trigger would reject the line
      // (DEF-049); this surfaces the same rule earlier, with a name, exactly as
      // convert.ts does for the identical case.
      if (!payment.staffId) {
        return {
          error: `payment #${index}: a reimbursable payment has no staffId — 2130 is a control account and requires a party`,
        };
      }
      return {
        accountCode: EXPENSE_FUNDING_ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES,
        side: 'credit',
        amount: payment.amount,
        partyType: 'employee',
        partyId: payment.staffId,
        lineMemo: `reimbursable payment #${index}`,
      };
    }
    case 'other':
    case 'ar_collection':
      // DEF-054 / invariant 10 — blocks exactly like an unmapped category, never a
      // silent drop from the enum.
      return {
        error: `payment #${index}: method "${payment.method}" has no account mapping (DEF-054) — Ian must decide whether it needs one or should be retired`,
      };
  }
}

export interface RoutingInput {
  totalAmount: Money;
  /** The expense header's opaque supplier reference — only read for `credit` payments. */
  supplierId: string | null;
  categoryName: string;
  /** Null when the category has no seeded/decided account — invariant 7. */
  categoryAccountCode: string | null;
  payments: RoutingPayment[];
}

/**
 * Builds the full set of lines for one expense — funding leg(s) plus exactly one
 * classification leg — or names the one reason it cannot. Never throws; every rejection
 * is a named `{ ok: false, reason }` (same discipline as `convert.ts`'s quarantine
 * results and `legacy-adapter.ts`'s `AdaptResult`), so a caller decides what to do with
 * a block instead of catching an exception.
 */
export function routeExpense(input: RoutingInput): RoutingResult {
  if (input.payments.length === 0) {
    return { ok: false, reason: 'an expense with no payments cannot post' };
  }

  const paidTotal = add(...input.payments.map((p) => p.amount));
  if (!equals(paidTotal, input.totalAmount)) {
    return {
      ok: false,
      reason: `sum(payments) (${paidTotal}) does not equal totalAmount (${input.totalAmount}) — inconsistent document`,
    };
  }

  const lines: RoutingLine[] = [];
  for (const [i, payment] of input.payments.entries()) {
    if (isZero(payment.amount)) continue;
    const result = fundingLine(payment, i + 1, input.supplierId);
    if ('error' in result) return { ok: false, reason: result.error };
    lines.push(result);
  }

  // Invariants 7, 8, 9 — the classification leg. Never a fallback to 6900: a category
  // seeded with no account_code (or PERSONAL/CAPEX misrouted) blocks, naming the
  // category, rather than guessing. PERSONAL (-> 3200) and CAPEX (-> a 15xx asset) reach
  // this exact same branch — they are ordinary rows in expense_categories whose seeded
  // account_code already IS 3200 / 1510 respectively (packages/db/seed/expense-categories.ts),
  // so no special-casing by group is needed here: the account_code the category resolved
  // to is always what gets debited.
  if (!input.categoryAccountCode) {
    return {
      ok: false,
      reason: `category "${input.categoryName}" has no account mapping — cannot post (never falls back to 6900)`,
    };
  }

  lines.push({
    accountCode: input.categoryAccountCode,
    side: 'debit',
    amount: input.totalAmount,
    lineMemo: input.categoryName,
  });

  if (lines.length < 2) {
    return { ok: false, reason: 'fewer than two non-zero lines — cannot form a balanced entry' };
  }

  return { ok: true, lines };
}
