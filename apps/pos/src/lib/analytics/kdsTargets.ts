// Universal (no 'use client') — shared by the KDS analytics server endpoint AND
// the client fallback so both derive the SAME applied-state "targets" from a
// ticket. The analytics writer applies (target − stored marker), making KDS
// analytics idempotent and convergent across server + fallback and across
// partial serves.
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";

export type KdsTicketLike = {
  status?: string | null;
  type?: string | null;
  qty?: number | null;
  uom?: string | null;
  qtyServed?: number | null;
  qtyCancelled?: number | null;
  durationMs?: number | null;
  servedAtClientMs?: number | null;
  cancelledAtClientMs?: number | null;
  createdAtClientMs?: number | null;
};

// A weight/measured item (non-integer qty or a weight uom) counts as ONE serving,
// not its gram/kg value. Mirrors applyKdsTicketDelta.servingUnits.
export function kdsServingUnits(t: KdsTicketLike | null | undefined): number {
  const q = Number(t?.qty ?? 1);
  if (!Number.isInteger(q)) return 1;
  const uom = String(t?.uom ?? "").trim().toLowerCase();
  if (uom && /^(kg|g|gram|grams|ml|l|liter|litre)$/.test(uom)) return 1;
  return q;
}

export type KdsTargets = {
  servedQty: number;
  cancelledQty: number;
  durationMs: number;
  durationCount: number;
};

/** The analytics state a ticket SHOULD have contributed, given its current fields. */
export function computeKdsTargets(t: KdsTicketLike): KdsTargets {
  const status = t.status;
  const servedQty = t.qtyServed ?? (status === "served" ? kdsServingUnits(t) : 0);
  const cancelledQty = t.qtyCancelled ?? (status === "cancelled" ? kdsServingUnits(t) : 0);
  const durMs = Number(t.durationMs ?? 0);
  const fullyServed = status === "served" && durMs > 0; // duration only on full serve
  return {
    servedQty: Number(servedQty) || 0,
    cancelledQty: Number(cancelledQty) || 0,
    durationMs: fullyServed ? durMs : 0,
    durationCount: fullyServed ? 1 : 0,
  };
}

/** YYYYMMDD bucket for the ticket's terminal (or creation) event. */
export function kdsEventDayId(t: KdsTicketLike, now: Date): string {
  let eventMs: number | null = null;
  if (t.status === "served") eventMs = t.servedAtClientMs ?? null;
  else if (t.status === "cancelled") eventMs = t.cancelledAtClientMs ?? null;
  eventMs = eventMs || t.createdAtClientMs || now.getTime();
  return getDayIdFromTimestamp(eventMs);
}
