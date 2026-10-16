import { describe, it, expect } from "vitest";
import { computeKdsTargets } from "@/lib/analytics/kdsTargets";

/**
 * These pin down a trap that cost a real serve during QA.
 *
 * `servedQty` is `t.qtyServed ?? fallback` — nullish, not falsy. A ticket
 * written with an explicit `qtyServed: 0` (which BOTH POS's createKitchenTickets
 * and the customer app's writer do) therefore reports ZERO serves unless the
 * serve path updates the field. The whole-ticket serve path did not, so serving
 * such a ticket logged no serve at all to KDS analytics.
 *
 * The fix is for the serve path to set `qtyServed` explicitly. These tests keep
 * the fallback honest and document why the explicit write matters.
 */
describe("computeKdsTargets — the qtyServed: 0 trap", () => {
  it("reports ZERO for a served ticket that still carries qtyServed: 0", () => {
    // Exactly the shape a freshly-written ticket has before a serve updates it.
    expect(computeKdsTargets({ status: "served", qty: 3, qtyServed: 0 }).servedQty).toBe(0);
  });

  it("reports the served quantity once the serve path writes it", () => {
    expect(computeKdsTargets({ status: "served", qty: 3, qtyServed: 3 }).servedQty).toBe(3);
  });

  it("falls back to the ticket qty only when qtyServed is genuinely absent", () => {
    expect(computeKdsTargets({ status: "served", qty: 2 }).servedQty).toBe(2);
    expect(computeKdsTargets({ status: "served", qty: 2, qtyServed: null }).servedQty).toBe(2);
  });

  it("counts a partial serve as what was actually served", () => {
    expect(computeKdsTargets({ status: "partially_served", qty: 3, qtyServed: 1 }).servedQty).toBe(1);
  });

  it("applies the same rule to cancellations", () => {
    expect(computeKdsTargets({ status: "cancelled", qty: 2, qtyCancelled: 0 }).cancelledQty).toBe(0);
    expect(computeKdsTargets({ status: "cancelled", qty: 2, qtyCancelled: 2 }).cancelledQty).toBe(2);
    expect(computeKdsTargets({ status: "cancelled", qty: 2 }).cancelledQty).toBe(2);
  });

  it("counts a weighed item as one serving, not its gram value", () => {
    expect(computeKdsTargets({ status: "served", qty: 250, uom: "g" }).servedQty).toBe(1);
  });

  it("only records a duration for a fully-served ticket", () => {
    expect(computeKdsTargets({ status: "served", qty: 1, durationMs: 5000 }).durationCount).toBe(1);
    expect(computeKdsTargets({ status: "partially_served", qty: 3, qtyServed: 1, durationMs: 5000 }).durationCount).toBe(0);
  });
});
