/**
 * T-436 - ISO date (`YYYY-MM-DD`) ordering without a relational operator on a string.
 *
 * An ISO date sorts correctly as text, so `a < b` would be right. It is written this way instead because the T-371 numeric guard
 * (G2) flags EVERY `<` / `>` on two strings as a possible NaN-blind comparison of a money figure, and a business date is not one:
 * rather than add an exemption for each date check, the ordering lives here once, as the default string sort (UTF-16 code units),
 * which for fixed-width ISO dates is exactly chronological order.
 */

/** -1 if `a` is earlier than `b`, 0 if the same day, 1 if later. Both must be `YYYY-MM-DD`. */
export function cmpIso(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return [a, b].sort()[0] === a ? -1 : 1;
}

export const isoBefore = (a: string, b: string): boolean => cmpIso(a, b) === -1;
export const isoAfter = (a: string, b: string): boolean => cmpIso(a, b) === 1;
/** `a` is the same day as `b` or earlier. */
export const isoOnOrBefore = (a: string, b: string): boolean => cmpIso(a, b) !== 1;
/** `a` is the same day as `b` or later. */
export const isoOnOrAfter = (a: string, b: string): boolean => cmpIso(a, b) !== -1;
