"use client";

import { doc, getDoc, getDocFromCache, onSnapshot, type DocumentData, type Firestore } from "firebase/firestore";
import type { ReceiptSettings } from "@/lib/types";
import { z } from "zod";

export const receiptSettingsSchema = z.object({
  businessName: z.string(),
  branchName: z.string(),
  address: z.string(),
  contact: z.string(),
  tin: z.string().optional(),
  vatType: z.enum(["VAT", "NON_VAT"]).optional(),
  logoUrl: z.string().url().optional().nullable(),
  footerText: z.string().optional(),
  showCashierName: z.boolean().default(true),
  showTableOrCustomer: z.boolean().default(true),
  showItemNotes: z.boolean().default(true),
  showDiscountBreakdown: z.boolean().default(true),
  showChargeBreakdown: z.boolean().default(true),
  paperWidth: z.enum(["58mm", "80mm"]).default("80mm"),
  receiptNoFormat: z.string().optional(),
  autoPrintAfterPayment: z.boolean().default(false),
  fontSize: z.coerce.number().min(8).max(16).default(12),
  fontFamily: z.string().default("'Courier New', Courier, monospace"),
  showLogo: z.boolean().default(true),
  logoWidthPct: z.coerce.number().min(20).max(100).default(80),
});

export type ReceiptSettingsFormValues = z.infer<typeof receiptSettingsSchema>;

export const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
    businessName: "Your Business",
    branchName: "",
    address: "Your Address",
    contact: "Your Contact Info",
    tin: "",
    vatType: "NON_VAT",
    logoUrl: null,
    showLogo: true,
    logoWidthPct: 80,
    footerText: "",
    showCashierName: true,
    showTableOrCustomer: true,
    showItemNotes: true,
    showDiscountBreakdown: true,
    showChargeBreakdown: true,
    paperWidth: "80mm",
    receiptNoFormat: "OR-######",
    autoPrintAfterPayment: false,
    fontSize: 12,
    fontFamily: "'Courier New', Courier, monospace",
};

/**
 * Merges fetched settings with defaults to ensure a complete object.
 */
export function mergeReceiptSettings(fetchedSettings: Partial<ReceiptSettings> | null | undefined): ReceiptSettings {
    return {
        ...DEFAULT_RECEIPT_SETTINGS,
        ...(fetchedSettings || {}),
    };
}

/**
 * Subscribes to real-time updates for a store's receipt settings.
 */
export function subscribeReceiptSettings(
    db: Firestore,
    storeId: string,
    callback: (settings: ReceiptSettings) => void,
    onError: (error: Error) => void
): () => void {
    const settingsRef = doc(db, `stores/${storeId}/receiptSettings`, "main");
    return onSnapshot(settingsRef, (docSnap) => {
        const fetched = docSnap.exists() ? (docSnap.data() as Partial<ReceiptSettings>) : {};
        callback(mergeReceiptSettings(fetched));
    }, onError);
}

/**
 * Fetches the current receipt settings for a store in a one-shot read.
 */
export async function getReceiptSettings(db: Firestore, storeId: string): Promise<ReceiptSettings> {
    const settingsRef = doc(db, `stores/${storeId}/receiptSettings`, "main");
    const docSnap = await getDoc(settingsRef);
    const fetched = docSnap.exists() ? (docSnap.data() as Partial<ReceiptSettings>) : {};
    return mergeReceiptSettings(fetched);
}

/**
 * Cache-first read for print hot paths: returns the REAL stored settings from the
 * local Firestore cache (instant, no server round-trip), falling back to the server
 * read only when the doc isn't cached yet. Correct paperWidth etc. — unlike a separate
 * localStorage mirror which can drift from the store's actual setting.
 */
export async function getReceiptSettingsCacheFirst(db: Firestore, storeId: string): Promise<ReceiptSettings> {
    const settingsRef = doc(db, `stores/${storeId}/receiptSettings`, "main");
    try {
        const cached = await getDocFromCache(settingsRef);
        return mergeReceiptSettings(cached.exists() ? (cached.data() as Partial<ReceiptSettings>) : {});
    } catch {
        // Not in the local cache yet — fall back to the normal (server) read.
        return getReceiptSettings(db, storeId);
    }
}
