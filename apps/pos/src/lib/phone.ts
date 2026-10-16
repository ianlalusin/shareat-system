/**
 * Shared normaliser for PH mobile numbers, used across the loyalty program
 * (account lookup, password reset, etc.) to derive the canonical customer
 * document ID. Accepted input shapes: 63XXXXXXXXXX / 09XXXXXXXXX / 9XXXXXXXXX
 * (non-digit characters are stripped before matching). All accepted shapes
 * return the canonical `+63XXXXXXXXXX` form; anything else returns null.
 */
export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("63")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("09")) return `+63${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("9")) return `+63${digits}`;
  return null;
}
