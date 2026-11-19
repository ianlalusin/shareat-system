/**
 * T-532 S1 — the printer bridge. Inside the Android shell the Capacitor plugin `ThermalPrinter` is on
 * `window.Capacitor.Plugins`; this module turns it into `window.ShareatPrinter`, the one door `adapter.ts` knows.
 * No `@capacitor/*` package is imported: the plugin is only reached through `window`, so a browser never loads native code.
 *
 * Per job (as v1 does): connect to the saved address -> `printReceipt` once per copy -> disconnect in `finally`,
 * so another app (GrabFood) can use the printer between jobs. A failure THROWS from `print`; `adapter.printLines` turns it into 'failed'.
 */
import { getMeta, setMeta } from '@/lib/pos-device/meta';

export const PRINTER_META_KEY = 'app.printer';

/** What this tablet remembers about its printer. Paper and font decide `widthMm` and `font` for the plugin. */
export interface SavedPrinter {
  address: string;
  name: string;
  widthMm: 58 | 80;
  font: 'small' | 'normal';
}

export interface BondedPrinter {
  name: string;
  address: string;
}

/** The part of the in-tree Java plugin (`ThermalPrinterPlugin.java`) this bridge uses. */
export interface ThermalPrinterPlugin {
  listBluetoothPrinters(): Promise<{ devices: BondedPrinter[] }>;
  connectBluetoothPrinter(opts: { address: string }): Promise<void>;
  disconnectBluetoothPrinter(): Promise<void>;
  printReceipt(opts: { text: string; widthMm: number; cut: boolean; beep: boolean; encoding: string; font: string }): Promise<void>;
}

interface CapacitorWindow {
  Capacitor?: { Plugins?: { ThermalPrinter?: ThermalPrinterPlugin } };
  ShareatPrinter?: unknown;
}

export const thermalPlugin = (): ThermalPrinterPlugin | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as CapacitorWindow).Capacitor?.Plugins?.ThermalPrinter;

export const loadSavedPrinter = (): Promise<SavedPrinter | null> => getMeta<SavedPrinter>(PRINTER_META_KEY);
export const savePrinter = (p: SavedPrinter): Promise<void> => setMeta(PRINTER_META_KEY, p);

/** ₱ is not in CP437 (the printer's code page); it would print as a stray glyph. Native path only; the browser keeps ₱. */
export const forPrinter = (line: string): string => line.replaceAll('₱', 'P');

/** The words a person sees for a failed print. */
export function printerErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!raw || /not connected|connect|bluetooth|socket|timeout|device/i.test(raw)) {
    return "Can't reach the printer. Is it on and paired in Android Bluetooth settings?";
  }
  return `The printer did not accept the job: ${raw}`;
}

export const NO_PRINTER_CHOSEN = 'No printer chosen yet. Open the Printer screen and pick one.';

/** Print `lines` `copies` times. Throws on any failure; the disconnect always runs once a connect was tried. */
export async function printViaPlugin(
  plugin: ThermalPrinterPlugin,
  saved: SavedPrinter | null,
  lines: string[],
  copies: number,
): Promise<void> {
  if (!saved?.address) throw new Error(NO_PRINTER_CHOSEN);
  const text = lines.map(forPrinter).join('\n');
  const count = Math.max(1, Math.floor(copies) || 1);
  try {
    await plugin.connectBluetoothPrinter({ address: saved.address });
    for (let i = 0; i < count; i++) {
      await plugin.printReceipt({ text, widthMm: saved.widthMm, cut: true, beep: i === 0, encoding: 'CP437', font: saved.font });
    }
  } finally {
    try {
      await plugin.disconnectBluetoothPrinter();
    } catch {
      /* a disconnect that fails must not hide the print result */
    }
  }
}

/** Define `window.ShareatPrinter` when the plugin exists. Safe to call twice; returns whether the bridge is in place. */
export function installPrinterBridge(load: () => Promise<SavedPrinter | null> = loadSavedPrinter): boolean {
  const plugin = thermalPlugin();
  if (!plugin) return false;
  const w = window as unknown as CapacitorWindow;
  if (w.ShareatPrinter) return true;
  w.ShareatPrinter = {
    print: async (lines: string[], opts: { copies: number }) => printViaPlugin(plugin, await load(), lines, opts.copies),
  };
  return true;
}
