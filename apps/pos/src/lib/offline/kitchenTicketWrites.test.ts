import { describe, it, expect } from "vitest";
import { selectTicketWriter } from "@/lib/offline/kitchenTicketWrites";

describe("selectTicketWriter", () => {
  it("returns the transaction when opts has tx", () => {
    const tx = { set() {}, update() {} };
    expect(selectTicketWriter({ tx })).toBe(tx);
  });
  it("returns the batch when opts has batch", () => {
    const batch = { set() {}, update() {} };
    expect(selectTicketWriter({ batch })).toBe(batch);
  });
  it("prefers tx over batch when both keys are present ('tx' in opts wins)", () => {
    const tx = { set() {}, update() {} };
    const batch = { set() {}, update() {} };
    expect(selectTicketWriter({ tx, batch } as any)).toBe(tx);
  });
});
