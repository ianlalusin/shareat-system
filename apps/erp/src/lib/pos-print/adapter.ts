/**
 * T-528 R4 — the print adapter. The APK plugin (T-530) is `window.ShareatPrinter`; without it the lines go
 * through a print-only view and the browser's own print dialog. Printing never throws at the caller: the
 * sale is already saved, so a failure is a result ('failed'), not an exception.
 */
export type PrintResult = 'printed' | 'fallback' | 'failed';

export interface PrintOptions {
  copies: number;
}

interface ShareatPrinterPlugin {
  print(lines: string[], opts: PrintOptions): void | Promise<void>;
}

const ROOT_ID = 'pos-print-root';
const STYLE_ID = 'pos-print-style';

function getPlugin(): ShareatPrinterPlugin | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { ShareatPrinter?: ShareatPrinterPlugin }).ShareatPrinter;
}

/** Which printer path this tablet has, for the header's Printer item. Never a guess. */
export function printerMode(): 'plugin' | 'browser' {
  return getPlugin() ? 'plugin' : 'browser';
}

export async function printLines(lines: string[], opts: PrintOptions): Promise<PrintResult> {
  const plugin = getPlugin();
  if (plugin) {
    try {
      await plugin.print(lines, opts);
      return 'printed';
    } catch {
      return 'failed';
    }
  }
  return browserPrint(lines);
}

/**
 * Some browsers and WebViews return from `window.print()` while the print view is still being laid out, so it is NEVER removed straight after the call:
 * it goes on `afterprint`, or after this fallback (some WebViews never fire the event).
 */
export const PRINT_VIEW_FALLBACK_MS = 10_000;

function browserPrint(lines: string[]): PrintResult {
  document.getElementById(ROOT_ID)?.remove(); // a stale view from a print that never reported back
  document.getElementById(STYLE_ID)?.remove();
  const root = document.createElement('div');
  root.id = ROOT_ID;
  const pre = document.createElement('pre');
  pre.style.fontFamily = 'ui-monospace, "Courier New", monospace';
  pre.style.margin = '0';
  pre.textContent = lines.join('\n');
  root.appendChild(pre);
  // Only the receipt shows on paper; the screen keeps the print view out of sight.
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `#${ROOT_ID}{display:none}@media print{body>*:not(#${ROOT_ID}){display:none!important}#${ROOT_ID}{display:block!important}}`;
  document.head.appendChild(style);
  document.body.appendChild(root);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup);
    if (timer !== undefined) clearTimeout(timer);
    root.remove();
    style.remove();
  };
  window.addEventListener('afterprint', cleanup);
  timer = setTimeout(cleanup, PRINT_VIEW_FALLBACK_MS);
  try {
    window.print();
    return 'fallback';
  } catch {
    cleanup();
    return 'failed';
  }
}
