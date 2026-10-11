/**
 * T-392 S1 - strict v1 amount reading. v1 stores pesos as floats; anything else (a "1,234.50" string, a currency symbol,
 * NaN, a missing field) is bad data and must be LOUD, naming the document - never a silent zero.
 */
export function parseAmount(value: unknown, docId: string, what: string, optional = false): number {
  if (value === undefined || value === null) {
    if (optional) return 0;
    throw new Error(`document ${docId}: ${what} is missing`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  throw new Error(`document ${docId}: ${what} is not a plain number (${JSON.stringify(value)})`);
}
