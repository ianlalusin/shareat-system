import { formatBusinessDateTime } from '@shareat/core/datetime';

/**
 * Display formatting for the ERP screens. Presentation only — never arithmetic, never storage.
 *
 * ⚠️ **This exists because five screens each had their own copy of `peso()`, and all five put the
 * minus sign in the wrong place.** They interpolated the symbol by hand — `₱${n.toLocaleString()}`
 * — which renders a negative balance as `₱-27,850.00`, symbol first and sign second. On a money
 * picker that is exactly the figure a reader must not misread: an overdrawn till is the reason the
 * overdraft guard (bible row 154) speaks up at all, and the screen was showing it in a shape that
 * invites the eye to skip the sign.
 *
 * ⭐ `Intl` with `style: 'currency'` puts the sign where the locale wants it — `-₱27,850.00` — and
 * it is the same formatter `@shareat/core`'s `formatMoney` uses. That one takes a branded `Money`;
 * these screens hold plain strings off the repo, so this is the same rule applied one layer out.
 */
const PESO = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function peso(amount: string | number): string {
  const n = Number(amount);
  // ⚠️ `-0` formats as "-₱0.00", which reads as a deficit that is not there. A balance of exactly
  // zero has no sign.
  return PESO.format(n === 0 ? 0 : n);
}

/** "2026-10" (or "2026-10-01") as "October 2026", Manila. Anything that is not a year-month comes back unchanged. */
export function monthName(period: string): string {
  const m = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(period);
  if (!m) return period;
  return formatBusinessDateTime(new Date(`${m[1]}-01T00:00:00+08:00`), { month: 'long', year: 'numeric' });
}
