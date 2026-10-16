import { describe, it, expect } from "vitest";
import {
  pendingEffects,
  markEffect,
  isItemComplete,
  type QueuedPayment,
} from "@/lib/offline/payment-queue";

function item(overrides: Partial<QueuedPayment> = {}): QueuedPayment {
  return {
    id: "q1",
    storeId: "s1",
    sessionId: "sess1",
    receiptId: "sess1",
    queuedAtMs: 0,
    status: "pending",
    ctx: { pin: "1234", phone: "0917", amount: 100 },
    effects: {
      analytics: "pending",
      loyaltyFinalize: "pending",
      loyaltyEarn: "pending",
      pinFinalize: "pending",
      loyaltyReverse: "skip",
    },
    ...overrides,
  };
}

describe("pendingEffects", () => {
  it("lists only effects still pending", () => {
    const it0 = item({ effects: { analytics: "done", loyaltyFinalize: "pending", loyaltyEarn: "skip", pinFinalize: "pending", loyaltyReverse: "skip" } });
    expect(pendingEffects(it0).sort()).toEqual(["loyaltyFinalize", "pinFinalize"]);
  });
});

describe("markEffect", () => {
  it("returns a new item with the effect state changed, others untouched", () => {
    const before = item();
    const after = markEffect(before, "analytics", "done");
    expect(after.effects.analytics).toBe("done");
    expect(after.effects.loyaltyEarn).toBe("pending");
    expect(before.effects.analytics).toBe("pending"); // immutability
  });
});

describe("isItemComplete", () => {
  it("is true when no effect is pending (done/skip only)", () => {
    expect(isItemComplete(item({ effects: { analytics: "done", loyaltyFinalize: "done", loyaltyEarn: "skip", pinFinalize: "done", loyaltyReverse: "skip" } }))).toBe(true);
  });
  it("is false when any effect is still pending", () => {
    expect(isItemComplete(item({ effects: { analytics: "done", loyaltyFinalize: "pending", loyaltyEarn: "skip", pinFinalize: "done", loyaltyReverse: "skip" } }))).toBe(false);
  });
});

function voidItem(effects: Partial<QueuedPayment["effects"]> = {}): QueuedPayment {
  return {
    id: "v1", storeId: "s1", sessionId: "sess1", receiptId: "sess1", queuedAtMs: 0, status: "pending", kind: "void",
    ctx: { amount: 0, pin: "1234", redemptionIds: ["r1", "r2"] },
    effects: { analytics: "skip", loyaltyFinalize: "skip", loyaltyEarn: "skip", pinFinalize: "pending", loyaltyReverse: "pending", ...effects },
  };
}

describe("outbox void support", () => {
  it("lists only the void effects as pending", () => {
    expect(pendingEffects(voidItem()).sort()).toEqual(["loyaltyReverse", "pinFinalize"]);
  });
  it("markEffect works for loyaltyReverse", () => {
    const after = markEffect(voidItem(), "loyaltyReverse", "done");
    expect(after.effects.loyaltyReverse).toBe("done");
  });
  it("isItemComplete true when void effects done/skip", () => {
    expect(isItemComplete(voidItem({ loyaltyReverse: "done", pinFinalize: "done" }))).toBe(true);
  });
});
