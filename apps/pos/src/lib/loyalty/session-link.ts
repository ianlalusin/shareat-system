import { normalizePhone } from "@/lib/phone";

/** Mirrors DEFAULT_POINTS_PER_PESO in src/lib/server/loyalty.ts (1 point per ₱100). */
export const DEFAULT_POINTS_PER_PESO = 0.01;
export const MIN_NAME_QUERY = 2;

export type CustomerQuery =
  | { kind: "phone"; phone: string }
  | { kind: "name"; q: string }
  | { kind: "incomplete" };

/** Digits-and-phone-punctuation only → a phone query; anything else → a name query. */
export function classifyCustomerQuery(raw: string): CustomerQuery {
  const q = String(raw ?? "").trim();
  if (!q) return { kind: "incomplete" };
  if (/^\+?[\d\s()-]+$/.test(q)) {
    const phone = normalizePhone(q);
    return phone ? { kind: "phone", phone } : { kind: "incomplete" };
  }
  return q.length >= MIN_NAME_QUERY ? { kind: "name", q } : { kind: "incomplete" };
}

/** The card QR is the bare phone string; anything else (URL, EMVCo, text) is not a card. */
export function parseCardQrPayload(payload: string): string | null {
  const c = classifyCustomerQuery(payload);
  return c.kind === "phone" ? c.phone : null;
}

export function nameMatches(name: string, q: string): boolean {
  const needle = String(q ?? "").trim().toLowerCase();
  if (needle.length < MIN_NAME_QUERY) return false;
  return String(name ?? "").toLowerCase().includes(needle);
}

export function maskPhone(phone: string): string {
  const n = normalizePhone(phone);
  if (!n) return "";
  const d = n.slice(3); // 10 digits, 9XXXXXXXXX
  return `+63 ${d[0]}•• ••• ${d.slice(-4)}`;
}

/** Same math as writeLoyaltyEarn: floor(amount × rate). 0 when disabled/invalid. */
export function estimateEarnPoints(
  amount: number,
  cfg?: { isEnabled?: boolean; pointsPerPeso?: number } | null,
): number {
  if (cfg && cfg.isEnabled === false) return 0;
  if (!(amount > 0)) return 0;
  const rate = Number(cfg?.pointsPerPeso) || DEFAULT_POINTS_PER_PESO;
  return Math.floor(amount * rate);
}

/**
 * A cashier link (staff typed/scanned the number) proves nothing about the
 * customer being present, so it earns points only: it grants no store presence
 * and cannot be used to spend the customer's points or vouchers.
 */
export function isCashierLinked(session: { linkedBy?: unknown } | null | undefined): boolean {
  return session?.linkedBy === "cashier";
}

export type CardPillModel = { linked: boolean; label: string; viaCashier: boolean };

export function cardPillModel(s: {
  linkedCustomerPhone?: string | null;
  linkedCustomerName?: string | null;
  linkedBy?: string | null;
}): CardPillModel {
  const phone = String(s.linkedCustomerPhone ?? "").trim();
  if (!phone) return { linked: false, label: "No card", viaCashier: false };
  const name = String(s.linkedCustomerName ?? "").trim();
  return {
    linked: true,
    label: name || maskPhone(phone) || "Linked",
    viaCashier: s.linkedBy === "cashier",
  };
}
