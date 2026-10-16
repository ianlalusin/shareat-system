"use client";

/**
 * Hand-off used by the "Seat now" button on /reservations. The reservations
 * page writes the party details here and navigates to /cashier; the cashier's
 * session list reads it once on mount, prefills the Start Session form (reusing
 * the existing pendingSeat path), and on completion marks the reservation
 * seated + links the new session. Kept in sessionStorage so it survives the
 * client-side navigation without coupling the two pages directly.
 */
const KEY = "reservationSeatHandoff";

export type ReservationSeatHandoff = {
  reservationId: string;
  storeId: string;
  name: string;
  partySize: number;
  phone?: string | null;
};

export function setReservationSeatHandoff(payload: ReservationSeatHandoff) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {}
}

export function takeReservationSeatHandoff(): ReservationSeatHandoff | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(raw) as ReservationSeatHandoff;
  } catch {
    return null;
  }
}
