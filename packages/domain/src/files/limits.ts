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
