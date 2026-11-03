/**
 * T-441 ruling: the declared content type is not trusted. The upload route checks the file's first bytes against
 * the type it claims (JPEG, PNG, WebP, PDF) before anything is stored. Pure; no imports.
 */
const starts = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b);

/** ZIP local-file-header (PK 03 04), empty archive (PK 05 06) and spanned archive (PK 07 08). */
const isZip = (bytes: Uint8Array): boolean => starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08]);

/**
 * T-511 S2a. A CSV has no magic number, so the check is "this is text": not empty, and no NUL byte in the first 8 KB (every image, zip and spreadsheet
 * binary carries NULs in its header). A leading UTF-8 byte-order mark is fine: it has no NUL. Looks only at the first 8 KB, so a large file is not scanned whole.
 */
const looksLikeText = (bytes: Uint8Array): boolean => {
  if (bytes.length === 0) return false;
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return false;
  return true;
};

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
    case 'application/zip':
    case 'application/x-zip-compressed':
      return isZip(bytes);
    // text/csv, and application/vnd.ms-excel (how Windows labels a .csv): accepted only as TEXT, so a real binary .xls is refused.
    case 'text/csv':
    case 'application/vnd.ms-excel':
      return looksLikeText(bytes);
    default:
      return false;
  }
}
