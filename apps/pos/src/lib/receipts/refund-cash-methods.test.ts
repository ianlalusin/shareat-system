import { describe, expect, it } from "vitest";
import type { ModeOfPayment } from "@/lib/types";
import { refundCashMethods } from "./refund-cash-methods";

const m = (over: Partial<ModeOfPayment>) =>
  ({ id: "x", name: "Cash", type: "other", sortOrder: 0, isActive: true, hasRef: false, isArchived: false, ...over }) as ModeOfPayment;

describe("refundCashMethods", () => {
  it("finds Cash labelled type 'other' (Lipa's live data) but never Gcash or a transfer", () => {
    expect(refundCashMethods([m({ id: "a" }), m({ id: "b", name: "Gcash" }), m({ id: "c", name: "Bank Transfer" }), m({ id: "d", name: " cash " })]).map((x) => x.id)).toEqual(["a", "d"]);
  });
  it("finds a method typed cash whatever its name", () => {
    expect(refundCashMethods([m({ id: "a", name: "Till", type: "cash" })]).map((x) => x.id)).toEqual(["a"]);
  });
  it("skips inactive and archived cash", () => {
    expect(refundCashMethods([m({ isActive: false }), m({ isArchived: true })])).toEqual([]);
  });
  it("returns nothing when the store has no cash", () => {
    expect(refundCashMethods([m({ name: "Bank Transfer" })])).toEqual([]);
  });
});
