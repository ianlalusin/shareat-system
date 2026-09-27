/**
 * The wastage reason taxonomy — T-164, ported from v1 verbatim.
 *
 * ⭐ **One canonical list, shared across every item kind, and that sharing is the point.** v1's own
 * reason: *"reports can aggregate 'spoilage' or 'theft' across all item kinds without per-module
 * string normalization."* Item usage, meat usage and general inventory all draw from this one
 * enum in v1 precisely so that each module cannot invent its own spelling of "spoilage".
 *
 * ⛔ **A real enum, never a free-text column.** The moment it is text, one screen writes
 * `Spoilage`, another `spoiled`, and a year later nobody can answer "how much did we lose to
 * theft" without a normalisation pass over history.
 *
 * ⚠️ **It is a DIFFERENT and larger list than the delivery-shortage taxonomy** (T-166). A shortage
 * is a supplier-relationship signal that feeds a conversation with a vendor; wastage is a
 * stock-loss classification that feeds cost reporting. They share two words and no purpose, and
 * merging them would make both reports wrong.
 */
export const WASTAGE_REASONS = [
  'spoilage',
  'expiry',
  /** Damaged where it was stored — a fridge failure, a crushed carton on a shelf. */
  'damage_storage',
  /** Damaged while being handled — dropped, mis-cut, spilled. */
  'damage_handling',
  /** Trim, peel, bone — loss inherent to preparing the item. */
  'prep_loss',
  'overproduction',
  /** Theft and unexplained shrinkage. ⚠️ Kept as one code: v1 does not separate them, and a
   *  distinction nobody can evidence at the point of recording produces two unreliable numbers
   *  instead of one honest one. */
  'theft',
  'quality_reject',
  /** ⭐ Goods a customer sent back that cannot be resold — T-179's unsaleable branch posts here. */
  'customer_return_unsellable',
  'other',
] as const;

export type WastageReason = (typeof WASTAGE_REASONS)[number];

/** T-343 S6a — presentation label, exhaustive over `WASTAGE_REASONS`. */
export const WASTAGE_REASON_LABEL: Readonly<Record<WastageReason, string>> = {
  spoilage: 'Spoilage',
  expiry: 'Expired',
  damage_storage: 'Damaged in storage',
  damage_handling: 'Damaged in handling',
  prep_loss: 'Prep loss (trim, peel, bone)',
  overproduction: 'Overproduction',
  theft: 'Theft or unexplained loss',
  quality_reject: 'Failed quality check',
  customer_return_unsellable: 'Customer return, not resellable',
  other: 'Other',
};

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Total: an out-of-enum code (a v1 leftover) humanises instead of throwing. */
export function wastageReasonLabel(value: string): string {
  return Object.hasOwn(WASTAGE_REASON_LABEL, value) ? WASTAGE_REASON_LABEL[value as WastageReason] : humanise(value);
}

export function isWastageReason(value: string): value is WastageReason {
  return (WASTAGE_REASONS as readonly string[]).includes(value);
}

/**
 * ⭐ Categories a usage record may NEVER carry — T-168's named footgun, shared here because both
 * the usage path and this module need the same answer.
 *
 * v1's reason, and it is exact: **the usage flow writes only an OUT leg**, so a movement
 * mislabelled as a transfer *destroys* stock instead of moving it. The stock leaves one location
 * and arrives nowhere.
 *
 * ⚠️ v1 enforces this on the client AND the server. The client copy is a convenience; **the server
 * is the control**, and in v2 the check lives here so both callers get the same list.
 */
export const RESERVED_USAGE_CATEGORIES = [
  'transfer',
  'transfers',
  'transfer out',
  'transfer_out',
  'transfer in',
  'transfer_in',
  'move',
  'moved',
  'relocate',
  'relocation',
] as const;

/** Case- and whitespace-insensitive, because the footgun is a human typing a label. */
export function isReservedUsageCategory(value: string | null | undefined): boolean {
  const normalised = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  return (RESERVED_USAGE_CATEGORIES as readonly string[]).some(
    (reserved) => reserved.replace(/[\s_-]+/g, ' ') === normalised,
  );
}
