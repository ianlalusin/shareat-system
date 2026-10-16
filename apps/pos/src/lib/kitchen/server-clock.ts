/**
 * Ticket age measured in server time, not in whatever the device believes.
 *
 * The KDS used to render `Date.now() - createdAtClientMs`, differencing two
 * machines' clocks. A customer-app order is stamped by the server while a POS
 * order is stamped by the cashier's browser, so a KDS tablet running 47s fast
 * showed customer orders as 47s old the moment they landed, and POS orders as
 * 0s — which reads exactly like "the timer started when they built their cart".
 *
 * The stamp was never the problem. Any honest stamp looks old on a fast clock,
 * and the only stamp that would have looked right is one taken from the same
 * wrong clock — self-consistency bought by corrupting the data. So the fix is
 * on the reading side: learn how far the device is from the server, then
 * measure server-time-to-server-time.
 *
 * Pure and clock-free: every function takes `nowMs` rather than calling
 * Date.now(), so the arithmetic is testable. The sampling lives in
 * hooks/use-server-clock.ts.
 */

/** Round trips slower than this tell us too little to correct anything. */
export const MAX_USEFUL_ROUND_TRIP_MS = 10_000;

/**
 * How far this device's clock runs ahead of the server's, in ms. Negative if it
 * runs behind, null if the sample cannot be trusted.
 *
 * The midpoint of the round trip is the device's best guess at the instant the
 * server answered, so comparing it to the server's own reading isolates the
 * clock difference from the network latency. This is what SNTP does, and it
 * matters: without it a 2s round trip would read as a 2s clock error.
 */
export function clientAheadFromSample(
  sentAtMs: number,
  serverMs: number,
  receivedAtMs: number
): number | null {
  if (!Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs)) return null;
  if (!Number.isFinite(serverMs) || serverMs <= 0) return null;

  const roundTripMs = receivedAtMs - sentAtMs;
  if (roundTripMs < 0 || roundTripMs > MAX_USEFUL_ROUND_TRIP_MS) return null;

  return Math.round((sentAtMs + receivedAtMs) / 2 - serverMs);
}

/** The server's clock, as best this device can tell. */
export function serverNowMs(clientAheadMs: number | null, nowMs: number): number {
  return nowMs - (clientAheadMs ?? 0);
}

/**
 * When a ticket was created, preferring the server's own stamp.
 *
 * `createdAt` is a Firestore serverTimestamp() and both writers set it, so it
 * is the same clock for every ticket regardless of who wrote it.
 * `createdAtClientMs` is only a fallback: it comes from whichever browser wrote
 * the ticket, and is briefly the only thing available on POS's own optimistic
 * write, before the server has confirmed the serverTimestamp.
 */
export function resolveTicketStartMs(
  createdAt: any,
  createdAtClientMs: number | null | undefined
): number | null {
  const fromServer = toMillis(createdAt);
  if (fromServer != null) return fromServer;

  const fromClient = Number(createdAtClientMs);
  return Number.isFinite(fromClient) && fromClient > 0 ? fromClient : null;
}

/** Live ticket age, corrected for this device's clock. Null if it has no start. */
export function ticketAgeMs(
  startMs: number | null,
  nowMs: number,
  clientAheadMs: number | null
): number | null {
  if (startMs == null || !Number.isFinite(startMs)) return null;
  return Math.max(0, serverNowMs(clientAheadMs, nowMs) - startMs);
}

/** The shapes a Firestore timestamp reaches the client in. */
function toMillis(input: any): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input : null;
  if (input instanceof Date) {
    const t = input.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof input.toMillis === "function") {
    const t = input.toMillis();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof input.seconds === "number") {
    const ns = typeof input.nanoseconds === "number" ? input.nanoseconds : 0;
    return input.seconds * 1000 + Math.floor(ns / 1e6);
  }
  return null;
}
