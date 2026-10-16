import { describe, it, expect } from "vitest";
import { servedQtyFields } from "./served-qty";

describe("servedQtyFields", () => {
  it("serves the whole ticket", () => {
    expect(servedQtyFields({ qtyOrdered: 3 })).toEqual({ qtyServed: 3, qtyRemaining: 0 });
  });

  it("falls back to qty for the package ticket, which has no qtyOrdered", () => {
    expect(servedQtyFields({ qty: 1 })).toEqual({ qtyServed: 1, qtyRemaining: 0 });
  });

  it("defaults to one when the ticket carries no quantity at all", () => {
    expect(servedQtyFields({})).toEqual({ qtyServed: 1, qtyRemaining: 0 });
  });

  it("does not re-serve quantity the kitchen already cancelled", () => {
    expect(servedQtyFields({ qtyOrdered: 3, qtyCancelled: 1 })).toEqual({ qtyServed: 2, qtyRemaining: 0 });
  });

  it("never goes negative", () => {
    expect(servedQtyFields({ qtyOrdered: 1, qtyCancelled: 4 })).toEqual({ qtyServed: 0, qtyRemaining: 0 });
  });

  it("treats an explicit zero as zero, not as missing", () => {
    expect(servedQtyFields({ qtyOrdered: 0 })).toEqual({ qtyServed: 0, qtyRemaining: 0 });
  });
});
