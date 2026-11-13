/**
 * Channel settlement — clearing the receivable Foodpanda and Grab raise. T-150.
 * Spec: `docs/tasks/150-channel-settlement.md`, written by a peer session 2026-08-28.
 *
 * ⭐ T-123 raises `1220 Channel receivable` on every verified delivery-platform day and **nothing
 * has ever cleared it**. This is 74% of v1's AR collection volume, and Phase 2's exit gate —
 * *"subledgers tie to control accounts"* — cannot pass while `1220` only grows.
 *
 * ⛔ **The fees are booked HERE, ONCE.** v1 recognised a platform fee both in the settlement and
 * again as a separate expense document, and it cost **₱198,148.29** across two stores. One
 * function owns these legs, which makes the double-count impossible rather than merely forbidden.
 */
import { advisoryLocksRepo, auditLogRepo, channelSettlementsRepo, loansRepo, moneyAccountsRepo, moneyTransfersRepo, settlementIntakeRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import { compare, fromCentavos, isZero, money, negate, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { parseDecimalInput, parseMoneyInput } from '../shared/money-input';
import { assertFieldRules } from '../shared/field-rules-assert';
import { CHANNEL_PAYOUT_DESTINATION_RULES, CHANNEL_SETTLEMENT_RECORD_RULES, SETTLEMENT_DIFFERENCE_RULES } from '../field-rules/channel-settlements';
import { refuse } from '../shared/refusal';
import { loadRuleBook } from '../business-rules/rules';
import type { BusinessRuleKey } from '../business-rules/registry';
import type { RuleBook } from '../business-rules/book';

const R = channelSettlementsRepo;

/**
 * ⚠️ Above this, a variance is not a rounding difference — it is a disagreement, and the posting
 * is refused so somebody reconciles instead of sweeping it to expense.
 *
 * T-371 — max(floor, percent of |gross|), exact, in THOUSANDTHS of a peso, never a float. T-512 (T-511 S5c): the floor
 * and the percent are the business rules `settlement.variance_floor_amount` (default 50.00) and `settlement.variance_percent`
 * (default 10), read on the business date and passed in as `{ floorCentavos, percentBp }`; percentBp is percent x 100. At the
 * defaults this is the same figure as before: |centavos| x 1000 / 1000 is |centavos| thousandths, the floor 5,000 centavos is
 * 50,000 thousandths. A percent that does not divide into whole thousandths is rounded half up at that scale, which is a
 * hundred times finer than the half-centavo allowance below. The old `EPSILON = 0.005` decimal-noise allowance is gone with
 * the floats it existed for: "above tolerance + ₱0.005" is exactly "10 × centavos > tolerance thousandths + 5".
 */
export interface VarianceRules {
  floorCentavos: bigint;
  percentBp: bigint;
}

export const VARIANCE_RULE_KEYS = ['settlement.variance_floor_amount', 'settlement.variance_percent'] as const satisfies readonly BusinessRuleKey[];

/** The variance rules in force on one date, from a loaded rule book (which must have been loaded for `VARIANCE_RULE_KEYS`). */
export function varianceRulesOn(book: RuleBook, date: string): VarianceRules {
  return {
    floorCentavos: book.valueOn('settlement.variance_floor_amount', date).centavos(),
    percentBp: book.valueOn('settlement.variance_percent', date).basisPoints(),
  };
}

export function toleranceMillsFor(grossCentavos: bigint, rules: VarianceRules): bigint {
  const abs = grossCentavos < 0n ? -grossCentavos : grossCentavos;
  const byPercent = (abs * rules.percentBp + 500n) / 1000n;
  const floor = rules.floorCentavos * 10n;
  return byPercent > floor ? byPercent : floor;
}

/** Thousandths to the nearest centavo (half up) — the tolerance as the screen shows it. Non-negative only. */
function millsToMoney(mills: bigint): Money {
  return fromCentavos((mills + 5n) / 10n);
}

/** Is a centavo figure past the tolerance (thousandths), allowing the half-centavo the float version allowed? */
export function pastTolerance(centavos: bigint, toleranceMills: bigint): boolean {
  return centavos * 10n > toleranceMills + 5n;
}

export interface SettlementDeductions {
  commission?: string;
  marketing?: string;
  platformFee?: string;
  vatOnFees?: string;
  withholdingTax?: string;
  penalty?: string;
}

export interface RecordSettlementInput {
  storeId: string;
  channelId: string;
  salesDayId: string;
  businessDate: string;
  /** What the platform says it settled, gross. */
  grossAmount: string;
  /** What actually landed in the bank. */
  netDeposited: string;
  deductions?: SettlementDeductions;
  /**
   * T-511 S6a: the loans this payout docked, one leg each. The loan deduction is the SUM of the legs; there is no separate deduction input. A leg with a blank
   * loan id is a picker left open and is dropped; an empty or absent list is a settlement with no loan. `ownerStoreId` absent, null or the paying store is a
   * same-store leg (a 2400 debit); another store is the 1250 / 2400 / 2150 triple. The same (loan, owner store) twice is refused.
   */
  loanLegs?: LoanLegInput[];
  reference?: string | null;
  settledOn: string;
  withholdingCertificateFileId?: string | null;
  /**
   * ⚠️ Required when the payout differs from the day by MORE than the tolerance, either sign: a shortfall books to 6420, a gain to 7100, and a person says why.
   * Without it a typo can quietly become expense or revenue. Within tolerance it is ignored (not stored, not refused).
   */
  acknowledgeDifference?: { reason: string } | null;
  /**
   * T-511 S6c: the booked period charges (`postPlatformCharge` -> `channel_period_charges.id`) the platform netted out of THIS payout. Each already credited the receivable
   * when it was booked, so the payout clears that much LESS of it: naming them is what stops the charge being expensed a second time as a settlement variance. Same channel
   * and store, booked, not already netted by a live (not voided) settlement; a duplicate id counts once. Empty or absent is no charge netted.
   */
  settleChargeIds?: string[];
}

export interface LoanLegInput {
  loanId: string;
  /** numeric(14,2) text; never negative, more than zero */
  amount: string;
  ownerStoreId?: string | null;
}

export interface SettlementResult {
  settlementId: string;
  entryId: string;
  variance: string;
  settlementGain: string;
}

/**
 * ⭐ **What this settlement WILL do, before it does it** — DEF-137.
 *
 * The screen has to show a variance or a gain *before* the Post button, because the tolerance
 * refusal is the whole control: *"that is a disagreement, not rounding — reconcile it."* Telling
 * somebody that only after they post is telling them too late.
 *
 * ⚠️ **The obvious implementation is the wrong one.** Recomputing the arithmetic in the form —
 * or in the page, or in a second service — is a second source of truth for the one number this
 * feature exists to police, and the two would drift the first time a deduction kind is added.
 * So `computeSettlement` below is the ONLY place the arithmetic lives, and `recordChannelSettlement`
 * and `previewChannelSettlement` are both callers of it. A preview that disagreed with the posting
 * would be worse than no preview at all.
 */
export interface SettlementPreview {
  channelName: string;
  storeId: string;
  /** What `1220` says this channel is still owed, right now. Derived, never stored. */
  outstanding: string;
  /** What this settlement would credit `1220` — capped at what is actually owed, less the booked charges it nets (S6c). The same figure the posting stores. */
  outstandingCleared: string;
  /** The six deduction kinds, summed. **Signed** — a promo day can make this negative. */
  feesTotal: string;
  loanDeduction: string;
  netDeposited: string;
  variance: string;
  settlementGain: string;
  tolerance: string;
  destinationAccountName: string | null;
  /**
   * Why this cannot post as entered. **Empty means it will post.** The first entry is the exact
   * sentence `recordChannelSettlement` would throw, because they come from the same function.
   */
  blockers: string[];
  /**
   * T-511 S6a: true when the payout differs from the day by more than the tolerance and no valid acknowledgement (a non-blank reason of at most 500 characters)
   * was given. Either sign.
   */
  needsAcknowledgement: boolean;
  /** The ABSOLUTE difference between the day and the payout, 2 decimals, whatever the tolerance ('0.00' when exact). */
  difference: string;
  /** 'short': the payout is less than the day (staff over-reported); 'over': more (staff under-reported); 'none': exact. */
  differenceSign: DifferenceSign;
  /**
   * T-351 / DEF-482 — false means every figure field above is a placeholder zero
   * (`ZERO_COMPUTED_SETTLEMENT`), not a real answer: at least one gross/net/deduction box failed to
   * parse, so there was no safe `Number()` to compute with. The form must show NONE of the figure
   * rows when this is false — "Banked ₱0.00" under a typed `1,5` is as misleading as a green
   * "reconciles exactly" would be. A config blocker (e.g. no payout account) does not affect this —
   * the arithmetic is still real even when the settlement cannot post for an unrelated reason.
   */
  figuresComputed: boolean;
}

export type DifferenceSign = 'short' | 'over' | 'none';

interface ComputedSettlement {
  outstandingCleared: Money;
  feesTotal: Money;
  loanDeduction: Money;
  netDeposited: Money;
  variance: Money;
  settlementGain: Money;
  tolerance: Money;
  blockers: string[];
  needsAcknowledgement: boolean;
  difference: Money;
  differenceSign: DifferenceSign;
  /** The trimmed reason of a VALID acknowledgement given past tolerance; null otherwise (nothing is stored when none was needed). */
  acknowledgedReason: string | null;
}

/** S5.5v Amendment A2 item 2 — what a preview shows while a figure refusal blocks the arithmetic:
 *  zeroed, never NaN. */
const ZERO_COMPUTED_SETTLEMENT: ComputedSettlement = {
  outstandingCleared: ZERO,
  feesTotal: ZERO,
  loanDeduction: ZERO,
  netDeposited: ZERO,
  variance: ZERO,
  settlementGain: ZERO,
  tolerance: ZERO,
  blockers: [],
  needsAcknowledgement: false,
  difference: ZERO,
  differenceSign: 'none',
  acknowledgedReason: null,
};

/**
 * T-371 — every typed figure, parsed (after `authorize()`) into a `Money` brand. The arithmetic and
 * the writer only ever see these, never the raw strings. A deduction left blank or absent is
 * `undefined`: no such deduction (R6 — its column carries a default; nothing invents a `'0'`).
 */
interface SettlementFigures {
  gross: Money;
  netDeposited: Money;
  deductions: Partial<Record<keyof SettlementDeductions, Money>>;
  /** The legs that survived the blank-loan drop, amounts parsed; `ownerStoreId` is the OWNER (the paying store's own id for a same-store leg, never null). */
  loanLegs: { loanId: string; ownerStoreId: string; amount: Money }[];
}

type FigureAccumulator = Partial<SettlementFigures> & { deductions: SettlementFigures['deductions']; loanLegs: SettlementFigures['loanLegs'] };

/** A leg with a blank loan id is a picker left open: it is not a leg (as the single loan was dropped). A loan id is trimmed and lower-cased, so the same loan typed twice in two cases is one loan. */
function realLoanLegs(legs: readonly LoanLegInput[] | undefined): LoanLegInput[] {
  return (legs ?? [])
    .filter((l) => (l.loanId ?? '').trim() !== '')
    .map((l) => ({ ...l, loanId: l.loanId.trim().toLowerCase(), ownerStoreId: l.ownerStoreId?.trim() || null }));
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The loans a settlement docks must be real loans of this organisation, and each leg's owner must be the store the loan belongs to: the 2400 debit is booked at the
 * owner (as `recordLoanPayment` books it at `loan.storeId`), so a leg naming any other store would debit a store for a debt it never owed. Plain sentences, never a raw database error.
 */
async function loanLegBlockers(tx: Tx, orgId: string, legs: SettlementFigures['loanLegs']): Promise<string[]> {
  const out: string[] = [];
  for (const leg of legs) {
    const loan = UUID_TEXT.test(leg.loanId) ? await loansRepo.getById(tx, orgId, leg.loanId) : undefined;
    if (!loan) {
      out.push('One of the loans docked from this payout could not be found. Pick the loan again from the list.');
    } else if (loan.storeId !== leg.ownerStoreId) {
      out.push(`The loan "${loan.name}" does not belong to the store named as its owner. The owner of a docked loan must be the store the loan belongs to.`);
    }
  }
  return out;
}

/**
 * T-343 S5.5s / DEF-470 item 8 — every figure below reached bare `Number()` in `computeSettlement`
 * with no parse at all: a comma-typed value became `NaN`, `NaN`-blind comparisons let it slip past
 * every guard, and the write itself hit a raw, unmapped `_finite_check`/`_identity_check` CHECK
 * violation. T-371: the parse now RETURNS the `Money` brands, and `computeSettlement` computes on
 * those (whole centavos) — no raw string reaches the arithmetic or the writer.
 */
const DEDUCTION_LABELS: Record<keyof SettlementDeductions, string> = {
  commission: 'The commission',
  platformFee: 'The platform fee',
  vatOnFees: 'The VAT on fees',
  marketing: 'The channel marketing',
  withholdingTax: 'The withholding tax',
  penalty: 'The penalty',
};

/** Lowercases just the leading word, so a human label reads naturally as a raw's trailing clause
 *  ("The commission" → "the commission"). */
function lead(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * S5.5v Amendment A2 item 1 — gross/net's blank refusal moved HERE from the app action, so it runs
 * AFTER `authorize()` (the domain's own rule: "authorize() is the FIRST thing either does"). Ian's
 * Q1 ruling (S5.5v): gross/net are copied off a physical payout statement, so a blank box is
 * someone who has not looked yet, never a zero the way a deduction's blank is.
 */
function figureBlank(raw: string, key: string, label: string, fn: string): void {
  if (raw.trim() === '') {
    throw refuse(`${fn}: ${key} is blank`, `${label} — enter the figure from the payout statement.`);
  }
}

/**
 * Every field's own check, as a list of thunks — `fn` is the caller's own name
 * (`previewChannelSettlement`/`recordChannelSettlement`), so the raw names which one actually
 * refused. Shared by `assertSettlementFigures` (throws on the first) and
 * `collectSettlementFigureBlockers` (item 3 — collects every one, for a preview).
 */
function figureChecks(
  fn: string,
  input: Pick<RecordSettlementInput, 'grossAmount' | 'netDeposited' | 'deductions' | 'loanLegs' | 'storeId'>,
  out: FigureAccumulator,
): Array<() => void> {
  const checks: Array<() => void> = [
    () => {
      figureBlank(input.grossAmount, 'grossAmount', 'The gross settled', fn);
      out.gross = parseMoneyInput(input.grossAmount, `${fn}: the gross amount`, 'The gross settled');
    },
    () => {
      figureBlank(input.netDeposited, 'netDeposited', 'The net deposited', fn);
      out.netDeposited = parseMoneyInput(input.netDeposited, `${fn}: the net deposited`, 'The net deposited');
    },
  ];
  const d = input.deductions ?? {};
  for (const key of Object.keys(DEDUCTION_LABELS) as (keyof SettlementDeductions)[]) {
    const v = d[key];
    if (v !== undefined) {
      checks.push(() => {
        // T-371 R6 — every deduction column carries a default, so a blank box is OMITTED: no such deduction.
        const parsed = parseDecimalInput(v, '14,2', `${fn}: ${lead(DEDUCTION_LABELS[key])}`, DEDUCTION_LABELS[key], { blank: 'omit' });
        if (parsed !== undefined) out.deductions[key] = parsed;
      });
    }
  }
  const legs = realLoanLegs(input.loanLegs);
  for (const leg of legs) {
    checks.push(() => {
      const amount = parseMoneyInput(leg.amount, `${fn}: the loan amount docked`, 'The amount docked');
      if (compare(amount, ZERO) < 0) {
        throw refuse(`${fn}: the loan amount docked cannot be negative.`, 'The amount docked cannot be negative.');
      }
      if (compare(amount, ZERO) === 0) {
        throw refuse(`${fn}: the loan amount docked cannot be zero.`, 'The amount docked for a loan must be more than zero. Leave the loan out if nothing was docked.');
      }
      out.loanLegs.push({ loanId: leg.loanId, ownerStoreId: leg.ownerStoreId || input.storeId, amount });
    });
  }
  // The same (loan, owner store) twice would be one row in the database (unique), so it is said in words here: in the preview and in the posting alike.
  checks.push(() => {
    const seen = new Set<string>();
    for (const leg of legs) {
      const key = `${leg.loanId}|${leg.ownerStoreId || input.storeId}`;
      if (seen.has(key)) {
        throw refuse(`${fn}: the same loan is listed twice.`, 'The same loan is listed twice. Put the amounts for one loan together in one line.');
      }
      seen.add(key);
    }
  });
  return checks;
}

/** Every check passed, so every figure is present — narrowed without a cast. */
function completeFigures(out: FigureAccumulator): SettlementFigures {
  if (out.gross === undefined || out.netDeposited === undefined) {
    throw refuse(
      'channel settlement: a figure check passed without recording its figure — that is a bug.',
      'The settlement figures could not be read. Nothing was saved; try again.',
    );
  }
  return { gross: out.gross, netDeposited: out.netDeposited, deductions: out.deductions, loanLegs: out.loanLegs };
}

/** `recordChannelSettlement`'s shape — all-or-nothing, throws on the first bad field. */
function assertSettlementFigures(
  fn: string,
  input: Pick<RecordSettlementInput, 'grossAmount' | 'netDeposited' | 'deductions' | 'loanLegs' | 'storeId'>,
): SettlementFigures {
  const out: FigureAccumulator = { deductions: {}, loanLegs: [] };
  for (const check of figureChecks(fn, input, out)) check();
  return completeFigures(out);
}

/** Presentable message off a thrown refusal — S5.5v Amendment A2 item 4: never developer text in
 *  a blocker. An unpresentable error is logged with its raw, and the blocker names no detail. */
function blockerMessageFor(err: unknown): string {
  const userMessage = err instanceof Error ? (err as unknown as { userMessage?: unknown }).userMessage : undefined;
  if (typeof userMessage === 'string') return userMessage;
  logger.error({ err }, 'channel settlement figure refusal carried no presentable message');
  return 'One of the figures could not be read.';
}

/** S5.5v Amendment A2 item 3 — the preview's own variant: collects EVERY field's refusal instead
 *  of stopping at the first, because a form that fixes one error at a time makes four round trips
 *  out of one. */
function collectSettlementFigureBlockers(
  fn: string,
  input: Pick<RecordSettlementInput, 'grossAmount' | 'netDeposited' | 'deductions' | 'loanLegs' | 'storeId'>,
): { blockers: string[]; figures: SettlementFigures | null } {
  const blockers: string[] = [];
  const out: FigureAccumulator = { deductions: {}, loanLegs: [] };
  for (const check of figureChecks(fn, input, out)) {
    try {
      check();
    } catch (err) {
      blockers.push(blockerMessageFor(err));
    }
  }
  return { blockers, figures: blockers.length === 0 ? completeFigures(out) : null };
}

/**
 * ⭐ **The one copy of the arithmetic and of every refusal that depends on it.**
 *
 * Pure: it takes the figures and the ledger's answer for what is outstanding, and returns what
 * would be posted plus the reasons it would be refused. It never reads and never writes, which is
 * exactly what lets the preview and the posting be the same code rather than two implementations
 * of one rule.
 */
function computeSettlement(
  figures: SettlementFigures,
  acknowledge: { reason: string } | null | undefined,
  outstanding: Money,
  /** T-511 S6c: the total of the booked charges this payout netted (signed; zero when none). */
  nettedCharges: Money,
  channelName: string,
  rules: VarianceRules,
): ComputedSettlement {
  // T-371 — whole centavos (bigint) throughout, never `Number()`: a figure that is not a parsed
  // `Money` cannot reach this function, and no comparison here can be NaN-blind.
  const c = (v: Money | undefined | null): bigint => (v == null ? 0n : toCentavos(v));
  const d = figures.deductions;
  const feesTotal =
    c(d.commission) + c(d.marketing) + c(d.platformFee) + c(d.vatOnFees) + c(d.withholdingTax) + c(d.penalty);
  const loanDeduction = figures.loanLegs.reduce((t, l) => t + toCentavos(l.amount), 0n);
  const netDeposited = c(figures.netDeposited);
  const gross = c(figures.gross);
  const netted = c(nettedCharges);
  // The charges already credited 1220 when they were booked, so before them the receivable stood at owed + netted.
  const owedGross = c(outstanding) + netted;
  const toleranceMills = toleranceMillsFor(gross, rules);
  const tolerance = millsToMoney(toleranceMills);

  const blockers: string[] = [];

  if (netDeposited < 0n) {
    blockers.push(NEGATIVE_DEPOSIT_BLOCKER);
  }
  if (owedGross <= 0n) {
    blockers.push(
      `${channelName} has nothing outstanding to settle. Either the sales day was never ` +
        'verified, or this payout is already settled.',
    );
  }

  // The receivable this clears is capped at what is actually outstanding — settling more than
  // is owed would drive 1220 negative, which is never a real state.
  // T-511 S6c: what the payout settles of the receivable, less the charges it nets (they were credited when booked). This is the figure STORED and credited to 1220,
  // so `channel_settlements_identity_check` (cleared + gain = fees + variance + loan + net) holds.
  const settled = owedGross < gross ? owedGross : gross;
  const outstandingCleared = settled - netted;
  if (netted !== 0n && outstandingCleared < 0n) {
    blockers.push(
      `The charges netted out of this payout (₱${fromCentavos(netted)}) are more than the receivable this payout settles (₱${fromCentavos(settled)}). ` +
        'Name only the charges the platform took out of this payout.',
    );
  }

  // Nothing to post at all (the netted charges use up the whole receivable and no money, fee or loan moved): refuse in words instead of an empty entry.
  const anyFee = [d.commission, d.marketing, d.platformFee, d.vatOnFees, d.withholdingTax, d.penalty].some((v) => c(v) !== 0n);
  if (outstandingCleared === 0n && netDeposited === 0n && !anyFee && figures.loanLegs.every((l) => toCentavos(l.amount) === 0n)) {
    blockers.push(
      `There is nothing to record for ${channelName}: the charges netted out of this payout use up the whole receivable it settles, and no money was deposited.`,
    );
  }

  // ⭐ variance is a statement about the SALES DAY, not about the platform.
  //    positive → staff over-reported; the shortfall is swept to 6420
  //    negative → staff under-reported; the excess is income at 7100
  const difference = outstandingCleared - (feesTotal + loanDeduction + netDeposited);
  const variance = difference > 0n ? difference : 0n;
  const settlementGain = difference < 0n ? -difference : 0n;

  // T-511 S6a: ONE acknowledgement for a difference of EITHER sign past tolerance (a shortfall used to be refused outright, a gain needed a tick).
  // Within tolerance an acknowledgement is ignored: nothing is stored and nothing is refused.
  const absDifference = difference < 0n ? -difference : difference;
  const differenceSign: DifferenceSign = difference > 0n ? 'short' : difference < 0n ? 'over' : 'none';
  let needsAcknowledgement = false;
  let acknowledgedReason: string | null = null;
  if (pastTolerance(absDifference, toleranceMills)) {
    if (acknowledge) {
      // the one server call of the rule set (the preview collects the refusal as a blocker, the posting throws it)
      try {
        acknowledgedReason = assertFieldRules(SETTLEMENT_DIFFERENCE_RULES, { reason: acknowledge.reason }).reason ?? null;
      } catch (e) {
        blockers.push(blockerMessageFor(e));
      }
    }
    if (acknowledgedReason === null) {
      needsAcknowledgement = true;
      if (!acknowledge) {
        blockers.push(
          differenceSign === 'short'
            ? `the day is short by ₱${fromCentavos(absDifference)}, past the ₱${tolerance} tolerance. A person has to accept that difference with a reason ` +
                '(acknowledgeDifference) before it books to expense; otherwise reconcile it against the platform statement.'
            : `the payout exceeds the day by ₱${fromCentavos(absDifference)}, past the ₱${tolerance} tolerance. A person has to accept that difference with a reason ` +
                '(acknowledgeDifference) before it books as income — a typo must not quietly become revenue.',
        );
      }
    }
  }

  return {
    outstandingCleared: fromCentavos(outstandingCleared),
    feesTotal: fromCentavos(feesTotal),
    loanDeduction: fromCentavos(loanDeduction),
    netDeposited: fromCentavos(netDeposited),
    variance: fromCentavos(variance),
    settlementGain: fromCentavos(settlementGain),
    tolerance,
    blockers,
    needsAcknowledgement,
    difference: fromCentavos(absDifference),
    differenceSign,
    acknowledgedReason,
  };
}

/**
 * The channel-level refusals, in the order they are listed: wrong store, no destination account, a posted settlement already. Pure, so the preview and the
 * T-511 review list (which asks about many days at once) say the same words. `alreadyPosted` is what `postedSettlementFor` found.
 */
export function settlementConfigBlockers(
  config: { name: string; storeId: string; destinationMoneyAccountId: string | null },
  input: { storeId: string; businessDate: string },
  alreadyPosted: boolean,
): string[] {
  const configBlockers: string[] = [];
  // ⚠️ The channel names its own store, and the caller names one too. They must agree, or the
  // 1220 leg lands on a store that never made the sale — a cross-store misposting that nothing
  // downstream would flag, because both stores are legitimate rows in the same books.
  if (config.storeId !== input.storeId) {
    configBlockers.push(
      `${config.name} belongs to another store. A settlement is recorded by the store whose ` +
        'sales day raised the receivable.',
    );
  }
  if (!config.destinationMoneyAccountId) {
    configBlockers.push(
      `${config.name} has no destination account set, so there is nowhere to bank this. Set the ` +
        'channel’s destination money account first.',
    );
  }
  if (alreadyPosted) {
    configBlockers.push(
      `${config.name} already has a posted settlement for ${input.businessDate}. Void that one ` +
        'first — a correction is void and re-post, never a second row.',
    );
  }
  return configBlockers;
}

/** The refusal for a payout the fees overrun; exported with `settlementConfigBlockers` for the same reason. */
export const NEGATIVE_DEPOSIT_BLOCKER =
  'fees exceeding the payout is a refusal, not a negative deposit. ' + 'Check the figures against the platform statement.';

/**
 * Everything a settlement needs to know before the arithmetic: the channel's configuration, what
 * the ledger says it is owed, and whether this day is already settled.
 *
 * ⚠️ Shared by the preview and the posting so a screen cannot be shown a green light the posting
 * then refuses. `authorize()` is the FIRST thing either does — a preview reveals a channel's
 * outstanding balance, so it is gated exactly as recording is.
 */
async function gatherSettlementContext(
  trx: Tx,
  actor: Actor,
  input: { storeId: string; channelId: string; businessDate: string; settleChargeIds?: readonly string[] },
  /** The posting locks each netted charge before reading whether it is taken; the preview only reads. */
  lockCharges: boolean,
): Promise<{
  config: { name: string; storeId: string; destinationMoneyAccountId: string | null; taxTreatment: string };
  destinationName: string | null;
  outstanding: Money;
  /** T-511 S6c: the netted charges, de-duplicated, and their total. */
  chargeIds: string[];
  nettedCharges: Money;
  chargeBlockers: string[];
  configBlockers: string[];
  /** T-512 — the variance rules in force on the business date: one rule-book query, the same for the preview and the posting. */
  variance: VarianceRules;
}> {
  await authorize(trx, actor, 'record_ar_collection', { storeId: input.storeId });

  const config = await R.channelConfig(trx, actor.orgId, input.channelId);
  if (!config) throw new Error(`channel ${input.channelId} does not exist.`);

  const already = await R.postedSettlementFor(trx, actor.orgId, input.channelId, input.businessDate);
  const configBlockers = settlementConfigBlockers(config, input, Boolean(already));

  let destinationName: string | null = null;
  if (config.destinationMoneyAccountId) {
    const destination = await moneyAccountsRepo.getById(trx, actor.orgId, config.destinationMoneyAccountId);
    destinationName = destination?.name ?? null;
  }

  // T-371 R4 — the ledger's balance is re-minted, never `Number()`-ed: a malformed figure throws here.
  const outstanding = money(await R.outstandingFor(trx, actor.orgId, input.channelId));
  const variance = varianceRulesOn(await loadRuleBook(trx, actor.orgId, VARIANCE_RULE_KEYS), input.businessDate);
  const netting = await chargeNetting(trx, actor.orgId, input, config, lockCharges);
  return { config, destinationName, outstanding, chargeIds: netting.ids, nettedCharges: netting.total, chargeBlockers: netting.blockers, configBlockers, variance };
}

/**
 * T-511 S6c - the booked charges this payout nets: de-duplicated (a repeated id counts once), each one checked in plain words, and (for the posting) serialised per
 * charge by a transaction advisory lock taken in sorted order BEFORE the "already netted" read, so two payouts naming one charge cannot both pass. An id that is not a
 * booked charge (unknown, a staged line, another org's) reads as "could not be found". A link counts only through a settlement that is not voided.
 */
async function chargeNetting(
  trx: Tx,
  orgId: string,
  input: { channelId: string; settleChargeIds?: readonly string[] },
  config: { name: string; storeId: string },
  lock: boolean,
): Promise<{ ids: string[]; total: Money; blockers: string[] }> {
  const ids = [...new Set((input.settleChargeIds ?? []).map((i) => (i ?? '').trim().toLowerCase()).filter((i) => i !== ''))];
  if (ids.length === 0) return { ids, total: ZERO, blockers: [] };
  const real = ids.filter((i) => UUID_TEXT.test(i));
  if (lock) for (const id of [...real].sort()) await advisoryLocksRepo.lockPeriodCharge(trx, id);
  const rows = new Map((await R.chargesForNetting(trx, orgId, real)).map((r) => [r.id, r]));
  const blockers = new Set<string>();
  let total = 0n;
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      blockers.add('One of the charges named for this payout could not be found, or has not been booked yet.');
    } else if (row.channelId !== input.channelId || row.storeId !== config.storeId) {
      blockers.add(`A charge named for this payout does not belong to ${config.name}. Name only the charges of this channel and store.`);
    } else if (row.nettedBySettlementId) {
      blockers.add(`A charge of ₱${row.totalAmount} dated ${row.chargeDate} was already netted out of another payout. Void that payout first, or leave the charge out of this one.`);
    } else {
      total += toCentavos(money(row.totalAmount));
    }
  }
  return { ids, total: fromCentavos(total), blockers: [...blockers] };
}

/**
 * What `recordChannelSettlement` would do with these figures — **without doing it.**
 *
 * Reads only. Returns every refusal it would hit rather than throwing the first one, because a
 * form that fixes one error at a time makes four round trips out of one.
 */
export async function previewChannelSettlement(
  tx: Tx,
  actor: Actor,
  input: Omit<RecordSettlementInput, 'salesDayId' | 'settledOn'> & { settledOn?: string },
): Promise<SettlementPreview> {
  const run = async (trx: Tx): Promise<SettlementPreview> => {
    const ctx = await gatherSettlementContext(trx, actor, input, false);
    // S5.5v Amendment A1 / A2 item 3 — the docstring's promise is "every refusal it would hit", so
    // EVERY bad figure is COLLECTED alongside the config blockers, never thrown past them.
    // `recordChannelSettlement` (below) keeps the throw — a post is all-or-nothing, a preview is not.
    const { blockers: figureBlockers, figures } = collectSettlementFigureBlockers('previewChannelSettlement', input);
    const legBlockers = figures ? await loanLegBlockers(trx, actor.orgId, figures.loanLegs) : [];
    // S5.5v Amendment A2 item 2 — a figure that failed to parse has no safe value to compute
    // with; running the arithmetic anyway is how "NaN" reaches the screen. Zero figures, blockers
    // only, until every field parses.
    const c = figures ? computeSettlement(figures, input.acknowledgeDifference, ctx.outstanding, ctx.nettedCharges, ctx.config.name, ctx.variance) : ZERO_COMPUTED_SETTLEMENT;
    return {
      channelName: ctx.config.name,
      storeId: ctx.config.storeId,
      outstanding: ctx.outstanding,
      outstandingCleared: c.outstandingCleared,
      feesTotal: c.feesTotal,
      loanDeduction: c.loanDeduction,
      netDeposited: c.netDeposited,
      variance: c.variance,
      settlementGain: c.settlementGain,
      tolerance: c.tolerance,
      destinationAccountName: ctx.destinationName,
      blockers: [...ctx.configBlockers, ...ctx.chargeBlockers, ...figureBlockers, ...legBlockers, ...c.blockers],
      needsAcknowledgement: c.needsAcknowledgement,
      difference: c.difference,
      differenceSign: c.differenceSign,
      figuresComputed: figureBlockers.length === 0,
    };
  };
  return run(tx);
}

/**
 * Record and post one platform payout against one channel-day.
 *
 * ⚠️ **Deductions are SIGNED.** A negative is a real credit — a promo-heavy day genuinely returns
 * money — and v1 shipped a bug by assuming otherwise. Nothing here clamps them.
 */
export async function recordChannelSettlement(
  tx: Tx,
  actor: Actor,
  rawInput: RecordSettlementInput,
): Promise<SettlementResult> {
  const run = async (trx: Tx): Promise<SettlementResult> => {
    // ⭐ One POSTED settlement per channel-day, one destination account, one store. The partial
    // unique index refuses a duplicate too — this says WHY, and it is the same context the
    // preview reads, so a screen cannot show a green light this then refuses.
    // T-440 — authorize() first, then the typed-field rules (gross, net, loan amount, reference, date),
    // THEN the channel/day lookups: a malformed figure is named before any business check can mask it.
    await authorize(trx, actor, 'record_ar_collection', { storeId: rawInput.storeId });
    // One pass per leg (the amount-docked rule is per box); no legs is one pass with a blank amount.
    for (const loanAmount of rawInput.loanLegs?.length ? rawInput.loanLegs.map((l) => l.amount) : [undefined]) {
      assertFieldRules(CHANNEL_SETTLEMENT_RECORD_RULES, {
        grossAmount: rawInput.grossAmount,
        netDeposited: rawInput.netDeposited,
        loanAmount,
        reference: rawInput.reference,
        settledOn: rawInput.settledOn,
      });
    }
    // An amount docked with no loan picked is a picker left open: the rules above saw it, the books do not.
    const input: RecordSettlementInput = { ...rawInput, loanLegs: realLoanLegs(rawInput.loanLegs) };
    if (!rawInput.salesDayId) {
      throw refuse(
        'recordChannelSettlement: no sales day selected',
        'Choose the day this payout settles. A settlement clears one verified channel-day — ' +
          'a payout covering several days is one settlement per day, sharing a reference.',
      );
    }
    // T-511 S7a (audit): the channel lock approve takes, taken here too (re-entrant inside approve), BEFORE the balance is read, so a hand-recorded settlement and an approve
    // of the same channel cannot both clear the same balance.
    await advisoryLocksRepo.lockSettlementChannel(trx, input.channelId);
    const ctx = await gatherSettlementContext(trx, actor, input, true);
    const figures = assertSettlementFigures('recordChannelSettlement', input);
    const legBlockers = await loanLegBlockers(trx, actor.orgId, figures.loanLegs);
    if (legBlockers.length > 0) throw refuse('recordChannelSettlement: a loan leg is not valid', legBlockers[0]!);
    // T-573: a dock lowers a loan's principal, so it takes the same row lock a payment does (in id order: two settlements cannot deadlock).
    for (const id of [...new Set(figures.loanLegs.map((l) => l.loanId))].sort()) await loansRepo.lockForPayment(trx, actor.orgId, id);
    const config = ctx.config;
    const c = computeSettlement(figures, input.acknowledgeDifference, ctx.outstanding, ctx.nettedCharges, config.name, ctx.variance);

    // ⚠️ Config refusals first — "no destination account" explains a settlement that cannot be
    // banked far better than the arithmetic error it would otherwise cause.
    const blockers = [...ctx.configBlockers, ...ctx.chargeBlockers, ...c.blockers];
    if (blockers.length > 0) throw new Error(`recordChannelSettlement: ${blockers[0]}`);

    const {
      outstandingCleared, variance, settlementGain, loanDeduction, netDeposited,
    } = c;
    // T-371 — an ABSENT deduction is no deduction: it books nothing and is stored as zero. The
    // column's own default is '0', so the locals are arithmetic only; the writer is given the optional values.
    const d = figures.deductions;
    const commission = d.commission ?? ZERO;
    const marketing = d.marketing ?? ZERO;
    const platformFee = d.platformFee ?? ZERO;
    const vatOnFees = d.vatOnFees ?? ZERO;
    const withholdingTax = d.withholdingTax ?? ZERO;
    const penalty = d.penalty ?? ZERO;
    const gross = figures.gross;

    const { id: settlementId } = await R.insertSettlement(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      channelId: input.channelId,
      salesDayId: input.salesDayId,
      businessDate: input.businessDate,
      grossAmount: gross,
      outstandingCleared,
      // R13: an absent deduction is OMITTED, so the column's own DEFAULT '0' applies (the locals above are arithmetic).
      commission: d.commission,
      marketing: d.marketing,
      platformFee: d.platformFee,
      vatOnFees: d.vatOnFees,
      withholdingTax: d.withholdingTax,
      penalty: d.penalty,
      variance,
      settlementGain,
      loanDeduction,
      differenceReason: c.acknowledgedReason,
      netDeposited,
      destinationMoneyAccountId: config.destinationMoneyAccountId!,
      reference: input.reference?.trim() || null,
      settledOn: input.settledOn,
      // ⛔ DEF-146. This was accepted on the input, documented in the schema as *"the one document
      // that cannot be obtained retroactively"*, and never written — an `as never` on this object
      // was hiding the fact that the repo's row type had no such field. A 2307 attached on screen
      // vanished on save, silently, which is precisely the failure this project exists to end.
      withholdingCertificateFileId: input.withholdingCertificateFileId ?? null,
      createdBy: actor.personId,
    });
    // T-511 S6a: the legs go in with the header, in this transaction. A deferred trigger checks at commit that they add up to `loanDeduction`.
    await R.insertLoanLegs(trx, actor.orgId, settlementId, figures.loanLegs);
    // T-511 S6c: the charges this payout netted, in the same transaction. History: a void leaves them and they stop counting through the parent status.
    await R.insertChargeLinks(trx, actor.orgId, settlementId, ctx.chargeIds);

    const memo = `${config.name} settlement — ${input.businessDate}`;
    const lines: Parameters<typeof postEntry>[1]['lines'] = [];

    // The money that actually landed.
    if (compare(netDeposited, ZERO) > 0) {
      const destination = await moneyAccountsRepo.getById(trx, actor.orgId, config.destinationMoneyAccountId!);
      if (!destination) throw new Error('recordChannelSettlement: the channel’s destination account no longer exists.');
      // ⚠️ Asked of the chart, not hard-coded: 1140 demands a money_account party, 1130 does not,
      // and which one a channel banks into is configuration.
      const needsParty = await R.accountRequiresParty(trx, actor.orgId, destination.glAccountCode);
      lines.push({
        accountCode: destination.glAccountCode,
        storeId: input.storeId,
        debit: netDeposited,
        ...(needsParty ? { partyType: 'money_account' as const, partyId: destination.id } : {}),
        lineMemo: memo,
      });
    }

    // ⚠️ Each fee to a REAL account, per the spec's deduction map — never one lump "fees" line.
    // Signed: a negative deduction becomes a credit, and that is the promo-day case v1 got wrong.
    const fee = (code: string, amount: Money, label: string) => {
      if (isZero(amount)) return;
      lines.push(
        compare(amount, ZERO) > 0
          ? { accountCode: code, storeId: input.storeId, debit: amount, lineMemo: `${label} — ${memo}` }
          : { accountCode: code, storeId: input.storeId, credit: negate(amount), lineMemo: `${label} (credit) — ${memo}` },
      );
    };
    fee(R.PLATFORM_FEE_CODE, commission, 'Commission');
    fee(R.PLATFORM_FEE_CODE, platformFee, 'Platform fee');
    // ⚠️ VAT on fees books WITH the fee, gross: bible §13 row 75 — no VAT engine, no input-VAT
    // account, and an input that is never claimed IS part of the cost.
    fee(R.PLATFORM_FEE_CODE, vatOnFees, 'VAT on fees');
    fee(R.MARKETING_CODE, marketing, 'Channel marketing');
    fee(R.ONLINE_ORDER_EXPENSE_CODE, penalty, 'Penalty');
    // ⭐ Expense, not an asset — see the schema comment and spec §7. The channel's `taxTreatment`
    // flag decides this if the posture ever changes; today every channel is `expense`.
    fee(R.TAXES_CODE, withholdingTax, 'Withholding tax');
    fee(R.SETTLEMENT_VARIANCE_CODE, variance, 'Settlement variance');

    if (compare(settlementGain, ZERO) > 0) {
      lines.push({
        accountCode: R.SETTLEMENT_GAIN_CODE,
        storeId: input.storeId,
        credit: settlementGain,
        lineMemo: `Settlement gain — ${memo}`,
      });
    }

    // The loans the platform docked out of the payout: one block per leg, in the order given (T-511 S6a).
    const crossStoreIds = [...new Set(figures.loanLegs.map((l) => l.ownerStoreId).filter((id) => id !== input.storeId))];
    const codes = crossStoreIds.length > 0 ? await moneyTransfersRepo.storeCodes(trx, actor.orgId, [input.storeId, ...crossStoreIds]) : new Map<string, string>();
    for (const leg of figures.loanLegs) {
      const legAmount = leg.amount;
      if (leg.ownerStoreId !== input.storeId) {
        // ⭐ Cross-store: the paying store is owed by the store that owns the loan, and invariant
        // 6's reciprocal check already proves that pair nets to zero.
        const payingCode = codes.get(input.storeId);
        const owningCode = codes.get(leg.ownerStoreId);
        if (!payingCode || !owningCode) {
          throw new Error('recordChannelSettlement: could not resolve both store codes for the loan deduction.');
        }
        // Three legs, and the arithmetic is worth stating because it is easy to get backwards:
        //   the PAYING store gave up cash that was not its debt   -> it is owed        (DR 1250)
        //   the OWNING store's loan principal falls               -> liability down    (DR 2400)
        //   ...and it now owes the paying store instead           -> liability up      (CR 2150)
        // Net debit is exactly one loan leg, which is what the settlement identity needs.
        // ⭐ Invariant 6's reciprocal check already proves Σ1250 = Σ2150 across stores, so this
        // case is watched by a check that already exists rather than one written for it.
        lines.push(
          {
            accountCode: R.DUE_FROM_STORE_CODE, storeId: input.storeId, debit: legAmount,
            partyType: 'store' as const, partyId: owningCode,
            lineMemo: `Due from ${owningCode} — their loan repaid out of this payout`,
          },
          {
            accountCode: R.LOANS_PAYABLE_CODE, storeId: leg.ownerStoreId, debit: legAmount,
            partyType: 'loan' as const, partyId: leg.loanId,
            lineMemo: `Loan repayment — ${memo}`,
          },
          {
            accountCode: R.DUE_TO_STORE_CODE, storeId: leg.ownerStoreId, credit: legAmount,
            partyType: 'store' as const, partyId: payingCode,
            lineMemo: `Due to ${payingCode} — they paid our loan`,
          },
        );
      } else {
        lines.push({
          accountCode: R.LOANS_PAYABLE_CODE,
          storeId: input.storeId,
          debit: legAmount,
          partyType: 'loan' as const,
          partyId: leg.loanId,
          lineMemo: `Loan repayment — ${memo}`,
        });
      }
    }

    // ...and the receivable it all clears. A zero credit is never posted (the netted charges can use up the whole receivable); computeSettlement blocks the case where no line is left.
    if (!isZero(outstandingCleared)) {
      lines.push({
        accountCode: R.CHANNEL_RECEIVABLE_CODE,
        storeId: input.storeId,
        credit: outstandingCleared,
        partyType: R.PARTY_TYPE,
        partyId: input.channelId,
        lineMemo: memo,
      });
    }

    const posted = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.settledOn,
      sourceType: 'channel_settlement',
      sourceId: settlementId,
      idempotencyKey: `channel_settlement:${settlementId}:post`,
      memo,
      postedBy: actor.personId,
      lines,
    });

    await R.markPosted(trx, actor.orgId, settlementId, {
      journalEntryId: posted.entryId,
      postedBy: actor.personId,
    });

    return {
      settlementId,
      entryId: posted.entryId,
      variance,
      settlementGain,
    };
  };
  return run(tx);
}

/**
 * ⭐ **Point a channel at the account its payouts land in** — DEF-137.
 *
 * ⛔ **This had no writer anywhere.** `sales_channels.destination_money_account_id` was added by
 * T-150's own migration, is read on every posting, and was set by exactly one thing in the whole
 * repository: a test fixture. So every real channel had it null, and `recordChannelSettlement`
 * correctly refused every real settlement — *"there is nowhere to bank this"*. A screen alone
 * would not have fixed DEF-137; the configuration it depends on had to become reachable too.
 *
 * ⚠️ **`set_channel_payout`, not `manage_chart_of_accounts` — and, since T-350 (DEF-477, Ian
 * 2026-09-28), not `manage_store_settings` either.** This creates nothing: it chooses among money
 * accounts that already exist, which is operational routing of the same kind as
 * `receivable_account_code`. But Ian ruled it admin-only, both for the first set AND for every
 * later change — a manager who already accepts a remittance may not say which wallet Foodpanda
 * pays into. Choosing the account already set is a no-op success (no write).
 */
export async function setChannelPayoutDestination(
  tx: Tx,
  actor: Actor,
  input: { channelId: string; moneyAccountId: string },
): Promise<{
  channelId: string;
  moneyAccountId: string;
  accountName: string;
  hadAccountBefore: boolean;
  /** T-350 S2 (F3/F5) — false only for the same-account no-op. The action gates `changed=1` on
   *  this, never on `hadAccountBefore` alone: a re-click of the same account already had one, but
   *  nothing was written, so the banner must not say "changed". */
  wrote: boolean;
}> {
  const run = async (trx: Tx) => {
    const config = await R.channelConfig(trx, actor.orgId, input.channelId);
    if (!config) {
      throw refuse(
        `setChannelPayoutDestination: channel ${input.channelId} does not exist.`,
        'That channel no longer exists.',
      );
    }
    // T-350 (DEF-477). Ian, 2026-09-28: admin only — replaces `manage_store_settings`.
    await authorize(trx, actor, 'set_channel_payout', { storeId: config.storeId });
    // T-440 / S9: the screen's own rule judges the box AFTER the gate (T-364 order). Moved here from the action.
    assertFieldRules(CHANNEL_PAYOUT_DESTINATION_RULES, { moneyAccountId: input.moneyAccountId });

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) {
      throw refuse(
        'setChannelPayoutDestination: that money account does not exist.',
        'That money account no longer exists.',
      );
    }
    // ⚠️ Same store, and this is a money-safety rule rather than tidiness: a payout banked into
    // another store's wallet moves one store's revenue into another store's custody with no
    // due-from/due-to pair to make it visible (bible rows 152–153). Cross-store money movement
    // is a transfer, made deliberately, never a side effect of a configuration screen.
    if (account.storeId !== config.storeId) {
      throw refuse(
        `setChannelPayoutDestination: ${account.name} belongs to another store. A channel banks ` +
          'into its own store’s account; moving money between stores is a transfer, not a setting.',
        `${account.name} belongs to another store. A channel banks into its own store's account — ` +
          'moving money between stores is a transfer, not a setting.',
      );
    }
    if (!account.isActive) {
      throw refuse(
        `setChannelPayoutDestination: ${account.name} is retired, so nothing can be banked into it.`,
        `${account.name} is retired, so nothing can be banked into it.`,
      );
    }

    const hadAccountBefore = config.destinationMoneyAccountId !== null;

    // T-350 (DEF-477): choosing the account that is already set is a no-op success — no write,
    // no `updated_at` movement.
    if (config.destinationMoneyAccountId === input.moneyAccountId) {
      return {
        channelId: input.channelId,
        moneyAccountId: input.moneyAccountId,
        accountName: account.name,
        hadAccountBefore,
        wrote: false,
      };
    }

    // T-350 S3 / DEF-169 (bible §13 row 238, Ian 2026-09-28) — the old account's NAME, read before
    // the UPDATE overwrites which account the channel points at. `getById` returns a retired
    // account too, so a change away from a since-retired account still names it correctly.
    const oldAccount = config.destinationMoneyAccountId
      ? await moneyAccountsRepo.getById(trx, actor.orgId, config.destinationMoneyAccountId)
      : null;

    await R.setDestinationAccount(trx, actor.orgId, input.channelId, input.moneyAccountId);

    // Same transaction, only on an actual write (never the no-op above, never a refusal — every
    // refusal already returned before this point). `source` is `'web'` because the ERP screen
    // (`actions.ts`'s `setPayoutDestinationAction`) is this function's only caller today; a second
    // front-end calling this must thread its own `source` through, not inherit this one.
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'set_channel_payout',
      storeId: config.storeId,
      entityId: input.channelId,
      // T-350 S6 (G2) — the STORED id, never the lookup's: `oldAccount` is org-scoped
      // (`getById`'s `eq(id) AND eq(orgId)`) and genuinely misses when the stored destination
      // belongs to another org. Reachable as a DB STATE, not through any app write path: this
      // function only ever WRITES an id `moneyAccountsRepo.getById(trx, actor.orgId, …)` above has
      // already fetched org-scoped, so `setChannelPayoutDestination` itself can never point a
      // channel at another org's account — but `destination_money_account_id`'s FK (`money_accounts.id`)
      // does not itself constrain the referenced row to the channel's own org (now DEF-490), so
      // some OTHER path (a migration, a manual fix, a future caller) can still leave a cross-org id
      // stored, and this code must not assume it never will. `config.destinationMoneyAccountId` is
      // the value that was actually on the row and is never wrong; the lookup is kept for the NAME
      // only, which really can be unknown.
      before: { moneyAccountId: config.destinationMoneyAccountId, moneyAccountName: oldAccount?.name ?? null },
      after: { moneyAccountId: account.id, moneyAccountName: account.name },
      source: 'web',
    });

    return {
      channelId: input.channelId,
      moneyAccountId: input.moneyAccountId,
      accountName: account.name,
      hadAccountBefore,
      wrote: true,
    };
  };
  return run(tx);
}

/**
 * Void a posted settlement. ⚠️ Reverses every leg through `reverseEntry` — a correction is void
 * and re-post, never an edit, because a posted settlement is immutable.
 */
export async function voidChannelSettlement(
  tx: Tx,
  actor: Actor,
  input: { settlementId: string; reason: string },
): Promise<{ reversedEntryId: string }> {
  const run = async (trx: Tx) => {
    const seen = await R.getById(trx, actor.orgId, input.settlementId);
    if (!seen) throw new Error(`voidChannelSettlement: settlement ${input.settlementId} does not exist.`);
    await authorize(trx, actor, 'record_ar_collection', { storeId: seen.storeId });
    // The channel lock approve takes first (channel, then the staged line, then the books), so a void and an approve of the same channel queue instead of crossing.
    await advisoryLocksRepo.lockSettlementChannel(trx, seen.channelId);
    // Read again under the lock: a second voider that queued behind the first must see it voided.
    const s = (await R.getById(trx, actor.orgId, input.settlementId)) ?? seen;
    if (s.status === 'voided') throw refuse(`voidChannelSettlement: settlement is ${s.status}, not posted.`, 'This settlement was already voided.');
    if (s.status !== 'posted') throw new Error(`voidChannelSettlement: settlement is ${s.status}, not posted.`);
    if (!s.journalEntryId) throw new Error('voidChannelSettlement: posted settlement carries no entry — that is a bug.');

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidChannelSettlement: say why this settlement is being voided.');

    // ⭐ The spec ports v1's *"void refuses while a loan payment stands"* guard. It is NOT needed
    // here, and the reason is structural rather than an omission: in v1 the loan repayment is a
    // SEPARATE record that can outlive the settlement. Here the repayment is a LEG INSIDE this
    // settlement's own entry, so reversing the entry reverses the repayment in the same
    // transaction. There is no window in which one can survive the other.
    // ⚠️ If a loan repayment ever becomes its own document, this guard has to come back.

    const reversal = await reverseEntry(trx, {
      entryId: s.journalEntryId,
      reason,
      reversedBy: actor.personId,
    });
    if (!(await R.markVoided(trx, actor.orgId, s.id, { voidedBy: actor.personId, voidReason: reason }))) {
      throw refuse(`voidChannelSettlement: settlement ${s.id} is no longer posted`, 'This settlement was already voided.');
    }
    // T-511 S7a: a staged day this settlement booked goes back to pending in the same transaction (a plain void is not a dead end). Only the CURRENT line returns; a line a
    // newer file replaced stays booked as history. A hand-recorded settlement carries no line, so nothing happens.
    const returned = await settlementIntakeRepo.markUnbooked(trx, actor.orgId, s.id);
    if (returned) {
      await auditLogRepo.append(trx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'settlement_day.unbooked',
        storeId: returned.storeId,
        entityId: returned.id,
        before: { reviewState: 'booked', settlementId: s.id },
        after: { reviewState: 'pending', voidedSettlementId: s.id },
        source: 'web',
      });
    }
    return { reversedEntryId: reversal.reversalEntryId };
  };
  return run(tx);
}

// =====================================================================================
// ⭐ T-178 — exposing this module's parsed deductions for order-wastage's settlement matcher.
//
// ⛔ ADDS a read path only; nothing above this line changes. `wastage/settlement-match.ts` is
// pure and must not build a second settlement parser (T-178 §4) — these two functions are the
// ONLY way it ever sees a settlement's own figures, composed entirely from the repo calls already
// used above (`getById`, `listSettlements`, `channelConfig`), never a new query shape.
// =====================================================================================

export interface PostedSettlementSummary {
  settlementId: string;
  storeId: string;
  /** ⭐ T-230 — the id is what `settlement-match` keys on, so a rename cannot lose a match. */
  channelId: string;
  /** The channel's name, for display in the proposal's rationale sentence. */
  channel: string;
  businessDate: string;
  grossAmount: string;
  outstandingCleared: string;
  netDeposited: string;
  deductions: SettlementDeductions;
  variance: string;
  settlementGain: string;
}

function toSummary(row: {
  id: string; storeId: string; channelId: string; channelName: string; businessDate: string;
  grossAmount: string; outstandingCleared: string; netDeposited: string;
  commission: string; marketing: string; platformFee: string; vatOnFees: string;
  withholdingTax: string; penalty: string; variance: string; settlementGain: string;
}): PostedSettlementSummary {
  return {
    settlementId: row.id,
    storeId: row.storeId,
    channelId: row.channelId,
    channel: row.channelName,
    businessDate: row.businessDate,
    grossAmount: row.grossAmount,
    outstandingCleared: row.outstandingCleared,
    netDeposited: row.netDeposited,
    deductions: {
      commission: row.commission,
      marketing: row.marketing,
      platformFee: row.platformFee,
      vatOnFees: row.vatOnFees,
      withholdingTax: row.withholdingTax,
      penalty: row.penalty,
    },
    variance: row.variance,
    settlementGain: row.settlementGain,
  };
}

/** One channel-day's POSTED settlement, if one exists — read-gated the same as a preview. */
export async function findPostedSettlementForChannelDay(
  tx: Tx,
  actor: Actor,
  input: { channelId: string; businessDate: string },
): Promise<PostedSettlementSummary | null> {
  const run = async (trx: Tx): Promise<PostedSettlementSummary | null> => {
    const config = await R.channelConfig(trx, actor.orgId, input.channelId);
    if (!config) return null;
    await authorize(trx, actor, 'record_ar_collection', { storeId: config.storeId });
    const posted = await R.postedSettlementFor(trx, actor.orgId, input.channelId, input.businessDate);
    if (!posted) return null;
    const row = await R.getById(trx, actor.orgId, posted.id);
    if (!row) return null;
    return toSummary({ ...row, channelName: config.name, businessDate: row.businessDate });
  };
  return run(tx);
}

/**
 * Every POSTED settlement for a store, most recent first — what the wastage screen hands to the
 * pure matcher alongside a store's open wastages. Composes `listSettlements` (already read-gated
 * by nothing itself — see below) with `getById` per row for the deduction breakdown that list
 * view does not carry.
 */
export async function listPostedSettlementsForStore(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; limit?: number },
): Promise<PostedSettlementSummary[]> {
  const run = async (trx: Tx): Promise<PostedSettlementSummary[]> => {
    await authorize(trx, actor, 'record_ar_collection', { storeId: input.storeId });
    const listed = await R.listSettlements(trx, actor.orgId, { storeId: input.storeId, limit: input.limit ?? 100 });
    const posted = listed.filter((s) => s.status === 'posted');
    const out: PostedSettlementSummary[] = [];
    for (const s of posted) {
      const row = await R.getById(trx, actor.orgId, s.id);
      if (!row) continue;
      out.push(toSummary({ ...row, channelName: s.channelName, businessDate: row.businessDate }));
    }
    return out;
  };
  return run(tx);
}

// T-511 S6b: the platform file figure replaces the staff figure in a day's sales and receivable (no caller until slice 7 approves a day).
export { correctPlatformSales } from './correction';
export type { CorrectPlatformSalesInput, CorrectPlatformSalesResult } from './correction';

// T-511 S6c: a platform charge with no sales day is booked once (no caller until slice 7 approves an upload). The clock seam stays off the barrel.
export { postPlatformCharge } from './charge';
export type { PostPlatformChargeInput, PostPlatformChargeResult } from './charge';
