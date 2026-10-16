import { describe, it, expect } from "vitest";
import { isWithinStoreHours, computeOnlineAvailability } from "@/lib/storefront/online-hours";

// Manila is UTC+8 (no DST). A fixed UTC instant maps to a known Manila clock,
// so these assertions are deterministic regardless of the runner's timezone.
const utc = (iso: string) => new Date(iso);

describe("isWithinStoreHours", () => {
  it("treats missing hours as always open", () => {
    expect(isWithinStoreHours(undefined, undefined, utc("2026-06-17T03:00:00Z"))).toBe(true);
    expect(isWithinStoreHours("10:00", undefined, utc("2026-06-17T03:00:00Z"))).toBe(true);
  });

  it("is open inside a normal daytime window (10:00–22:00 Manila)", () => {
    // 05:00Z => 13:00 Manila => open
    expect(isWithinStoreHours("10:00", "22:00", utc("2026-06-17T05:00:00Z"))).toBe(true);
  });

  it("is closed before opening and at/after closing", () => {
    // 00:00Z => 08:00 Manila => before 10:00 => closed
    expect(isWithinStoreHours("10:00", "22:00", utc("2026-06-17T00:00:00Z"))).toBe(false);
    // 14:00Z => 22:00 Manila => closing is exclusive => closed
    expect(isWithinStoreHours("10:00", "22:00", utc("2026-06-17T14:00:00Z"))).toBe(false);
  });

  it("handles overnight windows (18:00–02:00 Manila)", () => {
    // 17:00Z => 01:00 Manila => still open (past midnight)
    expect(isWithinStoreHours("18:00", "02:00", utc("2026-06-17T17:00:00Z"))).toBe(true);
    // 06:00Z => 14:00 Manila => closed (between close and open)
    expect(isWithinStoreHours("18:00", "02:00", utc("2026-06-17T06:00:00Z"))).toBe(false);
    // 11:00Z => 19:00 Manila => open
    expect(isWithinStoreHours("18:00", "02:00", utc("2026-06-17T11:00:00Z"))).toBe(true);
  });

  it("falls back to open on malformed hours", () => {
    expect(isWithinStoreHours("oops", "22:00", utc("2026-06-17T00:00:00Z"))).toBe(true);
  });
});

describe("computeOnlineAvailability", () => {
  const open5amZ = utc("2026-06-17T05:00:00Z"); // 13:00 Manila
  const midnightZ = utc("2026-06-17T00:00:00Z"); // 08:00 Manila

  it("an un-enrolled store is always closed", () => {
    const a = computeOnlineAvailability({ acceptsOnlineOrders: false, onlineOrderManualOpen: true }, open5amZ);
    expect(a.enrolled).toBe(false);
    expect(a.openNow).toBe(false);
  });

  it("auto mode follows the store hours", () => {
    const base = { acceptsOnlineOrders: true, onlineOrderMode: "auto" as const, openingTime: "10:00", closingTime: "22:00" };
    expect(computeOnlineAvailability(base, open5amZ).openNow).toBe(true);
    expect(computeOnlineAvailability(base, midnightZ).openNow).toBe(false);
    expect(computeOnlineAvailability(base, open5amZ).scheduleControlled).toBe(true);
  });

  it("manual mode ignores hours and uses the override", () => {
    const open = { acceptsOnlineOrders: true, onlineOrderMode: "manual" as const, onlineOrderManualOpen: true, openingTime: "10:00", closingTime: "22:00" };
    const closed = { ...open, onlineOrderManualOpen: false };
    // Outside hours but manually forced open => open.
    expect(computeOnlineAvailability(open, midnightZ).openNow).toBe(true);
    // Inside hours but manually forced closed => closed.
    expect(computeOnlineAvailability(closed, open5amZ).openNow).toBe(false);
  });

  it("defaults (enrolled, no mode/override) behave like the old always-open boolean", () => {
    const a = computeOnlineAvailability({ acceptsOnlineOrders: true }, midnightZ);
    expect(a.mode).toBe("manual");
    expect(a.openNow).toBe(true);
  });
});
