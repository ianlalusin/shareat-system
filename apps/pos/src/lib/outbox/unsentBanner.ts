/**
 * T-425 S5 - the 50,000 peso warning (Ruling 6). A banner on every screen while the ledger's unsent SALES total is at or above 50,000.00
 * pesos. It never blocks selling (ADR A3). Whole centavos in, whole-number arithmetic only (no rounding anywhere).
 */
import { formatCentavos } from '@/lib/money/format';

export const UNSENT_WARNING_THRESHOLD_CENTAVOS = 5_000_000;

export function shouldShowUnsentBanner(unsentTotalCentavos: number): boolean {
  return unsentTotalCentavos >= UNSENT_WARNING_THRESHOLD_CENTAVOS;
}

export function unsentBannerText(unsentTotalCentavos: number): string {
  return `₱${formatCentavos(unsentTotalCentavos)} in sales not yet sent. Keep selling. Tell the manager.`;
}
