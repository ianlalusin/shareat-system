import { describe, expect, it } from "vitest";
import { isEwalletTender } from "./ewallet-tender";

const m = (name: string, type: string) => ({ name, type });

describe("isEwalletTender (T-506 / Ian 1 Nov: GCash and Maya are e-wallets)", () => {
  it("takes GCash and Maya whatever v1 typed them (live data types them other)", () => {
    expect(isEwalletTender(m("GCash", "other"))).toBe(true);
    expect(isEwalletTender(m("Gcash", "other"))).toBe(true);
    expect(isEwalletTender(m(" Maya ", "other"))).toBe(true);
  });
  it("takes anything typed online (ERP 2 will type e-wallets correctly)", () => {
    expect(isEwalletTender(m("Whatever", "online"))).toBe(true);
  });
  it("never takes QRPH, Bank Transfer or Cash", () => {
    expect(isEwalletTender(m("QRPH", "other"))).toBe(false);
    expect(isEwalletTender(m("Bank Transfer", "other"))).toBe(false);
    expect(isEwalletTender(m("Cash", "other"))).toBe(false);
    expect(isEwalletTender(m("Maya Bank", "other"))).toBe(false);
  });
});
