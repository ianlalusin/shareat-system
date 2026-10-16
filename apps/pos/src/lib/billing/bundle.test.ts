import { describe, expect, it } from "vitest";
import { bundleExtraPax } from "./bundle";

describe("bundleExtraPax", () => {
  it("bills nothing extra below the covered headcount", () => {
    expect(bundleExtraPax(3, 5)).toBe(0);
  });

  it("bills nothing extra exactly at the cap", () => {
    expect(bundleExtraPax(5, 5)).toBe(0);
  });

  it("bills only the guests past the cap", () => {
    expect(bundleExtraPax(8, 5)).toBe(3);
  });

  // The cap is a billing threshold, not a seating limit: a headcount above it is
  // expected, not an error to be clamped away.
  it("allows a headcount far above the cap", () => {
    expect(bundleExtraPax(20, 5)).toBe(15);
  });

  it("never treats an unconfigured cap as 'bill every guest'", () => {
    expect(bundleExtraPax(8, 0)).toBe(0);
    expect(bundleExtraPax(8, undefined)).toBe(0);
    expect(bundleExtraPax(8, null)).toBe(0);
    expect(bundleExtraPax(8, -5)).toBe(0);
  });

  it("is safe against non-numeric guest counts", () => {
    expect(bundleExtraPax(undefined, 5)).toBe(0);
    expect(bundleExtraPax(null, 5)).toBe(0);
    expect(bundleExtraPax(NaN, 5)).toBe(0);
    expect(bundleExtraPax(-3, 5)).toBe(0);
  });

  it("reads numeric strings, as Firestore snapshots sometimes carry them", () => {
    expect(bundleExtraPax("8", "5")).toBe(3);
  });
});
