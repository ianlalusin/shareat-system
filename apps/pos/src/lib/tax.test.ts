import { describe, it, expect } from "vitest";
import { calculateBillTotals, type LoyaltyDiscountInput } from "@/lib/tax";
import type { SessionBillLine, Store, Discount, LineAdjustment } from "@/lib/types";

// --- fixtures -------------------------------------------------------------

function mkLine(partial: Partial<SessionBillLine>): SessionBillLine {
  return {
    id: "l1",
    type: "package",
    itemId: "i1",
    itemName: "Item",
    unitPrice: 0,
    qtyOrdered: 1,
    discountType: null,
    discountValue: null,
    discountQty: 0,
    freeQty: 0,
    voidedQty: 0,
    createdAt: null,
    updatedAt: null,
    ...partial,
  } as SessionBillLine;
}

function mkStore(taxType: Store["taxType"], taxRatePct = 12): Store {
  return { taxType, taxRatePct } as unknown as Store;
}

function lineDiscount(value: number, type: "percent" | "fixed" = "percent", qty = 1): Record<string, LineAdjustment> {
  return {
    adj1: {
      id: "adj1",
      kind: "discount",
      note: "disc",
      type,
      value,
      qty,
      createdAtClientMs: 1,
      createdByUid: "u1",
    } as LineAdjustment,
  };
}

function billDiscount(value: number, type: "percent" | "fixed" = "percent", vatExempt = false): Discount {
  return { id: "d1", name: "Disc", type, value, vatExempt } as unknown as Discount;
}

const noLoyalty: LoyaltyDiscountInput = null;

// --- VAT_INCLUSIVE (12%) --------------------------------------------------

describe("VAT_INCLUSIVE", () => {
  const store = mkStore("VAT_INCLUSIVE", 12);

  it("1. no discount: ₱112 → vatable 100, vat 12, grand 112", () => {
    const t = calculateBillTotals([mkLine({ unitPrice: 112, qtyOrdered: 1 })], store, null, [], noLoyalty);
    expect(t.subtotal).toBeCloseTo(112, 2);
    expect(t.vatableSales).toBeCloseTo(100, 2);
    expect(t.taxTotal).toBeCloseTo(12, 2);
    expect(t.grandTotal).toBeCloseTo(112, 2);
    expect(t.vatExemptSales).toBeCloseTo(0, 2);
  });

  it("2. 10% line discount: ₱112 → discount 11.20, grand 100.80, vatable 90, vat 10.80", () => {
    const t = calculateBillTotals(
      [mkLine({ unitPrice: 112, qtyOrdered: 1, lineAdjustments: lineDiscount(10) })],
      store,
      null,
      [],
      noLoyalty
    );
    expect(t.lineDiscountsTotal).toBeCloseTo(11.2, 2);
    expect(t.grandTotal).toBeCloseTo(100.8, 2);
    expect(t.vatableSales).toBeCloseTo(90, 2);
    expect(t.taxTotal).toBeCloseTo(10.8, 2);
  });

  it("3. 10% bill discount: identical to the 10% line discount", () => {
    const t = calculateBillTotals([mkLine({ unitPrice: 112, qtyOrdered: 1 })], store, billDiscount(10), [], noLoyalty);
    expect(t.billDiscountTotal).toBeCloseTo(11.2, 2);
    expect(t.grandTotal).toBeCloseTo(100.8, 2);
    expect(t.vatableSales).toBeCloseTo(90, 2);
    expect(t.taxTotal).toBeCloseTo(10.8, 2);
  });

  it("4. fixed ₱11.20 bill discount: grand 100.80, vatable 90, vat 10.80", () => {
    const t = calculateBillTotals(
      [mkLine({ unitPrice: 112, qtyOrdered: 1 })],
      store,
      billDiscount(11.2, "fixed"),
      [],
      noLoyalty
    );
    expect(t.grandTotal).toBeCloseTo(100.8, 2);
    expect(t.vatableSales).toBeCloseTo(90, 2);
    expect(t.taxTotal).toBeCloseTo(10.8, 2);
  });

  it("5. loyalty fixed ₱11.20: grand 100.80, vatable 90, vat 10.80", () => {
    const t = calculateBillTotals([mkLine({ unitPrice: 112, qtyOrdered: 1 })], store, null, [], [
      { type: "fixed", value: 11.2 },
    ]);
    expect(t.grandTotal).toBeCloseTo(100.8, 2);
    expect(t.vatableSales).toBeCloseTo(90, 2);
    expect(t.taxTotal).toBeCloseTo(10.8, 2);
  });

  it("6. senior/PWD VAT-exempt 20%: ₱112 → grand 80, vatExempt 80, vatable 0, vat 0", () => {
    const t = calculateBillTotals(
      [mkLine({ unitPrice: 112, qtyOrdered: 1 })],
      store,
      billDiscount(20, "percent", true),
      [],
      noLoyalty
    );
    expect(t.grandTotal).toBeCloseTo(80, 2);
    expect(t.vatExemptSales).toBeCloseTo(80, 2);
    expect(t.vatableSales).toBeCloseTo(0, 2);
    expect(t.taxTotal).toBeCloseTo(0, 2);
  });

  it("7. multi-line senior/PWD VAT-exempt 20%: ₱112+₱224 → grand 240, vatExempt 240, vat 0", () => {
    const t = calculateBillTotals(
      [mkLine({ id: "a", unitPrice: 112, qtyOrdered: 1 }), mkLine({ id: "b", unitPrice: 224, qtyOrdered: 1 })],
      store,
      billDiscount(20, "percent", true),
      [],
      noLoyalty
    );
    // gross 336 → net 300 → 20% off = 60 → exempt 240
    expect(t.grandTotal).toBeCloseTo(240, 2);
    expect(t.vatExemptSales).toBeCloseTo(240, 2);
    expect(t.taxTotal).toBeCloseTo(0, 2);
  });
});

// --- VAT_EXCLUSIVE (12%) — regression guard, behavior must be unchanged ---

describe("VAT_EXCLUSIVE", () => {
  const store = mkStore("VAT_EXCLUSIVE", 12);

  it("8. no discount: ₱100 → vatable 100, vat 12, grand 112", () => {
    const t = calculateBillTotals([mkLine({ unitPrice: 100, qtyOrdered: 1 })], store, null, [], noLoyalty);
    expect(t.vatableSales).toBeCloseTo(100, 2);
    expect(t.taxTotal).toBeCloseTo(12, 2);
    expect(t.grandTotal).toBeCloseTo(112, 2);
  });

  it("9. 10% line discount: ₱100 → vatable 90, vat 10.80, grand 100.80", () => {
    const t = calculateBillTotals(
      [mkLine({ unitPrice: 100, qtyOrdered: 1, lineAdjustments: lineDiscount(10) })],
      store,
      null,
      [],
      noLoyalty
    );
    expect(t.vatableSales).toBeCloseTo(90, 2);
    expect(t.taxTotal).toBeCloseTo(10.8, 2);
    expect(t.grandTotal).toBeCloseTo(100.8, 2);
  });
});

// --- NON_VAT — regression guard ------------------------------------------

describe("NON_VAT", () => {
  const store = mkStore("NON_VAT", 0);

  it("10. no discount: ₱100 → vatable 100, no tax, grand 100", () => {
    const t = calculateBillTotals([mkLine({ unitPrice: 100, qtyOrdered: 1 })], store, null, [], noLoyalty);
    expect(t.vatableSales).toBeCloseTo(100, 2);
    expect(t.taxTotal).toBeCloseTo(0, 2);
    expect(t.grandTotal).toBeCloseTo(100, 2);
  });

  it("11. 10% line discount: ₱100 → vatable 90, grand 90", () => {
    const t = calculateBillTotals(
      [mkLine({ unitPrice: 100, qtyOrdered: 1, lineAdjustments: lineDiscount(10) })],
      store,
      null,
      [],
      noLoyalty
    );
    expect(t.vatableSales).toBeCloseTo(90, 2);
    expect(t.grandTotal).toBeCloseTo(90, 2);
  });
});
