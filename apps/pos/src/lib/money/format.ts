/**
 * T-425 - plain text for whole centavos, with thousands separators and two decimals: 5_234_000 -> "52,340.00".
 * Whole-number arithmetic only (no floating point, no rounding), so a total printed on a slip is exactly the ledger's number.
 */
export function formatCentavos(centavos: number): string {
  const negative = centavos < 0;
  const abs = negative ? -centavos : centavos;
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
}
