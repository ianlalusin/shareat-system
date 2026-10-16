import { arrayUnion } from "firebase/firestore";
import type { ReservationEvent, ReservationEventType } from "@/lib/types";

export const EVENT_LABEL: Record<ReservationEventType, string> = {
  created: "Booked",
  edited: "Edited",
  confirmed: "Confirmed",
  seated: "Seated",
  cancelled: "Cancelled",
  no_show: "No-show",
  handled: "Handled",
  payment_recorded: "Payment recorded",
  payment_voided: "Payment voided",
  payments_applied: "Payments applied to bill",
};

type Actor = { uid?: string | null; name?: string | null } | null;

// Build a lifecycle event. Times use client ms to match the rest of the
// reservation model (reservedForMs, createdAtClientMs) and so the value is
// stable inside a Firestore array (serverTimestamp isn't allowed in arrays).
export function reservationEvent(
  type: ReservationEventType,
  by: Actor,
  note?: string | null,
): ReservationEvent {
  return {
    at: Date.now(),
    type,
    byUid: by?.uid ?? null,
    byName: by?.name ?? null,
    note: note ?? null,
  };
}

// For use in a Firestore update payload: { history: appendReservationEvent(evt) }.
export function appendReservationEvent(evt: ReservationEvent) {
  return arrayUnion(evt);
}
