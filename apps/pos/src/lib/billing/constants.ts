// Fixed doc ID for the seeded "Additional Griller" universal charge
// (see scripts/seed-griller-charge.ts). Only the ID is shared/hardcoded —
// name/value/enabled state are always read live from Firestore, so admin
// edits in Universal Charges take effect immediately with no code change.
export const GRILLER_CHARGE_ID = "griller-addon-charge";
