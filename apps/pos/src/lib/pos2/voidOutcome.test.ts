import { describe, expect, it } from "vitest";
import { ALREADY_VOIDED, voidOutcome } from "./voidOutcome";

describe("voidOutcome (T-424 audit: the queued loyalty reversal survives an unknown outcome)", () => {
  it("a definite 4xx refusal takes the reversal back out", () => {
    for (const status of [400, 401, 403, 404, 409]) expect(voidOutcome({ status, message: "That table is already paid or closed, so it cannot be voided." })).toBe("refused");
  });
  it("no answer (0) or a server error keeps it", () => {
    for (const status of [0, 500, 502, 503]) expect(voidOutcome({ status, message: "x" })).toBe("unknown");
    expect(voidOutcome(new Error("boom"))).toBe("unknown");
    expect(voidOutcome(null)).toBe("unknown");
  });
  it("409 already voided counts as done", () => {
    expect(voidOutcome({ status: 409, message: ALREADY_VOIDED })).toBe("voided");
  });
});
