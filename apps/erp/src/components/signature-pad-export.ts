/**
 * T-434 - what the signature pad hands the server: a PNG Blob as a multipart FILE PART, never a data URL.
 * No React or DOM import, so a unit test can run it with a fake canvas.
 *
 * ⛔ `toDataURL` is never called here or in the pad: a data URL is a string that ends up in action args, logs and (in v1) the
 * database. The bytes go through the same upload broker as every other file.
 */

/** The minimal canvas surface we use, so a test can pass a stub. */
export interface BlobCanvas {
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

/** Exports the canvas as a PNG Blob. Rejects (does not fall back to anything else) when the canvas yields no blob. */
export function exportSignaturePng(canvas: BlobCanvas): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The signature could not be saved. Try drawing it again.'));
    }, 'image/png');
  });
}

/** The form the server action reads: the PNG under `signature`, the person under `personId`. */
export function signatureFormData(blob: Blob, personId: string): FormData {
  const fd = new FormData();
  fd.append('signature', new File([blob], 'signature.png', { type: 'image/png' }));
  fd.append('personId', personId);
  return fd;
}
