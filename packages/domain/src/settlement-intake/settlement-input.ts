/**
 * T-511 S5b - a staged day line as the T-150 settlement input. Pure; nothing is posted here.
 * `dayBlockers` hands the result to `previewChannelSettlement` (the one copy of the settlement arithmetic and its refusals), so the review screen can never show
 * a green light the later posting refuses. Money fields stay numeric(14,2) text, as staged. Spec: docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 1.
 */
import { isZero, money } from '@shareat/core/money';
import type { RecordSettlementInput } from '../channel-settlements';

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

/**
 * `grossAmount` is the FILE's order value (net of the platform discount, decision 15), `netDeposited` the staged net payout, the three deduction kinds pass
 * straight through with their staged signs. `loan` is set only when a loan is given AND the day deducts something: one leg of the whole deduction
 * (two-loan days need migration 0229, slice 6).
 */
export function lineToSettlementInput(line: SettlementInputLine, loan?: { loanId: string; ownerStoreId?: string | null }): StagedSettlementInput {
  const deducts = !isZero(money(line.loanDeduction));
  return {
    storeId: line.storeId,
    channelId: line.channelId,
    businessDate: line.salesDate,
    grossAmount: line.orderValue,
    netDeposited: line.netPayout,
    deductions: { commission: line.commission, marketing: line.marketing, platformFee: line.platformFee },
    loan: loan && deducts ? { loanId: loan.loanId, amount: line.loanDeduction, ownerStoreId: loan.ownerStoreId } : null,
    settledOn: line.salesDate,
    recognizeGain: false,
  };
}
