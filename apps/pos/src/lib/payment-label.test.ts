import { describe, it, expect } from "vitest";
import { paymentLabel } from "./payment-label";

describe("paymentLabel", () => {
  it("uses methodLabel verbatim when present", () => {
    expect(paymentLabel({ payment: { methodLabel: "GCash" } })).toBe("GCash");
  });

  it("prefers methodLabel over the paymongo branch", () => {
    expect(
      paymentLabel({ payment: { method: "paymongo", methodLabel: "Maya" } })
    ).toBe("Maya");
  });

  it("ignores a whitespace-only methodLabel and falls through to the next branch", () => {
    expect(
      paymentLabel({ payment: { method: "paymongo", methodLabel: "   " } })
    ).toBe("Online (PayMongo)");
  });

  it("falls back to Online (PayMongo) for a paymongo order with no methodLabel", () => {
    expect(paymentLabel({ payment: { method: "paymongo" } })).toBe("Online (PayMongo)");
  });

  it("falls back to Cash on Delivery for a delivery order", () => {
    expect(paymentLabel({ fulfillment: { type: "delivery" } })).toBe("Cash on Delivery");
  });

  it("falls back to Pay at Counter for a pickup order", () => {
    expect(paymentLabel({ fulfillment: { type: "pickup" } })).toBe("Pay at Counter");
  });

  it("falls back to Pay at Counter when fulfillment is entirely absent", () => {
    expect(paymentLabel({})).toBe("Pay at Counter");
  });

  it("falls back to Pay at Counter for a null/undefined order", () => {
    expect(paymentLabel(null)).toBe("Pay at Counter");
    expect(paymentLabel(undefined)).toBe("Pay at Counter");
  });
});
