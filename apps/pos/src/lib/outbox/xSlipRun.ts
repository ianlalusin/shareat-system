"use client";

/**
 * T-425 S5 - building and printing an X-slip from the sale ledger (Ruling 7). The text comes from `formatXSlip` over the ledger only; the print
 * goes through printHub like every other print. With no paired printer nothing is sent and the caller shows the text on screen.
 */
import { listEvents } from "@/lib/outbox/ledger";
import { formatXSlip } from "@/lib/printing/xSlipFormatter";
import { getLastPrinterAddress, isNativeBluetoothAvailable, printViaNativeBluetooth } from "@/lib/printing/printHub";
import { readTerminal } from "@/lib/terminal/counter";
import { getReceiptSettings } from "@/lib/receipts/receipt-settings";
import { db } from "@/lib/firebase/client";

export async function paperWidthFor(storeId: string): Promise<58 | 80> {
  try {
    const settings = await getReceiptSettings(db, storeId);
    return settings.paperWidth === "58mm" ? 58 : 80;
  } catch {
    return 80;
  }
}

/** The slip text for [periodStartMs, periodEndMs]. Never throws on an empty ledger. */
export async function buildXSlipText(i: { storeId: string; storeName: string; periodStartMs: number; periodEndMs: number }): Promise<{ text: string; widthMm: 58 | 80 }> {
  const [events, terminal, widthMm] = await Promise.all([listEvents(), readTerminal().catch(() => null), paperWidthFor(i.storeId)]);
  const text = formatXSlip({
    storeName: i.storeName,
    terminalNo: terminal?.terminalNo ?? 0,
    periodStartMs: i.periodStartMs,
    periodEndMs: i.periodEndMs,
    events,
    widthMm,
  });
  return { text, widthMm };
}

/** 'printed' when sent to the paired Bluetooth printer; 'no-printer' when there is none (show it on screen); 'failed' when the printer refused. */
export async function printXSlipText(text: string, widthMm: 58 | 80): Promise<"printed" | "no-printer" | "failed"> {
  if (!isNativeBluetoothAvailable() || !getLastPrinterAddress()) return "no-printer";
  try {
    await printViaNativeBluetooth({ target: "receipt", text, widthMm, cut: true, beep: true, encoding: "CP437" });
    return "printed";
  } catch (e) {
    console.warn("[x-slip] print failed", e);
    return "failed";
  }
}
