import { describe, expect, it } from "vitest";
import { sanitizeDeliveryConfig } from "./delivery-config";

describe("sanitizeDeliveryConfig", () => {
  it("clamps negative numbers to 0", () => {
    expect(sanitizeDeliveryConfig({ deliveryFee: -5, minOrder: -1, prepEtaMinutes: -10, serviceAreaNote: "" }))
      .toEqual({ deliveryFee: 0, minOrder: 0, prepEtaMinutes: 0, serviceAreaNote: "" });
  });

  it("coerces string numbers from form inputs", () => {
    expect(sanitizeDeliveryConfig({ deliveryFee: "50", minOrder: "200", prepEtaMinutes: "15", serviceAreaNote: "Lipa only" } as any))
      .toEqual({ deliveryFee: 50, minOrder: 200, prepEtaMinutes: 15, serviceAreaNote: "Lipa only" });
  });

  it("defaults missing/invalid numbers to 0", () => {
    expect(sanitizeDeliveryConfig({ deliveryFee: undefined, minOrder: NaN, prepEtaMinutes: "abc" as any, serviceAreaNote: undefined as any }))
      .toEqual({ deliveryFee: 0, minOrder: 0, prepEtaMinutes: 0, serviceAreaNote: "" });
  });

  it("truncates serviceAreaNote to 300 chars, matching the server", () => {
    const long = "x".repeat(400);
    const result = sanitizeDeliveryConfig({ deliveryFee: 0, minOrder: 0, prepEtaMinutes: 0, serviceAreaNote: long });
    expect(result.serviceAreaNote).toHaveLength(300);
  });

  it("rounds fractional minutes/pesos to whole numbers", () => {
    expect(sanitizeDeliveryConfig({ deliveryFee: 49.6, minOrder: 199.4, prepEtaMinutes: 14.5, serviceAreaNote: "" }))
      .toEqual({ deliveryFee: 50, minOrder: 199, prepEtaMinutes: 15, serviceAreaNote: "" }); // Math.round: 49.6->50, 199.4->199, 14.5->15
  });
});
