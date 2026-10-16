import { describe, expect, it } from "vitest";

import { pickOnlineQr, planFlagChange } from "./online-qr";
import type { SavedQrCode } from "@/lib/types";

/** Minimal fixture — only the fields pickOnlineQr/planFlagChange care about. */
function makeQr(overrides: Partial<SavedQrCode> & { id: string }): SavedQrCode {
  return {
    id: overrides.id,
    storeId: "store1",
    name: overrides.name ?? `QR ${overrides.id}`,
    provider: "gcash",
    sortOrder: overrides.sortOrder ?? 0,
    isActive: overrides.isActive ?? true,
    payload: "00020101...",
    createdAt: null,
    createdAtMs: 0,
    createdByUid: "uid1",
    updatedAt: null,
    useForOnlineOrders: overrides.useForOnlineOrders,
  };
}

function shuffle<T>(arr: T[]): T[] {
  // A plain reversal, deliberately deterministic — no Math.random flakiness in
  // a test whose whole point is determinism. Reversal is enough: it puts a
  // different qualifying doc first, so any "whichever came back first"
  // implementation returns a different answer and the test fails.
  const out = [...arr].reverse();
  return out;
}

describe("pickOnlineQr", () => {
  it("returns null when none flagged", () => {
    const codes = [makeQr({ id: "a" }), makeQr({ id: "b", isActive: true })];
    expect(pickOnlineQr(codes)).toBeNull();
  });

  it("returns the one flagged and active", () => {
    const target = makeQr({ id: "b", useForOnlineOrders: true, isActive: true });
    const codes = [makeQr({ id: "a" }), target, makeQr({ id: "c" })];
    expect(pickOnlineQr(codes)).toBe(target);
  });

  it("returns null when the flagged one is inactive", () => {
    const codes = [
      makeQr({ id: "a" }),
      makeQr({ id: "b", useForOnlineOrders: true, isActive: false }),
    ];
    expect(pickOnlineQr(codes)).toBeNull();
  });

  it("breaks a tie between two flagged codes by the lower sortOrder", () => {
    const lower = makeQr({ id: "z", useForOnlineOrders: true, isActive: true, sortOrder: 1 });
    const higher = makeQr({ id: "a", useForOnlineOrders: true, isActive: true, sortOrder: 5 });
    const codes = [higher, lower];
    expect(pickOnlineQr(codes)).toBe(lower);
  });

  it("breaks a tie between equal sortOrder by the lexicographically lower id", () => {
    const higherId = makeQr({ id: "qr-b", useForOnlineOrders: true, isActive: true, sortOrder: 3 });
    const lowerId = makeQr({ id: "qr-a", useForOnlineOrders: true, isActive: true, sortOrder: 3 });
    const codes = [higherId, lowerId];
    expect(pickOnlineQr(codes)).toBe(lowerId);
  });

  it("is deterministic: the same set in shuffled array order returns the SAME document", () => {
    const codes = [
      makeQr({ id: "qr-c", useForOnlineOrders: true, isActive: true, sortOrder: 2 }),
      makeQr({ id: "qr-a", useForOnlineOrders: true, isActive: true, sortOrder: 2 }),
      makeQr({ id: "qr-b", useForOnlineOrders: true, isActive: true, sortOrder: 2 }),
      makeQr({ id: "qr-d", useForOnlineOrders: false, isActive: true, sortOrder: 1 }),
      makeQr({ id: "qr-e", useForOnlineOrders: true, isActive: false, sortOrder: 0 }),
    ];

    const originalPick = pickOnlineQr(codes);
    const shuffledPick = pickOnlineQr(shuffle(codes));

    expect(originalPick).not.toBeNull();
    expect(originalPick?.id).toBe("qr-a");
    expect(shuffledPick?.id).toBe(originalPick?.id);
  });
});

describe("planFlagChange", () => {
  it("flagging a fresh one produces 2 entries: set target true + clear the old one", () => {
    const codes = [
      makeQr({ id: "a", useForOnlineOrders: true }),
      makeQr({ id: "b", useForOnlineOrders: false }),
    ];
    const plan = planFlagChange(codes, "b");
    expect(plan).toHaveLength(2);
    expect(plan).toEqual(
      expect.arrayContaining([
        { id: "b", useForOnlineOrders: true },
        { id: "a", useForOnlineOrders: false },
      ]),
    );
  });

  it("flagging the one already flagged returns an empty array", () => {
    const codes = [
      makeQr({ id: "a", useForOnlineOrders: true }),
      makeQr({ id: "b", useForOnlineOrders: false }),
    ];
    expect(planFlagChange(codes, "a")).toEqual([]);
  });

  it("unflags every currently-true code when targetId is null", () => {
    const codes = [
      makeQr({ id: "a", useForOnlineOrders: true }),
      makeQr({ id: "b", useForOnlineOrders: false }),
    ];
    expect(planFlagChange(codes, null)).toEqual([{ id: "a", useForOnlineOrders: false }]);
  });

  it("returns an empty array for an empty collection", () => {
    expect(planFlagChange([], "anything")).toEqual([]);
    expect(planFlagChange([], null)).toEqual([]);
  });
});
