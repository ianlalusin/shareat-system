import { describe, it, expect } from "vitest";
import { globalInactiveIds, partitionVisibleRefills, stalePackageIds } from "../refill-visibility";

const sr = (refillId: string, extra: Partial<{ isEnabled: boolean; isOther: boolean }> = {}) => ({
  refillId,
  refillName: refillId,
  isEnabled: extra.isEnabled ?? true,
  isOther: extra.isOther ?? false,
});

describe("globalInactiveIds", () => {
  it("collects only ids explicitly marked inactive", () => {
    const set = globalInactiveIds([
      { id: "pork", isActive: true },
      { id: "combo", isActive: false },
      { id: "beef" }, // undefined -> not inactive
    ]);
    expect([...set]).toEqual(["combo"]);
  });
});

describe("partitionVisibleRefills", () => {
  const all = [sr("pork"), sr("beef"), sr("combo"), sr("rice", { isOther: true })];

  it("hides a globally retired refill even when the store still enables it", () => {
    const { mains } = partitionVisibleRefills(all, new Set(["combo"]));
    expect(mains.map((r) => r.refillId)).toEqual(["pork", "beef"]);
  });

  it("hides a store-disabled refill", () => {
    const { mains } = partitionVisibleRefills([sr("pork"), sr("beef", { isEnabled: false })], new Set());
    expect(mains.map((r) => r.refillId)).toEqual(["pork"]);
  });

  it("keeps a refill that has no global doc at all — fail open, never silently vanish", () => {
    // "orphan" is absent from the globals list entirely, so it is not inactive.
    const inactive = globalInactiveIds([{ id: "pork", isActive: true }]);
    const { mains } = partitionVisibleRefills([sr("pork"), sr("orphan")], inactive);
    expect(mains.map((r) => r.refillId)).toEqual(["pork", "orphan"]);
  });

  it("applies the package allow-list when there is one", () => {
    const { mains } = partitionVisibleRefills(all, new Set(), ["pork", "beef"]);
    expect(mains.map((r) => r.refillId)).toEqual(["pork", "beef"]);
  });

  it("treats an empty or missing allow-list as no filter", () => {
    expect(partitionVisibleRefills(all, new Set(), []).mains).toHaveLength(3);
    expect(partitionVisibleRefills(all, new Set(), null).mains).toHaveLength(3);
  });

  it("splits Other Refills out of the meats", () => {
    const { mains, others } = partitionVisibleRefills(all, new Set());
    expect(mains.map((r) => r.refillId)).toEqual(["pork", "beef", "combo"]);
    expect(others.map((r) => r.refillId)).toEqual(["rice"]);
  });

  it("reproduces the Lipa bug: granting a meat only via a retired combo leaves it out", () => {
    // package allows Pork + the combo; combo is retired -> only Pork survives.
    const { mains } = partitionVisibleRefills(all, new Set(["combo"]), ["pork", "combo"]);
    expect(mains.map((r) => r.refillId)).toEqual(["pork"]);
  });
});

describe("stalePackageIds", () => {
  it("flags ids the editor cannot show", () => {
    expect(stalePackageIds(["pork", "combo", "deleted"], ["pork", "beef"])).toEqual(["combo", "deleted"]);
  });

  it("returns nothing when every id is selectable", () => {
    expect(stalePackageIds(["pork", "beef"], ["pork", "beef", "rice"])).toEqual([]);
  });

  it("de-duplicates and tolerates empty input", () => {
    expect(stalePackageIds(["combo", "combo"], ["pork"])).toEqual(["combo"]);
    expect(stalePackageIds(null, ["pork"])).toEqual([]);
    expect(stalePackageIds(undefined, [])).toEqual([]);
  });
});
