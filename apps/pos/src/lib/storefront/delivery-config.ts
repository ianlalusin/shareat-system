/** Raw, possibly-string form state for the delivery/pricing config dialog. */
export type DeliveryConfigInput = {
  deliveryFee?: number | string;
  minOrder?: number | string;
  prepEtaMinutes?: number | string;
  serviceAreaNote?: string;
};

export type DeliveryConfig = {
  deliveryFee: number;
  minOrder: number;
  prepEtaMinutes: number;
  serviceAreaNote: string;
};

function clampNonNegativeInt(v: number | string | undefined): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Clamps raw form text before it is submitted to set-config
 * (POS/src/app/api/admin/storefront-catalog/route.ts:68-83). Deliberately
 * STRICTER than the server, not a mirror of it: the server does
 * `Math.max(0, Number(x ?? 0)) || 0` and would happily store 49.6, while this
 * rounds to whole pesos/minutes first. Whole numbers only is the product
 * decision here (no ₱49.50 delivery fees) — because the client rounds before
 * the round trip, what the server stores still equals what the dialog shows.
 */
export function sanitizeDeliveryConfig(input: DeliveryConfigInput): DeliveryConfig {
  return {
    deliveryFee: clampNonNegativeInt(input.deliveryFee),
    minOrder: clampNonNegativeInt(input.minOrder),
    prepEtaMinutes: clampNonNegativeInt(input.prepEtaMinutes),
    serviceAreaNote: String(input.serviceAreaNote ?? "").slice(0, 300),
  };
}
