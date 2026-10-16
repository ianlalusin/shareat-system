"use client";

import { formatKitchenTicket, type KitchenTicketPrintData } from "@/lib/printing/kitchenTicketFormatter";

export interface KitchenTicketDoc {
  id: string;
  kitchenLocationId: string | null;
  kitchenLocationName?: string | null;
  itemName: string;
  qty?: number;
  qtyOrdered?: number;
  tableNumber?: unknown;
  tableDisplayName?: string | null;
  customerName?: string | null;
  sessionMode?: string;
  modifiersText?: string | null;
  notes?: string | null;
  widthMm?: 58 | 80;
}

export interface BackupPrintDeps {
  isOnline: () => boolean;
  getKitchenPrinterAddress: () => string | null;
  locationPrintsOnOutage: (kitchenLocationId: string | null) => boolean;
  printText: (text: string, widthMm: 58 | 80) => Promise<void>;
  onStamp: (ticketId: string) => void;
  onAlert: (message: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  delayMs?: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function tableOrCustomer(t: KitchenTicketDoc): string {
  if (t.sessionMode === "alacarte") return `CUSTOMER: ${t.customerName ?? "Walk-in"}`;
  return t.tableDisplayName || (t.tableNumber != null ? `TABLE ${t.tableNumber}` : "TABLE");
}

/**
 * Prints one offline kitchen ticket to the shared Bluetooth kitchen printer, IF
 * this device is offline, the ticket's location is flagged printOnOutage, and a
 * kitchen printer is paired. Retries on failure, then alerts the cashier. On
 * success, stamps the ticket printedOffline. Never throws — printing must not
 * break the order flow.
 */
export async function printKitchenTicketBackup(
  ticket: KitchenTicketDoc,
  deps: BackupPrintDeps,
): Promise<"printed" | "skipped" | "failed"> {
  if (deps.isOnline()) return "skipped";
  const address = deps.getKitchenPrinterAddress();
  if (!address) return "skipped";
  if (!deps.locationPrintsOnOutage(ticket.kitchenLocationId)) return "skipped";

  const now = (deps.now ?? (() => new Date()))();
  const data: KitchenTicketPrintData = {
    stationName: ticket.kitchenLocationName || "KITCHEN",
    tableOrCustomer: tableOrCustomer(ticket),
    itemName: ticket.itemName,
    qty: ticket.qty ?? ticket.qtyOrdered ?? 1,
    modifiersText: ticket.modifiersText,
    notes: ticket.notes,
    timeText: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
  };
  const widthMm = ticket.widthMm ?? 80;
  const text = formatKitchenTicket(data, widthMm);

  const maxAttempts = deps.maxAttempts ?? 3;
  const delayMs = deps.delayMs ?? 400;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let printed = false;
    try {
      await deps.printText(text, widthMm);
      printed = true;
    } catch {
      if (attempt < maxAttempts) await sleep(delayMs);
    }
    if (printed) {
      deps.onStamp(ticket.id); // outside the print try: a stamp error must not cause a reprint
      return "printed";
    }
  }
  deps.onAlert(`Kitchen printer unreachable — deliver "${data.itemName}" to ${data.stationName} manually.`);
  return "failed";
}
