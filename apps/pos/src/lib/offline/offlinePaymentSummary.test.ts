import { describe, it, expect } from "vitest";
import { buildOfflinePaymentSummary } from "@/lib/offline/offlinePaymentSummary";

const CASH = { id: "m_cash", name: "Cash", type: "cash" };
const CARD = { id: "m_card", name: "Card", type: "card" };

describe("buildOfflinePaymentSummary", () => {
  it("exact cash: no change, mop reflects the tender", () => {
    const r = buildOfflinePaymentSummary({
      payments: [{ methodId: "m_cash", amount: 100 }],
      paymentMethods: [CASH, CARD],
      amountDueCents: 10000,
    });
    expect(r).toEqual({ mopMap: { Cash: 100 }, totalPaid: 100, change: 0 });
  });

  it("cash with change: change is deducted from the cash mop", () => {
    const r = buildOfflinePaymentSummary({
      payments: [{ methodId: "m_cash", amount: 150 }],
      paymentMethods: [CASH, CARD],
      amountDueCents: 10000,
    });
    expect(r.change).toBe(50);
    expect(r.totalPaid).toBe(150);
    expect(r.mopMap.Cash).toBe(100); // 150 tendered - 50 change
  });

  it("card exact: no change, mop by method name", () => {
    const r = buildOfflinePaymentSummary({
      payments: [{ methodId: "m_card", amount: 100 }],
      paymentMethods: [CASH, CARD],
      amountDueCents: 10000,
    });
    expect(r).toEqual({ mopMap: { Card: 100 }, totalPaid: 100, change: 0 });
  });

  it("split cash+card exact: both mops present, no change", () => {
    const r = buildOfflinePaymentSummary({
      payments: [
        { methodId: "m_card", amount: 60 },
        { methodId: "m_cash", amount: 40 },
      ],
      paymentMethods: [CASH, CARD],
      amountDueCents: 10000,
    });
    expect(r.change).toBe(0);
    expect(r.mopMap).toEqual({ Card: 60, Cash: 40 });
  });

  it("throws when underpaid", () => {
    expect(() =>
      buildOfflinePaymentSummary({
        payments: [{ methodId: "m_cash", amount: 90 }],
        paymentMethods: [CASH],
        amountDueCents: 10000,
      }),
    ).toThrow(/balance is not zero/);
  });

  it("throws when change exists but no cash tender", () => {
    expect(() =>
      buildOfflinePaymentSummary({
        payments: [{ methodId: "m_card", amount: 150 }],
        paymentMethods: [CASH, CARD],
        amountDueCents: 10000,
      }),
    ).toThrow(/no Cash payment/i);
  });

  it("throws when change exceeds cash tendered", () => {
    expect(() =>
      buildOfflinePaymentSummary({
        payments: [
          { methodId: "m_card", amount: 110 },
          { methodId: "m_cash", amount: 40 },
        ],
        paymentMethods: [CASH, CARD],
        amountDueCents: 10000,
      }),
    ).toThrow(/exceeds cash paid/i);
  });
});
