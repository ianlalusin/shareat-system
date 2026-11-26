/** T-641 - small formatting helpers for what a tool hands the model. Money stays an exact decimal string all the way (never a float). */

/** "1234.5" -> "₱1,234.50"; "-12" -> "-₱12.00". Works on the decimal TEXT, so nothing is rounded by a float. A value that is not a decimal comes back as it is. */
export function peso(value: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return value;
  const frac = `${m[3] ?? ''}00`.slice(0, 2);
  return `${m[1]}₱${BigInt(m[2] ?? '0').toLocaleString('en-US')}.${frac}`;
}

/** "someNewCheck" -> "Some new check"; "expense_outlier" -> "Expense outlier". */
export function plainKind(kind: string): string {
  const words = kind.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Cuts a list to `max` rows and says how many were left out, so the model never presents a cut list as the whole one. */
export function top<T>(rows: readonly T[], max: number): { rows: T[]; more: number } {
  return { rows: rows.slice(0, max), more: Math.max(0, rows.length - max) };
}
