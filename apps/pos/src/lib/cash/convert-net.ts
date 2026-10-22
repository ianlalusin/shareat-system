/** T-427: calculations in centavos; peso numbers exist only at the existing Firestore/display boundary. */
import { parsePesoInput, storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { formatCentavos } from '@/lib/money/format';

export interface ConversionLike {
  status?: string;
  fromMethod: string;
  toMethod: string;
  amount: number;
  createdAtClientMs: number;
  source?: string;
}

export const NEGATIVE_METHOD_NOTICE = 'A payment method is below zero today; the office must check this day.';

/** Optional signed manual adjustment; every nonblank amount still uses the one exact typed-money parser. */
export function parseCashAdjustment(raw: string): number {
  const text = raw.trim();
  if (!text) return 0;
  return text.startsWith('-') ? -parsePesoInput(text.slice(1)) : parsePesoInput(text.startsWith('+') ? text.slice(1) : text);
}

export function convertNetPesos(docs: readonly ConversionLike[], fromMs: number, toMs: number, isCashKey: (name: string) => boolean): number {
  let cents = 0;
  for (const doc of docs) {
    if (doc.status !== 'active' || doc.createdAtClientMs < fromMs || doc.createdAtClientMs > toMs) continue;
    const sign = (isCashKey(doc.toMethod) ? 1 : 0) - (isCashKey(doc.fromMethod) ? 1 : 0);
    if (sign) cents += sign * storedPesosToCentavos(doc.amount);
  }
  return toWirePesos(cents);
}

/** The prior handover already included its closing millisecond; the first handover includes the opening instant. */
export function handoverReadFrom(periodStartMs: number, hasPrior: boolean): number {
  return periodStartMs + (hasPrior ? 1 : 0);
}

interface CashFigures { startingCash: number; cashSales: number; convertNet: number; deductions: number; manualCashAdjustment?: number }
export function computeExpectedCash(input: CashFigures): number {
  return toWirePesos(storedPesosToCentavos(input.startingCash) + storedPesosToCentavos(input.cashSales) +
    storedPesosToCentavos(input.convertNet) + storedPesosToCentavos(input.manualCashAdjustment ?? 0) - storedPesosToCentavos(input.deductions));
}

export function convertLineText(net: number): string | null {
  const cents = storedPesosToCentavos(net);
  return cents === 0 ? null : `Convert and tender fixes: ${cents < 0 ? '−' : '+'}₱${formatCentavos(Math.abs(cents))}`;
}

export function buildHandoverRecord(input: CashFigures & { countedCash: number; manualCashAdjustmentReason?: string }) {
  const manualCashAdjustment = toWirePesos(storedPesosToCentavos(input.manualCashAdjustment ?? 0));
  const manualCashAdjustmentReason = input.manualCashAdjustmentReason?.trim() || null;
  if (manualCashAdjustment !== 0 && !manualCashAdjustmentReason) throw new Error('Say why cash sales are being adjusted.');
  const expectedCash = computeExpectedCash(input);
  return {
    startingCash: input.startingCash, cashSales: input.cashSales, convertNet: input.convertNet,
    deductionsTotal: input.deductions, countedCash: input.countedCash, expectedCash, manualCashAdjustment, manualCashAdjustmentReason,
    variance: toWirePesos(storedPesosToCentavos(input.countedCash) - storedPesosToCentavos(expectedCash)),
  };
}

export function negativeMethods(byMethod: Record<string, number>): string[] {
  return Object.entries(byMethod).filter(([, amount]) => storedPesosToCentavos(amount) < 0).map(([name]) => name).sort();
}
