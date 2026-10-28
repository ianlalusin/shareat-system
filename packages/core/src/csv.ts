/**
 * The one CSV cell rule — T-498 S2 / DEF-800. Every CSV writer in the tree (the ERP report exports and the leave
 * register) calls `escapeCsvCell`; nobody hand-rolls it.
 *
 * Two jobs, in this order:
 *  1. A STRING cell whose first character is `= + - @ TAB CR` is read by Excel and Google Sheets as a formula, so it
 *     gets a leading `'` (OWASP CSV-injection guidance) and shows as text.
 *  2. Then the usual quoting: a cell with a comma, quote or newline is wrapped in `"` with inner quotes doubled.
 *
 * Exceptions, so numbers stay numbers: a JS `number` is never prefixed, and neither is a string that is a plain
 * number or a peso figure.
 */

/**
 * A plain number or money figure that must NOT be prefixed. Our exports emit money through `formatMoney`
 * (`Intl.NumberFormat('en-PH', PHP)`), which gives `₱1,234.50` and, for a negative, `-₱303.03` (sign before the
 * symbol). Also allowed: the same with the sign after the symbol (`₱-303.03`), and bare `-12` / `-1,234.50`.
 * Only a minus is allowed as a sign: a leading `+` is never a number we emit. `-1+1` and `-1,23` do not match, so
 * they are prefixed.
 */
const PLAIN_NUMBER_OR_PESO = /^(?:-?₱-?|-)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && FORMULA_START.test(s) && !PLAIN_NUMBER_OR_PESO.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
