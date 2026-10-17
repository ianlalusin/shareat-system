/**
 * T-441 - the browser-side photo shrink, moved out of `PhotoInput` unchanged in its rules (T-296: under 950 KB, EXIF
 * orientation kept, white behind transparency, pre-scaled past the canvas ceiling). Browser only.
 *
 * Returns the file to upload: a PDF or an already-small image passes through untouched; otherwise a JPEG under the
 * target. Throws `CompressionRefused` when no attempt got under the target (the person must choose another photo), and
 * `CompressionUnavailable` when this browser cannot compress at all (the caller sends the original; the server decides).
 */
import {
  OUTPUT_TYPE,
  PHOTO_TARGET_BYTES,
  compressionAttempts,
  formatBytes,
  isCompressibleImage,
  needsPreScale,
  scaleToEdge,
} from '../photo-compression';

export class CompressionRefused extends Error {}
export class CompressionUnavailable extends Error {}

/** Whether this file needs the shrink step at all. */
export function needsCompression(file: File): boolean {
  return isCompressibleImage(file.type) && file.size > PHOTO_TARGET_BYTES;
}

async function encode(bitmap: ImageBitmap, edge: number, quality: number): Promise<Blob | null> {
  const { width, height } = scaleToEdge(bitmap.width, bitmap.height, edge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // White FIRST: a transparent PNG encoded to JPEG would otherwise get a black background.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, OUTPUT_TYPE, quality));
}

export async function shrinkPhoto(file: File): Promise<File> {
  if (!needsCompression(file)) return file;
  try {
    // `imageOrientation: 'from-image'` is load-bearing: without it every phone photo arrives sideways.
    let bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (needsPreScale(bitmap.width, bitmap.height)) {
      const fit = scaleToEdge(bitmap.width, bitmap.height, 2000);
      const pre = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: fit.width, resizeHeight: fit.height });
      bitmap.close();
      bitmap = pre;
    }
    let best: Blob | null = null;
    for (const { edge, quality } of compressionAttempts()) {
      const blob = await encode(bitmap, edge, quality);
      if (!blob) continue;
      best = blob;
      if (blob.size <= PHOTO_TARGET_BYTES) break;
    }
    bitmap.close();
    if (!best || best.size > PHOTO_TARGET_BYTES) {
      throw new CompressionRefused(
        `This image could not be reduced below ${formatBytes(PHOTO_TARGET_BYTES)} without making it unreadable. ` +
          'Retake it with less of the background in frame, or crop it first.',
      );
    }
    return new File([best], file.name.replace(/\.\w+$/, '') + '.jpg', { type: OUTPUT_TYPE, lastModified: Date.now() });
  } catch (err) {
    if (err instanceof CompressionRefused) throw err;
    throw new CompressionUnavailable('Could not compress in this browser.');
  }
}
