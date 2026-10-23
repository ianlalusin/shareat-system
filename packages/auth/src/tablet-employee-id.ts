/**
 * T-464 - the Employee ID a POS tablet's sign-in box takes: the NUMBER of the badge code, 1 to 3 digits (`7`, `07` and `007` all mean `SE-007`).
 * A leaf with no imports so the browser form and the server share one rule (a second copy is a second source of truth).
 *
 * Anything else (letters, a prefix, a 4th digit, spaces inside) is not an Employee ID on the tablet: the form refuses it and so does the server.
 * Such a person signs in through "Manager sign-in" instead.
 */
const TYPED = /^[0-9]{1,3}$/;

/** The typed digits, trimmed, or null when it is not 1-3 digits. */
export function parseTabletEmployeeId(typed: string): string | null {
  const t = typed.trim();
  return TYPED.test(t) ? t : null;
}

/** `7` -> `SE-007` (the `allocateStaffCode` format, upper-case), or null when it is not 1-3 digits. */
export function tabletEmployeeIdToStaffCode(typed: string): string | null {
  const digits = parseTabletEmployeeId(typed);
  return digits === null ? null : `SE-${digits.padStart(3, '0')}`;
}
