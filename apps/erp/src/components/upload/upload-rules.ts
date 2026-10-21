/**
 * T-441 - what the upload control may offer for a purpose. Pure.
 *
 * Everything about file TYPES is read from `PURPOSE_LIMITS` at call time (the same object the server checks), so a type
 * added there reaches the picker with no edit here. This file holds no type literal of its own.
 */
import { PURPOSE_LIMITS, type LimitPurpose } from '@shareat/domain/files/limits';

export type UploadPurpose = LimitPurpose;

/** The picker's `accept` list: exactly the types the server will take for this purpose. */
export function acceptFor(purpose: UploadPurpose): string {
  return PURPOSE_LIMITS[purpose].types.join(',');
}

/** Whether a PDF is allowed (decides the words "Add photo or PDF" and whether a document tile can appear). */
export function allowsPdf(purpose: UploadPurpose): boolean {
  return PURPOSE_LIMITS[purpose].types.some((t) => t.endsWith('/pdf'));
}

/** A person's photo is a circle; everything else is a rounded square. */
export function shapeFor(purpose: UploadPurpose): 'circle' | 'square' {
  return purpose === 'staff_photo' ? 'circle' : 'square';
}

/**
 * Purposes whose stored files keep their own read rule (bible row 353): the control never draws a thumbnail for a stored
 * one, and opening it is one audited fetch per open.
 */
export const GUARDED_PURPOSES: readonly UploadPurpose[] = ['leave_document', 'staff_signature'];
