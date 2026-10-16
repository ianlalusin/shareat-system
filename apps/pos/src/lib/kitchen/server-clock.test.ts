import { describe, it, expect } from "vitest";
import {
  clientAheadFromSample,
  resolveTicketStartMs,
  serverNowMs,
  ticketAgeMs,
} from "./server-clock";

const T0 = 1_700_000_000_000;

describe("clientAheadFromSample", () => {
  it("is zero when the device agrees with the server", () => {
    // Request at T0, reply says T0+10, response back at T0+20: the midpoint of
    // the round trip is exactly the server's clock.
    expect(clientAheadFromSample(T0, T0 + 10, T0 + 20)).toBe(0);
  });

  it("measures a fast device as positive", () => {
    // The reported bug: a device 47s ahead of real time.
    const ahead = 47_000;
    expect(clientAheadFromSample(T0 + ahead, T0 + 10, T0 + ahead + 20)).toBe(ahead);
  });

  it("measures a slow device as negative", () => {
    expect(clientAheadFromSample(T0 - 30_000, T0 + 10, T0 - 30_000 + 20)).toBe(-30_000);
  });

  it("splits the round trip rather than blaming it on the clock", () => {
    // A 2s round trip on a correct clock must not read as a 2s offset.
    expect(clientAheadFromSample(T0, T0 + 1_000, T0 + 2_000)).toBe(0);
  });

  it("refuses a sample it cannot trust", () => {
    // Garbage, or a reply that arrived before it was sent.
    expect(clientAheadFromSample(NaN, T0, T0)).toBeNull();
    expect(clientAheadFromSample(T0, 0, T0 + 10)).toBeNull();
    expect(clientAheadFromSample(T0 + 100, T0, T0)).toBeNull();
  });

  it("refuses a round trip too slow to be informative", () => {
    // A 30s round trip could hide a 15s error either way; better no correction
    // than a confidently wrong one.
    expect(clientAheadFromSample(T0, T0, T0 + 30_000)).toBeNull();
  });
});

describe("serverNowMs", () => {
  it("subtracts the device's error", () => {
    expect(serverNowMs(47_000, T0 + 47_000)).toBe(T0);
  });

  it("passes the clock through when no offset is known yet", () => {
    expect(serverNowMs(null, T0)).toBe(T0);
    expect(serverNowMs(0, T0)).toBe(T0);
  });
});

describe("resolveTicketStartMs", () => {
  it("prefers the server timestamp over the device one", () => {
    // Both writers set createdAt; only the server's is trustworthy, because
    // createdAtClientMs comes from whichever browser wrote the ticket.
    expect(resolveTicketStartMs({ seconds: T0 / 1000, nanoseconds: 0 }, T0 + 47_000)).toBe(T0);
  });

  it("accepts the shapes a Firestore timestamp arrives in", () => {
    expect(resolveTicketStartMs({ toMillis: () => T0 }, null)).toBe(T0);
    expect(resolveTicketStartMs(new Date(T0), null)).toBe(T0);
    expect(resolveTicketStartMs(T0, null)).toBe(T0);
  });

  it("falls back to the client stamp while serverTimestamp is still pending", () => {
    // Latency compensation: POS's own optimistic write sees createdAt as null
    // until the server confirms it.
    expect(resolveTicketStartMs(null, T0)).toBe(T0);
    expect(resolveTicketStartMs(undefined, T0)).toBe(T0);
  });

  it("returns null when neither is usable", () => {
    expect(resolveTicketStartMs(null, null)).toBeNull();
    expect(resolveTicketStartMs(null, 0)).toBeNull();
    expect(resolveTicketStartMs({}, NaN)).toBeNull();
  });
});

describe("ticketAgeMs", () => {
  it("reads zero the instant a server-stamped ticket lands on a fast device", () => {
    // The whole bug: without the offset this showed 47s on arrival.
    expect(ticketAgeMs(T0, T0 + 47_000, 47_000)).toBe(0);
  });

  it("ticks forward normally once corrected", () => {
    expect(ticketAgeMs(T0, T0 + 47_000 + 90_000, 47_000)).toBe(90_000);
  });

  it("never reports a negative age", () => {
    expect(ticketAgeMs(T0 + 5_000, T0, 0)).toBe(0);
  });

  it("is null for a ticket with no usable start", () => {
    expect(ticketAgeMs(null, T0, 0)).toBeNull();
  });

  it("behaves exactly as before when no offset is known", () => {
    expect(ticketAgeMs(T0, T0 + 30_000, null)).toBe(30_000);
  });
});
