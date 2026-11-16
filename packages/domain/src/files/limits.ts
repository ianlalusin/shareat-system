/**
 * What each upload purpose may hold, and how big. T-441 S1 (audit A7).
 *
 * A db-free LEAF: the photo-upload control imports this file in the browser
 * (`@shareat/domain/files/limits`) so the picker's `accept` list and the server's allow-list are the same
 * object, not two copies. `tests/unit/client-bundle-boundary.test.ts` walks type-only imports too, so this
 * file must NOT import the database package for any reason - it declares its own purpose list instead, and
 * `files/index.ts` holds a compile-time check that the two lists are identical (a drift fails `typecheck`).
 *
 * The object is deliberately a plain, non-frozen record: a test adds a type to it and expects every reader to see it.
 */

/** Mirror of `FILE_PURPOSES` in `packages/db/schema/stored-files.ts` (kept equal by a compile-time check in `files/index.ts`). */
export const LIMIT_PURPOSES = [
  'receipt_photo',
  'ar_collection_proof',
  'memo_document',
  'wastage_dispute',
  'onboarding_document',
  'leave_document',
  'staff_photo',
  'staff_signature',
  // T-511 S2a (migration 0228): a Grab / Foodpanda settlement statement (CSV or zip).
  'channel_settlement_file',
  // T-519 S1 (migration 0236): the scan of a signed staff deduction agreement.
  'staff_deduction_agreement',
] as const;
export type LimitPurpose = (typeof LIMIT_PURPOSES)[number];

/**
 * What each purpose may hold, and how big. v1 used one blanket 25 MB with "no content-type restriction"
 * because a single rule had to cover images, PDFs and Word documents at once. Per-purpose limits make the
 * blanket unnecessary.
 */
export const PURPOSE_LIMITS: Record<LimitPurpose, { readonly types: readonly string[]; readonly maxBytes: number }> = {
  receipt_photo: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 8 * 1024 * 1024 },
  ar_collection_proof: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 8 * 1024 * 1024 },
  memo_document: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 15 * 1024 * 1024 },
  wastage_dispute: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * 1024 * 1024 },
  onboarding_document: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 25 * 1024 * 1024 },
  // T-436: a medical-certificate photo. Images only; the app-wide 1 MB photo cap applies on top.
  leave_document: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * 1024 * 1024 },
  // T-434. The staff ID-card photo, and the on-screen signature (PNG only, under the app-wide 1 MB image ceiling).
  staff_photo: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * 1024 * 1024 },
  staff_signature: { types: ['image/png'], maxBytes: 1024 * 1024 },
  // T-511 S2a. A settlement statement: a CSV or a zip of CSVs. Windows often sends a .csv as application/vnd.ms-excel, so that type is listed
  // (its bytes must still be text: files/magic.ts). 3 MB here; the zip reader holds the same 3 MB compressed (a test keeps them equal) and caps a zip at 40 files and 15 MB once opened (T-511 S8a).
  channel_settlement_file: {
    types: ['text/csv', 'application/vnd.ms-excel', 'application/zip', 'application/x-zip-compressed'],
    maxBytes: 3 * 1024 * 1024,
  },
  // T-519 S1. A phone photo or PDF scan of the signed paper.
  staff_deduction_agreement: { types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 8 * 1024 * 1024 },
};

/**
 * T-296 - Ian, 2026-09-12: "every uploaded photo accross the app to not exceed 1mb".
 *
 * ONE ceiling for every image, applied on top of the per-purpose limit. Deliberately not a per-purpose field:
 * Ian said "across the app", and five copies of one rule is five places for it to drift. Exactly 1 MB; the
 * browser aims at 950 KB (`PHOTO_TARGET_BYTES`). PDFs are NOT subject to it.
 */
export const MAX_IMAGE_BYTES = 1024 * 1024;

/** Whether `MAX_IMAGE_BYTES` applies. Images only. */
export function isImageContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/');
}

/**
 * T-511 S8a - the most the settlement upload screen sends in one go: 20 MB, under the 26 MB Server Action body limit (`apps/erp/next.config.js`; a test keeps
 * them in order), so the person reads a sentence instead of getting a bare 413. Lives here with the other upload limits; the form (a browser file) imports it.
 */
export const SETTLEMENT_BATCH_MAX_BYTES = 20 * 1024 * 1024;

/** The sentence to show when the chosen files together are too big for one go, or null. */
export function settlementBatchProblem(sizes: readonly number[]): string | null {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= SETTLEMENT_BATCH_MAX_BYTES) return null;
  return `These files together are ${(total / (1024 * 1024)).toFixed(1)} MB, over the ${SETTLEMENT_BATCH_MAX_BYTES / (1024 * 1024)} MB the upload can carry at once. Choose fewer files and upload the rest in a second go.`;
}
