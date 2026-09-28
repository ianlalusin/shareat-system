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
import {
  channelSettlementsRepo,
  moneyAccountsRepo,
  moneyTransfersRepo,
  transaction,
  type Tx,
} from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

const R = channelSettlementsRepo;

/** Decimal noise only, never a business allowance. The same value AP, AR and trade use. */
const EPSILON = 0.005;

/**
 * ⚠️ Above this, a variance is not a rounding difference — it is a disagreement, and the posting
 * is refused so somebody reconciles instead of sweeping it to expense.
 */
function toleranceFor(gross: number): number {
  return Math.max(50, Math.abs(gross) * 0.1);
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
  loan?: { loanId: string; amount: string; ownerStoreId?: string | null } | null;
  reference?: string | null;
  settledOn: string;
  withholdingCertificateFileId?: string | null;
  /**
   * ⚠️ Required to accept an above-tolerance GAIN. Without it a typo can quietly become revenue,
   * which is the one direction of this error nobody notices.
   */
  recognizeGain?: boolean;
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
  /** What this settlement would credit `1220` — capped at what is actually owed. */
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
  /** True when the ONLY thing in the way is the explicit "recognise the gain" acknowledgement. */
  needsGainAcknowledgement: boolean;
}

interface ComputedSettlement {
  outstandingCleared: number;
  feesTotal: number;
  loanDeduction: number;
  netDeposited: number;
  variance: number;
  settlementGain: number;
  tolerance: number;
  blockers: string[];
  needsGainAcknowledgement: boolean;
}

/** S5.5v Amendment A2 item 2 — what a preview shows while a figure refusal blocks the arithmetic:
 *  zeroed, never NaN. */
const ZERO_COMPUTED_SETTLEMENT: ComputedSettlement = {
  outstandingCleared: 0,
  feesTotal: 0,
  loanDeduction: 0,
  netDeposited: 0,
  variance: 0,
  settlementGain: 0,
  tolerance: 0,
  blockers: [],
  needsGainAcknowledgement: false,
};

/**
 * T-343 S5.5s / DEF-470 item 8 — every figure below reached bare `Number()` in `computeSettlement`
 * with no parse at all: a comma-typed value became `NaN`, `NaN`-blind comparisons let it slip past
 * every guard, and the write itself hit a raw, unmapped `_finite_check`/`_identity_check` CHECK
 * violation. Throw-only: the existing `Number()` arithmetic in `computeSettlement` is unchanged —
 * this only confirms every typed string parses before that arithmetic ever runs.
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
  input: Pick<RecordSettlementInput, 'grossAmount' | 'netDeposited' | 'deductions' | 'loan'>,
): Array<() => void> {
  const checks: Array<() => void> = [
    () => {
      figureBlank(input.grossAmount, 'grossAmount', 'The gross settled', fn);
      parseMoneyInput(input.grossAmount, `${fn}: the gross amount`, 'The gross settled');
    },
    () => {
      figureBlank(input.netDeposited, 'netDeposited', 'The net deposited', fn);
      parseMoneyInput(input.netDeposited, `${fn}: the net deposited`, 'The net deposited');
    },
  ];
  const d = input.deductions ?? {};
  for (const key of Object.keys(DEDUCTION_LABELS) as (keyof SettlementDeductions)[]) {
    const v = d[key];
    if (v !== undefined) {
      checks.push(() => parseMoneyInput(v, `${fn}: ${lead(DEDUCTION_LABELS[key])}`, DEDUCTION_LABELS[key]));
    }
  }
  if (input.loan) {
    checks.push(() => {
      const amount = parseMoneyInput(input.loan!.amount, `${fn}: the loan amount docked`, 'The amount docked');
      if (Number(amount) < 0) {
        throw refuse(`${fn}: the loan amount docked cannot be negative.`, 'The amount docked cannot be negative.');
      }
    });
  }
  return checks;
}

/** `recordChannelSettlement`'s shape — all-or-nothing, throws on the first bad field. */
function assertSettlementFigures(
  fn: string,
  input: Pick<RecordSettlementInput, 'grossAmount' | 'netDeposited' | 'deductions' | 'loan'>,
): void {
  for (const check of figureChecks(fn, input)) check();
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
  input: Pick<RecordSettlementInput, 'grossAmount' | 'netDeposited' | 'deductions' | 'loan'>,
): string[] {
  const blockers: string[] = [];
  for (const check of figureChecks(fn, input)) {
    try {
      check();
    } catch (err) {
      blockers.push(blockerMessageFor(err));
    }
  }
  return blockers;
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
  input: Pick<RecordSettlementInput, 'grossAmount' | 'netDeposited' | 'deductions' | 'loan' | 'recognizeGain'>,
  outstanding: number,
  channelName: string,
): ComputedSettlement {
  const d = input.deductions ?? {};
  const num = (v: string | undefined) => Number(v ?? 0);
  const commission = num(d.commission);
  const marketing = num(d.marketing);
  const platformFee = num(d.platformFee);
  const vatOnFees = num(d.vatOnFees);
  const withholdingTax = num(d.withholdingTax);
  const penalty = num(d.penalty);
  const feesTotal = commission + marketing + platformFee + vatOnFees + withholdingTax + penalty;
  const loanDeduction = input.loan ? Number(input.loan.amount) : 0;
  const netDeposited = Number(input.netDeposited);
  const gross = Number(input.grossAmount);
  const tolerance = toleranceFor(gross);

  const blockers: string[] = [];

  if (netDeposited < 0) {
    blockers.push(
      'fees exceeding the payout is a refusal, not a negative deposit. ' +
        'Check the figures against the platform statement.',
    );
  }
  if (outstanding <= EPSILON) {
    blockers.push(
      `${channelName} has nothing outstanding to settle. Either the sales day was never ` +
        'verified, or this payout is already settled.',
    );
  }

  // The receivable this clears is capped at what is actually outstanding — settling more than
  // is owed would drive 1220 negative, which is never a real state.
  const outstandingCleared = Math.min(outstanding, gross);

  // ⭐ variance is a statement about the SALES DAY, not about the platform.
  //    positive → staff over-reported; the shortfall is swept to 6420
  //    negative → staff under-reported; the excess is income at 7100
  const difference = outstandingCleared - (feesTotal + loanDeduction + netDeposited);
  const variance = difference > 0 ? difference : 0;
  const settlementGain = difference < 0 ? -difference : 0;

  if (variance > tolerance + EPSILON) {
    blockers.push(
      `the day is short by ₱${variance.toFixed(2)}, past the ₱${tolerance.toFixed(2)} tolerance. ` +
        'That is a disagreement, not rounding — reconcile it against the platform statement ' +
        'rather than sweeping it to expense.',
    );
  }
  const needsGainAcknowledgement = settlementGain > tolerance + EPSILON && !input.recognizeGain;
  if (needsGainAcknowledgement) {
    blockers.push(
      `the payout exceeds the day by ₱${settlementGain.toFixed(2)}, past the ` +
        `₱${tolerance.toFixed(2)} tolerance. Pass recognizeGain to book it as income — a typo ` +
        'must not quietly become revenue.',
    );
  }

  return {
    outstandingCleared,
    feesTotal,
    loanDeduction,
    netDeposited,
    variance,
    settlementGain,
    tolerance,
    blockers,
    needsGainAcknowledgement,
  };
}

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
  input: { storeId: string; channelId: string; businessDate: string },
): Promise<{
  config: { name: string; storeId: string; destinationMoneyAccountId: string | null; taxTreatment: string };
  destinationName: string | null;
  outstanding: number;
  configBlockers: string[];
}> {
  await authorize(trx, actor, 'record_ar_collection', { storeId: input.storeId });

  const config = await R.channelConfig(trx, actor.orgId, input.channelId);
  if (!config) throw new Error(`channel ${input.channelId} does not exist.`);

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

  const already = await R.postedSettlementFor(trx, actor.orgId, input.channelId, input.businessDate);
  if (already) {
    configBlockers.push(
      `${config.name} already has a posted settlement for ${input.businessDate}. Void that one ` +
        'first — a correction is void and re-post, never a second row.',
    );
  }

  let destinationName: string | null = null;
  if (config.destinationMoneyAccountId) {
    const destination = await moneyAccountsRepo.getById(trx, actor.orgId, config.destinationMoneyAccountId);
    destinationName = destination?.name ?? null;
  }

  const outstanding = Number(await R.outstandingFor(trx, actor.orgId, input.channelId));
  return { config, destinationName, outstanding, configBlockers };
}

/**
 * What `recordChannelSettlement` would do with these figures — **without doing it.**
 *
 * Reads only. Returns every refusal it would hit rather than throwing the first one, because a
 * form that fixes one error at a time makes four round trips out of one.
 */
export async function previewChannelSettlement(
  tx: Tx | null,
  actor: Actor,
  input: Omit<RecordSettlementInput, 'salesDayId' | 'settledOn'> & { settledOn?: string },
): Promise<SettlementPreview> {
  const run = async (trx: Tx): Promise<SettlementPreview> => {
    const ctx = await gatherSettlementContext(trx, actor, input);
    // S5.5v Amendment A1 / A2 item 3 — the docstring's promise is "every refusal it would hit", so
    // EVERY bad figure is COLLECTED alongside the config blockers, never thrown past them.
    // `recordChannelSettlement` (below) keeps the throw — a post is all-or-nothing, a preview is not.
    const figureBlockers = collectSettlementFigureBlockers('previewChannelSettlement', input);
    // S5.5v Amendment A2 item 2 — a figure that failed to parse has no safe Number() to compute
    // with; running the arithmetic anyway is how "NaN" reaches the screen. Zero figures, blockers
    // only, until every field parses.
    const c = figureBlockers.length === 0 ? computeSettlement(input, ctx.outstanding, ctx.config.name) : ZERO_COMPUTED_SETTLEMENT;
    return {
      channelName: ctx.config.name,
      storeId: ctx.config.storeId,
      outstanding: ctx.outstanding.toFixed(2),
      outstandingCleared: c.outstandingCleared.toFixed(2),
      feesTotal: c.feesTotal.toFixed(2),
      loanDeduction: c.loanDeduction.toFixed(2),
      netDeposited: c.netDeposited.toFixed(2),
      variance: c.variance.toFixed(2),
      settlementGain: c.settlementGain.toFixed(2),
      tolerance: c.tolerance.toFixed(2),
      destinationAccountName: ctx.destinationName,
      blockers: [...ctx.configBlockers, ...figureBlockers, ...c.blockers],
      needsGainAcknowledgement: c.needsGainAcknowledgement,
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Record and post one platform payout against one channel-day.
 *
 * ⚠️ **Deductions are SIGNED.** A negative is a real credit — a promo-heavy day genuinely returns
 * money — and v1 shipped a bug by assuming otherwise. Nothing here clamps them.
 */
export async function recordChannelSettlement(
  tx: Tx | null,
  actor: Actor,
  input: RecordSettlementInput,
): Promise<SettlementResult> {
  const run = async (trx: Tx): Promise<SettlementResult> => {
    // ⭐ One POSTED settlement per channel-day, one destination account, one store. The partial
    // unique index refuses a duplicate too — this says WHY, and it is the same context the
    // preview reads, so a screen cannot show a green light this then refuses.
    const ctx = await gatherSettlementContext(trx, actor, input);
    assertSettlementFigures('recordChannelSettlement', input);
    const config = ctx.config;
    const c = computeSettlement(input, ctx.outstanding, config.name);

    // ⚠️ Config refusals first — "no destination account" explains a settlement that cannot be
    // banked far better than the arithmetic error it would otherwise cause.
    const blockers = [...ctx.configBlockers, ...c.blockers];
    if (blockers.length > 0) throw new Error(`recordChannelSettlement: ${blockers[0]}`);

    const {
      outstandingCleared, variance, settlementGain, loanDeduction, netDeposited,
    } = c;
    const d = input.deductions ?? {};
    const num = (v: string | undefined) => Number(v ?? 0);
    const commission = num(d.commission);
    const marketing = num(d.marketing);
    const platformFee = num(d.platformFee);
    const vatOnFees = num(d.vatOnFees);
    const withholdingTax = num(d.withholdingTax);
    const penalty = num(d.penalty);
    const gross = Number(input.grossAmount);

    const { id: settlementId } = await R.insertSettlement(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      channelId: input.channelId,
      salesDayId: input.salesDayId,
      businessDate: input.businessDate,
      grossAmount: gross.toFixed(2),
      outstandingCleared: outstandingCleared.toFixed(2),
      commission: commission.toFixed(2),
      marketing: marketing.toFixed(2),
      platformFee: platformFee.toFixed(2),
      vatOnFees: vatOnFees.toFixed(2),
      withholdingTax: withholdingTax.toFixed(2),
      penalty: penalty.toFixed(2),
      variance: variance.toFixed(2),
      settlementGain: settlementGain.toFixed(2),
      loanDeduction: loanDeduction.toFixed(2),
      loanId: input.loan?.loanId ?? null,
      loanOwnerStoreId: input.loan?.ownerStoreId ?? null,
      netDeposited: netDeposited.toFixed(2),
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

    const memo = `${config.name} settlement — ${input.businessDate}`;
    const lines: Parameters<typeof postEntry>[1]['lines'] = [];

    // The money that actually landed.
    if (netDeposited > EPSILON) {
      const destination = await moneyAccountsRepo.getById(trx, actor.orgId, config.destinationMoneyAccountId!);
      if (!destination) throw new Error('recordChannelSettlement: the channel’s destination account no longer exists.');
      // ⚠️ Asked of the chart, not hard-coded: 1140 demands a money_account party, 1130 does not,
      // and which one a channel banks into is configuration.
      const needsParty = await R.accountRequiresParty(trx, actor.orgId, destination.glAccountCode);
      lines.push({
        accountCode: destination.glAccountCode,
        storeId: input.storeId,
        debit: netDeposited.toFixed(2),
        ...(needsParty ? { partyType: 'money_account' as const, partyId: destination.id } : {}),
        lineMemo: memo,
      });
    }

    // ⚠️ Each fee to a REAL account, per the spec's deduction map — never one lump "fees" line.
    // Signed: a negative deduction becomes a credit, and that is the promo-day case v1 got wrong.
    const fee = (code: string, amount: number, label: string) => {
      if (Math.abs(amount) <= EPSILON) return;
      lines.push(
        amount > 0
          ? { accountCode: code, storeId: input.storeId, debit: amount.toFixed(2), lineMemo: `${label} — ${memo}` }
          : { accountCode: code, storeId: input.storeId, credit: (-amount).toFixed(2), lineMemo: `${label} (credit) — ${memo}` },
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

    if (settlementGain > EPSILON) {
      lines.push({
        accountCode: R.SETTLEMENT_GAIN_CODE,
        storeId: input.storeId,
        credit: settlementGain.toFixed(2),
        lineMemo: `Settlement gain — ${memo}`,
      });
    }

    // The loan the platform docked out of the payout.
    if (loanDeduction > EPSILON) {
      const ownerStoreId = input.loan?.ownerStoreId ?? null;
      if (ownerStoreId && ownerStoreId !== input.storeId) {
        // ⭐ Cross-store: the paying store is owed by the store that owns the loan, and invariant
        // 6's reciprocal check already proves that pair nets to zero.
        const codes = await moneyTransfersRepo.storeCodes(trx, actor.orgId, [input.storeId, ownerStoreId]);
        const payingCode = codes.get(input.storeId);
        const owningCode = codes.get(ownerStoreId);
        if (!payingCode || !owningCode) {
          throw new Error('recordChannelSettlement: could not resolve both store codes for the loan deduction.');
        }
        // Three legs, and the arithmetic is worth stating because it is easy to get backwards:
        //   the PAYING store gave up cash that was not its debt   -> it is owed        (DR 1250)
        //   the OWNING store's loan principal falls               -> liability down    (DR 2400)
        //   ...and it now owes the paying store instead           -> liability up      (CR 2150)
        // Net debit is exactly one loanDeduction, which is what the settlement identity needs.
        // ⭐ Invariant 6's reciprocal check already proves Σ1250 = Σ2150 across stores, so this
        // case is watched by a check that already exists rather than one written for it.
        lines.push(
          {
            accountCode: R.DUE_FROM_STORE_CODE, storeId: input.storeId, debit: loanDeduction.toFixed(2),
            partyType: 'store' as const, partyId: owningCode,
            lineMemo: `Due from ${owningCode} — their loan repaid out of this payout`,
          },
          {
            accountCode: R.LOANS_PAYABLE_CODE, storeId: ownerStoreId, debit: loanDeduction.toFixed(2),
            partyType: 'loan' as const, partyId: input.loan!.loanId,
            lineMemo: `Loan repayment — ${memo}`,
          },
          {
            accountCode: R.DUE_TO_STORE_CODE, storeId: ownerStoreId, credit: loanDeduction.toFixed(2),
            partyType: 'store' as const, partyId: payingCode,
            lineMemo: `Due to ${payingCode} — they paid our loan`,
          },
        );
      } else {
        lines.push({
          accountCode: R.LOANS_PAYABLE_CODE,
          storeId: input.storeId,
          debit: loanDeduction.toFixed(2),
          partyType: 'loan' as const,
          partyId: input.loan!.loanId,
          lineMemo: `Loan repayment — ${memo}`,
        });
      }
    }

    // ...and the receivable it all clears.
    lines.push({
      accountCode: R.CHANNEL_RECEIVABLE_CODE,
      storeId: input.storeId,
      credit: outstandingCleared.toFixed(2),
      partyType: R.PARTY_TYPE,
      partyId: input.channelId,
      lineMemo: memo,
    });

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
      variance: variance.toFixed(2),
      settlementGain: settlementGain.toFixed(2),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
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
 * ⚠️ **`manage_store_settings`, not `manage_chart_of_accounts`.** Bible row 149 reserves for an
 * admin the act of *creating a place money can be recorded against*. This creates nothing: it
 * chooses among money accounts that already exist, which is operational routing of the same kind
 * as `receivable_account_code`. A branch manager who already accepts a remittance — the largest
 * transfer this business makes (row 150) — may say which wallet Foodpanda pays into.
 */
export async function setChannelPayoutDestination(
  tx: Tx | null,
  actor: Actor,
  input: { channelId: string; moneyAccountId: string },
): Promise<{ channelId: string; moneyAccountId: string }> {
  const run = async (trx: Tx) => {
    const config = await R.channelConfig(trx, actor.orgId, input.channelId);
    if (!config) {
      throw new Error(`setChannelPayoutDestination: channel ${input.channelId} does not exist.`);
    }
    await authorize(trx, actor, 'manage_store_settings', { storeId: config.storeId });

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) {
      throw new Error('setChannelPayoutDestination: that money account does not exist.');
    }
    // ⚠️ Same store, and this is a money-safety rule rather than tidiness: a payout banked into
    // another store's wallet moves one store's revenue into another store's custody with no
    // due-from/due-to pair to make it visible (bible rows 152–153). Cross-store money movement
    // is a transfer, made deliberately, never a side effect of a configuration screen.
    if (account.storeId !== config.storeId) {
      throw new Error(
        `setChannelPayoutDestination: ${account.name} belongs to another store. A channel banks ` +
          'into its own store’s account; moving money between stores is a transfer, not a setting.',
      );
    }
    if (!account.isActive) {
      throw new Error(
        `setChannelPayoutDestination: ${account.name} is retired, so nothing can be banked into it.`,
      );
    }

    await R.setDestinationAccount(trx, actor.orgId, input.channelId, input.moneyAccountId);
    return { channelId: input.channelId, moneyAccountId: input.moneyAccountId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Void a posted settlement. ⚠️ Reverses every leg through `reverseEntry` — a correction is void
 * and re-post, never an edit, because a posted settlement is immutable.
 */
export async function voidChannelSettlement(
  tx: Tx | null,
  actor: Actor,
  input: { settlementId: string; reason: string },
): Promise<{ reversedEntryId: string }> {
  const run = async (trx: Tx) => {
    const s = await R.getById(trx, actor.orgId, input.settlementId);
    if (!s) throw new Error(`voidChannelSettlement: settlement ${input.settlementId} does not exist.`);
    await authorize(trx, actor, 'record_ar_collection', { storeId: s.storeId });
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
    await R.markVoided(trx, actor.orgId, s.id, { voidedBy: actor.personId, voidReason: reason });
    return { reversedEntryId: reversal.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
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
  tx: Tx | null,
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
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Every POSTED settlement for a store, most recent first — what the wastage screen hands to the
 * pure matcher alongside a store's open wastages. Composes `listSettlements` (already read-gated
 * by nothing itself — see below) with `getById` per row for the deduction breakdown that list
 * view does not carry.
 */
export async function listPostedSettlementsForStore(
  tx: Tx | null,
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
  if (tx) return run(tx);
  return transaction(run);
}
