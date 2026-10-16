import QRCode from 'qrcode';

/**
 * How the PIN-slip QR reaches the thermal paper. Mirrors QR_MODE_* in
 * android/.../ThermalPrinterPlugin.java — keep the two in step.
 *  raster-trim   — our image, rows cut to padding + QR (no printer commands needed).
 *  raster-margin — our image, rows cut to the QR only, centred with GS L. The store
 *                  printer ignores GS L for images (test slip 2026-09-24): prints left.
 *  raster-full   — our image padded to the full paper width (the pre-2026-09 path).
 *  native        — the printer draws the QR itself from the link text (~200 bytes). Default:
 *                  too little data to overrun the Bluetooth buffer, and it printed
 *                  centred on the store printer's test slip.
 */
export type PinQrMode = 'raster-trim' | 'raster-margin' | 'raster-full' | 'native';

export const PIN_QR_MODES: { value: PinQrMode; label: string }[] = [
  { value: 'raster-trim', label: 'A · Trimmed image' },
  { value: 'raster-margin', label: 'B · Image + left margin' },
  { value: 'raster-full', label: 'C · Full-width image (old)' },
  { value: 'native', label: 'D · Printer-drawn' },
];

export const DEFAULT_PIN_QR_MODE: PinQrMode = 'native';

/**
 * Printer dots per QR module for the image modes. 5 dots = 0.625mm at 203dpi, so a
 * v8/v9 join URL prints ~32-34mm wide. Kept at 5: every extra dot grows the image
 * data the printer has to buffer.
 */
export const PIN_QR_MODULE_DOTS = 5;

/**
 * Printer dots per QR module when the printer draws the QR (native). Size is free
 * there, since only the link text crosses Bluetooth. 5 dots = 0.625mm, ~31-33mm
 * wide for a v8/v9 join URL; v9 is 53 x 5 = 265 dots. Dropped from 6, which
 * printed too dark and dense on the store printer.
 */
export const PIN_QR_NATIVE_DOTS = 5;

const STORAGE_KEY = 'pinQrMode';

export function parsePinQrMode(raw: string | null | undefined): PinQrMode {
  return PIN_QR_MODES.some((m) => m.value === raw) ? (raw as PinQrMode) : DEFAULT_PIN_QR_MODE;
}

export function getPinQrMode(): PinQrMode {
  try {
    return parsePinQrMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PIN_QR_MODE;
  }
}

export function setPinQrMode(mode: PinQrMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
}

/**
 * Renders the QR the native plugin prints: a PNG at one printer dot per pixel,
 * plus the module count (symbol width without quiet zone) that native mode
 * needs to centre the printer-drawn symbol.
 */
export async function renderPinQr(text: string): Promise<{ qrImageBase64: string; qrModules: number }> {
  const qrModules = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules.size;
  const dataUrl = await QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: PIN_QR_MODULE_DOTS,
  });
  return { qrImageBase64: dataUrl.replace(/^data:image\/png;base64,/, ''), qrModules };
}
