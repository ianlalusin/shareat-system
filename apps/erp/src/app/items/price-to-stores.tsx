/**
 * T-638. The price a commissary charges stores for an item, in plain words. One place, read by the item page (where it is
 * edited) and by Commissary -> Catalogue (read-only), so the two never word it differently. The figures come from the
 * domain's `priceToStores` (the very walk the orders price with); this file only says them.
 */
import type { PriceToStores } from '@shareat/domain';
import { peso } from '../../lib/format';

/** "15.0000" -> "15", "12.5000" -> "12.5". */
function plain(n: string): string {
  return n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n;
}

export interface PriceToStoresWords {
  /** "₱245.00", or "Needs a cost" (never ₱0). */
  headline: string;
  /** How it was worked out, or what is missing. */
  how: string;
  /** The muted chip, or null. */
  alert: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-11-27' -> '27 Nov' (plain text, no time zone involved: it is a business day). */
function shortDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`;
}

/** T-650 S1: where the cost came from, in words - "last production (27 Nov, Lipa)", "slab delivery", "last delivery". */
export function basisWords(v: Pick<PriceToStores, 'basisFrom' | 'basisProducedOn' | 'basisStoreName'>): string {
  if (v.basisFrom === 'produced') return `last production (${v.basisProducedOn ? shortDay(v.basisProducedOn) : 'date unknown'}, ${v.basisStoreName ?? 'a store'})`;
  return v.basisFrom === 'linked' ? 'slab delivery' : 'last delivery';
}

export function priceToStoresWords(v: PriceToStores): PriceToStoresWords {
  if (v.price === null) {
    return {
      headline: 'Needs a cost',
      how: v.rule?.pricingMode === 'fixed'
        ? 'The fixed price comes to nothing and there is no manual cost, so a store cannot be charged for it.'
        : v.rule
        ? 'There is no delivery cost yet for the markup to add to, and no manual cost, so a store cannot be charged for it.'
        : 'No pricing rule is set, and there is no manual cost, so a store cannot be charged for it.',
      alert: null,
    };
  }
  const headline = peso(v.price);
  if (v.from === 'manual_cost') {
    return { headline, how: `${headline} = manual cost (no deliveries yet)`, alert: null };
  }
  const rule = v.rule;
  let how = headline;
  if (rule?.pricingMode === 'fixed') how = `${headline} fixed`;
  else if (rule && v.basis !== null) {
    const base = `${basisWords(v)} ${peso(v.basis)}`;
    how =
      rule.pricingMode === 'fixed_markup'
        ? `${headline} = ${base} + ${peso(rule.fixedMarkupAmount ?? '0')}`
        : `${headline} = ${base} + ${plain(rule.markupPercent ?? '0')}%`;
  }
  const t = rule?.marginAlertThresholdPct;
  return { headline, how, alert: v.marginAlert && t ? `below your ${plain(t)}% margin alert` : null };
}

/** The read-only rendering: the worked-out line and the chip. */
export function PriceToStoresText({ view }: { view: PriceToStores }) {
  const w = priceToStoresWords(view);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={view.price === null ? 'text-warning-ink' : undefined}>{view.price === null ? w.headline : w.how}</span>
      {w.alert && (
        <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
          {w.alert}
        </span>
      )}
    </span>
  );
}
