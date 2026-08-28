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
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';

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
    await authorize(trx, actor, 'record_ar_collection', { storeId: input.storeId });

    const config = await R.channelConfig(trx, actor.orgId, input.channelId);
    if (!config) throw new Error(`recordChannelSettlement: channel ${input.channelId} does not exist.`);
    if (!config.destinationMoneyAccountId) {
      throw new Error(
        `recordChannelSettlement: ${config.name} has no destination account set, so there is ` +
          'nowhere to bank this. Set the channel’s destination money account first.',
      );
    }

    // ⭐ One POSTED settlement per channel-day. A second is refused, never duplicated — the
    // partial unique index refuses it too, but saying so here explains WHY.
    const already = await R.postedSettlementFor(trx, actor.orgId, input.channelId, input.businessDate);
    if (already) {
      throw new Error(
        `recordChannelSettlement: ${config.name} already has a posted settlement for ` +
          `${input.businessDate}. Void that one first — a correction is void and re-post, never a ` +
          'second row.',
      );
    }

    const d = input.deductions ?? {};
    const num = (v: string | undefined) => Number(v ?? 0);
    const commission = num(d.commission);
    const marketing = num(d.marketing);
    const platformFee = num(d.platformFee);
    const vatOnFees = num(d.vatOnFees);
    const withholdingTax = num(d.withholdingTax);
    const penalty = num(d.penalty);
    const loanDeduction = input.loan ? Number(input.loan.amount) : 0;
    const netDeposited = Number(input.netDeposited);
    const gross = Number(input.grossAmount);

    if (netDeposited < 0) {
      throw new Error(
        'recordChannelSettlement: fees exceeding the payout is a refusal, not a negative deposit. ' +
          'Check the figures against the platform statement.',
      );
    }

    // What the ledger says this channel is still owed. ⭐ Derived, never stored.
    const outstanding = Number(await R.outstandingFor(trx, actor.orgId, input.channelId));
    if (outstanding <= EPSILON) {
      throw new Error(
        `recordChannelSettlement: ${config.name} has nothing outstanding to settle. Either the ` +
          'sales day was never verified, or this payout is already settled.',
      );
    }

    // The receivable this clears is capped at what is actually outstanding — settling more than
    // is owed would drive 1220 negative, which is never a real state.
    const outstandingCleared = Math.min(outstanding, gross);

    const feesAndDeductions =
      commission + marketing + platformFee + vatOnFees + withholdingTax + penalty + loanDeduction + netDeposited;

    // ⭐ variance is a statement about the SALES DAY, not about the platform.
    //    positive → staff over-reported; the shortfall is swept to 6420
    //    negative → staff under-reported; the excess is income at 7100
    const difference = outstandingCleared - feesAndDeductions;
    const variance = difference > 0 ? difference : 0;
    const settlementGain = difference < 0 ? -difference : 0;
    const tolerance = toleranceFor(gross);

    if (variance > tolerance + EPSILON) {
      throw new Error(
        `recordChannelSettlement: the day is short by ₱${variance.toFixed(2)}, past the ` +
          `₱${tolerance.toFixed(2)} tolerance. That is a disagreement, not rounding — reconcile ` +
          'it against the platform statement rather than sweeping it to expense.',
      );
    }
    if (settlementGain > tolerance + EPSILON && !input.recognizeGain) {
      throw new Error(
        `recordChannelSettlement: the payout exceeds the day by ₱${settlementGain.toFixed(2)}, past ` +
          `the ₱${tolerance.toFixed(2)} tolerance. Pass recognizeGain to book it as income — a ` +
          'typo must not quietly become revenue.',
      );
    }

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
      destinationMoneyAccountId: config.destinationMoneyAccountId,
      reference: input.reference?.trim() || null,
      settledOn: input.settledOn,
      createdBy: actor.personId,
    } as never);

    const memo = `${config.name} settlement — ${input.businessDate}`;
    const lines: Parameters<typeof postEntry>[1]['lines'] = [];

    // The money that actually landed.
    if (netDeposited > EPSILON) {
      const destination = await moneyAccountsRepo.getById(trx, actor.orgId, config.destinationMoneyAccountId);
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
