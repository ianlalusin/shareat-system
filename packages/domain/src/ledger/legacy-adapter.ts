/**
 * legacy-adapter — translates v1's { accountId, direction: 'in'|'out', amount } legs into
 * v2's { accountCode, debit, credit } lines. docs/tasks/107-legacy-leg-adapter.md.
 *
 * v1 never stores debit or credit. It stores a `direction` — balance increased or
 * decreased — and derives the accounting polarity at read time from the account's
 * *inferred* nature: a string-prefix convention on the account id
 * (`src/lib/financial/accounts/account-defs.ts:19-43` in ERP-rebuild, reproduced exactly
 * below as `inferLegacyAccountNature`). v2 does not infer anything — `normalBalance` is a
 * DECLARED column (bible §13 row 39; docs/GLOSSARY.md "normal balance").
 *
 * §4 — the reason this file exists: for every leg, polarity is computed BOTH ways. When
 * they disagree, a Finding is emitted naming the account and both polarities, but the
 * line is ALWAYS written using v2's declared polarity. v1's prefix table is a heuristic
 * over a string; v2's column is a declared fact. This is what turns a translator into an
 * audit instrument (bible §1.4 — the migration IS the audit).
 *
 * Deliberately excluded (Contract §5, "It does not decide whether the entry balances"):
 * NO balance pre-check. A group of legs that cannot balance is adapted anyway (ok:true)
 * and left for `postEntry`'s database constraints to reject at COMMIT — a second
 * implementation of the balance rule here would be a second source of truth.
 *
 * NO imports from `@shareat/db` (Contract §1) — the resolver is injected so this stays a
 * pure, unit-testable function; the real v1->v2 account mapping is T-113's job, not this
 * one's.
 *
 * NEVER THROWS for bad legacy data (Contract §2 / bible §11 rule 5) — bad legacy data is
 * the expected input for a function that will classify millions of ETL rows. Every
 * rejection is a classified `{ ok: false, reason }`, never an exception.
 */
import { moneyFromLegacyFloat, ZERO, type Money } from '@shareat/core/money';

export type LegDirection = 'in' | 'out';

export interface LegacyLeg {
  /** v1's structured id, e.g. 'cash__cashier', 'ap__SUP123'. */
  accountId: string;
  direction: LegDirection;
  /** v1 stored every peso as a JS float — see the money section below. */
  amount: string | number;
  legKey?: string;
}

export type NormalBalance = 'debit' | 'credit';

export interface ResolvedAccount {
  /** v2 account code, e.g. '1110'. */
  code: string;
  normalBalance: NormalBalance;
  isPostable: boolean;
  /**
   * Carried through the contract but deliberately NEVER used to gate anything here
   * (invariant 11): a reserved or archived account resolves and adapts fine. Account
   * eligibility by status is `postEntry` / the database's job (T-103's trigger), not
   * this function's — checking it twice would be a second source of truth.
   */
  status: 'active' | 'reserved' | 'archived';
}

export interface AdaptedLine {
  accountCode: string;
  /** Money as a decimal string, matching numeric(14,2). '0.00' when this leg is not on
   *  the debit side. Minted (T-371): `moneyFromLegacyFloat` or ZERO, never a bare string. */
  debit: Money;
  /** Money as a decimal string. '0.00' when this leg is not on the credit side. */
  credit: Money;
  legKey?: string;
}

/**
 * A classified observation, never an error. Findings accumulate alongside a successful
 * (`ok: true`) adaptation — they never turn a group into a rejection (invariant 15).
 */
export type Finding =
  | {
      type: 'polarity_disagreement';
      accountId: string;
      legKey?: string;
      /** What v1's inferred prefix nature says this leg's polarity is. */
      v1Polarity: NormalBalance;
      /** What v2's declared normalBalance says — this is what the line is ALWAYS written with. */
      v2Polarity: NormalBalance;
      message: string;
    }
  | {
      type: 'precision_loss';
      accountId: string;
      legKey?: string;
      /** The legacy amount exactly as received, stringified — never itself rounded. */
      rawAmount: string;
      /** The Money value this amount was rounded to (half-away-from-zero, matching v1's
       *  own roundMoney()) and actually written to the line. */
      roundedAmount: string;
      message: string;
    };

export type AdaptResult =
  | { ok: true; lines: AdaptedLine[]; findings: Finding[] }
  | { ok: false; reason: string; findings: Finding[] };

/**
 * Reproduces `account-defs.ts:19-43` (ERP-rebuild) EXACTLY — Contract §4 requires the
 * exact same rule, not a paraphrase, because the whole point of the disagreement check is
 * to compare v2's declared fact against the ACTUAL legacy heuristic, not against a
 * plausible-sounding approximation of it.
 *
 * Credit for: ap__*, liability__*, staff_reimbursable__*, income__*, equity__*,
 * contra_asset__*, and the single EXACT string 'others__remittance_overage' (not a
 * prefix — every other `others__*` id falls into "everything else"). Debit for
 * everything else, including an explicit (redundant but intentional, matching the
 * source) `clearing__*` case.
 */
export function inferLegacyAccountNature(accountId: string): NormalBalance {
  if (accountId.startsWith('ap__')) return 'credit';
  if (accountId.startsWith('liability__')) return 'credit';
  if (accountId.startsWith('staff_reimbursable__')) return 'credit';
  if (accountId.startsWith('income__')) return 'credit';
  if (accountId.startsWith('equity__')) return 'credit';
  if (accountId.startsWith('contra_asset__')) return 'credit';
  if (accountId === 'others__remittance_overage') return 'credit';
  if (accountId.startsWith('clearing__')) return 'debit';
  return 'debit';
}

/**
 * v1's own read-time derivation (`balancer.ts:52-56`, `isLegDebit`): nature x direction.
 * A debit-normal account increasing ('in'), or a credit-normal account decreasing
 * ('out'), is the debit contribution; everything else is the credit contribution.
 */
function legacyPolarity(accountId: string, direction: LegDirection): NormalBalance {
  const nature = inferLegacyAccountNature(accountId);
  const isDebit = (nature === 'debit' && direction === 'in') || (nature === 'credit' && direction === 'out');
  return isDebit ? 'debit' : 'credit';
}

/**
 * v2's translation (the table in the task spec): `direction` says which way the balance
 * moved, `normalBalance` says which side of the ledger that means.
 *   in  + debit-normal  -> debit      in  + credit-normal -> credit
 *   out + debit-normal  -> credit     out + credit-normal -> debit
 */
function declaredPolarity(direction: LegDirection, normalBalance: NormalBalance): NormalBalance {
  if (direction === 'in') return normalBalance;
  return normalBalance === 'debit' ? 'credit' : 'debit';
}

/**
 * Normalizes a legacy amount (string or number, per LegacyLeg) to a finite JS number, or
 * null if it cannot be interpreted as one at all (garbage legacy data — classified, never
 * thrown).
 */
function toFiniteNumber(amount: string | number): number | null {
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) ? n : null;
}

export function adaptLegacyLegs(
  legs: LegacyLeg[],
  resolve: (accountId: string) => ResolvedAccount | null,
): AdaptResult {
  if (legs.length === 0) {
    return { ok: false, reason: 'adaptLegacyLegs: empty leg array', findings: [] };
  }

  const lines: AdaptedLine[] = [];
  const findings: Finding[] = [];

  for (const leg of legs) {
    const resolved = resolve(leg.accountId);
    if (!resolved) {
      return {
        ok: false,
        reason: `adaptLegacyLegs: unresolvable accountId '${leg.accountId}'`,
        findings,
      };
    }

    if (!resolved.isPostable) {
      return {
        ok: false,
        reason: `adaptLegacyLegs: account '${leg.accountId}' (v2 code '${resolved.code}') is not postable`,
        findings,
      };
    }

    const numericAmount = toFiniteNumber(leg.amount);
    if (numericAmount === null) {
      return {
        ok: false,
        reason: `adaptLegacyLegs: amount for account '${leg.accountId}' is not a finite number: ${JSON.stringify(leg.amount)}`,
        findings,
      };
    }
    if (numericAmount <= 0) {
      return {
        ok: false,
        reason: `adaptLegacyLegs: non-positive amount for account '${leg.accountId}': ${numericAmount}`,
        findings,
      };
    }

    // Money — §3. `moneyFromLegacyFloat` is the ETL-only helper built for exactly this:
    // convert a v1 float into Money, reporting (never throwing on) precision loss.
    const { value: amountMoney, rounded } = moneyFromLegacyFloat(numericAmount);
    if (rounded) {
      findings.push({
        type: 'precision_loss',
        accountId: leg.accountId,
        legKey: leg.legKey,
        rawAmount: String(leg.amount),
        roundedAmount: amountMoney,
        message: `account '${leg.accountId}': legacy amount ${String(leg.amount)} does not survive the round trip to numeric(14,2) exactly — stored as ${amountMoney}`,
      });
    }

    // §4 — the disagreement check. Computed both ways; v2's is always what gets written.
    const v1Polarity = legacyPolarity(leg.accountId, leg.direction);
    const v2Polarity = declaredPolarity(leg.direction, resolved.normalBalance);
    if (v1Polarity !== v2Polarity) {
      findings.push({
        type: 'polarity_disagreement',
        accountId: leg.accountId,
        legKey: leg.legKey,
        v1Polarity,
        v2Polarity,
        message: `account '${leg.accountId}' (v2 code '${resolved.code}'): v1's inferred prefix nature implies ${v1Polarity}, v2's declared normalBalance implies ${v2Polarity} — writing the line as ${v2Polarity}`,
      });
    }

    lines.push({
      accountCode: resolved.code,
      debit: v2Polarity === 'debit' ? amountMoney : ZERO,
      credit: v2Polarity === 'credit' ? amountMoney : ZERO,
      legKey: leg.legKey,
    });
  }

  return { ok: true, lines, findings };
}
