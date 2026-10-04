/**
 * T-375 S2 (R3, R4) - POS v1 payment methods -> the store's tenders. `docs/tasks/375-pos-v1-day-feed.md`.
 *
 * PURE: no I/O. A POS method resolves to the store's ACTIVE tender whose normalized alias (lowercase, a-z0-9 only)
 * equals the method's normalized name. Explicit alias only: no name matching, no cash whitelist, no gaps. A zero
 * method is ignored; a negative method refuses; an unresolved non-zero method refuses; methods that resolve to one
 * tender are summed.
 *
 * The one float -> centavo conversion lives here (R4, I7): after it, only `@shareat/core/money`.
 */
import { add, fromCentavos, ZERO, type Money } from '@shareat/core/money';

export interface ResolverTender {
  readonly id: string;
  readonly kind: 'cash' | 'wallet';
  readonly moneyAccountId: string | null;
  readonly posV1Alias: string | null;
  readonly isActive: boolean;
}

export type ResolvedMethods =
  | { readonly ok: true; readonly cash: Money; readonly wallets: Map<string, Money> }
  | { readonly ok: false; readonly sentence: string; readonly raw: string };

/** v1's normalization: lowercase, strip everything outside a-z0-9. */
export function normalizePosV1Alias(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * One JSON number -> integer centavos: `c = round(x * 100)`, accepted only when `|x * 100 - c| <= 0.001` (R4).
 * Returns null for a non-finite or non-centavo value. Sign is kept (the caller decides what a negative means).
 */
export function toCentavos(x: number): bigint | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const scaled = x * 100;
  const c = Math.round(scaled);
  if (Math.abs(scaled - c) > 0.001) return null;
  return BigInt(c);
}

function pesos(centavos: bigint): string {
  const abs = centavos < 0n ? -centavos : centavos;
  const [whole = '0', frac = '00'] = fromCentavos(abs).split('.');
  return `₱${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

function refusal(raw: string, sentence: string): ResolvedMethods {
  return { ok: false, sentence, raw };
}

export function resolvePosV1Methods(byMethod: Record<string, number>, tenders: readonly ResolverTender[]): ResolvedMethods {
  const byAlias = new Map<string, ResolverTender>();
  for (const t of tenders) {
    if (!t.isActive || t.posV1Alias == null) continue;
    const key = normalizePosV1Alias(t.posV1Alias);
    if (key && !byAlias.has(key)) byAlias.set(key, t);
  }

  let cash: Money = ZERO;
  const wallets = new Map<string, Money>();

  for (const [method, amount] of Object.entries(byMethod)) {
    const c = toCentavos(amount);
    if (c === null) {
      return refusal(
        `resolvePosV1Methods: method "${method}" amount ${String(amount)} is not a whole number of centavos`,
        `POS sent an amount for "${method}" that isn't a whole number of centavos, so the day can't be imported.`,
      );
    }
    if (c === 0n) continue;
    if (c < 0n) {
      return refusal(
        `resolvePosV1Methods: method "${method}" total is negative (${c} centavos)`,
        `POS shows ${pesos(c)} more refunded than taken as "${method}" that day, so the day can't be imported.`,
      );
    }
    const tender = byAlias.get(normalizePosV1Alias(method));
    if (!tender) {
      return refusal(
        `resolvePosV1Methods: method "${method}" (${c} centavos) has no active tender alias`,
        `POS took ${pesos(c)} as "${method}", which isn't set up as a tender for this store. ` +
          'An admin maps it under Settings › POS link, then import again.',
      );
    }
    const value = fromCentavos(c);
    if (tender.kind === 'cash') {
      cash = add(cash, value);
    } else {
      if (!tender.moneyAccountId) {
        return refusal(
          `resolvePosV1Methods: wallet tender ${tender.id} has no money account`,
          `The tender for "${method}" has no money account. An admin fixes it under Settings › POS link, then import again.`,
        );
      }
      wallets.set(tender.moneyAccountId, add(wallets.get(tender.moneyAccountId) ?? ZERO, value));
    }
  }
  return { ok: true, cash, wallets };
}
