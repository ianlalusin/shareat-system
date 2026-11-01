/**
 * The e-wallets Convert can move money to and from. A method is an e-wallet when its type is "online" OR its name is exactly
 * "GCash" or "Maya" (Ian, 1 Nov 2026; QRPH and Bank Transfer are not). v1's live data types every method "other" (found at Lipa),
 * so type alone matched nothing. Same shape as isCashTender; once ERP 2 types e-wallets "online" the name check does nothing.
 */
const EWALLET_NAMES = new Set(["gcash", "maya"]);

export function isEwalletTender(m: { type?: unknown; name?: unknown }): boolean {
  return String(m.type ?? "").toLowerCase() === "online" || EWALLET_NAMES.has(String(m.name ?? "").trim().toLowerCase());
}
