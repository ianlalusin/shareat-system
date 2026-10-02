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
  /**
   * ⭐ WHICH float this cash came out of — **required** when the resolved account is a staff one
   * (`1120`), because that account is a control account serving every holder at the store, and
   * this is its party (T-266 §7.2). ⚠️ Not routing: the ACCOUNT decides the code is `1120`; this
   * decides whose it was. Both questions, both answered, or the line is refused.
   */
  cashRequestId?: string | null;
  /** @deprecated ⛔ The 'office' free-text flag, replaced by the money account (DEF-058). Kept on
   *  the type only so an old caller fails to typecheck rather than silently posting to the wrong
   *  drawer. Nothing reads it. */
  accountCode?: string | null;
  /** ⭐ WHICH money account this payment moved (ADR-010, DEF-058). Required for `cash` and
   *  `online`: the account decides BOTH the GL code and who owns it. */
  moneyAccountId?: string | null;
  /** That account's GL code, resolved by the caller — this module is pure and cannot look it up.
   *  `1110`/`1120`/`1130` for cash by custodian, `1140` for every wallet and bank account. */
  moneyAccountGlCode?: string | null;
  /** ⭐ T-369 S8 (DEF-551): that account's STORE. When given, the credit line is placed THERE (`balanceOf` reads
   *  a safe at its own store), not at the expense's. Optional so a caller that never passes it keeps the old
   *  line shape exactly. */
  moneyAccountStoreId?: string | null;
}

export type RoutingLineSide = 'debit' | 'credit';

/** Owner's drawings. ⚠️ Party-requiring since T-127 — see `RoutingInput.owner`. */
export const OWNER_DRAWINGS_CODE = '3200';
/** Due from owners — a personal expense the business EXPECTS BACK. Party-requiring, T-127. */
export const DUE_FROM_OWNER_CODE = '1260';

export interface PersonalExpenseOwner {
  /** The `owners` row — the party on both possible lines. */
  id: string;
  /**
   * ⭐ `repayable` → `1260` Due from owners. `drawing` → `3200` Owner's drawings.
   *
   * ⛔ It is the ONE decision made at the expense, and it is the line the tax treatment turns on:
   * a payment made with no expectation of repayment is a distribution however it is labelled.
   */
  treatment: 'repayable' | 'drawing';
}

export interface RoutingLine {
  accountCode: string;
  side: RoutingLineSide;
  amount: Money;
  /** ⚠️ `cash_request` since T-266 — a staff float's holder. See `fundingLine`'s cash branch. */
  partyType?: 'supplier' | 'employee' | 'money_account' | 'owner' | 'cash_request';
  partyId?: string | null;
  lineMemo?: string | null;
  /** T-369 S8: the money account's store, set on a cash/online credit whenever the caller passed
   *  `moneyAccountStoreId` (even when it is the expense's own store); absent means "the expense's own store". */
  storeId?: string;
}

export type RoutingResult = { ok: true; lines: RoutingLine[] } | { ok: false; reason: string };

function fundingLine(
  payment: RoutingPayment,
  index: number,
  supplierId: string | null,
): RoutingLine | { error: string } {
  switch (payment.method) {
    // ⭐ CASH AND ONLINE ARE ONE BRANCH NOW (DEF-058). Both say "money left a place we hold it",
    // and the place is the money account. Its GL code decides where the credit lands and its
    // custodian decides who owned it — neither is a separate thing the user states.
    //
    // ⛔ This replaces the free-text `accountCode === 'office'` flag. Ian: *"payments must
    // automatically know who owns the account chosen from the dropdown, so the office drawer
    // checkbox must not exist."* Which is DEF-058's recorded resolution reached from the user's
    // side: *"the owner belongs to the ACCOUNT — it should be derived, never ticked."* A tickbox
    // let a cashier route cash to the office drawer; choosing an account they are not offered
    // cannot.
    case 'cash':
    case 'online': {
      if (!payment.moneyAccountId || !payment.moneyAccountGlCode) {
        return {
          error: `payment #${index}: a ${payment.method} payment names no money account — every peso has to leave somewhere nameable`,
        };
      }
      const line: RoutingLine = {
        accountCode: payment.moneyAccountGlCode,
        side: 'credit',
        amount: payment.amount,
        lineMemo: `${payment.method} payment #${index}`,
      };
      if (payment.moneyAccountStoreId) line.storeId = payment.moneyAccountStoreId;

      // ⭐ TWO of these four accounts are CONTROL accounts and need a party; two ARE the location
      // and refuse one. T-266 §7.1 — the parallel is exact:
      //
      //     1140  one line, many WALLETS   -> party = which wallet   (money_account)
      //     1120  one line, many FLOATS    -> party = whose float    (cash_request)
      //     1110 / 1130  one drawer, one safe — the code IS the place, party refused
      //
      // ⛔ This branch used to read `if (glCode === ONLINE)` under a comment asserting
      // "1110/1120/1130 ARE the location, and the trigger refuses a party on them." True for two
      // of the three. `1120` is seeded `requiresParty: true`
      // (packages/db/seed/chart-of-accounts.ts:133) precisely because ONE staff-float account per
      // store serves many holders — so a party-less credit hit
      // `journal_lines_party_requirement` (migration 0007) and an expense paid from a staff float
      // COULD NOT POST AT ALL. Nothing caught it: the form makes you hand-type a cash_request id,
      // and the one unit test that routed 1120 asserted the account code and never the party.
      if (payment.moneyAccountGlCode === EXPENSE_FUNDING_ACCOUNTS.ONLINE) {
        line.partyType = 'money_account';
        line.partyId = payment.moneyAccountId;
      } else if (payment.moneyAccountGlCode === EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF) {
        // ⛔ Refuse here, by name, rather than letting the trigger refuse it in Postgres —
        // the same discipline the `credit`-without-supplier branch below already applies.
        //
        // ⚠️ And the refusal must NOT be "fixed" by dropping 1120's party requirement. Spending
        // recorded without the request lands in no bucket of `floatPositionOf` — `outstanding`
        // never falls, the request never reaches `liquidated`, and DEF-159's gate then refuses
        // that person every future float. See T-266 §4.2.
        if (!payment.cashRequestId) {
          return {
            error:
              `payment #${index}: this is paid from a staff float, which belongs to a specific ` +
              'person — name the cash request it draws down, or the float can never be liquidated',
          };
        }
        // ⭐ The party is the REQUEST, not the money account — mirroring `releaseCashRequest`
        // (packages/domain/src/cash-requests/index.ts), which debits this same account with
        // exactly this party when the float goes out. Released and spent have to name the same
        // thing or the float cannot close.
        line.partyType = 'cash_request';
        line.partyId = payment.cashRequestId;
      }
      return line;
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
  /**
   * ⭐ **The owner a PERSONAL expense belongs to.** Null for every other category.
   *
   * > **Ian, 2026-08-27:** *"personal expense must be parked at owner's drawing, not automatically
   * > posted against it. It might be posted against owner's salary if they are given; if owner's
   * > salary does not exist then owner's drawing."*
   *
   * ⛔ **So `3200` is the FALLBACK, not the default.** A personal expense by a salaried owner is an
   * advance against their pay — recoverable, netted off at payroll — and booking it as a drawing
   * would permanently reduce equity for money the business is going to get back.
   *
   * ⚠️ Without an owner at all, a personal expense escapes that owner's drawing limit, which is
   * summed from `3200` by owner. Same shape as `staffId` on a reimbursable payment (invariant 3):
   * the account decides a party is needed, and the document has to supply it.
   */
  owner?: PersonalExpenseOwner | null;
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

  // ⭐ A PERSONAL expense does not have ONE account — it has two, and the owner decides which.
  // Invariant 7's rule applies unchanged: an unresolvable posting BLOCKS and names its reason, and
  // it never defaults to "some owner".
  if (input.categoryAccountCode === OWNER_DRAWINGS_CODE) {
    if (!input.owner) {
      return {
        ok: false,
        reason:
          `category "${input.categoryName}" is a personal expense, which belongs to a specific ` +
          `owner — say which owner, or it escapes that owner's drawing limit`,
      };
    }
    // ⛔ Repayable → a RECEIVABLE, not a drawing. Reducing equity for money the business intends to
    // get back would be wrong twice over: equity down, and a receivable nothing records. How a 1260
    // balance later CLEARS — cash, payroll recovery, or written off to 3200 — is a separate act with
    // its own date and author, which is why it is not a routing choice here.
    const repayable = input.owner.treatment === 'repayable';
    lines.push({
      accountCode: repayable ? DUE_FROM_OWNER_CODE : OWNER_DRAWINGS_CODE,
      side: 'debit',
      amount: input.totalAmount,
      lineMemo: repayable ? `${input.categoryName} — owed back` : input.categoryName,
      partyType: 'owner' as const,
      partyId: input.owner.id,
    });
  } else {
    lines.push({
      accountCode: input.categoryAccountCode,
      side: 'debit',
      amount: input.totalAmount,
      lineMemo: input.categoryName,
    });
  }

  if (lines.length < 2) {
    return { ok: false, reason: 'fewer than two non-zero lines — cannot form a balanced entry' };
  }

  return { ok: true, lines };
}
