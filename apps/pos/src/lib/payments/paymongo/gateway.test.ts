import { describe, it, expect } from "vitest";
import { isPaymongoQrMethod, shouldOfferPaymongoQr } from "@/lib/payments/paymongo/gateway";

describe("isPaymongoQrMethod", () => {
  it("is true only for the paymongo_qrph gateway", () => {
    expect(isPaymongoQrMethod({ gateway: "paymongo_qrph" })).toBe(true);
    expect(isPaymongoQrMethod({ gateway: null })).toBe(false);
    expect(isPaymongoQrMethod({ gateway: undefined })).toBe(false);
  });
});

describe("shouldOfferPaymongoQr", () => {
  it("offers only when active AND online", () => {
    const mop = { gateway: "paymongo_qrph" as const, isActive: true };
    expect(shouldOfferPaymongoQr(mop, true)).toBe(true);
    expect(shouldOfferPaymongoQr(mop, false)).toBe(false);
    expect(shouldOfferPaymongoQr({ gateway: "paymongo_qrph", isActive: false }, true)).toBe(false);
  });

  it("never gates a non-gateway method (returns true so normal rules apply)", () => {
    expect(shouldOfferPaymongoQr({ gateway: null, isActive: true }, false)).toBe(true);
  });
});
