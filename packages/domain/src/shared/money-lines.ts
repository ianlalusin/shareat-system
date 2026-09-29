/**
 * `MoneyLines` — the pure rules behind every "where did this money come from / go to" form.
 * T-266, `docs/tasks/266-money-lines.md`.
 *
 * ## ⭐ Why this is a module and not a component's internals
 *
 * v1 decides what a payment form allows in **two** places — the editor's dropdown
 * (`expense-editor.tsx:603`, `enabledPaymentMethods`) and its validator
 * (`lib/financial/expense/payments.ts`) — and they have already drifted:
 * `enabledPaymentMethods` is computed from the store's settings and **never passed to the
 * component**, so a store that disabled Credit still offers it and the user finds out at save.
 *
 * ⛔ So the rule is: **the component renders this module's output and the server action
 * re-validates with the same functions.** Nothing here may import React, a database handle, or
 * anything that cannot run on both sides of the boundary. That is what makes the two incapable of
 * disagreeing, rather than merely unlikely to.
 *
 * ⚠️ This module does NOT own the overdraft rule. `judgeDraw`
 * (`packages/domain/src/money-accounts/overdraft.ts`) already does, is already pure, and is
 * already what `approveExpense` calls — so the form calls it too and renders its sentence
 * verbatim. Re-deriving "can this account cover it" here would be a fourth opinion (bible row
 * 154's whole point). This module only decides WHICH ACCOUNT a line draws on and how much each
 * account is asked for; `judgeDraw` decides whether that is allowed.
 */
import { add, compare, money, ZERO, type Money } from '@shareat/core/money';
/**
 * ⭐ Re-exported so a CLIENT component reaches the overdraft verdict through this one pure
 * subpath (`@shareat/domain/money-lines`) instead of the package barrel.
 *
 * ⛔ The barrel re-exports every domain module, several of which import `@shareat/db` — so
 * `import { judgeDraw } from '@shareat/domain'` in a browser bundle pulls the Postgres driver.
 * `next build` refuses it, which is how this was found rather than shipped.
 */
export { judgeDraw, type DrawVerdict, type DrawableAccount } from '../money-accounts/draw-verdict';

// -------------------------------------------------------------------------------------
// Direction and methods
// -------------------------------------------------------------------------------------

/**
 * ⭐ One component, two directions (T-266 §8). The split UI, the add-a-line control and the
 * amount arithmetic are identical; what changes is the method set and four rules.
 *
 * ⛔ Sales money-in is NOT a direction. It is derived from the verified sales day, never picked by
 * a person — a picker there would invent a choice that must not exist.
 */
export type MoneyDirection = 'out' | 'in';

export type MoneyLineMethod =
  | 'cash'
  | 'online'
  | 'credit'
  | 'reimbursable'
  | 'store_credit'
  | 'offset';

/**
 * ⛔ `other` and `ar_collection` are deliberately ABSENT (Ian's ruling 4, 2026-09-11).
 *
 * They remain in `expense_payments.method` for ETL'd history, and `routeExpense` blocks them by
 * design (DEF-054) — but v2's form offered them labelled *"(DEF-054 — blocks posting)"*, which is
 * a choice guaranteed to fail. A method that cannot post is not a method a form offers.
 */
export const MONEY_OUT_METHODS: readonly MoneyLineMethod[] = ['cash', 'online', 'credit', 'reimbursable'];
export const MONEY_IN_METHODS: readonly MoneyLineMethod[] = ['cash', 'online', 'store_credit', 'offset'];

export function methodsForDirection(direction: MoneyDirection): readonly MoneyLineMethod[] {
  return direction === 'out' ? MONEY_OUT_METHODS : MONEY_IN_METHODS;
}

export const METHOD_LABELS: Record<MoneyLineMethod, string> = {
  cash: 'Cash',
  online: 'Online / e-wallet',
  credit: 'Credit (AP)',
  reimbursable: 'Reimbursable (staff paid)',
  store_credit: 'Store credit',
  offset: 'Offset against a charge',
};

// -------------------------------------------------------------------------------------
// The line, and what it draws on
// -------------------------------------------------------------------------------------

export interface MoneyLine {
  method: MoneyLineMethod;
  /** ⚠️ A STRING, always — `parseMoneyInput` owns the conversion (T-260 / DEF-272). Never a
   *  number: `Number('0.004') > 0` is `true` and stores as `0.00`. */
  amount: string;
  moneyAccountId?: string | null;
  /** Required when the chosen account's custodian is `staff` — it is `1120`'s party. */
  cashRequestId?: string | null;
  /** Required for `reimbursable` — `2130`'s party. */
  staffId?: string | null;
  /** ⭐ Per LINE, not per document (DEF-067) — a three-way split has three references. */
  referenceNo?: string | null;
  notes?: string | null;
}

/** What the picker needs to know about one place money can sit. Mirrors `MoneyAccountRow`'s
 *  shape plus the derived balance, so the loader can pass rows through with one join. */
export interface MoneyAccountOption {
  id: string;
  name: string;
  storeId: string;
  custodian: 'cashier' | 'office' | 'staff';
  instrument: 'cash' | 'ewallet' | 'bank';
  glAccountCode: string;
  /** Derived from the ledger by the loader — there is no balance column and never will be. */
  balance: string;
  overdraftLimit: string;
  floatTarget: string | null;
}

/**
 * ⭐ An open float, presented as if it were an account (T-266 §7).
 *
 * > *"online gcash bpi bdo are separate accounts but they are all online, so ana, ben and joy are
 * > staff accounts and they are all staff float"* — Ian, 2026-09-11
 *
 * Labelled by **person**, valued by **outstanding**, identified by the **request**.
 *
 * ⚠️ The label-vs-identity split is only unambiguous because `releaseCashRequest` refuses a second
 * float while one is open for the same person (DEF-159). ⛔ **If that gate is ever relaxed, two
 * rows here can carry the same `holderName`** and the picker silently shows duplicates.
 */
export interface FloatOption {
  cashRequestId: string;
  holderName: string;
  outstanding: string;
  /** The staff-float money account this float posts against — resolves the `1120` GL code. */
  moneyAccountId: string;
  storeId: string;
}

/** One selectable row in the "paid from" list — an account or a float, flattened (§7.3). */
export type SourceOption =
  | ({ kind: 'account' } & MoneyAccountOption)
  | ({ kind: 'float' } & FloatOption);

export function floatAsSource(f: FloatOption): SourceOption {
  return { kind: 'float', ...f };
}

export function accountAsSource(a: MoneyAccountOption): SourceOption {
  return { kind: 'account', ...a };
}

/** What a source row holds right now — the number the picker groups and badges by. */
export function availableOf(source: SourceOption): Money {
  return money(source.kind === 'float' ? source.outstanding : source.balance);
}

/** How a source row is labelled. A float reads as its holder; an account as its own name. */
export function labelOf(source: SourceOption): string {
  return source.kind === 'float' ? source.holderName : source.name;
}

// -------------------------------------------------------------------------------------
// ⭐ Per-ACCOUNT aggregation — §6.3
// -------------------------------------------------------------------------------------

/**
 * ⭐ **Summed per source across every line, never per line.**
 *
 * `approveExpense` already does exactly this and names the reason: *"Two ₱600 cash lines against
 * one ₱1,000 drawer are individually affordable and together are not — checking them one at a
 * time would let exactly that through (the DEF-065 family of error: a split's rows are only ever
 * right when considered together)."*
 *
 * ⛔ A preview that checked each line alone would show green and then be refused at approve, which
 * is worse than showing no preview at all.
 *
 * Keyed by the SOURCE key, not the money account id — two floats share one staff-float account
 * and must not be summed together, because each has its own outstanding balance.
 */
export function sourceKey(line: Pick<MoneyLine, 'moneyAccountId' | 'cashRequestId'>): string | null {
  if (line.cashRequestId) return `float:${line.cashRequestId}`;
  return line.moneyAccountId ? `account:${line.moneyAccountId}` : null;
}

export function keyOfSource(source: SourceOption): string {
  return source.kind === 'float' ? `float:${source.cashRequestId}` : `account:${source.id}`;
}

/** Total asked of each source across the whole document. Unparseable and blank amounts contribute
 *  nothing — they are a half-typed row, not a claim about money. */
export function drawnPerSource(lines: readonly MoneyLine[]): Map<string, Money> {
  const drawn = new Map<string, Money>();
  for (const line of lines) {
    const key = sourceKey(line);
    if (!key) continue;
    const amount = tryMoney(line.amount);
    if (!amount) continue;
    drawn.set(key, add(drawn.get(key) ?? ZERO, amount));
  }
  return drawn;
}

/** `money()` or nothing — never a throw, because this runs on every keystroke in the form. */
export function tryMoney(raw: string | null | undefined): Money | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    return money(trimmed);
  } catch {
    return null;
  }
}

export function totalOfLines(lines: readonly MoneyLine[]): Money {
  return lines.reduce<Money>((sum, l) => add(sum, tryMoney(l.amount) ?? ZERO), ZERO);
}

// -------------------------------------------------------------------------------------
// ⭐ Coverage grouping — §6.1
// -------------------------------------------------------------------------------------

/**
 * ⛔ **Nothing is ever hidden** (Ian's ruling, 2026-09-11). A coverage FILTER would give a shorter
 * list and hide the correct answer most afternoons: a cashier drawer's ledger balance is
 * provisional, because a sales day posts only at verify, so *"a drawer that reads ₱0 at 2pm may
 * hold ₱40,000"* (`overdraft.ts:10-14`). Teaching people that the form lies is how they start
 * working around it.
 */
export type CoverageBand = 'covers' | 'short' | 'empty';

export const COVERAGE_BAND_LABELS: Record<CoverageBand, string> = {
  covers: 'Covers',
  short: 'Has funds, short',
  empty: 'Empty',
};

/**
 * Which band a source falls in, given what THIS document already asks of it.
 *
 * @param alreadyDrawn what other lines have already claimed from this same source — so the second
 *                     line against one drawer is judged on what is left, not the full balance.
 */
export function bandFor(available: Money, needed: Money, alreadyDrawn: Money = ZERO): CoverageBand {
  if (compare(available, ZERO) <= 0) return 'empty';
  const remaining = subtractFloor(available, alreadyDrawn);
  return compare(remaining, needed) >= 0 ? 'covers' : 'short';
}

/** Subtraction that stops at zero — a source already over-drawn reads as empty-for-this-line
 *  rather than negative, which the band language has no way to express. */
function subtractFloor(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? ZERO : money((Number(a) - Number(b)).toFixed(2));
}

export interface GroupedSources {
  band: CoverageBand;
  label: string;
  sources: SourceOption[];
}

/**
 * The picker's three groups, in order, omitting any that is empty.
 *
 * ⭐ Floats are FLAT in here, not behind a second step (§7.3) — Ana sits next to Office cash,
 * because she is the same kind of thing: a holder under a control account. Nobody picks "Online"
 * and then picks GCash.
 */
export function groupSourcesByCoverage(
  sources: readonly SourceOption[],
  needed: Money,
  drawn: ReadonlyMap<string, Money> = new Map(),
): GroupedSources[] {
  const bands: CoverageBand[] = ['covers', 'short', 'empty'];
  return bands
    .map((band) => ({
      band,
      label: COVERAGE_BAND_LABELS[band],
      sources: sources.filter(
        (s) => bandFor(availableOf(s), needed, drawn.get(keyOfSource(s)) ?? ZERO) === band,
      ),
    }))
    .filter((g) => g.sources.length > 0);
}

// -------------------------------------------------------------------------------------
// Validation — the SAME function the server action calls
// -------------------------------------------------------------------------------------

export interface MoneyLineIssue {
  /** Index into `lines`, or `null` for an issue about the document as a whole. */
  line: number | null;
  field: 'method' | 'amount' | 'moneyAccountId' | 'cashRequestId' | 'staffId' | 'referenceNo' | 'document';
  message: string;
}

export interface ValidateMoneyLinesInput {
  direction: MoneyDirection;
  lines: readonly MoneyLine[];
  sources: readonly SourceOption[];
  /** Null when the document names no supplier — `credit` then has no party and is refused. */
  supplierId?: string | null;
  /** ⭐ NULL means this supplier does not take credit (T-266 §5). A number is the terms. */
  supplierCreditTermsDays?: number | null;
  supplierName?: string | null;
  /** When given, the lines must sum to exactly this. */
  mustTotal?: string | null;
}

/**
 * T-361 / DEF-492 — the one sentence for "this supplier takes no credit," shared by two callers:
 * `validateMoneyLines` below (the web action's early, per-line answer) and the domain's own gate
 * on `createExpense`/`editExpense` (the authority for every caller, including the recurring job) —
 * one rule definition, two call sites (bible §15.11, the same shape as `assertNotInverted`).
 */
export function cashOnDeliverySentence(supplierName: string | null): string {
  return `${supplierName ?? 'This supplier'} is cash-on-delivery. Set payment terms on the supplier to pay on credit.`;
}

/**
 * Every rule that can be decided without a database, in one pass.
 *
 * ⚠️ Deliberately NOT here: whether the actor may use a given account (an authorization question —
 * `packages/auth`), and whether an account can afford the draw (`judgeDraw`). This answers *is
 * this document coherent*, nothing more.
 */
export function validateMoneyLines(input: ValidateMoneyLinesInput): MoneyLineIssue[] {
  const issues: MoneyLineIssue[] = [];
  const allowed = methodsForDirection(input.direction);
  const sourcesByKey = new Map(input.sources.map((s) => [keyOfSource(s), s] as const));

  if (input.lines.length === 0) {
    issues.push({ line: null, field: 'document', message: 'Add at least one payment line.' });
  }

  input.lines.forEach((line, i) => {
    if (!allowed.includes(line.method)) {
      issues.push({
        line: i,
        field: 'method',
        message: `"${line.method}" is not available when money is going ${input.direction === 'out' ? 'out' : 'in'}.`,
      });
      return;
    }

    const amount = tryMoney(line.amount);
    if (!amount) {
      // T-353 / DEF-484 — a BLANK amount asks for a value; only a malformed one is quoted back.
      // `String(… ?? '')` covers a hand-posted non-string reaching this far. A string test, not a
      // `Number(…) <op> 0` comparison — no new site for the money-positivity census.
      const blank = String(line.amount ?? '').trim() === '';
      issues.push({
        line: i,
        field: 'amount',
        message: blank ? 'Enter an amount.' : `"${line.amount}" is not a valid amount. Use at most two decimal places.`,
      });
    } else if (compare(amount, ZERO) <= 0) {
      issues.push({ line: i, field: 'amount', message: 'An amount has to be above zero.' });
    }

    if (line.method === 'cash' || line.method === 'online') {
      const key = sourceKey(line);
      const source = key ? sourcesByKey.get(key) : undefined;
      if (!source) {
        issues.push({
          line: i,
          field: 'moneyAccountId',
          message: 'Choose where the money came from — every peso has to leave somewhere nameable.',
        });
      } else if (source.kind === 'account' && source.custodian === 'staff' && !line.cashRequestId) {
        // ⛔ T-266 §4 — the same refusal `routeExpense` makes, surfaced before the user submits
        // rather than after Postgres raises. Never "fixed" by dropping 1120's party requirement.
        issues.push({
          line: i,
          field: 'cashRequestId',
          message:
            'This is paid from a staff float, which belongs to a specific person — say whose, ' +
            'or the float can never be liquidated.',
        });
      } else if (source.kind === 'float') {
        const outstanding = money(source.outstanding);
        if (amount && compare(amount, outstanding) > 0) {
          issues.push({
            line: i,
            field: 'amount',
            message: `${source.holderName}'s float holds ${outstanding} — this line asks for more.`,
          });
        }
      }
    }

    if (line.method === 'reimbursable' && !line.staffId) {
      issues.push({
        line: i,
        field: 'staffId',
        message: 'Say who paid out of pocket — a reimbursable is money owed to a named person.',
      });
    }

    if (line.method === 'credit') {
      if (!input.supplierId) {
        issues.push({
          line: i,
          field: 'method',
          message: 'A credit payment needs a supplier — accounts payable is tracked per supplier.',
        });
      } else if (input.supplierCreditTermsDays === null || input.supplierCreditTermsDays === undefined) {
        // ⭐ T-266 §5. v1 could not ask this at all: its `paymentOptions` is free text nothing reads.
        issues.push({
          line: i,
          field: 'method',
          message: cashOnDeliverySentence(input.supplierName ?? null),
        });
      }
    }
  });

  // ⚠️ v1's rule, kept (`payment-config.ts:66`, `allowMultipleRows: false`): two AP lines on one
  // document are two payables the subledger cannot tell apart.
  if (input.lines.filter((l) => l.method === 'credit').length > 1) {
    issues.push({
      line: null,
      field: 'document',
      message: 'Only one credit line per document.',
    });
  }

  const mustTotal = tryMoney(input.mustTotal);
  if (mustTotal) {
    const total = totalOfLines(input.lines);
    if (compare(total, mustTotal) !== 0) {
      issues.push({
        line: null,
        field: 'document',
        message: `The lines total ${total} but this document is for ${mustTotal}.`,
      });
    }
  }

  return issues;
}
