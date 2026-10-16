'use client';

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import ThermalPrinter from '@/lib/printing/thermalPrinter';
import { webusbPrint } from '@/lib/printing/webusbPrinter';

export type PrintTarget = 'receipt' | 'pin';
export type PrintTransport = 'browser' | 'native_bluetooth' | 'webusb';

export type PrintJob = {
  target: PrintTarget;
  text?: string; // ESC/POS plain text payload
  widthMm?: 58 | 80;
  cut?: boolean;
  beep?: boolean;
  encoding?: string;
  showLogo?: boolean;
  /** Logo width as a % of paper width (20-100), from receipt settings. */
  logoWidthPct?: number;
  /** Thermal font size bucket: small=Font B, normal=Font A, large=double-height. */
  font?: 'small' | 'normal' | 'large';
  storeId?: string | null;
};

export function isNativeBluetoothAvailable() {
  return Capacitor.isNativePlatform();
}

export function getLastPrinterAddress() {
  try { return localStorage.getItem('last_printer_address'); } catch { return null; }
}

export function setLastPrinterAddress(address: string) {
  try { localStorage.setItem('last_printer_address', address); } catch {}
}

// ─── Logo Cache ──────────────────────────────────────────────────────────────

const LOGO_CACHE_PREFIX = 'logoCacheBase64:';
const LOGO_URL_PREFIX = 'logoCacheUrl:';

/**
 * Fetches an image URL and returns its base64 (without data URI prefix).
 */
async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    // Native (Capacitor) build: fetch through the native HTTP client, which is
    // NOT subject to the WebView's CORS policy. A Storage image read as a blob
    // via window.fetch otherwise needs a bucket CORS rule (origin
    // https://localhost) — without it the fetch is blocked and the logo silently
    // never prints. CapacitorHttp returns the body as base64 for a blob response.
    if (Capacitor.isNativePlatform()) {
      const res = await CapacitorHttp.get({ url, responseType: 'blob' });
      const data = res?.data;
      if (typeof data === 'string' && data.length > 0) {
        return data.includes(',') ? data.split(',')[1] : data;
      }
      return null;
    }

    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1] ?? null;
        resolve(base64);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Cache the logo base64 in localStorage for a given store.
 * Called when receipt settings load/change so the logo is ready for offline printing.
 */
export async function cacheLogoForStore(storeId: string, logoUrl: string | null | undefined): Promise<void> {
  if (!logoUrl) {
    // Clear cache if logo was removed
    try {
      localStorage.removeItem(LOGO_CACHE_PREFIX + storeId);
      localStorage.removeItem(LOGO_URL_PREFIX + storeId);
    } catch {}
    return;
  }

  try {
    const cachedUrl = localStorage.getItem(LOGO_URL_PREFIX + storeId);
    // Skip re-fetch if the URL hasn't changed
    if (cachedUrl === logoUrl && localStorage.getItem(LOGO_CACHE_PREFIX + storeId)) {
      return;
    }

    const base64 = await fetchImageAsBase64(logoUrl);
    if (base64) {
      localStorage.setItem(LOGO_CACHE_PREFIX + storeId, base64);
      localStorage.setItem(LOGO_URL_PREFIX + storeId, logoUrl);
    }
  } catch (e) {
    console.warn('Logo cache write failed:', e);
  }
}

/**
 * Get the cached logo base64 for a store. Returns null if not cached.
 */
function getCachedLogo(storeId: string): string | null {
  try {
    return localStorage.getItem(LOGO_CACHE_PREFIX + storeId);
  } catch {
    return null;
  }
}

/**
 * Resolves the logo base64 for printing:
 * 1. Try localStorage cache
 * 2. Fallback: fetch logoUrl from receipt settings, download image, cache it
 * 3. If all fails, return null (logo won't print, but printing continues)
 */
async function resolveLogoBase64(storeId: string): Promise<string | null> {
  // 1. Try cache first
  const cached = getCachedLogo(storeId);
  if (cached) return cached;

  // 2. Fallback: load settings and fetch the logo
  try {
    const { getReceiptSettings } = await import('@/lib/receipts/receipt-settings');
    const { db } = await import('@/lib/firebase/client');
    const settings = await getReceiptSettings(db, storeId);

    if (!settings.showLogo || !settings.logoUrl) return null;

    const base64 = await fetchImageAsBase64(settings.logoUrl);
    if (base64) {
      // Cache for next time
      try {
        localStorage.setItem(LOGO_CACHE_PREFIX + storeId, base64);
        localStorage.setItem(LOGO_URL_PREFIX + storeId, settings.logoUrl);
      } catch {}
      return base64;
    }
  } catch (e) {
    console.warn('Logo fallback fetch failed:', e);
  }

  return null;
}

/**
 * Central print function for native bluetooth (Capacitor).
 * Keep UI pages thin and route all thermal jobs here.
 */
export async function printViaNativeBluetooth(
  job: Required<Pick<PrintJob, 'text'>> & PrintJob,
  address: string | null = getLastPrinterAddress(),
) {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Native Bluetooth printing is only available in the Android app build.');
  }

  const lastAddress = address;
  if (!lastAddress) {
    throw new Error('No printer connected. Please configure printer in Settings.');
  }

  const widthMm = (job.widthMm ?? 80) as 58 | 80;
  let logoPrinted = false;

  await ThermalPrinter.connectBluetoothPrinter({ address: lastAddress });
  try {
    // Print logo if enabled — cache → fetch fallback → skip gracefully
    if (job.showLogo && job.storeId) {
      try {
        const base64 = await resolveLogoBase64(job.storeId);
        if (base64) {
          await ThermalPrinter.printImage({
            base64,
            widthMm,
            align: 'center',
            widthPct: job.logoWidthPct,
          });
          logoPrinted = true;
        }
      } catch (e) {
        // Logo print failed — continue with text-only receipt
        console.warn('Logo print failed, continuing without logo:', e);
      }
    }

    await ThermalPrinter.printReceipt({
      text: job.text,
      widthMm,
      cut: job.cut ?? true,
      beep: job.beep ?? true,
      encoding: job.encoding ?? 'CP437',
      skipInit: logoPrinted,
      font: job.font,
    });
  } finally {
    // Always release the BT socket so other apps (e.g. GrabFood) can print freely.
    try { await ThermalPrinter.disconnectBluetoothPrinter(); } catch {}
  }
}


/**
 * Central print function for WebUSB (browser-to-USB).
 * Caller must ensure this runs from a user gesture (e.g. button click).
 */
export async function printViaWebUSB(job: Required<Pick<PrintJob, 'text'>> & PrintJob) {
  const res = await webusbPrint({
    text: job.text,
    cut: job.cut ?? true,
  });
  return res;
}
