/**
 * T-511 S5b - a staged day line as the T-150 settlement input. Pure; nothing is posted here.
 * `dayBlockers` hands the result to `previewChannelSettlement` (the one copy of the settlement arithmetic and its refusals), so the review screen can never show
 * a green light the later posting refuses. Money fields stay numeric(14,2) text, as staged. Spec: docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 1.
 *
 * T-511 S6a: a day can dock several loans, so the input carries `loanLegs` (one per loan), built by `loanLegsForLine` from the loan check's allocation of THIS store's rows.
 * Spec: docs/tasks/511-settlement-upload-s6-spec.md "S6a".
 */
import { fromCentavos, isZero, money, toCentavos } from '@shareat/core/money';
import type { RecordSettlementInput } from '../channel-settlements';
import { CHANNEL_SETTLEMENT_REFERENCE_MAX } from '../field-rules/channel-settlements';
import type { LoanCheckResult } from './loan-check';

/** The fields of a staged day line this needs (a `DayLineRow` has them all). */
export interface SettlementInputLine {
  storeId: string;
  channelId: string;
  salesDate: string;
  orderValue: string;
  commission: string;
  marketing: string;
  platformFee: string;
  netPayout: string;
  loanDeduction: string;
  /** Grab settlement id, or the Foodpanda invoice number; null when the file carried none */
  payoutReference?: string | null;
}

export type StagedSettlementInput = Omit<RecordSettlementInput, 'salesDayId' | 'settledOn'> & { settledOn: string };

/** One loan a staged day docked: `ownerStoreId` is the loan's own store (the paying store itself for a same-store loan). */
export interface StagedLoanLeg {
  loanId: string;
  amount: string;
  ownerStoreId: string;
}

/** What the legs of a line need of the loan check (a `LoanCheckResult` has all of it). */
export type LoanLegsSource = Pick<LoanCheckResult, 'allocations' | 'rowStoreIds' | 'byLoan'>;

const NO_LEGS_BLOCKER = 'This payout deducts for loans, but the loan check has not placed all of it on the open loans. Match the loan check first.';

/**
 * The legs of a staged day: the allocations of THIS store's rows (never another store's, the check is company-wide), merged per loan (the database keeps one
 * leg per loan and owner store), in the order each loan first appears, exact centavos. An admin override needs no special case: `checkLoanDay` already allocates
 * pinned rows. A zero deduction has no legs whatever the check says. A deduction the legs do not add up to exactly (no check, no allocation, a partial one) is a
 * plain `blocker` and `legs` is empty: never a list that is short of the deduction.
 */
export function loanLegsForLine(line: Pick<SettlementInputLine, 'storeId' | 'loanDeduction'>, check: LoanLegsSource | null): { legs: StagedLoanLeg[]; blocker: string | null } {
  const deduction = toCentavos(money(line.loanDeduction));
  if (deduction === 0n) return { legs: [], blocker: null };
  if (!check) return { legs: [], blocker: NO_LEGS_BLOCKER };

  const merged = new Map<string, bigint>();
  for (const a of check.allocations) {
    if (check.rowStoreIds[a.rowKey] !== line.storeId) continue;
    merged.set(a.loanId, (merged.get(a.loanId) ?? 0n) + toCentavos(a.amount));
  }
  const legs: StagedLoanLeg[] = [];
  let total = 0n;
  for (const [loanId, cents] of merged) {
    const owner = check.byLoan.find((l) => l.loanId === loanId)?.ownerStoreId;
    if (!owner) return { legs: [], blocker: NO_LEGS_BLOCKER };
    legs.push({ loanId, amount: String(fromCentavos(cents)), ownerStoreId: owner });
    total += cents;
  }
  if (total !== deduction) return { legs: [], blocker: NO_LEGS_BLOCKER };
  return { legs, blocker: null };
}

/** What approve adds to the mapping (T-511 S7a, Rulings 3 and 6). */
export interface StagedSettlementOptions {
  /** the first open date when the sales day's period is closed; the settlement books on it (never into a closed month) */
  willPostOn?: string | null;
  /** the approver's typed reason; the ONLY source of `acknowledgeDifference` (blank is none) */
  differenceReason?: string | null;
  /** a carrier day (Foodpanda): the booked, un-netted charges of its upload and their total, taken out of the staged net payout */
  charges?: { ids: readonly string[]; total: string } | null;
}

/**
 * `grossAmount` is the FILE's order value (net of the platform discount, decision 15), `netDeposited` the staged net payout, the three deduction kinds pass
 * straight through with their staged signs. `loanLegs` is a fresh copy of the legs given, and only when the day deducts something. `reference` is the payout
 * reference cut to the field rule. `settledOn` is `willPostOn ?? salesDate`. A staged day is never auto-acknowledged: `acknowledgeDifference` comes only from
 * a typed reason. A carrier names its charges (`settleChargeIds`) and the platform netted them out of the invoice payout, so they come off `netDeposited`.
 */
export function lineToSettlementInput(line: SettlementInputLine, loanLegs?: readonly StagedLoanLeg[], opts: StagedSettlementOptions = {}): StagedSettlementInput {
  const deducts = !isZero(money(line.loanDeduction));
  const reason = opts.differenceReason?.trim();
  const charges = opts.charges && opts.charges.ids.length > 0 ? opts.charges : null;
  return {
    storeId: line.storeId,
    channelId: line.channelId,
    businessDate: line.salesDate,
    grossAmount: line.orderValue,
    netDeposited: charges ? String(fromCentavos(toCentavos(money(line.netPayout)) - toCentavos(money(charges.total)))) : line.netPayout,
    deductions: { commission: line.commission, marketing: line.marketing, platformFee: line.platformFee },
    loanLegs: deducts && loanLegs ? loanLegs.map((l) => ({ ...l })) : [],
    settledOn: opts.willPostOn ?? line.salesDate,
    ...(line.payoutReference ? { reference: line.payoutReference.slice(0, CHANNEL_SETTLEMENT_REFERENCE_MAX) } : {}),
    ...(reason ? { acknowledgeDifference: { reason } } : {}),
    ...(charges ? { settleChargeIds: [...charges.ids] } : {}),
  };
}

/**
 * The invoice a Foodpanda day belongs to, as the channel and the invoice number the day carries as its payout reference (the same whichever upload brought the day), or null
 * for a day with no invoice (every Grab day). The carrier and the period charges of a re-uploaded invoice follow THIS, never the upload id.
 */
export function invoiceOf(line: { platform: string; channelId: string; payoutReference?: string | null }): { channelId: string; invoiceNumber: string } | null {
  return line.platform === 'foodpanda' && line.payoutReference ? { channelId: line.channelId, invoiceNumber: line.payoutReference } : null;
}

/** What the carrier rule needs of one invoice (an `InvoiceCarrierFacts` of the repo has all of it). */
export interface CarrierSource {
  carrierDate: string | null;
  charges: readonly { chargeId: string | null; totalAmount: string | null; nettedBySettlementId: string | null }[];
}

/**
 * T-511 S7a, Ruling 6. The platform nets a period charge out of the invoice payout, so ONE day carries it: the latest-dated CURRENT day line of the invoice (whatever its
 * review state, whichever upload brought it). `unbooked` counts the charges of the invoice still staged and not booked (they hold the carrier); `charges` is the booked, not yet netted ones and their
 * total, or null when this day is not the carrier or there is none. Pure.
 */
export function carrierChargesFor(
  line: { salesDate: string; isCurrent: boolean },
  upload: CarrierSource | undefined,
): { isCarrier: boolean; unbooked: number; charges: { ids: string[]; total: string } | null } {
  if (!upload || !line.isCurrent || upload.carrierDate !== line.salesDate) return { isCarrier: false, unbooked: 0, charges: null };
  const open = upload.charges.filter((c) => c.chargeId !== null && c.nettedBySettlementId === null);
  const total = open.reduce((t, c) => t + toCentavos(money(c.totalAmount ?? '0')), 0n);
  return {
    isCarrier: true,
    unbooked: upload.charges.filter((c) => c.chargeId === null).length,
    charges: open.length > 0 ? { ids: open.map((c) => c.chargeId!), total: String(fromCentavos(total)) } : null,
  };
}
