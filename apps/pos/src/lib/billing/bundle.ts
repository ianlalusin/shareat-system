/**
 * Bundle package headcount rules.
 *
 * `bundleMaxCap` is a BILLING threshold, not a seating limit. A bundle priced at
 * ₱1999 "good for 5" covers the first 5 guests in that flat price; guests past
 * the 5th are billed per head at `bundleExtraHeadPrice`. There is no maximum
 * guest count — the headcount is free to exceed the cap, and it still drives PIN
 * slots, covers, kitchen prep and guest analytics (see `StorePackage.isBundle`).
 *
 * An extra-head price of 0 is a valid configuration: guests beyond the cap are
 * simply included at no charge.
 */

/**
 * Guests billed beyond a bundle's covered headcount.
 *
 * Returns 0 for a missing or zero cap — an unconfigured cap must never bill
 * every guest as overflow.
 */
export function bundleExtraPax(guestCount: unknown, cap: unknown): number {
  const guests = Number(guestCount);
  const covered = Number(cap);
  if (!Number.isFinite(guests) || !Number.isFinite(covered) || covered <= 0) return 0;
  return Math.max(0, guests - covered);
}
