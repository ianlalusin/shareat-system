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

/**
 * `grossAmount` is the FILE's order value (net of the platform discount, decision 15), `netDeposited` the staged net payout, the three deduction kinds pass
 * straight through with their staged signs. `loanLegs` is a fresh copy of the legs given, and only when the day deducts something. A staged day is never
 * auto-acknowledged: it carries no `acknowledgeDifference`, approve asks a person.
 */
export function lineToSettlementInput(line: SettlementInputLine, loanLegs?: readonly StagedLoanLeg[]): StagedSettlementInput {
  const deducts = !isZero(money(line.loanDeduction));
  return {
    storeId: line.storeId,
    channelId: line.channelId,
    businessDate: line.salesDate,
    grossAmount: line.orderValue,
    netDeposited: line.netPayout,
    deductions: { commission: line.commission, marketing: line.marketing, platformFee: line.platformFee },
    loanLegs: deducts && loanLegs ? loanLegs.map((l) => ({ ...l })) : [],
    settledOn: line.salesDate,
  };
}
