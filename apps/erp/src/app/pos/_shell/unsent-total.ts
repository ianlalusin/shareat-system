/**
 * T-621 S3 - the unsent-sales warning. Pure.
 *
 * While offline, completed sales wait in the outbox. The shell sums the bill total (`payload.device.total`) of every queued `sale.completed` event, in exact
 * centavos (`toCentavos`, never a float), and warns when the sum reaches `pos.offline_unsent_warn_amount`. Any other event kind (a refund is not a
 * `sale.completed`) is not money owed to the server here and is ignored. Selling never stops; the band only asks for the manager.
 */
import { money, toCentavos } from '@shareat/core/money';
import type { PosEvent } from '@/lib/pos-device';

/** One sale's bill total in centavos, or null when the payload has no readable total (an old or malformed row is skipped, never guessed). */
function saleTotalCentavos(e: PosEvent): bigint | null {
  const total = (e.payload.device as { total?: unknown } | undefined)?.total;
  if (typeof total !== 'string' && typeof total !== 'number') return null;
  try {
    return toCentavos(money(String(total)));
  } catch {
    return null;
  }
}

/** The total of the sales waiting to send, in centavos. */
export function unsentSalesCentavos(events: readonly PosEvent[]): bigint {
  let sum = 0n;
  for (const e of events) {
    if (e.kind !== 'sale.completed') continue;
    const c = saleTotalCentavos(e);
    if (c !== null) sum += c;
  }
  return sum;
}

/** Show the band only offline, only with a rule in hand (an old snapshot has none), and only at or above it. */
export function showUnsentWarning(i: { online: boolean; unsentCentavos: bigint; warnCentavos: number | null }): boolean {
  return !i.online && i.warnCentavos !== null && i.unsentCentavos >= BigInt(i.warnCentavos);
}

/** '₱52,300' for whole pesos, '₱52,300.50' otherwise. Integer text only. */
export function pesoText(centavos: bigint): string {
  const neg = centavos < 0n;
  const abs = neg ? -centavos : centavos;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = abs % 100n;
  return `${neg ? '-' : ''}₱${whole}${cents === 0n ? '' : `.${cents.toString().padStart(2, '0')}`}`;
}

/** The band's sentence. */
export const unsentWarningText = (centavos: bigint): string => `${pesoText(centavos)} in sales not sent yet. Keep selling; call the manager.`;
