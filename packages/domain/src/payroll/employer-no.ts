/**
 * T-500: an agency employer number as people write it ("03-1234567-8") becomes the digits we store ("0312345678").
 * Only spaces and dashes are dropped; a letter or any other mark stays, so the digits-only check still refuses it.
 */
export function normaliseEmployerNo(raw: string): string {
  return raw.trim().replace(/[\s-]/g, '');
}
