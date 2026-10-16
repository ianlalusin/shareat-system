'use client';

/**
 * T-296 — a file input that compresses a photo to under 1 MB before the form submits.
 *
 * **Ian, 2026-09-12:** *"i want every uploaded photo accross the app to not exceed 1mb so compress
 * it before uploading."*
 *
 * ## ⭐ It is a drop-in replacement for `<input type="file">`
 *
 * The compressed blob is written back onto the input through a `DataTransfer`, so the form submits
 * it under the same field name and **no server action changes at all** — `/ap`, `/customers/[id]`
 * and the delivery form still read `formData.get('receiptPhoto')` exactly as before.
 *
 * ## ⛔ The control is the SERVER, not this
 *
 * `MAX_IMAGE_BYTES` in `packages/domain/src/files/index.ts` refuses any image over 1 MB. With
 * JavaScript off this component does nothing, the original file is submitted, and the server
 * refuses it with a message naming the size. That is the honest arrangement: the browser is the
 * convenience, the database-side rule is the guarantee.
 *
 * ## ⚠️ Traps handled here, each of which fails by LOOKING fine
 *
 * - **EXIF orientation** — `createImageBitmap(file, { imageOrientation: 'from-image' })`. Without
 *   it every iPhone photo arrives sideways, and the upload still "works".
 * - **Alpha → black** — a transparent PNG encoded to JPEG gets a black background. Canvas filled
 *   white first.
 * - **Canvas ceiling** — mobile Safari returns a BLANK canvas past ~16.7 MP instead of throwing,
 *   which encodes tiny and reads as superb compression. Pre-scaled before the first draw.
 * - **Refusal, not silent mangling** — past the 1280 px floor the input reports the failure and
 *   clears itself rather than uploading something unreadable.
 */
import { useRef, useState } from 'react';
import {
  OUTPUT_TYPE,
  PHOTO_TARGET_BYTES,
  compressionAttempts,
  formatBytes,
  isCompressibleImage,
  needsPreScale,
  scaleToEdge,
} from './photo-compression';

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; from: number; to: number }
  | { kind: 'passthrough'; reason: string }
  | { kind: 'failed'; reason: string };

async function encode(
  bitmap: ImageBitmap,
  edge: number,
  quality: number,
): Promise<Blob | null> {
  const { width, height } = scaleToEdge(bitmap.width, bitmap.height, edge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // ⛔ White FIRST. A transparent PNG drawn straight onto a fresh canvas and encoded to JPEG comes
  //    out with a black background, which on a receipt photo is indistinguishable from a ruined
  //    scan.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, OUTPUT_TYPE, quality));
}

export function PhotoInput({
  name,
  required,
  className,
  accept = 'image/*,application/pdf',
  capture,
}: {
  name: string;
  required?: boolean;
  className?: string;
  accept?: string;
  /** T-434: `user` opens the phone's front camera (an ID-card photo of the person standing there). */
  capture?: 'user' | 'environment';
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function onChange() {
    const input = ref.current;
    const file = input?.files?.[0];
    if (!input || !file) return setStatus({ kind: 'idle' });

    if (!isCompressibleImage(file.type)) {
      // ⛔ A PDF cannot be canvas-re-encoded, and the rule Ian stated is about photos. It passes
      //    through and keeps its own per-purpose limit.
      return setStatus({ kind: 'passthrough', reason: 'Not an image — uploaded as-is.' });
    }
    if (file.size <= PHOTO_TARGET_BYTES) {
      return setStatus({ kind: 'passthrough', reason: `${formatBytes(file.size)} — already small enough.` });
    }

    setStatus({ kind: 'working' });
    try {
      // ⛔ `imageOrientation: 'from-image'` is load-bearing. Without it a phone photo loses its
      //    EXIF rotation and every receipt arrives sideways, having "uploaded successfully".
      let bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

      if (needsPreScale(bitmap.width, bitmap.height)) {
        // Past the canvas ceiling the draw silently yields blank pixels, so shrink at decode time.
        const fit = scaleToEdge(bitmap.width, bitmap.height, 2000);
        const pre = await createImageBitmap(file, {
          imageOrientation: 'from-image',
          resizeWidth: fit.width,
          resizeHeight: fit.height,
        });
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
        // ⛔ Refuse rather than upload something unreadable OR something oversized. Clearing the
        //    input means the form cannot be submitted with the original by accident.
        input.value = '';
        return setStatus({
          kind: 'failed',
          reason:
            `This image could not be reduced below ${formatBytes(PHOTO_TARGET_BYTES)} without ` +
            'making it unreadable. Retake it with less of the background in frame, or crop it first.',
        });
      }

      const compressed = new File([best], file.name.replace(/\.\w+$/, '') + '.jpg', {
        type: OUTPUT_TYPE,
        lastModified: Date.now(),
      });
      const dt = new DataTransfer();
      dt.items.add(compressed);
      input.files = dt.files;
      setStatus({ kind: 'done', from: file.size, to: compressed.size });
    } catch {
      // ⚠️ Never swallow into a pretended success. The original file is still on the input, so the
      //    server's own ceiling is what decides — which is the correct fallback, not a silent one.
      setStatus({
        kind: 'passthrough',
        reason: 'Could not compress in this browser — uploading the original, which the server may refuse if it is over 1 MB.',
      });
    }
  }

  return (
    <div className="space-y-1">
      <input
        ref={ref}
        type="file"
        name={name}
        required={required}
        accept={accept}
        capture={capture}
        onChange={onChange}
        className={className}
      />
      {status.kind === 'working' && <p className="text-xs text-neutral-500">Compressing…</p>}
      {status.kind === 'done' && (
        // ⭐ Visible, always. Silently replacing someone's file is how trust in an upload is lost.
        <p className="text-xs text-success">
          Compressed {formatBytes(status.from)} → <strong>{formatBytes(status.to)}</strong>
        </p>
      )}
      {status.kind === 'passthrough' && <p className="text-xs text-neutral-500">{status.reason}</p>}
      {status.kind === 'failed' && (
        <p className="text-xs text-danger">{status.reason}</p>
      )}
    </div>
  );
}
