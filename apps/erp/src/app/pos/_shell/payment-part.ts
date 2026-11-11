/**
 * T-528 R1 / T-546 R3 - what the Payment screen needs from the cached snapshot, read defensively. Pure: no React, no storage.
 * Null when the cached snapshot is older than the fields Pay needs (the tablet must go online once): the Orders tab then shows its
 * "has not loaded its price list yet" banner and Pay stays blocked. T-546 adds the till's receipt printer settings to that list.
 */
export interface SnapshotPaymentPart {
  store: { storeId: string; name: string; terminalNo: number; vatRegistered: boolean; receiptPaperMm: 58 | 80; receiptCopies: number };
  tenders: { id: string; name: string; kind: string }[];
  discountPresets: { id: string; name: string; valueType: string; value: string }[];
  rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number };
  staff: { personId: string; displayName: string }[];
}

export function paymentPartOf(b: Record<string, unknown>): SnapshotPaymentPart | null {
  const store = b.store as Partial<SnapshotPaymentPart['store']> | undefined;
  const rules = b.rules as Partial<SnapshotPaymentPart['rules']> | undefined;
  if (!store || typeof store.terminalNo !== 'number' || typeof store.vatRegistered !== 'boolean' || typeof store.name !== 'string') return null;
  // The closed lists of the server (T-546): paper 58 or 80, copies a whole 1 to 3. Anything else is a snapshot this build cannot print from.
  if (store.receiptPaperMm !== 58 && store.receiptPaperMm !== 80) return null;
  if (typeof store.receiptCopies !== 'number' || !Number.isInteger(store.receiptCopies) || store.receiptCopies < 1 || store.receiptCopies > 3) return null;
  if (!rules || typeof rules.vatPercentBasisPoints !== 'number' || typeof rules.scPwdPercentBasisPoints !== 'number') return null;
  if (!Array.isArray(b.tenders) || !Array.isArray(b.discountPresets)) return null;
  return {
    store: {
      storeId: String(store.storeId ?? ''),
      name: store.name,
      terminalNo: store.terminalNo,
      vatRegistered: store.vatRegistered,
      receiptPaperMm: store.receiptPaperMm,
      receiptCopies: store.receiptCopies,
    },
    tenders: b.tenders as SnapshotPaymentPart['tenders'],
    discountPresets: b.discountPresets as SnapshotPaymentPart['discountPresets'],
    rules: { vatPercentBasisPoints: rules.vatPercentBasisPoints, scPwdPercentBasisPoints: rules.scPwdPercentBasisPoints },
    staff: Array.isArray(b.staff) ? (b.staff as SnapshotPaymentPart['staff']) : [],
  };
}
