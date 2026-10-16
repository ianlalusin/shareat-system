import { describe, it, expect } from "vitest";
import {
  cardPillModel,
  classifyCustomerQuery,
  estimateEarnPoints,
  isCashierLinked,
  maskPhone,
  nameMatches,
  parseCardQrPayload,
} from "./session-link";

describe("classifyCustomerQuery", () => {
  it("normalizes phone shapes", () => {
    for (const raw of ["+639171234567", "09171234567", "9171234567", "0917 123 4567", "(0917) 123-4567"]) {
      expect(classifyCustomerQuery(raw)).toEqual({ kind: "phone", phone: "+639171234567" });
    }
  });
  it("treats partial digit strings as incomplete, not a name", () => {
    expect(classifyCustomerQuery("0917")).toEqual({ kind: "incomplete" });
    expect(classifyCustomerQuery("12345")).toEqual({ kind: "incomplete" });
  });
  it("treats text of 2+ chars as a name and shorter/empty as incomplete", () => {
    expect(classifyCustomerQuery("  Maria ")).toEqual({ kind: "name", q: "Maria" });
    expect(classifyCustomerQuery("M")).toEqual({ kind: "incomplete" });
    expect(classifyCustomerQuery("")).toEqual({ kind: "incomplete" });
  });
});

describe("parseCardQrPayload", () => {
  it("accepts the card QR (phone string)", () => {
    expect(parseCardQrPayload("+639171234567")).toBe("+639171234567");
    expect(parseCardQrPayload("09171234567")).toBe("+639171234567");
  });
  it("rejects URLs, payment QRs and junk", () => {
    expect(parseCardQrPayload("https://shareat.net/c/09171234567")).toBeNull();
    expect(parseCardQrPayload("00020101021228370011ph.ppmi.p2m")).toBeNull();
    expect(parseCardQrPayload("hello")).toBeNull();
    expect(parseCardQrPayload("")).toBeNull();
  });
});

describe("nameMatches", () => {
  it("is a case-insensitive plain substring match", () => {
    expect(nameMatches("Maria Santos", "mar")).toBe(true);
    expect(nameMatches("Maria Santos", "SANTOS")).toBe(true);
    expect(nameMatches("Maria Santos", "xyz")).toBe(false);
  });
  it("requires 2+ chars and treats regex/special chars literally", () => {
    expect(nameMatches("Maria Santos", "m")).toBe(false);
    expect(nameMatches("Maria Santos", ".*")).toBe(false);
    expect(nameMatches("A.* B", ".*")).toBe(true);
    expect(nameMatches("Maria", "%")).toBe(false);
  });
});

describe("maskPhone", () => {
  it("masks the middle digits", () => {
    expect(maskPhone("+639171234567")).toBe("+63 9•• ••• 4567");
  });
  it("returns empty string for invalid input", () => {
    expect(maskPhone("nope")).toBe("");
  });
});

describe("estimateEarnPoints", () => {
  it("uses the store rate, floors, defaults to 1pt/₱100", () => {
    expect(estimateEarnPoints(1250, { isEnabled: true, pointsPerPeso: 0.02 })).toBe(25);
    expect(estimateEarnPoints(1250)).toBe(12);
    expect(estimateEarnPoints(99, null)).toBe(0);
  });
  it("is 0 when loyalty is disabled or amount invalid", () => {
    expect(estimateEarnPoints(1000, { isEnabled: false, pointsPerPeso: 0.01 })).toBe(0);
    expect(estimateEarnPoints(0)).toBe(0);
    expect(estimateEarnPoints(NaN)).toBe(0);
  });
});

describe("cardPillModel", () => {
  it("unlinked", () => {
    expect(cardPillModel({})).toEqual({ linked: false, label: "No card", viaCashier: false });
    expect(cardPillModel({ linkedCustomerPhone: "  " })).toEqual({ linked: false, label: "No card", viaCashier: false });
  });
  it("linked with name", () => {
    expect(cardPillModel({ linkedCustomerPhone: "+639171234567", linkedCustomerName: "Maria Santos" }))
      .toEqual({ linked: true, label: "Maria Santos", viaCashier: false });
  });
  it("linked without name falls back to masked phone; cashier flag", () => {
    expect(cardPillModel({ linkedCustomerPhone: "+639171234567", linkedBy: "cashier" }))
      .toEqual({ linked: true, label: "+63 9•• ••• 4567", viaCashier: true });
  });
});

describe("isCashierLinked", () => {
  it("is true only for linkedBy === 'cashier'", () => {
    expect(isCashierLinked({ linkedBy: "cashier" })).toBe(true);
    expect(isCashierLinked({ linkedBy: "participant" })).toBe(false);
    expect(isCashierLinked({ linkedBy: "Cashier" })).toBe(false);
    expect(isCashierLinked({})).toBe(false);
    expect(isCashierLinked({ linkedBy: null })).toBe(false);
  });
  it("is false for a missing session doc", () => {
    expect(isCashierLinked(null)).toBe(false);
    expect(isCashierLinked(undefined)).toBe(false);
  });
});
