'use client';

/**
 * use-print.ts
 * Centralized print hook — replaces handlePrint / handleThermalPrint
 * in every call site. Handles platform routing, formatting, audit write.
 *
 * Usage:
 *   const { printReceipt, isPrinting } = usePrint({
 *     receiptData, storeId, sessionId, appUser
 *   });
 */

import { useCallback, useRef, useState } from 'react';
import { doc, updateDoc, increment, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
import { getReceiptSettings } from '@/lib/receipts/receipt-settings';
import { formatReceiptText, formatPinText } from '@/lib/printing/receiptFormatter';
import ThermalPrinter from '@/lib/printing/thermalPrinter';
import { getPinQrMode, renderPinQr, PIN_QR_NATIVE_DOTS } from '@/lib/printing/pinQr';
import {
  isNativeBluetoothAvailable,
  getLastPrinterAddress,
  printViaNativeBluetooth,
} from '@/lib/printing/printHub';
import type { AppUser } from '@/context/auth-context';
import type { ReceiptData } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';

function getUsername(appUser: AppUser | null | undefined): string {
  return (
    appUser?.displayName?.trim() ||
    (appUser as any)?.name?.trim() ||
    (appUser?.email ? String(appUser.email).split('@')[0] : '') ||
    (appUser?.uid ? String(appUser.uid).slice(0, 6) : 'unknown')
  );
}

interface UsePrintOptions {
  receiptData: ReceiptData | null;
  storeId: string | null | undefined;
  sessionId?: string | null;
  appUser?: AppUser | null;
}

interface UsePrintReturn {
  printReceipt: () => Promise<void>;
  isPrinting: boolean;
  error: string | null;
}

export function usePrint({
  receiptData,
  storeId,
  sessionId,
  appUser,
}: UsePrintOptions): UsePrintReturn {
  const [isPrinting, setIsPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const writeAudit = useCallback(async () => {
    if (!storeId || !sessionId || sessionId === 'PREVIEW') return;
    try {
      await updateDoc(doc(db, 'stores', storeId, 'receipts', sessionId), {
        printedCount: increment(1),
        lastPrintedAt: serverTimestamp(),
        lastPrintedByUid: appUser?.uid ?? null,
        lastPrintedByUsername: appUser ? getUsername(appUser) : null,
      });
    } catch (e) {
      console.warn('Print audit tracking failed:', e);
    }
  }, [storeId, sessionId, appUser]);

  const printReceipt = useCallback(async () => {
    if (!receiptData || isPrinting) return;
    setIsPrinting(true);
    setError(null);

    try {
      if (isNativeBluetoothAvailable()) {
        const lastAddress = getLastPrinterAddress();
        if (!lastAddress) {
          toast({
            variant: 'destructive',
            title: 'No Printer',
            description: 'Go to Manager Tools → Printer Setup to connect a printer.',
          });
          return;
        }
        const liveSettings = storeId
          ? await getReceiptSettings(db, storeId)
          : receiptData.settings;
        const paperWidth: 58 | 80 = liveSettings.paperWidth === '58mm' ? 58 : 80;
        // A thermal printer only has built-in ROM fonts, so the CSS fontFamily
        // can't apply on paper (it stays a screen/PDF concern). Map the numeric
        // fontSize to the three sizes the printer can actually do: small = Font
        // B, normal = Font A, large = Font A double-height.
        const fontSizeVal = liveSettings.fontSize ?? 12;
        const fontMode: 'small' | 'normal' | 'large' =
          fontSizeVal <= 10 ? 'small' : fontSizeVal >= 14 ? 'large' : 'normal';
        const text = formatReceiptText({ ...receiptData, settings: liveSettings }, paperWidth, fontMode);
        await printViaNativeBluetooth({
          target: 'receipt',
          text,
          widthMm: paperWidth,
          cut: true,
          beep: true,
          encoding: 'CP437',
          showLogo: liveSettings.showLogo ?? false,
          logoWidthPct: liveSettings.logoWidthPct,
          font: fontMode,
          storeId,
        });
        await writeAudit();
        toast({ title: 'Printed', description: 'Receipt sent to thermal printer.' });
      } else {
        await new Promise<void>(r =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        window.print();
        await writeAudit();
      }
    } catch (e: any) {
      const msg: string = e?.message ?? 'Unknown print error';
      setError(msg);
      toast({ variant: 'destructive', title: 'Print Failed', description: msg });
    } finally {
      setIsPrinting(false);
    }
  }, [receiptData, isPrinting, storeId, writeAudit, toast]);

  return { printReceipt, isPrinting, error };
}

// ─── PIN print ────────────────────────────────────────────────────────────────

export interface UsePinPrintOptions {
  pin: string | null;
  customerName?: string | null;
  /** Table label ("Table 3") printed on its own line under the greeting; omit for Ala Carte. */
  tableLabel?: string | null;
  storeName?: string;
  storeId?: string | null;
  joinUrl?: string | null;
  /**
   * Paper width from the on-screen selector — the single source of truth for the
   * slip layout. Passed in so the print exactly matches what the cashier sees and
   * selected, and so the hot path needs no Firestore read (fast on native). Defaults
   * to 80mm when not provided.
   */
  paperSize?: "58mm" | "80mm";
}

export interface UsePinPrintReturn {
  printPin: () => Promise<void>;
  isPrintingPin: boolean;
}

export function usePinPrint({
  pin,
  customerName,
  tableLabel,
  storeName,
  storeId,
  joinUrl,
  paperSize,
}: UsePinPrintOptions): UsePinPrintReturn {
  const [isPrintingPin, setIsPrintingPin] = useState(false);
  // Ref mirrors the in-flight flag so the re-entry guard doesn't have to live
  // inside the useCallback deps — keeps `printPin`'s identity stable across
  // print start/finish, which auto-print effects in callers depend on.
  const isPrintingPinRef = useRef(false);
  const { toast } = useToast();

  const printPin = useCallback(async () => {
    if (!pin || isPrintingPinRef.current) return;
    isPrintingPinRef.current = true;
    setIsPrintingPin(true);

    try {
      if (isNativeBluetoothAvailable()) {
        const lastAddress = getLastPrinterAddress();
        if (!lastAddress) {
          toast({
            variant: 'destructive',
            title: 'No Printer',
            description: 'Go to Settings to connect a printer.',
          });
          return;
        }
        // Paper width comes straight from the on-screen selector (the value the cashier
        // sees). No settings/Firestore read here — that keeps the slip layout in lockstep
        // with the selector AND removes the network round-trip that made native printing lag.
        const paperWidth: 58 | 80 = paperSize === '58mm' ? 58 : 80;
        const { top, bottom } = formatPinText({ pin, customerName, tableLabel, storeName, width: paperWidth, qrPosition: 'middle' });

        // The QR is rendered client-side as a PNG; the plugin then sends it in the
        // mode chosen under Settings → PIN slip QR (see pinQr.ts). Image size is set
        // by trimming the blank padding, not by shrinking the QR: the old 4-dot QR
        // sent ~15KB per slip, mostly blank row padding, and overran the printer's
        // Bluetooth buffer (clipped QR, streaks). The print head is a fixed 203dpi;
        // a smaller+crisper QR would need a shorter join URL.
        const qrText = joinUrl || 'https://customer.shareat.net';
        const { qrImageBase64, qrModules } = await renderPinQr(qrText);

        await ThermalPrinter.connectBluetoothPrinter({ address: lastAddress });
        try {
          await ThermalPrinter.printPinSlip({
            top,
            bottom,
            qrData: qrText,
            qrSize: PIN_QR_NATIVE_DOTS,
            qrImageBase64,
            qrModules,
            qrMode: getPinQrMode(),
            paperWidthMm: paperWidth,
            encoding: 'CP437',
          });
        } finally {
          try { await ThermalPrinter.disconnectBluetoothPrinter(); } catch {}
        }
        toast({ title: 'PIN Printed', description: 'PIN slip sent to thermal printer.' });
      } else {
        window.print();
      }
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Print Failed', description: e?.message ?? 'Unknown error' });
    } finally {
      isPrintingPinRef.current = false;
      setIsPrintingPin(false);
    }
  }, [pin, storeId, customerName, tableLabel, storeName, toast, joinUrl, paperSize]);

  return { printPin, isPrintingPin };
}
