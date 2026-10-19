/**
 * T-441 ruling: the declared content type is not trusted. The upload route checks the file's first bytes against
 * the type it claims (JPEG, PNG, WebP, PDF) before anything is stored. Pure; no imports.
 */
const starts = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b);

export function fileBytesMatchType(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType.toLowerCase()) {
    case 'image/jpeg':
      return starts(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8); // "RIFF" .... "WEBP"
    case 'application/pdf':
      return starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    default:
      return false;
  }
}
