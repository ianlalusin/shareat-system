import { describe, it, expect } from "vitest";
import {
  buildCustomerOrderBillLine,
  pendingBillLineFor,
  shouldVoidBilledQty,
  type PendingBillLine,
} from "@/lib/kitchen/customer-order-billing";

const pending = (over: Partial<PendingBillLine> = {}): PendingBillLine => ({
  lineId: "addon_kimbap_150",
  itemId: "kimbap",
  itemName: "Kimbap (Signature)",
  category: "Sides",
  unitPrice: 150,
  modifiers: null,
  modifiersText: null,
  modifiersTotal: null,
  kitchenLocationId: "kds_main",
  kitchenLocationName: "Main Kitchen",
  note: null,
  ...over,
});

describe("pendingBillLineFor", () => {
  it("returns the pending line for a customer order awaiting its first serve", () => {
    expect(pendingBillLineFor({ billOnServe: true, pendingBillLine: pending() })).not.toBeNull();
  });

  it("ignores a staff-placed add-on, which was already billed up front", () => {
    expect(pendingBillLineFor({ type: "addon", billLineId: "addon_x_100" })).toBeNull();
  });

  it("ignores a refill ticket", () => {
    expect(pendingBillLineFor({ type: "refill", billLineId: null })).toBeNull();
  });

  it("refuses a malformed pending line rather than billing something unidentifiable", () => {
    expect(pendingBillLineFor({ billOnServe: true, pendingBillLine: null })).toBeNull();
    expect(pendingBillLineFor({ billOnServe: true, pendingBillLine: pending({ lineId: "" }) })).toBeNull();
    expect(pendingBillLineFor({ billOnServe: true, pendingBillLine: pending({ itemId: "" }) })).toBeNull();
  });
});

describe("shouldVoidBilledQty", () => {
  it("voids the unserved remainder of a staff add-on, which was billed in full up front", () => {
    expect(shouldVoidBilledQty({ type: "addon", billLineId: "addon_x_100" })).toBe(true);
  });

  it("NEVER voids a bill-on-serve ticket — its line only ever holds what was served", () => {
    // The partial-serve trap: 1 of 3 served bills 1. Voiding the remaining 2
    // would drive the line to -1 billable.
    expect(
      shouldVoidBilledQty({ type: "addon", billLineId: "addon_kimbap_150", billOnServe: true })
    ).toBe(false);
  });

  it("does nothing for a customer order cancelled before any serve", () => {
    expect(shouldVoidBilledQty({ type: "addon", billLineId: null, billOnServe: true })).toBe(false);
  });
});

describe("buildCustomerOrderBillLine", () => {
  it("bills only the quantity actually served", () => {
    expect(buildCustomerOrderBillLine(pending(), 1).qtyOrdered).toBe(1);
    expect(buildCustomerOrderBillLine(pending(), 3).qtyOrdered).toBe(3);
  });

  it("opens the line with a clean adjustment slate", () => {
    const line = buildCustomerOrderBillLine(pending(), 2);
    expect(line).toMatchObject({ voidedQty: 0, freeQty: 0, discountQty: 0, discountValue: 0, discountType: null });
  });

  it("carries the price quoted at order time, not a later catalog price", () => {
    expect(buildCustomerOrderBillLine(pending({ unitPrice: 150 }), 1).unitPrice).toBe(150);
  });

  it("stamps provenance so a cashier can see the diner ordered it", () => {
    expect(buildCustomerOrderBillLine(pending(), 1).orderedVia).toBe("customer_app");
  });

  it("writes modifiers structurally and as text, and nulls them when there are none", () => {
    const withMods = buildCustomerOrderBillLine(
      pending({
        modifiers: [{ groupId: "og_dip", groupName: "Dip", valueId: "cheese", valueName: "Cheese", priceDelta: 20 }],
        modifiersText: "Cheese",
        modifiersTotal: 20,
      }),
      1
    );
    expect(withMods.modifiers).toHaveLength(1);
    expect(withMods.modifiersText).toBe("Cheese");
    expect(withMods.modifiersTotal).toBe(20);

    const without = buildCustomerOrderBillLine(pending(), 1);
    expect(without.modifiers).toBeNull();
    expect(without.modifiersText).toBeNull();
    expect(without.modifiersTotal).toBeNull();
  });

  it("uses the same line id the ticket reserved, so repeat orders merge onto one line", () => {
    expect(buildCustomerOrderBillLine(pending(), 1).id).toBe("addon_kimbap_150");
  });
});
