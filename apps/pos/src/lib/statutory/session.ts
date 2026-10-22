import { resolveHeads } from './capture';
import type { StatutoryInput } from './shares';
import type { StatutoryDiner } from '@/lib/types';
import type { TaxAndTotals } from '@/lib/tax';

export interface StatutorySession {
  statutoryDiners?: StatutoryDiner[] | null;
  statutoryHeadCount?: number | null;
  guestCountFinal?: number | null;
  guestCountServerVerified?: number | null;
  guestCountCashierInitial?: number | null;
  packageSnapshot?: { isBundle?: boolean; bundleMaxCap?: number } | null;
}
export function statutoryInputOf(session: StatutorySession | null | undefined): StatutoryInput | null {
  if (!session?.statutoryDiners?.length) return null;
  return { diners: session.statutoryDiners, heads: resolveHeads(session),
    package: session.packageSnapshot ? { isBundle: session.packageSnapshot.isBundle, bundleMaxCap: session.packageSnapshot.bundleMaxCap } : null };
}
/** Join the calculated figures to the full identity only at the receipt boundary. */
export function receiptStatutoryDiners(input: StatutoryInput | null, totals: TaxAndTotals) {
  return totals.statutoryDiners.map(figure => {
    const diner = input?.diners.find(diner => diner.id === figure.dinerId);
    if (!diner) throw new Error('Review the Senior / PWD list before payment.');
    const { dinerId: _id, ...amounts } = figure;
    return { ...amounts, name: diner.name, idNo: diner.idNo };
  });
}
