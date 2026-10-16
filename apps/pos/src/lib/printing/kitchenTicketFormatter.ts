"use client";

export interface KitchenTicketPrintData {
  stationName: string;
  tableOrCustomer: string;
  itemName: string;
  qty: number;
  modifiersText?: string | null;
  notes?: string | null;
  timeText: string;
}

/**
 * Builds plain-text ESC/POS content for an OFFLINE kitchen ticket (one item per
 * ticket, matching createKitchenTickets). Kitchen tickets are prep instructions,
 * not receipts — deliberately minimal: OFFLINE header, station, table/customer,
 * the item x qty, optional modifiers/notes, and the time.
 */
export function formatKitchenTicket(
  d: KitchenTicketPrintData,
  width: 58 | 80 = 80,
): string {
  const cols = width === 58 ? 32 : 48;
  const hr = "-".repeat(cols);
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((cols - s.length) / 2));
    return " ".repeat(pad) + s;
  };

  const lines: string[] = [];
  lines.push(center("*** OFFLINE ***"));
  lines.push(center(d.stationName.toUpperCase()));
  lines.push(hr);
  lines.push(d.tableOrCustomer);
  lines.push("");
  lines.push(`${d.qty} x ${d.itemName}`);
  if (d.modifiersText && d.modifiersText.trim()) lines.push(`  + ${d.modifiersText.trim()}`);
  if (d.notes && d.notes.trim()) lines.push(`  Note: ${d.notes.trim()}`);
  lines.push("");
  lines.push(hr);
  lines.push(d.timeText);
  lines.push("");

  return lines.join("\n") + "\n";
}
