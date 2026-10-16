import { describe, it, expect } from "vitest";
import { formatKitchenTicket } from "@/lib/printing/kitchenTicketFormatter";

const base = {
  stationName: "GRILL",
  tableOrCustomer: "TABLE 5",
  itemName: "Beef Platter",
  qty: 2,
  timeText: "14:32",
};

describe("formatKitchenTicket", () => {
  it("includes the OFFLINE header, station, table, and qty x item", () => {
    const t = formatKitchenTicket(base);
    expect(t).toContain("*** OFFLINE ***");
    expect(t).toContain("GRILL");
    expect(t).toContain("TABLE 5");
    expect(t).toContain("2 x Beef Platter");
    expect(t).toContain("14:32");
  });

  it("includes modifiers and notes when present", () => {
    const t = formatKitchenTicket({ ...base, modifiersText: "extra sauce", notes: "no onions" });
    expect(t).toContain("extra sauce");
    expect(t).toContain("no onions");
  });

  it("omits the note line when notes are absent", () => {
    const t = formatKitchenTicket(base);
    expect(t).not.toContain("Note:");
  });

  it("ends with a newline so the printer flushes the last line", () => {
    expect(formatKitchenTicket(base).endsWith("\n")).toBe(true);
  });
});
