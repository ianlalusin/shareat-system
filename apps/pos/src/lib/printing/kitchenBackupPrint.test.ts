import { describe, it, expect, vi } from "vitest";
import { printKitchenTicketBackup, type KitchenTicketDoc, type BackupPrintDeps } from "@/lib/printing/kitchenBackupPrint";

function ticket(over: Partial<KitchenTicketDoc> = {}): KitchenTicketDoc {
  return { id: "t1", kitchenLocationId: "grill", kitchenLocationName: "Grill", itemName: "Beef", qty: 2, tableDisplayName: "Table 5", sessionMode: "package_dinein", ...over };
}
function deps(over: Partial<BackupPrintDeps> = {}): BackupPrintDeps {
  return {
    isOnline: () => false,
    getKitchenPrinterAddress: () => "AA:BB",
    locationPrintsOnOutage: () => true,
    printText: vi.fn(async () => {}),
    onStamp: vi.fn(),
    onAlert: vi.fn(),
    now: () => new Date(2026, 6, 2, 14, 32, 0),
    sleep: async () => {},
    maxAttempts: 3,
    delayMs: 0,
    ...over,
  };
}

describe("printKitchenTicketBackup", () => {
  it("skips when online", async () => {
    const d = deps({ isOnline: () => true });
    expect(await printKitchenTicketBackup(ticket(), d)).toBe("skipped");
    expect(d.printText).not.toHaveBeenCalled();
  });
  it("skips when no kitchen printer is paired", async () => {
    const d = deps({ getKitchenPrinterAddress: () => null });
    expect(await printKitchenTicketBackup(ticket(), d)).toBe("skipped");
    expect(d.printText).not.toHaveBeenCalled();
  });
  it("skips when the location is not flagged to print", async () => {
    const d = deps({ locationPrintsOnOutage: () => false });
    expect(await printKitchenTicketBackup(ticket(), d)).toBe("skipped");
    expect(d.printText).not.toHaveBeenCalled();
  });
  it("prints and stamps on success", async () => {
    const d = deps();
    expect(await printKitchenTicketBackup(ticket(), d)).toBe("printed");
    expect(d.printText).toHaveBeenCalledTimes(1);
    expect(d.onStamp).toHaveBeenCalledWith("t1");
    expect(d.onAlert).not.toHaveBeenCalled();
  });
  it("retries then alerts (not stamped) after all attempts fail", async () => {
    const printText = vi.fn(async () => { throw new Error("busy"); });
    const d = deps({ printText });
    expect(await printKitchenTicketBackup(ticket(), d)).toBe("failed");
    expect(printText).toHaveBeenCalledTimes(3);
    expect(d.onAlert).toHaveBeenCalledTimes(1);
    expect(d.onStamp).not.toHaveBeenCalled();
  });
  it("succeeds after a transient failure (retry)", async () => {
    let n = 0;
    const printText = vi.fn(async () => { if (++n < 2) throw new Error("busy"); });
    const d = deps({ printText });
    expect(await printKitchenTicketBackup(ticket(), d)).toBe("printed");
    expect(printText).toHaveBeenCalledTimes(2);
    expect(d.onStamp).toHaveBeenCalledWith("t1");
  });
});
