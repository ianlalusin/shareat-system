"use client";

import { printViaNativeBluetooth } from "@/lib/printing/printHub";

const KEY = "kitchen_printer_address";

export function getKitchenPrinterAddress(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function setKitchenPrinterAddress(address: string): void {
  try { localStorage.setItem(KEY, address); } catch {}
}

/** Prints plain ESC/POS text to the paired kitchen Bluetooth printer. */
export async function printKitchenText(text: string, widthMm: 58 | 80): Promise<void> {
  await printViaNativeBluetooth(
    { target: "receipt", text, widthMm, cut: true, beep: true },
    getKitchenPrinterAddress(),
  );
}
