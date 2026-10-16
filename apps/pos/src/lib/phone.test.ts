import { describe, it, expect } from "vitest";
import { normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  describe("accepted shapes", () => {
    it("12-digit 63XXXXXXXXXX returns +63XXXXXXXXXX", () => {
      expect(normalizePhone("639171234567")).toBe("+639171234567");
    });

    it("11-digit 09XXXXXXXXX returns +63XXXXXXXXXX", () => {
      expect(normalizePhone("09171234567")).toBe("+639171234567");
    });

    it("10-digit 9XXXXXXXXX returns +63XXXXXXXXXX", () => {
      expect(normalizePhone("9171234567")).toBe("+639171234567");
    });
  });

  describe("punctuation/spaces stripped before matching", () => {
    it("strips spaces from a 09-prefixed number", () => {
      expect(normalizePhone("0917 123 4567")).toBe("+639171234567");
    });

    it("strips a leading + and spaces from a 63-prefixed number", () => {
      expect(normalizePhone("+63 917 123 4567")).toBe("+639171234567");
    });

    it("strips parentheses and dashes from a 09-prefixed number", () => {
      expect(normalizePhone("(0917) 123-4567")).toBe("+639171234567");
    });
  });

  describe("rejects", () => {
    it("empty string returns null", () => {
      expect(normalizePhone("")).toBeNull();
    });

    it("too-short number returns null", () => {
      expect(normalizePhone("12345")).toBeNull();
    });

    it("too-long number returns null", () => {
      expect(normalizePhone("639171234567890")).toBeNull();
    });

    it("10-digit number not starting with 9 returns null", () => {
      expect(normalizePhone("8171234567")).toBeNull();
    });

    it("11-digit number not starting with 09 returns null", () => {
      expect(normalizePhone("19171234567")).toBeNull();
    });

    it("12-digit number not starting with 63 returns null", () => {
      expect(normalizePhone("649171234567")).toBeNull();
    });

    it("pure-garbage non-numeric string returns null", () => {
      expect(normalizePhone("abcdefghij")).toBeNull();
    });
  });
});
