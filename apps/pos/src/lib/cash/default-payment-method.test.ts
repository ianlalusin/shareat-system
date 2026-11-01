import { describe, expect, it } from "vitest";
import { defaultPaymentMethodId } from "./default-payment-method";

const m = (id: string, name: string, type: string) => ({ id, name, type });

describe("defaultPaymentMethodId (DEF-808 C4)", () => {
  it("pre-selects Cash even when v1 typed it other", () => {
    expect(defaultPaymentMethodId([m("g", "GCash", "other"), m("c", "Cash", "other")])).toBe("c");
  });
  it("prefers a method typed cash", () => {
    expect(defaultPaymentMethodId([m("g", "GCash", "online"), m("t", "Till", "cash")])).toBe("t");
  });
  it("never takes Gcash as the cash default; falls back to the first method, then to empty", () => {
    expect(defaultPaymentMethodId([m("g", "Gcash", "other"), m("b", "Bank Transfer", "other")])).toBe("g");
    expect(defaultPaymentMethodId([])).toBe("");
  });
});
