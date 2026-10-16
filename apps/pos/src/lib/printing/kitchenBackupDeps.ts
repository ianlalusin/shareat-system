"use client";

import type { BackupPrintDeps } from "@/lib/printing/kitchenBackupPrint";
import { getKitchenPrinterAddress, printKitchenText } from "@/lib/printing/kitchenPrinter";

/**
 * Builds the production BackupPrintDeps. `isOnline` is intentionally always
 * false here: this is only called from the OFFLINE ticket-creation branches,
 * so the online guard is a defensive no-op. Callers supply the store's kitchen
 * locations (for printOnOutage), a stamp callback (local-first ticket update),
 * and an alert callback (cashier toast).
 */
export function makeKitchenBackupDeps(args: {
  kitchenLocations: { id: string; printOnOutage?: boolean }[];
  stampTicket: (ticketId: string) => void;
  alert: (message: string) => void;
}): BackupPrintDeps {
  const flagById = new Map(args.kitchenLocations.map((l) => [l.id, !!l.printOnOutage]));
  return {
    isOnline: () => false,
    getKitchenPrinterAddress,
    locationPrintsOnOutage: (id) => (id ? flagById.get(id) === true : false),
    printText: printKitchenText,
    onStamp: args.stampTicket,
    onAlert: args.alert,
  };
}
